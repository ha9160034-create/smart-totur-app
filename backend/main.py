import asyncio
import base64
import logging
import os
from contextlib import asynccontextmanager
from typing import Literal, Optional

import fitz  # PyMuPDF
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from pydantic import ValidationError

from prompts import build_tutor_system_prompt
from schema import ExplainSlideResponse, LecturePlan

load_dotenv()

logger = logging.getLogger("whiteboard_tutor.api")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)

BoardMode = Literal["auto", "whiteboard", "pdf_overlay"]

# ---------------------------------------------------------------------------
# Runtime Configuration (100% env-driven, zero hardcoded keys or paid lock-in)
# ---------------------------------------------------------------------------
GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()
FAST_TUTOR_MODEL: str = os.getenv("FAST_TUTOR_MODEL", "gemini-4-hydrogen").strip()
DEEP_TUTOR_MODEL: str = os.getenv("DEEP_TUTOR_MODEL", "gemini-4-neon").strip()

# Clamp DPI strictly within the engineered 150-200 DPI window
PDF_RENDER_DPI: int = max(150, min(200, int(os.getenv("PDF_RENDER_DPI", "160"))))
MAX_PDF_SIZE_MB: int = max(1, int(os.getenv("MAX_PDF_SIZE_MB", "25")))
MAX_PDF_SIZE_BYTES: int = MAX_PDF_SIZE_MB * 1024 * 1024
MAX_RENDER_DIM_PX: int = max(1024, int(os.getenv("MAX_RENDER_DIM_PX", "2048")))

_raw_cors = os.getenv("CORS_ORIGINS", "*").strip()
CORS_ORIGINS: list[str] = (
    ["*"]
    if _raw_cors == "*"
    else [origin.strip() for origin in _raw_cors.split(",") if origin.strip()]
)

_genai_client: Optional[genai.Client] = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Initialize a single shared google-genai client for the FastAPI lifecycle."""
    global _genai_client
    if GEMINI_API_KEY:
        _genai_client = genai.Client(api_key=GEMINI_API_KEY)
        logger.info(
            "Gemini client initialized | fast=%s | deep=%s | dpi=%d",
            FAST_TUTOR_MODEL,
            DEEP_TUTOR_MODEL,
            PDF_RENDER_DPI,
        )
    else:
        logger.warning("GEMINI_API_KEY is not set; /api/explain will fail until configured.")
    yield
    _genai_client = None


app = FastAPI(
    title="AI Smart Whiteboard Tutor API",
    version="0.2.0",
    description="Contract-first FastAPI backend returning structured LecturePlan JSON for Intelligent Medical Systems slides.",
    lifespan=lifespan,
)

# Per CORS spec, allow_credentials cannot be True when allow_origins=["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=("*" not in CORS_ORIGINS),
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# In-Memory PDF Processing (Zero Disk Writes)
# ---------------------------------------------------------------------------
async def _read_upload_bounded(file: UploadFile, max_bytes: int) -> bytes:
    """Read uploaded file in chunks and abort immediately if it exceeds max_bytes."""
    chunks: list[bytes] = []
    total = 0
    chunk_size = 1024 * 1024  # 1 MiB

    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"PDF exceeds maximum allowed size of {MAX_PDF_SIZE_MB} MB.",
            )
        chunks.append(chunk)

    data = b"".join(chunks)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty.",
        )
    if not data.lstrip().startswith(b"%PDF-"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid file payload: uploaded file does not have a valid PDF header.",
        )
    return data


class PdfPageRangeError(ValueError):
    """Raised when the requested 1-based page_number is out of bounds."""


class PdfEncryptedError(ValueError):
    """Raised when the uploaded PDF requires a password."""


def _render_pdf_page_in_memory(
    pdf_bytes: bytes,
    page_number: int,
    dpi: int,
    max_dim_px: int,
) -> tuple[bytes, int, int, int]:
    """
    Render a single 1-based PDF page into in-memory JPEG bytes using PyMuPDF.
    Returns (jpeg_bytes, total_pages, width_px, height_px). Runs in a worker thread.
    """
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        if doc.needs_pass:
            raise PdfEncryptedError("PDF is password-protected and cannot be read.")

        total_pages = doc.page_count
        if total_pages == 0:
            raise PdfPageRangeError("PDF contains zero pages.")

        if page_number < 1 or page_number > total_pages:
            raise PdfPageRangeError(
                f"page_number={page_number} is out of range (valid pages: 1..{total_pages})."
            )

        page = doc.load_page(page_number - 1)  # PyMuPDF is 0-indexed

        # Start with target DPI zoom, then cap max pixel edge to prevent token/RAM spikes on poster slides
        scale = dpi / 72.0
        rect = page.rect  # CropBox-respecting dimensions in points
        longest_edge_px = max(rect.width, rect.height) * scale
        if longest_edge_px > max_dim_px and longest_edge_px > 0:
            scale = scale * (max_dim_px / longest_edge_px)

        matrix = fitz.Matrix(scale, scale)
        # alpha=False prevents transparent slide backgrounds from turning black in JPEG
        pix = page.get_pixmap(matrix=matrix, colorspace=fitz.csRGB, alpha=False)
        jpeg_bytes = pix.tobytes(output="jpeg", jpg_quality=88)
        width_px, height_px = pix.width, pix.height

    return jpeg_bytes, total_pages, width_px, height_px


# ---------------------------------------------------------------------------
# Defensive Post-Sanitization (Preserves Exact LecturePlan Schema Contract)
# ---------------------------------------------------------------------------
def _sanitize_plan(plan: LecturePlan, board_mode: BoardMode) -> LecturePlan:
    """
    Fix minor geometric/field slips from fast models without changing the schema:
    - Ensure bounding boxes satisfy ymin <= ymax and xmin <= xmax.
    - Strip mismatched bbox/slot fields so Skia renderer never receives conflicting hints.
    """
    pdf_action_types = {"pdf_highlight", "pdf_circle"}
    wb_action_types = {
        "wb_heading",
        "wb_bullet",
        "wb_equation",
        "wb_code",
        "wb_flow_card",
    }

    for step in plan.steps:
        if board_mode in ("whiteboard", "pdf_overlay"):
            step.mode = board_mode

        for action in step.actions:
            if action.type in pdf_action_types:
                action.slot = None
                action.connect_from_slot = None
                if action.bbox is not None:
                    if action.bbox.ymin > action.bbox.ymax:
                        action.bbox.ymin, action.bbox.ymax = action.bbox.ymax, action.bbox.ymin
                    if action.bbox.xmin > action.bbox.xmax:
                        action.bbox.xmin, action.bbox.xmax = action.bbox.xmax, action.bbox.xmin
            elif action.type in wb_action_types or action.type == "clear_board":
                action.bbox = None

    return plan


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
async def health_check() -> dict[str, object]:
    return {
        "status": "ok",
        "gemini_configured": _genai_client is not None,
        "fast_model": FAST_TUTOR_MODEL,
        "deep_model": DEEP_TUTOR_MODEL,
        "pdf_render_dpi": PDF_RENDER_DPI,
    }


@app.post(
    "/api/explain",
    response_model=ExplainSlideResponse,
    summary="Generate a structured LecturePlan + aligned slide image for a single PDF page",
)
async def explain_slide(
    file: UploadFile = File(..., description="Lecture PDF file"),
    page_number: int = Form(..., ge=1, description="1-based page number to explain"),
    board_mode: BoardMode = Form(
        "auto",
        description="Visual explanation mode: auto, whiteboard, or pdf_overlay",
    ),
    use_deep_model: bool = Form(
        False,
        description="False -> FAST_TUTOR_MODEL (default 85%), True -> DEEP_TUTOR_MODEL (complex 15%)",
    ),
) -> ExplainSlideResponse:
    if _genai_client is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server misconfiguration: GEMINI_API_KEY is missing.",
        )

    # 1. Validate & read uploaded PDF in memory with size limit
    if file.content_type and file.content_type not in (
        "application/pdf",
        "application/octet-stream",
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported content type '{file.content_type}'. Please upload a PDF file.",
        )

    pdf_bytes = await _read_upload_bounded(file, MAX_PDF_SIZE_BYTES)

    # 2. Convert requested PDF page to in-memory JPEG bytes (offloaded from event loop)
    try:
        image_bytes, total_pages, slide_width, slide_height = await asyncio.to_thread(
            _render_pdf_page_in_memory,
            pdf_bytes,
            page_number,
            PDF_RENDER_DPI,
            MAX_RENDER_DIM_PX,
        )
    except PdfEncryptedError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    except PdfPageRangeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except (fitz.FileDataError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Corrupted or unreadable PDF document.",
        ) from exc

    # 3. Route model & assemble locked system prompt
    selected_model = DEEP_TUTOR_MODEL if use_deep_model else FAST_TUTOR_MODEL
    system_prompt = build_tutor_system_prompt(board_mode)
    user_instruction = (
        f"Explain slide page {page_number} of {total_pages} from this lecture PDF. "
        f"Follow board_mode='{board_mode}' strictly and return a valid LecturePlan JSON."
    )

    logger.info(
        "Explaining page %d/%d | mode=%s | model=%s | img_kb=%.1f",
        page_number,
        total_pages,
        board_mode,
        selected_model,
        len(image_bytes) / 1024.0,
    )

    # 4. Call official google-genai SDK asynchronously with strict Pydantic response_schema
    try:
        response = await _genai_client.aio.models.generate_content(
            model=selected_model,
            contents=[
                genai_types.Part.from_bytes(
                    data=image_bytes,
                    mime_type="image/jpeg",
                ),
                user_instruction,
            ],
            config=genai_types.GenerateContentConfig(
                system_instruction=system_prompt,
                response_mime_type="application/json",
                response_schema=LecturePlan,
            ),
        )
    except genai_errors.APIError as exc:
        code = getattr(exc, "code", None)
        logger.error("Gemini API error (%s) on model=%s: %s", code, selected_model, exc)
        if code in (401, 403):
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Gemini API authentication failed. Verify GEMINI_API_KEY permissions.",
            ) from exc
        if code == 404:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Configured Gemini model '{selected_model}' was not found.",
            ) from exc
        if code == 429:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Gemini API rate limit or quota exceeded. Please retry shortly.",
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Upstream Gemini API error (status={code}).",
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected error while calling Gemini API")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unexpected error communicating with the AI model.",
        ) from exc

    # 5. Parse & validate strict LecturePlan contract
    try:
        if isinstance(response.parsed, LecturePlan):
            plan = response.parsed
        elif response.text:
            plan = LecturePlan.model_validate_json(response.text)
        else:
            raise ValueError("Model returned an empty response payload.")
    except (ValidationError, ValueError) as exc:
        logger.error("Structured output failed LecturePlan validation: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI response failed LecturePlan schema validation.",
        ) from exc

    sanitized_plan = _sanitize_plan(plan, board_mode)
    encoded_b64 = base64.b64encode(image_bytes).decode("ascii")

    return ExplainSlideResponse(
        plan=sanitized_plan,
        slide_image_data_uri=f"data:image/jpeg;base64,{encoded_b64}",
        slide_width=slide_width,
        slide_height=slide_height,
        page_number=page_number,
        total_pages=total_pages,
    )

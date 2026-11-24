import asyncio
import base64
import logging
import os
from contextlib import asynccontextmanager
from typing import Literal, Optional

import edge_tts
import fitz  # PyMuPDF
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from pydantic import BaseModel, Field, ValidationError

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
FALLBACK_TUTOR_MODEL: str = os.getenv("FALLBACK_TUTOR_MODEL", "gemini-3.1-flash-lite").strip()

# Clamp DPI strictly within the engineered 150-200 DPI window
PDF_RENDER_DPI: int = max(150, min(200, int(os.getenv("PDF_RENDER_DPI", "160"))))
MAX_PDF_SIZE_MB: int = max(1, int(os.getenv("MAX_PDF_SIZE_MB", "25")))
MAX_PDF_SIZE_BYTES: int = MAX_PDF_SIZE_MB * 1024 * 1024
MAX_RENDER_DIM_PX: int = max(1024, int(os.getenv("MAX_RENDER_DIM_PX", "2048")))

# Iraqi Neural TTS Configuration (edge-tts, 100% in-memory)
TTS_VOICE: str = os.getenv("TTS_VOICE", "ar-IQ-BasselNeural").strip()
TTS_TIMEOUT_SEC: float = max(5.0, float(os.getenv("TTS_TIMEOUT_SEC", "15.0")))

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
            "Gemini client initialized | fast=%s | deep=%s | fallback=%s | dpi=%d",
            FAST_TUTOR_MODEL,
            DEEP_TUTOR_MODEL,
            FALLBACK_TUTOR_MODEL,
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
# Extended Response Envelope & Concurrent In-Memory Neural TTS (edge-tts)
# ---------------------------------------------------------------------------
class StepAudioPayload(BaseModel):
    step_id: int
    audio_base64: Optional[str] = Field(
        default=None,
        description="Base64-encoded MP3 audio synthesized for this step's speech_ar.",
    )


class ExplainSlideWithAudioResponse(ExplainSlideResponse):
    """Extends ExplainSlideResponse cleanly with per-step Base64 MP3 audio without modifying schema.py."""
    step_audio: list[StepAudioPayload] = Field(
        default_factory=list,
        description="Index-aligned per-step MP3 audio payloads matching plan.steps.",
    )


async def _synthesize_step_audio_b64(text: str, voice: str = TTS_VOICE) -> Optional[str]:
    """Generate MP3 speech purely in memory via edge-tts and return raw Base64."""
    cleaned = (text or "").strip()
    if not cleaned:
        return None
    try:
        communicate = edge_tts.Communicate(text=cleaned, voice=voice)
        audio_chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                audio_chunks.append(chunk["data"])
        if not audio_chunks:
            return None
        return base64.b64encode(b"".join(audio_chunks)).decode("ascii")
    except Exception as exc:
        logger.warning("edge-tts synthesis failed (voice=%s): %s", voice, exc)
        return None


async def _synthesize_plan_audio(plan: LecturePlan) -> list[StepAudioPayload]:
    """Synthesize all TeachingStep narrations concurrently using asyncio.gather."""
    tasks = [
        asyncio.wait_for(
            _synthesize_step_audio_b64(step.speech_ar, TTS_VOICE),
            timeout=TTS_TIMEOUT_SEC,
        )
        for step in plan.steps
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    payloads: list[StepAudioPayload] = []
    for step, result in zip(plan.steps, results):
        if isinstance(result, str) and result:
            audio_b64: Optional[str] = result
        else:
            if isinstance(result, Exception):
                logger.warning("TTS failed/timed out for step %d: %s", step.step_id, result)
            audio_b64 = None
        payloads.append(StepAudioPayload(step_id=step.step_id, audio_base64=audio_b64))
    return payloads


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
        "fallback_model": FALLBACK_TUTOR_MODEL,
        "pdf_render_dpi": PDF_RENDER_DPI,
        "tts_voice": TTS_VOICE,
    }


def _build_model_fallback_chain(use_deep_model: bool) -> list[str]:
    """Build a deduplicated ordered fallback chain of Gemini models."""
    candidates = (
        [DEEP_TUTOR_MODEL, FAST_TUTOR_MODEL, FALLBACK_TUTOR_MODEL]
        if use_deep_model
        else [FAST_TUTOR_MODEL, FALLBACK_TUTOR_MODEL]
    )
    chain: list[str] = []
    for name in candidates:
        cleaned = name.strip()
        if cleaned and cleaned not in chain:
            chain.append(cleaned)
    return chain


@app.post(
    "/api/explain",
    response_model=ExplainSlideWithAudioResponse,
    summary="Generate a thorough 5-8 step LecturePlan + aligned slide image + synchronized Iraqi TTS audio",
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
) -> ExplainSlideWithAudioResponse:
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

    # 3. Build deduplicated model fallback chain & assemble locked system prompt
    model_chain = _build_model_fallback_chain(use_deep_model)
    system_prompt = build_tutor_system_prompt(board_mode)
    user_instruction = (
        f"Explain slide page {page_number} of {total_pages} from this lecture PDF thoroughly. "
        f"Do NOT summarize briefly: break down every concept, diagram component, equation, or code line into "
        f"5 to 8 detailed steps, with each step's speech_ar strictly 20 to 40 words in natural Iraqi academic Arabic "
        f"(keeping all scientific terms in English). Follow board_mode='{board_mode}' strictly and return a valid LecturePlan JSON."
    )

    logger.info(
        "Explaining page %d/%d | mode=%s | chain=%s | img_kb=%.1f",
        page_number,
        total_pages,
        board_mode,
        " -> ".join(model_chain),
        len(image_bytes) / 1024.0,
    )

    # 4. Call official google-genai SDK asynchronously across fallback chain with backoff
    response = None
    used_model: Optional[str] = None
    last_api_error: Optional[genai_errors.APIError] = None
    last_error_code: Optional[int] = None
    last_failed_model: str = model_chain[0] if model_chain else FAST_TUTOR_MODEL
    max_attempts_per_model = 2

    for model_idx, candidate_model in enumerate(model_chain):
        has_next_model = model_idx < len(model_chain) - 1
        config_kwargs: dict[str, object] = {
            "system_instruction": system_prompt,
            "response_mime_type": "application/json",
            "response_schema": LecturePlan,
        }
        if candidate_model == "gemini-3.5-flash-lite":
            config_kwargs["thinking_config"] = genai_types.ThinkingConfig(
                thinking_level=genai_types.ThinkingLevel.MINIMAL
            )
        gen_config = genai_types.GenerateContentConfig(**config_kwargs)

        for attempt in range(1, max_attempts_per_model + 1):
            try:
                response = await _genai_client.aio.models.generate_content(
                    model=candidate_model,
                    contents=[
                        genai_types.Part.from_bytes(
                            data=image_bytes,
                            mime_type="image/jpeg",
                        ),
                        user_instruction,
                    ],
                    config=gen_config,
                )
                used_model = candidate_model
                break
            except genai_errors.APIError as exc:
                code = getattr(exc, "code", None)
                err_str = str(exc)
                is_transient = (
                    code in (503, 429)
                    or "503" in err_str
                    or "429" in err_str
                )
                last_api_error = exc
                last_error_code = (
                    code
                    if isinstance(code, int)
                    else (503 if "503" in err_str else (429 if "429" in err_str else None))
                )
                last_failed_model = candidate_model

                if code in (401, 403):
                    logger.error(
                        "Gemini auth error (%s) on model=%s: %s",
                        code,
                        candidate_model,
                        exc,
                    )
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="Gemini API authentication failed. Verify GEMINI_API_KEY permissions.",
                    ) from exc

                if is_transient:
                    if attempt < max_attempts_per_model:
                        wait_sec = 1.5 * attempt
                        logger.warning(
                            "Gemini transient error (%s) on model=%s; retrying in %.1fs (attempt %d/%d)...",
                            last_error_code,
                            candidate_model,
                            wait_sec,
                            attempt,
                            max_attempts_per_model,
                        )
                        await asyncio.sleep(wait_sec)
                        continue

                    if has_next_model:
                        logger.warning(
                            "Model '%s' exhausted %d attempts (%s); falling back to '%s'.",
                            candidate_model,
                            max_attempts_per_model,
                            last_error_code,
                            model_chain[model_idx + 1],
                        )
                        break

                if code == 404 and has_next_model:
                    logger.warning(
                        "Model '%s' not found (404); falling back to '%s'.",
                        candidate_model,
                        model_chain[model_idx + 1],
                    )
                    break

                logger.error(
                    "Gemini API error (%s) on model=%s: %s",
                    code,
                    candidate_model,
                    exc,
                )
                break
            except Exception as exc:
                logger.exception(
                    "Unexpected error while calling Gemini API on model=%s",
                    candidate_model,
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Unexpected error communicating with the AI model.",
                ) from exc

        if response is not None:
            break

    if response is None:
        logger.error(
            "All models in fallback chain failed (%s) | last_model=%s | last_code=%s | error=%s",
            " -> ".join(model_chain),
            last_failed_model,
            last_error_code,
            last_api_error,
        )
        if last_error_code == 404:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Configured Gemini model '{last_failed_model}' was not found.",
            ) from last_api_error
        if last_error_code == 429:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Gemini API rate limit or quota exceeded across all configured models. Please retry shortly.",
            ) from last_api_error
        if last_error_code == 503:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Google Gemini servers are currently experiencing high global demand across all fallback models. Please retry in a few moments.",
            ) from last_api_error
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Upstream Gemini API error (status={last_error_code}).",
        ) from last_api_error

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

    # 6. Synthesize Iraqi-English neural MP3 audio for every step concurrently in memory
    step_audio = await _synthesize_plan_audio(sanitized_plan)
    logger.info(
        "Completed page %d/%d | used_model=%s | steps=%d | audio_ready=%d/%d | voice=%s",
        page_number,
        total_pages,
        used_model,
        len(sanitized_plan.steps),
        sum(1 for a in step_audio if a.audio_base64),
        len(step_audio),
        TTS_VOICE,
    )

    return ExplainSlideWithAudioResponse(
        plan=sanitized_plan,
        slide_image_data_uri=f"data:image/jpeg;base64,{encoded_b64}",
        slide_width=slide_width,
        slide_height=slide_height,
        page_number=page_number,
        total_pages=total_pages,
        step_audio=step_audio,
    )

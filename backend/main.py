import asyncio
import base64
import hashlib
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Literal, Optional

import edge_tts
import fitz  # PyMuPDF
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from pydantic import BaseModel, Field, ValidationError

import db
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
FAST_TUTOR_MODEL: str = os.getenv("FAST_TUTOR_MODEL", "gemini-3.5-flash-lite").strip()
DEEP_TUTOR_MODEL: str = os.getenv("DEEP_TUTOR_MODEL", "gemini-3.1-flash-lite").strip()
FALLBACK_TUTOR_MODEL: str = os.getenv("FALLBACK_TUTOR_MODEL", "gemini-3.1-flash-lite").strip()
EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "gemini-embedding-001").strip()
EMBEDDING_DIM: int = 768

# Clamp DPI strictly within the engineered 150-200 DPI window
PDF_RENDER_DPI: int = max(150, min(200, int(os.getenv("PDF_RENDER_DPI", "160"))))
MAX_PDF_SIZE_MB: int = max(1, int(os.getenv("MAX_PDF_SIZE_MB", "25")))
MAX_PDF_SIZE_BYTES: int = MAX_PDF_SIZE_MB * 1024 * 1024
MAX_RENDER_DIM_PX: int = max(1024, int(os.getenv("MAX_RENDER_DIM_PX", "2048")))

# Strictly locked Iraqi Arabic neural voice (edge-tts, 100% in-memory; never ar-EG-* or ar-SA-*)
TTS_VOICE: str = "ar-IQ-BasselNeural"
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
    """Initialize shared google-genai and Supabase clients for the FastAPI lifecycle."""
    global _genai_client
    db.init_supabase()
    if GEMINI_API_KEY:
        _genai_client = genai.Client(api_key=GEMINI_API_KEY)
        logger.info(
            "Gemini client initialized | fast=%s | deep=%s | fallback=%s | embed=%s(%dd) | dpi=%d | tts_voice=%s | supabase=%s",
            FAST_TUTOR_MODEL,
            DEEP_TUTOR_MODEL,
            FALLBACK_TUTOR_MODEL,
            EMBEDDING_MODEL,
            EMBEDDING_DIM,
            PDF_RENDER_DPI,
            TTS_VOICE,
            db.is_configured(),
        )
    else:
        logger.warning("GEMINI_API_KEY is not set; /api/explain will fail until configured.")
    yield
    _genai_client = None
    db.close_supabase()


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
) -> tuple[bytes, int, int, int, str]:
    """
    Render a single 1-based PDF page into in-memory JPEG bytes using PyMuPDF.
    Returns (jpeg_bytes, total_pages, width_px, height_px, page_text). Runs in a worker thread.
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
        page_text = (page.get_text("text") or "").strip()

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

    return jpeg_bytes, total_pages, width_px, height_px, page_text


def _extract_all_pdf_pages_in_memory(
    pdf_bytes: bytes,
    fallback_title: str,
) -> tuple[str, int, dict[int, str]]:
    """
    Extract document title, total page count, and per-page text across all pages in memory.
    Runs in a worker thread only when indexing a brand-new PDF.
    """
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        if doc.needs_pass:
            raise PdfEncryptedError("PDF is password-protected and cannot be read.")
        total_pages = doc.page_count
        if total_pages == 0:
            raise PdfPageRangeError("PDF contains zero pages.")

        meta_title = ((doc.metadata or {}).get("title") or "").strip()
        clean_fallback = os.path.splitext(os.path.basename(fallback_title or "lecture.pdf"))[0].strip()
        title = meta_title if len(meta_title) >= 3 else (clean_fallback or "Untitled Lecture")

        page_texts: dict[int, str] = {}
        for idx in range(total_pages):
            txt = (doc.load_page(idx).get_text("text") or "").strip()
            if txt:
                page_texts[idx + 1] = txt

    return title, total_pages, page_texts


def _chunk_page_text(
    page_number: int,
    text: str,
    max_chars: int = 800,
    overlap: int = 120,
) -> list[dict[str, Any]]:
    """Split a single page's extracted text into overlapping RAG chunks."""
    normalized = " ".join(text.split())
    if not normalized:
        return []
    if len(normalized) <= max_chars:
        return [{"page_number": page_number, "chunk_text": normalized}]

    chunks: list[dict[str, Any]] = []
    start = 0
    step = max(1, max_chars - overlap)
    while start < len(normalized):
        end = min(len(normalized), start + max_chars)
        piece = normalized[start:end].strip()
        if piece:
            chunks.append({"page_number": page_number, "chunk_text": piece})
        if end >= len(normalized):
            break
        start += step
    return chunks


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
    """Extends ExplainSlideResponse cleanly with per-step Base64 MP3 audio & cache metadata."""
    step_audio: list[StepAudioPayload] = Field(
        default_factory=list,
        description="Index-aligned per-step MP3 audio payloads matching plan.steps.",
    )
    cached: bool = Field(
        default=False,
        description="True when served directly from Supabase explained_pages cache.",
    )
    lecture_id: Optional[str] = Field(
        default=None,
        description="Supabase UUID of the indexed lecture, when persistence is enabled.",
    )


class CachedPageSummary(BaseModel):
    page_number: int
    board_mode: BoardMode
    use_deep_model: bool = False
    title: Optional[str] = None
    created_at: Optional[str] = None


class LectureSummary(BaseModel):
    id: str
    title: str
    total_pages: int
    created_at: Optional[str] = None
    cached_page_numbers: list[int] = Field(default_factory=list)
    cached_pages: list[CachedPageSummary] = Field(default_factory=list)


class RecentLecturesResponse(BaseModel):
    lectures: list[LectureSummary] = Field(default_factory=list)
    supabase_configured: bool = False


async def _embed_texts(
    texts: list[str],
    task_type: Literal["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"],
    batch_size: int = 50,
) -> list[list[float]]:
    """Generate 768-dim embeddings via gemini-embedding-001 in batches."""
    if _genai_client is None or not texts:
        return []

    vectors: list[list[float]] = []
    config = genai_types.EmbedContentConfig(
        task_type=task_type,
        output_dimensionality=EMBEDDING_DIM,
    )

    for start in range(0, len(texts), batch_size):
        batch = texts[start : start + batch_size]
        resp = await _genai_client.aio.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=batch,
            config=config,
        )
        embeddings = getattr(resp, "embeddings", None) or []
        for emb in embeddings:
            values = list(getattr(emb, "values", None) or [])
            if len(values) == EMBEDDING_DIM:
                vectors.append(values)

    return vectors


async def _ensure_lecture_indexed(
    file_hash: str,
    pdf_bytes: bytes,
    filename: str,
    existing_lecture: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """
    Ensure the PDF exists in `lectures` and has its full-document chunks indexed in `lecture_chunks`.
    Safe and non-fatal: returns the lecture row (or None if Supabase is unavailable).
    """
    if not db.is_configured():
        return None

    lecture = existing_lecture or await db.get_lecture_by_hash(file_hash)
    if lecture is not None:
        if await db.has_lecture_chunks(lecture["id"]):
            return lecture

    try:
        title, total_pages, page_texts = await asyncio.to_thread(
            _extract_all_pdf_pages_in_memory,
            pdf_bytes,
            filename,
        )
    except Exception as exc:
        logger.warning("Full-PDF text extraction skipped: %s", exc)
        return lecture

    if lecture is None:
        lecture = await db.create_or_get_lecture(
            file_hash=file_hash,
            title=title,
            total_pages=total_pages,
        )
    if lecture is None:
        return None

    # Build chunks across all pages with extractable text
    raw_chunks: list[dict[str, Any]] = []
    for p_num in sorted(page_texts.keys()):
        raw_chunks.extend(_chunk_page_text(p_num, page_texts[p_num]))

    if not raw_chunks:
        logger.info(
            "Indexed lecture '%s' (%d pages) with 0 text chunks (likely scanned PDF).",
            lecture["title"],
            total_pages,
        )
        return lecture

    try:
        vectors = await _embed_texts(
            [c["chunk_text"] for c in raw_chunks],
            task_type="RETRIEVAL_DOCUMENT",
        )
        if len(vectors) == len(raw_chunks):
            for chunk_item, vec in zip(raw_chunks, vectors):
                chunk_item["embedding"] = vec
            inserted = await db.insert_lecture_chunks(lecture["id"], raw_chunks)
            logger.info(
                "Indexed lecture '%s' (%d pages) | chunks_stored=%d | embed_model=%s(%dd)",
                lecture["title"],
                total_pages,
                inserted,
                EMBEDDING_MODEL,
                EMBEDDING_DIM,
            )
        else:
            logger.warning(
                "Embedding count mismatch (%d != %d); skipping chunk storage for lecture %s.",
                len(vectors),
                len(raw_chunks),
                lecture["id"],
            )
    except Exception as exc:
        logger.warning("Full-PDF embedding/indexing failed (continuing without RAG): %s", exc)

    return lecture


async def _retrieve_rag_context(
    lecture_id: Optional[str],
    page_number: int,
    page_text: str,
) -> Optional[str]:
    """Fetch top 3 related chunks from OTHER pages of the same lecture for prompt injection."""
    if not lecture_id or not db.is_configured():
        return None

    query_text = " ".join((page_text or "").split())[:1500]
    if not query_text:
        return None

    try:
        query_vecs = await _embed_texts([query_text], task_type="RETRIEVAL_QUERY")
        if not query_vecs:
            return None
        matches = await db.match_lecture_chunks(
            lecture_id=lecture_id,
            exclude_page_number=page_number,
            query_embedding=query_vecs[0],
            match_count=3,
        )
        if not matches:
            return None

        formatted_lines: list[str] = []
        for idx, item in enumerate(matches, start=1):
            p_num = item.get("page_number")
            snippet = " ".join(str(item.get("chunk_text", "")).split())[:500]
            if snippet:
                formatted_lines.append(f"[{idx}] (Page {p_num}): {snippet}")
        if not formatted_lines:
            return None

        logger.info(
            "RAG retrieved %d related chunks for lecture=%s page=%d from pages=%s",
            len(formatted_lines),
            lecture_id,
            page_number,
            [m.get("page_number") for m in matches],
        )
        return "\n".join(formatted_lines)
    except Exception as exc:
        logger.warning("RAG retrieval failed (continuing without RAG context): %s", exc)
        return None


def _build_response_from_cache(
    lecture: dict[str, Any],
    cached_row: dict[str, Any],
) -> ExplainSlideWithAudioResponse:
    """Reconstruct ExplainSlideWithAudioResponse from a Supabase explained_pages row."""
    plan = LecturePlan.model_validate(cached_row["plan_json"])
    raw_img = str(cached_row["page_image_base64"])
    slide_uri = (
        raw_img
        if raw_img.startswith("data:image/")
        else f"data:image/jpeg;base64,{raw_img}"
    )

    raw_audios = cached_row.get("step_audios_json") or []
    step_audio = [StepAudioPayload.model_validate(item) for item in raw_audios]

    return ExplainSlideWithAudioResponse(
        plan=plan,
        slide_image_data_uri=slide_uri,
        slide_width=int(cached_row.get("slide_width") or 1280),
        slide_height=int(cached_row.get("slide_height") or 720),
        page_number=int(cached_row["page_number"]),
        total_pages=int(lecture["total_pages"]),
        step_audio=step_audio,
        cached=True,
        lecture_id=str(lecture["id"]),
    )


async def _synthesize_step_audio_b64(text: str) -> Optional[str]:
    """Generate MP3 speech purely in memory via edge-tts strictly using ar-IQ-BasselNeural."""
    cleaned = (text or "").strip()
    if not cleaned:
        return None
    try:
        communicate = edge_tts.Communicate(text=cleaned, voice=TTS_VOICE)
        audio_chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                audio_chunks.append(chunk["data"])
        if not audio_chunks:
            return None
        return base64.b64encode(b"".join(audio_chunks)).decode("ascii")
    except Exception as exc:
        logger.warning("edge-tts synthesis failed (voice=%s): %s", TTS_VOICE, exc)
        return None


async def _synthesize_plan_audio(plan: LecturePlan) -> list[StepAudioPayload]:
    """Synthesize all TeachingStep narrations concurrently using asyncio.gather."""
    tasks = [
        asyncio.wait_for(
            _synthesize_step_audio_b64(step.speech_ar),
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
        "supabase_configured": db.is_configured(),
        "fast_model": FAST_TUTOR_MODEL,
        "deep_model": DEEP_TUTOR_MODEL,
        "fallback_model": FALLBACK_TUTOR_MODEL,
        "embedding_model": EMBEDDING_MODEL,
        "pdf_render_dpi": PDF_RENDER_DPI,
        "tts_voice": TTS_VOICE,
    }


@app.get(
    "/api/lectures",
    response_model=RecentLecturesResponse,
    summary="List previously indexed lectures and their cached pages from Supabase",
)
async def list_lectures() -> RecentLecturesResponse:
    if not db.is_configured():
        return RecentLecturesResponse(lectures=[], supabase_configured=False)

    rows = await db.list_lectures_with_cached_pages()
    return RecentLecturesResponse(
        lectures=[LectureSummary.model_validate(row) for row in rows],
        supabase_configured=True,
    )


@app.get(
    "/api/lectures/{lecture_id}/pages/{page_number}",
    response_model=ExplainSlideWithAudioResponse,
    summary="Load a cached explained slide directly by lecture_id without re-uploading the PDF",
)
async def get_cached_lecture_page(
    lecture_id: str,
    page_number: int,
    board_mode: Optional[BoardMode] = Query(default=None),
    use_deep_model: Optional[bool] = Query(default=None),
) -> ExplainSlideWithAudioResponse:
    if not db.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase caching is not configured on the server.",
        )

    found = await db.get_cached_page_by_lecture_id(
        lecture_id=lecture_id,
        page_number=page_number,
        board_mode=board_mode,
        use_deep_model=use_deep_model,
    )
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Cached explanation not found for lecture '{lecture_id}' page {page_number}.",
        )

    lecture, cached_row = found
    try:
        return _build_response_from_cache(lecture, cached_row)
    except (ValidationError, KeyError, ValueError) as exc:
        logger.error("Corrupted cached explained_pages row: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Cached slide payload failed schema validation.",
        ) from exc


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

    req_started = time.perf_counter()
    pdf_bytes = await _read_upload_bounded(file, MAX_PDF_SIZE_BYTES)
    file_hash = hashlib.sha256(pdf_bytes).hexdigest()

    # 1b. Fast Cache Hit Path (< 0.5s): skip rendering, Gemini, and edge-tts if already cached
    existing_lecture: Optional[dict[str, Any]] = None
    if db.is_configured():
        existing_lecture = await db.get_lecture_by_hash(file_hash)
        if existing_lecture is not None:
            cached_row = await db.get_cached_explained_page(
                lecture_id=existing_lecture["id"],
                page_number=page_number,
                board_mode=board_mode,
                use_deep_model=use_deep_model,
            )
            if cached_row is not None:
                try:
                    cached_response = _build_response_from_cache(existing_lecture, cached_row)
                    elapsed_ms = (time.perf_counter() - req_started) * 1000.0
                    logger.info(
                        "CACHE HIT | lecture=%s | page=%d/%d | mode=%s | deep=%s | %.1fms",
                        existing_lecture["id"],
                        page_number,
                        existing_lecture["total_pages"],
                        board_mode,
                        use_deep_model,
                        elapsed_ms,
                    )
                    return cached_response
                except (ValidationError, KeyError, ValueError) as exc:
                    logger.warning("Cached row invalid; regenerating page %d: %s", page_number, exc)

    # 2. Convert requested PDF page to in-memory JPEG bytes (offloaded from event loop)
    try:
        image_bytes, total_pages, slide_width, slide_height, current_page_text = (
            await asyncio.to_thread(
                _render_pdf_page_in_memory,
                pdf_bytes,
                page_number,
                PDF_RENDER_DPI,
                MAX_RENDER_DIM_PX,
            )
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

    # 2b. First-Time Full-Document Indexing & Cross-Page RAG Retrieval
    lecture_row = await _ensure_lecture_indexed(
        file_hash=file_hash,
        pdf_bytes=pdf_bytes,
        filename=file.filename or "lecture.pdf",
        existing_lecture=existing_lecture,
    )
    lecture_id: Optional[str] = str(lecture_row["id"]) if lecture_row else None
    rag_context = await _retrieve_rag_context(
        lecture_id=lecture_id,
        page_number=page_number,
        page_text=current_page_text,
    )

    # 3. Build deduplicated model fallback chain & assemble locked system prompt (with RAG context)
    model_chain = _build_model_fallback_chain(use_deep_model)
    system_prompt = build_tutor_system_prompt(board_mode, rag_context=rag_context)
    user_instruction = (
        f"Explain slide page {page_number} of {total_pages} from this lecture PDF thoroughly. "
        f"Do NOT summarize briefly: break down every concept, diagram component, equation, or code line into "
        f"5 to 8 detailed steps, with each step's speech_ar strictly 20 to 40 words in clear, natural Iraqi academic Arabic "
        f"(لهجة عراقية بيضاء مفهومة) with light Arabic diacritics (تشكيل خفيف) on ambiguous words, avoiding heavy slang spellings "
        f"and keeping all scientific terms in English. Follow board_mode='{board_mode}' strictly and return a valid LecturePlan JSON."
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

    # 7. Persist generated LecturePlan, rendered JPEG, and Base64 MP3s into Supabase cache
    if lecture_id is not None and db.is_configured():
        await db.save_explained_page(
            lecture_id=lecture_id,
            page_number=page_number,
            board_mode=board_mode,
            use_deep_model=use_deep_model,
            plan_json=sanitized_plan.model_dump(mode="json"),
            page_image_base64=encoded_b64,
            slide_width=slide_width,
            slide_height=slide_height,
            step_audios_json=[item.model_dump(mode="json") for item in step_audio],
        )

    logger.info(
        "Completed page %d/%d | used_model=%s | steps=%d | audio_ready=%d/%d | voice=%s | rag=%s | cached=False",
        page_number,
        total_pages,
        used_model,
        len(sanitized_plan.steps),
        sum(1 for a in step_audio if a.audio_base64),
        len(step_audio),
        TTS_VOICE,
        bool(rag_context),
    )

    return ExplainSlideWithAudioResponse(
        plan=sanitized_plan,
        slide_image_data_uri=f"data:image/jpeg;base64,{encoded_b64}",
        slide_width=slide_width,
        slide_height=slide_height,
        page_number=page_number,
        total_pages=total_pages,
        step_audio=step_audio,
        cached=False,
        lecture_id=lecture_id,
    )

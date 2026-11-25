import asyncio
import logging
import os
from typing import Any, Optional

logger = logging.getLogger("whiteboard_tutor.db")

try:
    from supabase import Client, create_client
except ImportError:  # pragma: no cover - handled gracefully if package not installed yet
    Client = Any  # type: ignore[misc, assignment]
    create_client = None  # type: ignore[assignment]

_supabase_client: Optional[Client] = None


def _get_supabase_credentials() -> tuple[str, str]:
    url = os.getenv("SUPABASE_URL", "").strip()
    key = (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.getenv("SUPABASE_KEY", "").strip()
        or os.getenv("SUPABASE_ANON_KEY", "").strip()
    )
    return url, key


def init_supabase() -> bool:
    """Initialize the shared Supabase client from environment variables."""
    global _supabase_client
    url, key = _get_supabase_credentials()

    if not url or not key:
        _supabase_client = None
        logger.warning(
            "SUPABASE_URL or SUPABASE_KEY is not set; running without Supabase caching/RAG."
        )
        return False

    if create_client is None:
        _supabase_client = None
        logger.warning(
            "supabase package is not installed; run 'pip install -r requirements.txt' to enable caching/RAG."
        )
        return False

    try:
        _supabase_client = create_client(url, key)
        logger.info("Supabase client initialized | url=%s", url)
        return True
    except Exception as exc:
        _supabase_client = None
        logger.error("Failed to initialize Supabase client: %s", exc)
        return False


def close_supabase() -> None:
    """Release the shared Supabase client reference during shutdown."""
    global _supabase_client
    _supabase_client = None


def is_configured() -> bool:
    """Return True when the Supabase client is initialized and ready."""
    return _supabase_client is not None


def _format_pgvector(embedding: list[float]) -> str:
    """Serialize a Python float vector into pgvector text format: [0.1,0.2,...]."""
    return "[" + ",".join(f"{float(v):.8f}" for v in embedding) + "]"


# ---------------------------------------------------------------------------
# Lectures CRUD
# ---------------------------------------------------------------------------
async def get_lecture_by_hash(file_hash: str) -> Optional[dict[str, Any]]:
    if _supabase_client is None:
        return None

    def _query() -> Optional[dict[str, Any]]:
        resp = (
            _supabase_client.table("lectures")
            .select("id, file_hash, title, total_pages, created_at")
            .eq("file_hash", file_hash)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        return rows[0] if rows else None

    try:
        return await asyncio.to_thread(_query)
    except Exception as exc:
        logger.warning("Supabase get_lecture_by_hash failed: %s", exc)
        return None


async def create_or_get_lecture(
    file_hash: str,
    title: str,
    total_pages: int,
) -> Optional[dict[str, Any]]:
    """Insert a lecture record or fetch the existing one if concurrently inserted."""
    if _supabase_client is None:
        return None

    def _upsert() -> Optional[dict[str, Any]]:
        resp = (
            _supabase_client.table("lectures")
            .upsert(
                {
                    "file_hash": file_hash,
                    "title": title,
                    "total_pages": total_pages,
                },
                on_conflict="file_hash",
            )
            .execute()
        )
        rows = resp.data or []
        if rows:
            return rows[0]
        # Fallback read if PostgREST returns empty representation
        lookup = (
            _supabase_client.table("lectures")
            .select("id, file_hash, title, total_pages, created_at")
            .eq("file_hash", file_hash)
            .limit(1)
            .execute()
        )
        lookup_rows = lookup.data or []
        return lookup_rows[0] if lookup_rows else None

    try:
        return await asyncio.to_thread(_upsert)
    except Exception as exc:
        logger.warning("Supabase create_or_get_lecture failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Lecture Chunks & Vector Similarity Search (pgvector)
# ---------------------------------------------------------------------------
async def has_lecture_chunks(lecture_id: str) -> bool:
    if _supabase_client is None:
        return False

    def _check() -> bool:
        resp = (
            _supabase_client.table("lecture_chunks")
            .select("id")
            .eq("lecture_id", lecture_id)
            .limit(1)
            .execute()
        )
        return bool(resp.data)

    try:
        return await asyncio.to_thread(_check)
    except Exception as exc:
        logger.warning("Supabase has_lecture_chunks failed: %s", exc)
        return False


async def insert_lecture_chunks(
    lecture_id: str,
    chunks: list[dict[str, Any]],
    batch_size: int = 100,
) -> int:
    """Bulk-insert embedded lecture chunks in batches. Returns number of inserted rows."""
    if _supabase_client is None or not chunks:
        return 0

    rows = [
        {
            "lecture_id": lecture_id,
            "page_number": int(item["page_number"]),
            "chunk_text": str(item["chunk_text"]),
            "embedding": _format_pgvector(item["embedding"]),
        }
        for item in chunks
    ]

    def _insert_batches() -> int:
        inserted = 0
        for start in range(0, len(rows), batch_size):
            batch = rows[start : start + batch_size]
            _supabase_client.table("lecture_chunks").insert(batch).execute()
            inserted += len(batch)
        return inserted

    try:
        return await asyncio.to_thread(_insert_batches)
    except Exception as exc:
        logger.warning("Supabase insert_lecture_chunks failed: %s", exc)
        return 0


async def match_lecture_chunks(
    lecture_id: str,
    exclude_page_number: int,
    query_embedding: list[float],
    match_count: int = 3,
    match_threshold: float = 0.25,
) -> list[dict[str, Any]]:
    """Query match_lecture_chunks RPC for top related chunks from OTHER pages of the same lecture."""
    if _supabase_client is None or not query_embedding:
        return []

    def _rpc() -> list[dict[str, Any]]:
        resp = _supabase_client.rpc(
            "match_lecture_chunks",
            {
                "query_embedding": _format_pgvector(query_embedding),
                "target_lecture_id": lecture_id,
                "exclude_page_number": exclude_page_number,
                "match_count": match_count,
                "match_threshold": match_threshold,
            },
        ).execute()
        return list(resp.data or [])

    try:
        return await asyncio.to_thread(_rpc)
    except Exception as exc:
        logger.warning("Supabase match_lecture_chunks RPC failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Explained Pages Cache
# ---------------------------------------------------------------------------
async def get_cached_explained_page(
    lecture_id: str,
    page_number: int,
    board_mode: str,
    use_deep_model: bool,
) -> Optional[dict[str, Any]]:
    if _supabase_client is None:
        return None

    def _query() -> Optional[dict[str, Any]]:
        resp = (
            _supabase_client.table("explained_pages")
            .select(
                "id, lecture_id, page_number, board_mode, use_deep_model, "
                "plan_json, page_image_base64, slide_width, slide_height, "
                "step_audios_json, created_at"
            )
            .eq("lecture_id", lecture_id)
            .eq("page_number", page_number)
            .eq("board_mode", board_mode)
            .eq("use_deep_model", use_deep_model)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        return rows[0] if rows else None

    try:
        return await asyncio.to_thread(_query)
    except Exception as exc:
        logger.warning("Supabase get_cached_explained_page failed: %s", exc)
        return None


async def save_explained_page(
    lecture_id: str,
    page_number: int,
    board_mode: str,
    use_deep_model: bool,
    plan_json: dict[str, Any],
    page_image_base64: str,
    slide_width: int,
    slide_height: int,
    step_audios_json: list[dict[str, Any]],
) -> bool:
    if _supabase_client is None:
        return False

    def _upsert() -> bool:
        _supabase_client.table("explained_pages").upsert(
            {
                "lecture_id": lecture_id,
                "page_number": page_number,
                "board_mode": board_mode,
                "use_deep_model": use_deep_model,
                "plan_json": plan_json,
                "page_image_base64": page_image_base64,
                "slide_width": slide_width,
                "slide_height": slide_height,
                "step_audios_json": step_audios_json,
            },
            on_conflict="lecture_id,page_number,board_mode,use_deep_model",
        ).execute()
        return True

    try:
        return await asyncio.to_thread(_upsert)
    except Exception as exc:
        logger.warning("Supabase save_explained_page failed: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Mobile "Recent Lectures" Listing & Direct Cached Page Retrieval
# ---------------------------------------------------------------------------
async def list_lectures_with_cached_pages(limit: int = 30) -> list[dict[str, Any]]:
    """Return recent indexed lectures along with lightweight cached page metadata."""
    if _supabase_client is None:
        return []

    def _query() -> list[dict[str, Any]]:
        lectures_resp = (
            _supabase_client.table("lectures")
            .select("id, file_hash, title, total_pages, created_at")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        lectures = list(lectures_resp.data or [])
        if not lectures:
            return []

        lecture_ids = [lec["id"] for lec in lectures]

        # Avoid selecting heavy base64 image/audio blobs when listing recent lectures
        try:
            pages_resp = (
                _supabase_client.table("explained_pages")
                .select(
                    "lecture_id, page_number, board_mode, use_deep_model, "
                    "created_at, slide_title:plan_json->>title"
                )
                .in_("lecture_id", lecture_ids)
                .order("page_number", desc=False)
                .execute()
            )
            page_rows = list(pages_resp.data or [])
        except Exception:
            # Fallback for older PostgREST versions without JSON arrow select alias
            pages_resp = (
                _supabase_client.table("explained_pages")
                .select("lecture_id, page_number, board_mode, use_deep_model, created_at")
                .in_("lecture_id", lecture_ids)
                .order("page_number", desc=False)
                .execute()
            )
            page_rows = list(pages_resp.data or [])

        by_lecture: dict[str, list[dict[str, Any]]] = {}
        for row in page_rows:
            lid = row["lecture_id"]
            by_lecture.setdefault(lid, []).append(
                {
                    "page_number": int(row["page_number"]),
                    "board_mode": row["board_mode"],
                    "use_deep_model": bool(row["use_deep_model"]),
                    "title": row.get("slide_title") or None,
                    "created_at": row.get("created_at"),
                }
            )

        enriched: list[dict[str, Any]] = []
        for lec in lectures:
            cached_entries = by_lecture.get(lec["id"], [])
            unique_pages = sorted({entry["page_number"] for entry in cached_entries})
            enriched.append(
                {
                    "id": lec["id"],
                    "title": lec["title"],
                    "total_pages": int(lec["total_pages"]),
                    "created_at": lec.get("created_at"),
                    "cached_page_numbers": unique_pages,
                    "cached_pages": cached_entries,
                }
            )
        return enriched

    try:
        return await asyncio.to_thread(_query)
    except Exception as exc:
        logger.warning("Supabase list_lectures_with_cached_pages failed: %s", exc)
        return []


async def get_cached_page_by_lecture_id(
    lecture_id: str,
    page_number: int,
    board_mode: Optional[str] = None,
    use_deep_model: Optional[bool] = None,
) -> Optional[tuple[dict[str, Any], dict[str, Any]]]:
    """Fetch a lecture row and matching cached explained_page row by lecture_id + page_number."""
    if _supabase_client is None:
        return None

    def _query() -> Optional[tuple[dict[str, Any], dict[str, Any]]]:
        lec_resp = (
            _supabase_client.table("lectures")
            .select("id, file_hash, title, total_pages, created_at")
            .eq("id", lecture_id)
            .limit(1)
            .execute()
        )
        lec_rows = lec_resp.data or []
        if not lec_rows:
            return None
        lecture = lec_rows[0]

        query = (
            _supabase_client.table("explained_pages")
            .select(
                "id, lecture_id, page_number, board_mode, use_deep_model, "
                "plan_json, page_image_base64, slide_width, slide_height, "
                "step_audios_json, created_at"
            )
            .eq("lecture_id", lecture_id)
            .eq("page_number", page_number)
        )
        if board_mode is not None:
            query = query.eq("board_mode", board_mode)
        if use_deep_model is not None:
            query = query.eq("use_deep_model", use_deep_model)

        page_resp = query.order("created_at", desc=True).limit(1).execute()
        page_rows = page_resp.data or []
        if not page_rows:
            return None
        return lecture, page_rows[0]

    try:
        return await asyncio.to_thread(_query)
    except Exception as exc:
        logger.warning("Supabase get_cached_page_by_lecture_id failed: %s", exc)
        return None

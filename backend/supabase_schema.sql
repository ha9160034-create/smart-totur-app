-- =============================================================================
-- AI Smart Whiteboard Tutor — Stage 5 Supabase Schema (PostgreSQL + pgvector)
-- Run this script once in the Supabase SQL Editor.
-- =============================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Lectures Table (Deduplicated by PDF SHA-256 hash)
-- -----------------------------------------------------------------------------
create table if not exists public.lectures (
  id uuid primary key default gen_random_uuid(),
  file_hash text not null unique,
  title text not null,
  total_pages integer not null check (total_pages > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_lectures_created_at
  on public.lectures (created_at desc);

-- -----------------------------------------------------------------------------
-- 2. Lecture Chunks Table (768-dim gemini-embedding-001 vectors for Full-PDF RAG)
-- -----------------------------------------------------------------------------
create table if not exists public.lecture_chunks (
  id uuid primary key default gen_random_uuid(),
  lecture_id uuid not null references public.lectures(id) on delete cascade,
  page_number integer not null check (page_number > 0),
  chunk_text text not null,
  embedding vector(768) not null
);

create index if not exists idx_lecture_chunks_lecture_page
  on public.lecture_chunks (lecture_id, page_number);

create index if not exists idx_lecture_chunks_embedding_hnsw
  on public.lecture_chunks
  using hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- 3. Explained Pages Cache Table
-- -----------------------------------------------------------------------------
create table if not exists public.explained_pages (
  id uuid primary key default gen_random_uuid(),
  lecture_id uuid not null references public.lectures(id) on delete cascade,
  page_number integer not null check (page_number > 0),
  board_mode text not null check (board_mode in ('auto', 'whiteboard', 'pdf_overlay')),
  use_deep_model boolean not null default false,
  plan_json jsonb not null,
  page_image_base64 text not null,
  slide_width integer not null default 1280 check (slide_width > 0),
  slide_height integer not null default 720 check (slide_height > 0),
  step_audios_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint uq_explained_pages_key unique (lecture_id, page_number, board_mode, use_deep_model)
);

create index if not exists idx_explained_pages_lecture_page
  on public.explained_pages (lecture_id, page_number);

-- -----------------------------------------------------------------------------
-- 4. Similarity Search RPC: Top-K Related Chunks from OTHER Pages of Same PDF
-- -----------------------------------------------------------------------------
create or replace function public.match_lecture_chunks(
  query_embedding vector(768),
  target_lecture_id uuid,
  exclude_page_number integer,
  match_count integer default 3,
  match_threshold double precision default 0.25
)
returns table (
  id uuid,
  lecture_id uuid,
  page_number integer,
  chunk_text text,
  similarity double precision
)
language sql
stable
as $$
  select
    lc.id,
    lc.lecture_id,
    lc.page_number,
    lc.chunk_text,
    1 - (lc.embedding <=> query_embedding) as similarity
  from public.lecture_chunks lc
  where lc.lecture_id = target_lecture_id
    and lc.page_number <> exclude_page_number
    and 1 - (lc.embedding <=> query_embedding) >= match_threshold
  order by lc.embedding <=> query_embedding asc
  limit greatest(match_count, 1);
$$;

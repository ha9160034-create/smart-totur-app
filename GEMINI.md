# Project Invariants (AI Smart Whiteboard Tutor)
- **Workspace Structure:** Only `backend/` (FastAPI, Python) and `mobile/` (Expo SDK 58, TypeScript) exist. Do not create web/Vite files at root.
- **Active Gemini Models:** Use `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite` for generation and `gemini-embedding-001` for embeddings. Never use retired `gemini-2.5-*` or `text-embedding-004`.
- **TTS & Audio:** Backend `edge-tts` must strictly use `"ar-IQ-BasselNeural"`. Mobile must strictly use `expo-audio` + `expo-file-system/legacy` (never `expo-av`).
- **Mobile Uploads:** Always use native `XMLHttpRequest` with `{ uri, name, type }` for `FormData` uploads (Expo SDK 58 `fetch` rejects native FormData parts).
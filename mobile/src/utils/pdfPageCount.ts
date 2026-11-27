import * as FileSystem from "expo-file-system/legacy";

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Lightweight pure-JS base64 -> latin1 decoder for scanning local PDF dictionaries
 * without requiring Node Buffer or extra native modules.
 */
function decodeBase64ToLatin1(b64: string): string {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const out: string[] = [];
  let i = 0;
  while (i < clean.length) {
    const c1 = BASE64_CHARS.indexOf(clean[i++] ?? "");
    const c2 = BASE64_CHARS.indexOf(clean[i++] ?? "");
    const ch3 = clean[i++] ?? "=";
    const ch4 = clean[i++] ?? "=";
    const c3 = ch3 === "=" ? -1 : BASE64_CHARS.indexOf(ch3);
    const c4 = ch4 === "=" ? -1 : BASE64_CHARS.indexOf(ch4);
    if (c1 < 0 || c2 < 0) break;

    out.push(String.fromCharCode((c1 << 2) | (c2 >> 4)));
    if (c3 >= 0) {
      out.push(String.fromCharCode(((c2 & 15) << 4) | (c3 >> 2)));
    }
    if (c4 >= 0) {
      out.push(String.fromCharCode(((c3 & 3) << 6) | c4));
    }
  }
  return out.join("");
}

/**
 * Fast offline local PDF page count estimator using expo-file-system/legacy.
 * Serves as an instant fallback while POST /api/pdf-info confirms the authoritative
 * PyMuPDF page count (essential for PDF 1.5+ compressed object streams).
 */
export async function extractLocalPdfPageCount(
  uri: string
): Promise<number | null> {
  if (!uri) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    // Guard memory: skip local latin1 scan on huge (>12MB) PDFs and let /api/pdf-info answer
    if (
      info.exists &&
      "size" in info &&
      typeof info.size === "number" &&
      info.size > 12 * 1024 * 1024
    ) {
      return null;
    }

    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (!base64) return null;
    const raw = decodeBase64ToLatin1(base64);

    // Strategy 1: Root /Type /Pages dictionary /Count N (take maximum root tree count)
    let maxPagesCount = 0;
    const pagesDictRe = /\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = pagesDictRe.exec(raw)) !== null) {
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n) && n > maxPagesCount && n <= 2000) {
        maxPagesCount = n;
      }
    }
    if (maxPagesCount > 0) {
      return maxPagesCount;
    }

    // Strategy 2: Count individual /Type /Page dictionaries (excluding /Pages)
    const leafPages = raw.match(/\/Type\s*\/Page(?![sA-Za-z])/g);
    if (leafPages && leafPages.length > 0 && leafPages.length <= 2000) {
      return leafPages.length;
    }

    return null;
  } catch {
    return null;
  }
}

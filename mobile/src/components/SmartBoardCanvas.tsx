import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Image,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  Canvas,
  Path,
  RoundedRect,
  Skia,
} from "@shopify/react-native-skia";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type {
  BoundingBox,
  SketchIcon,
  TeachingStep,
  VisualAction,
  WhiteboardSlot,
  WordTiming,
} from "../types/schema";
import {
  createRoughArrowPath,
  createRoughCirclePath,
  createRoughRectPath,
  createRoughTableGridPath,
  createRoughUnderlinePath,
  createSketchIconPath,
  hashSeed,
  makeEmptySkiaPath,
} from "../utils/roughSkia";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------
export interface RectFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SmartBoardCanvasProps {
  /** Complete list of steps from LecturePlan.steps */
  steps: TeachingStep[];
  /** Active 0-based step index */
  currentStepIndex: number;
  /**
   * URI of the rendered PDF slide image (local file://, http://, or data:image/jpeg;base64,...).
   * Used automatically in pdf_overlay mode when renderPdfLayer is not provided.
   */
  slideImageUri?: string;
  /**
   * Known width/height ratio of the PDF page (e.g. 16/9 or 0.707 for A4).
   * Automatically updated from Image.onLoad when slideImageUri is provided.
   */
  slideAspectRatio?: number;
  /**
   * Optional custom PDF background renderer (e.g., react-native-pdf in an Expo Dev Build).
   * Receives the exact aspect-ratio-preserved content frame so the Skia overlay aligns 1:1.
   */
  renderPdfLayer?: (contentRect: RectFrame) => React.ReactNode;
  /** Normalized 0.0 -> 1.0 audio playback progress driving progressive strokes & typewriter reveal */
  stepProgress?: number;
  /** Current step audio playback time in milliseconds for exact WordBoundary sync */
  currentTimeMs?: number;
  /** Word-level timestamps emitted by backend edge-tts for the active step */
  wordTimings?: WordTiming[];
  /** True while step audio is actively playing (displays live pen/cursor at typing tip) */
  isPlaying?: boolean;
  /** Incremented on Replay Step to re-trigger progressive animation without remounting canvas */
  replayToken?: number;
  /** Safe top padding so whiteboard cards begin cleanly below the floating HUD pill */
  topInset?: number;
  /** Safe bottom padding so cards & Reset View button stay clear of the floating dark dock */
  bottomInset?: number;
}

// ---------------------------------------------------------------------------
// Warm Paper Palette, Cross-Platform Fonts & Constants
// ---------------------------------------------------------------------------
const PAPER_BG = "#FAF8F5";
const PAPER_GRID_COLOR = "rgba(148, 138, 122, 0.17)";
const MIN_SCALE = 0.6;
const MAX_SCALE = 3.0;
const MIN_TABLE_COL_WIDTH = 105;
const TABLE_CANVAS_BLEED = 8; // >= 6px bleed on all sides so 3-4px corner overshoots & double-strokes never clip
const WORD_SYNC_REVEAL_WINDOW_MS = 240;
const WORD_SYNC_LEAD_MS = 150; // Leading edge so visuals arrive slightly ahead of speech
const CARD_BORDER_DRAW_MS = 480;
const TABLE_GRID_DRAW_MS = 580;
const ARROW_DRAW_DELAY_MS = 320;
const ARROW_DRAW_MS = 440;
const PDF_STROKE_DRAW_MS = 460;

const CODE_FONT_FAMILY = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const SERIF_FONT_FAMILY = Platform.select({
  ios: "Georgia",
  android: "serif",
  default: "serif",
});

interface ColorToken {
  stroke: string;
  fill: string;
  noteFill: string;
  highlight: string;
  text: string;
  badgeBg: string;
}

const COLOR_MAP: Record<VisualAction["color"], ColorToken> = {
  blue: {
    stroke: "#2563EB",
    fill: "#F0F6FF",
    noteFill: "#EFF6FF",
    highlight: "rgba(37, 99, 235, 0.24)",
    text: "#1E3A8A",
    badgeBg: "#DBEAFE",
  },
  red: {
    stroke: "#DC2626",
    fill: "#FEF2F2",
    noteFill: "#FFF5F5",
    highlight: "rgba(220, 38, 38, 0.24)",
    text: "#991B1B",
    badgeBg: "#FEE2E2",
  },
  green: {
    stroke: "#16A34A",
    fill: "#F0FDF4",
    noteFill: "#F0FDF4",
    highlight: "rgba(22, 163, 74, 0.24)",
    text: "#166534",
    badgeBg: "#DCFCE7",
  },
  yellow: {
    stroke: "#CA8A04",
    fill: "#FEFCE8",
    noteFill: "#FEFCE8",
    highlight: "rgba(250, 204, 21, 0.42)",
    text: "#854D0E",
    badgeBg: "#FEF9C3",
  },
  black: {
    stroke: "#1E293B",
    fill: "#FFFFFF",
    noteFill: "#F8FAFC",
    highlight: "rgba(15, 23, 42, 0.16)",
    text: "#0F172A",
    badgeBg: "#E2E8F0",
  },
};

function getColorToken(color?: VisualAction["color"]): ColorToken {
  return (color && COLOR_MAP[color]) || COLOR_MAP.blue;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// Text Normalization & WordBoundary Token Matching (Arabic + English)
// ---------------------------------------------------------------------------
function normalizeBlockText(raw?: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "    ")
    .replace(/^\s*\n+/, "")
    .replace(/\n+\s*$/, "");
}

const SYNC_STOPWORDS = new Set([
  "the",
  "an",
  "of",
  "to",
  "and",
  "or",
  "is",
  "are",
  "be",
  "on",
  "at",
  "by",
  "as",
  "في",
  "من",
  "علي",
  "الي",
  "عن",
  "مع",
  "هذا",
  "هذه",
  "التي",
  "الذي",
  "بين",
  "كل",
  "كان",
  "او",
  "ان",
  "ما",
  "لا",
  "هو",
  "هي",
]);

function normalizeSyncToken(raw: string): string {
  return raw
    .toLowerCase()
    // Strip Arabic diacritics (tashkeel) and tatweel
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    // Normalize common Arabic orthographic variants
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    // Strip punctuation / symbols
    .replace(/[^\u0600-\u06FFa-z0-9_]+/g, "")
    .trim();
}

function stripArabicArticle(norm: string): string {
  if (norm.length >= 4 && norm.startsWith("ال")) {
    return norm.slice(2);
  }
  return norm;
}

function extractSyncTokens(text: string): string[] {
  const parts = normalizeBlockText(text).split(/[\s,.;:!?()[\]{}<>/"'`|\\\-+*=]+/);
  const filtered: string[] = [];
  const fallback: string[] = [];
  for (const part of parts) {
    const norm = normalizeSyncToken(part);
    if (norm.length < 2) continue;
    fallback.push(norm);
    if (!SYNC_STOPWORDS.has(norm)) {
      filtered.push(norm);
    }
  }
  return filtered.length > 0 ? filtered : fallback;
}

interface NormalizedTimingEntry {
  norm: string;
  bare: string;
  startMs: number;
}

function tokensMatch(a: string, bNorm: string, bBare: string): boolean {
  if (!a || !bNorm) return false;
  const aBare = stripArabicArticle(a);
  if (a === bNorm || aBare === bBare || a === bBare || aBare === bNorm) {
    return true;
  }
  if (aBare.length >= 4 && bBare.length >= 4) {
    if (bBare.startsWith(aBare) || aBare.startsWith(bBare)) {
      return true;
    }
  }
  return false;
}

/**
 * Matches an ordered list of item texts (wb_table rows or stacked wb_bullet items)
 * against normalized WordTiming entries, returning each item's spoken trigger start_ms
 * (or null when no keyword match exists so callers fall back to proportional stepProgress).
 */
function computeItemTriggerMsList(
  itemTexts: string[],
  wordTimings?: WordTiming[]
): Array<number | null> {
  if (!Array.isArray(wordTimings) || wordTimings.length === 0) {
    return itemTexts.map(() => null);
  }

  const normalizedTimings: NormalizedTimingEntry[] = [];
  for (const wt of wordTimings) {
    if (!wt || typeof wt.word !== "string" || !Number.isFinite(wt.start_ms)) {
      continue;
    }
    const subParts = wt.word.split(/\s+/);
    for (const part of subParts) {
      const norm = normalizeSyncToken(part);
      if (norm.length < 2) continue;
      normalizedTimings.push({
        norm,
        bare: stripArabicArticle(norm),
        startMs: Math.max(0, wt.start_ms),
      });
    }
  }

  if (normalizedTimings.length === 0) {
    return itemTexts.map(() => null);
  }
  normalizedTimings.sort((a, b) => a.startMs - b.startMs);

  const results: Array<number | null> = [];
  let cursor = 0;

  for (const text of itemTexts) {
    const tokens = extractSyncTokens(text);
    if (tokens.length === 0) {
      results.push(null);
      continue;
    }

    // Prioritize English technical identifiers & first meaningful token
    const prioritized = [...tokens].sort((a, b) => {
      const aLatin = /^[a-z0-9_]+$/.test(a) ? 0 : 1;
      const bLatin = /^[a-z0-9_]+$/.test(b) ? 0 : 1;
      return aLatin - bLatin;
    });

    let matchedIdx = -1;

    // Pass 1: search forward from current monotonic cursor
    for (let tIdx = cursor; tIdx < normalizedTimings.length; tIdx++) {
      const entry = normalizedTimings[tIdx];
      if (prioritized.some((tok) => tokensMatch(tok, entry.norm, entry.bare))) {
        matchedIdx = tIdx;
        break;
      }
    }

    // Pass 2: if not found ahead (e.g. tutor introduced row earlier), search from start
    if (matchedIdx === -1 && cursor > 0) {
      for (let tIdx = 0; tIdx < cursor; tIdx++) {
        const entry = normalizedTimings[tIdx];
        if (prioritized.some((tok) => tokensMatch(tok, entry.norm, entry.bare))) {
          matchedIdx = tIdx;
          break;
        }
      }
    }

    if (matchedIdx !== -1) {
      results.push(normalizedTimings[matchedIdx].startMs);
      if (matchedIdx >= cursor) {
        cursor = Math.min(normalizedTimings.length, matchedIdx + 1);
      }
    } else {
      results.push(null);
    }
  }

  return results;
}

/**
 * Computes per-annotation spoken trigger timestamps (ms) for pdf_circle / pdf_highlight
 * actions in a single step so multiple annotations fire on cue as each term is spoken
 * instead of simultaneously at t = 0.
 */
function computePdfActionTriggerMsList(
  pdfActions: VisualAction[],
  step: TeachingStep | undefined,
  wordTimings?: WordTiming[]
): Array<number | null> {
  const count = pdfActions.length;
  if (count === 0) return [];
  if (count === 1) return [0];

  const hasTimings = Array.isArray(wordTimings) && wordTimings.length > 0;
  if (!hasTimings) {
    return pdfActions.map(() => null);
  }

  const enTerms = Array.isArray(step?.en_terms)
    ? step!.en_terms.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];

  // Build search hints for each PDF action (prefer explicit action.text, then sequential en_terms)
  const hintTexts = pdfActions.map((action, idx) => {
    const actionText = normalizeBlockText(action.text);
    if (actionText.length > 0) return actionText;
    if (enTerms.length >= count) {
      const start = Math.floor((idx * enTerms.length) / count);
      const end = Math.max(start + 1, Math.floor(((idx + 1) * enTerms.length) / count));
      return enTerms.slice(start, end).join(" ");
    }
    if (idx < enTerms.length) {
      return enTerms[idx];
    }
    return "";
  });

  const matched = computeItemTriggerMsList(hintTexts, wordTimings);

  // Estimate step spoken duration from wordTimings for clean monotonic stagger fallback
  let maxEndMs = 0;
  for (const wt of wordTimings!) {
    if (Number.isFinite(wt.start_ms) && Number.isFinite(wt.duration_ms)) {
      maxEndMs = Math.max(maxEndMs, wt.start_ms + wt.duration_ms);
    } else if (Number.isFinite(wt.start_ms)) {
      maxEndMs = Math.max(maxEndMs, wt.start_ms + 300);
    }
  }
  const staggerSpanMs = maxEndMs > 600 ? Math.min(maxEndMs * 0.65, maxEndMs - 500) : 0;

  return matched.map((triggerMs, idx) => {
    if (triggerMs !== null) {
      return idx === 0 ? Math.min(triggerMs, 650) : triggerMs;
    }
    if (staggerSpanMs > 0) {
      return Math.round((idx / count) * staggerSpanMs);
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Lightweight Multi-Language Syntax Highlighter
// ---------------------------------------------------------------------------
const CODE_KEYWORDS = new Set([
  "def",
  "class",
  "return",
  "try",
  "except",
  "finally",
  "raise",
  "if",
  "elif",
  "else",
  "for",
  "while",
  "in",
  "not",
  "and",
  "or",
  "is",
  "import",
  "from",
  "as",
  "with",
  "pass",
  "break",
  "continue",
  "lambda",
  "yield",
  "async",
  "await",
  "True",
  "False",
  "None",
  "int",
  "float",
  "str",
  "bool",
  "void",
  "double",
  "char",
  "public",
  "private",
  "static",
  "new",
  "catch",
  "throw",
  "const",
  "let",
  "var",
  "function",
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "ORDER",
  "BY",
  "LIMIT",
]);

const CODE_BUILTINS = new Set([
  "print",
  "len",
  "range",
  "input",
  "open",
  "list",
  "dict",
  "set",
  "tuple",
  "type",
  "isinstance",
  "Exception",
  "ValueError",
  "TypeError",
  "ZeroDivisionError",
  "KeyError",
  "IndexError",
  "FileNotFoundError",
  "RuntimeError",
]);

interface CodeToken {
  text: string;
  color: string;
  italic?: boolean;
}

function tokenizeCodeLine(line: string): CodeToken[] {
  if (!line) return [{ text: " ", color: "#F8FAFC" }];

  let codePart = line;
  let commentPart = "";
  const commentMatch = line.match(/(^|\s)(#.*|\/\/.*|--.*)$/);
  if (commentMatch && commentMatch.index !== undefined) {
    const idx = commentMatch.index + commentMatch[1].length;
    codePart = line.slice(0, idx);
    commentPart = line.slice(idx);
  }

  const tokens: CodeToken[] = [];
  const regex =
    /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(codePart)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        text: codePart.slice(lastIndex, match.index),
        color: "#CBD5E1",
      });
    }
    const word = match[0];
    if (
      (word.startsWith("'") && word.endsWith("'")) ||
      (word.startsWith('"') && word.endsWith('"'))
    ) {
      tokens.push({ text: word, color: "#86EFAC" });
    } else if (/^\d/.test(word)) {
      tokens.push({ text: word, color: "#FCD34D" });
    } else if (CODE_KEYWORDS.has(word)) {
      tokens.push({ text: word, color: "#C084FC" });
    } else if (CODE_BUILTINS.has(word)) {
      tokens.push({ text: word, color: "#38BDF8" });
    } else {
      const nextChar = codePart[match.index + word.length];
      tokens.push({
        text: word,
        color: nextChar === "(" ? "#60A5FA" : "#F8FAFC",
      });
    }
    lastIndex = match.index + word.length;
  }

  if (lastIndex < codePart.length) {
    tokens.push({ text: codePart.slice(lastIndex), color: "#CBD5E1" });
  }
  if (commentPart) {
    tokens.push({ text: commentPart, color: "#64748B", italic: true });
  }

  return tokens.length > 0 ? tokens : [{ text: " ", color: "#F8FAFC" }];
}

// ---------------------------------------------------------------------------
// Crisp Skia Path Helpers (Used ONLY for Paper Grid & Clean Dark Code Cards)
// ---------------------------------------------------------------------------
function makePathFromBuilder(
  draw: (builder: {
    moveTo: (x: number, y: number) => unknown;
    lineTo: (x: number, y: number) => unknown;
    quadTo: (x1: number, y1: number, x2: number, y2: number) => unknown;
  }) => void
) {
  if (typeof Skia?.PathBuilder?.Make === "function") {
    const builder = Skia.PathBuilder.Make();
    draw(builder);
    return builder.build();
  }

  const legacyPath = Skia.Path.Make() as unknown as {
    moveTo?: (x: number, y: number) => unknown;
    lineTo?: (x: number, y: number) => unknown;
    quadTo?: (x1: number, y1: number, x2: number, y2: number) => unknown;
  };
  if (typeof legacyPath?.moveTo === "function") {
    draw(
      legacyPath as {
        moveTo: (x: number, y: number) => unknown;
        lineTo: (x: number, y: number) => unknown;
        quadTo: (x1: number, y1: number, x2: number, y2: number) => unknown;
      }
    );
  }
  return legacyPath as ReturnType<typeof Skia.Path.Make>;
}

/** Crisp clockwise rounded-rectangle stroke path kept exclusively for dark wb_code cards */
function buildRoundedRectStrokePath(rect: RectFrame, radius: number) {
  const { x, y, width: w, height: h } = rect;
  if (w <= 0 || h <= 0) return makeEmptySkiaPath();
  const r = Math.min(radius, w / 2, h / 2);

  return makePathFromBuilder((b) => {
    b.moveTo(x + r, y);
    b.lineTo(x + w - r, y);
    b.quadTo(x + w, y, x + w, y + r);
    b.lineTo(x + w, y + h - r);
    b.quadTo(x + w, y + h, x + w - r, y + h);
    b.lineTo(x + r, y + h);
    b.quadTo(x, y + h, x, y + h - r);
    b.lineTo(x, y + r);
    b.quadTo(x, y, x + r, y);
  });
}

// ---------------------------------------------------------------------------
// Pure Geometry Math: Aspect-Ratio Contain & [0-1000] BBox Mapping
// ---------------------------------------------------------------------------
function computeContainRect(
  containerW: number,
  containerH: number,
  contentAspect: number,
  topInset: number,
  bottomInset: number
): RectFrame {
  const usableW = Math.max(0, containerW - 16);
  const usableH = Math.max(0, containerH - topInset - bottomInset);
  if (usableW <= 0 || usableH <= 0 || contentAspect <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const containerAspect = usableW / usableH;
  if (contentAspect > containerAspect) {
    const width = usableW;
    const height = usableW / contentAspect;
    return {
      x: (containerW - width) / 2,
      y: topInset + (usableH - height) / 2,
      width,
      height,
    };
  }
  const height = usableH;
  const width = usableH * contentAspect;
  return {
    x: (containerW - width) / 2,
    y: topInset,
    width,
    height,
  };
}

function mapBboxToScreenRect(bbox: BoundingBox, pdfDrawRect: RectFrame): RectFrame {
  const ymin = Math.max(0, Math.min(1000, Math.min(bbox.ymin, bbox.ymax)));
  const ymax = Math.max(0, Math.min(1000, Math.max(bbox.ymin, bbox.ymax)));
  const xmin = Math.max(0, Math.min(1000, Math.min(bbox.xmin, bbox.xmax)));
  const xmax = Math.max(0, Math.min(1000, Math.max(bbox.xmin, bbox.xmax)));

  return {
    x: pdfDrawRect.x + (xmin / 1000) * pdfDrawRect.width,
    y: pdfDrawRect.y + (ymin / 1000) * pdfDrawRect.height,
    width: Math.max(4, ((xmax - xmin) / 1000) * pdfDrawRect.width),
    height: Math.max(4, ((ymax - ymin) / 1000) * pdfDrawRect.height),
  };
}

/**
 * Maps a [0-1000] bbox inside rendered pdfDrawRect to a symmetrically centered
 * oval frame (cy = imgY + ((ymin + ymax)/2000)*imgH, padX = 14, padY = 10).
 */
function mapPdfCircleRect(bbox: BoundingBox, pdfDrawRect: RectFrame): RectFrame {
  const ymin = Math.max(0, Math.min(1000, Math.min(bbox.ymin, bbox.ymax)));
  const ymax = Math.max(0, Math.min(1000, Math.max(bbox.ymin, bbox.ymax)));
  const xmin = Math.max(0, Math.min(1000, Math.min(bbox.xmin, bbox.xmax)));
  const xmax = Math.max(0, Math.min(1000, Math.max(bbox.xmin, bbox.xmax)));

  const cx = pdfDrawRect.x + ((xmin + xmax) / 2000) * pdfDrawRect.width;
  const cy = pdfDrawRect.y + ((ymin + ymax) / 2000) * pdfDrawRect.height;
  const rawW = Math.max(12, ((xmax - xmin) / 1000) * pdfDrawRect.width);
  const rawH = Math.max(12, ((ymax - ymin) / 1000) * pdfDrawRect.height);

  const padX = 14;
  const padY = 10;
  const width = rawW + padX * 2;
  const height = rawH + padY * 2;

  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  };
}

/**
 * Maps a [0-1000] bbox inside rendered pdfDrawRect to a vertically centered,
 * baseline-aligned translucent marker highlight rect.
 */
function mapPdfHighlightRect(bbox: BoundingBox, pdfDrawRect: RectFrame): RectFrame {
  const ymin = Math.max(0, Math.min(1000, Math.min(bbox.ymin, bbox.ymax)));
  const ymax = Math.max(0, Math.min(1000, Math.max(bbox.ymin, bbox.ymax)));
  const xmin = Math.max(0, Math.min(1000, Math.min(bbox.xmin, bbox.xmax)));
  const xmax = Math.max(0, Math.min(1000, Math.max(bbox.xmin, bbox.xmax)));

  const cx = pdfDrawRect.x + ((xmin + xmax) / 2000) * pdfDrawRect.width;
  const cy = pdfDrawRect.y + ((ymin + ymax) / 2000) * pdfDrawRect.height;
  const rawW = Math.max(8, ((xmax - xmin) / 1000) * pdfDrawRect.width);
  const rawH = Math.max(10, ((ymax - ymin) / 1000) * pdfDrawRect.height);

  const width = rawW + 8;
  const height = Math.max(14, rawH * 1.08);

  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  };
}

// ---------------------------------------------------------------------------
// Cumulative Multi-Band Infinite Whiteboard Builder
// ---------------------------------------------------------------------------
interface ResolvedAction {
  key: string;
  action: VisualAction;
  stepIdx: number;
  isCurrentStep: boolean;
}

interface WhiteboardBlock {
  blockId: string;
  bandIndex: number;
  slot: WhiteboardSlot;
  createdAtStepIdx: number;
  lastUpdatedStepIdx: number;
  items: ResolvedAction[];
  connectFromBlockId?: string;
}

interface CumulativeBoardLayout {
  blockRects: Map<string, RectFrame>;
  boardWidth: number;
  boardHeight: number;
}

function resolveWhiteboardBlocks(
  steps: TeachingStep[],
  currentStepIndex: number
): WhiteboardBlock[] {
  const safeSteps = Array.isArray(steps) ? steps : [];
  let blocks: WhiteboardBlock[] = [];
  let currentBand = 0;
  let bandSlots = new Map<WhiteboardSlot, WhiteboardBlock>();
  let latestBySlot = new Map<WhiteboardSlot, WhiteboardBlock>();

  const resetBoard = () => {
    blocks = [];
    currentBand = 0;
    bandSlots = new Map();
    latestBySlot = new Map();
  };

  for (let i = 0; i <= currentStepIndex; i++) {
    const step = safeSteps[i];
    if (!step) continue;

    if (step.mode !== "whiteboard") {
      resetBoard();
      continue;
    }

    const isCurrent = i === currentStepIndex;
    const actions = Array.isArray(step.actions) ? step.actions : [];

    for (let j = 0; j < actions.length; j++) {
      const action = actions[j];
      if (!action) continue;
      if (action.type === "clear_board") {
        resetBoard();
        continue;
      }

      const rawSlot: WhiteboardSlot | undefined =
        action.slot ??
        (action.type === "wb_table"
          ? "main_top"
          : action.type === "wb_note"
          ? "bottom_summary"
          : undefined);
      if (!rawSlot) continue;

      // Always promote wb_heading and wb_table to full contentWidth so headings & tables
      // never crush inside narrow left_col / right_col half-width columns
      let targetSlot: WhiteboardSlot = rawSlot;
      if (
        action.type === "wb_heading" &&
        (rawSlot === "left_col" || rawSlot === "right_col")
      ) {
        targetSlot = "header";
      } else if (
        action.type === "wb_table" &&
        (rawSlot === "left_col" || rawSlot === "right_col")
      ) {
        targetSlot = bandSlots.has("main_top") ? "full_canvas" : "main_top";
      }

      const resolvedItem: ResolvedAction = {
        key: `s${step.step_id}-i${i}-a${j}-${action.type}-${targetSlot}`,
        action,
        stepIdx: i,
        isCurrentStep: isCurrent,
      };

      const existingInBand = bandSlots.get(targetSlot);

      // Stack bullets cleanly inside the same slot if the current band's slot already holds bullets
      if (
        action.type === "wb_bullet" &&
        existingInBand &&
        existingInBand.items[0]?.action.type === "wb_bullet"
      ) {
        existingInBand.items.push(resolvedItem);
        existingInBand.lastUpdatedStepIdx = i;
        continue;
      }

      // If this slot is already occupied in the current band, open a new band below
      // instead of overwriting earlier steps' cards on the infinite canvas
      if (existingInBand) {
        currentBand += 1;
        bandSlots = new Map();
      }

      const connectFromBlock = action.connect_from_slot
        ? latestBySlot.get(action.connect_from_slot)
        : undefined;

      const newBlock: WhiteboardBlock = {
        blockId: `b${currentBand}-${targetSlot}-s${step.step_id}-a${j}`,
        bandIndex: currentBand,
        slot: targetSlot,
        createdAtStepIdx: i,
        lastUpdatedStepIdx: i,
        items: [resolvedItem],
        connectFromBlockId: connectFromBlock?.blockId,
      };

      blocks.push(newBlock);
      bandSlots.set(targetSlot, newBlock);
      latestBySlot.set(targetSlot, newBlock);
      if (targetSlot !== rawSlot) {
        latestBySlot.set(rawSlot, newBlock);
      }
    }
  }

  return blocks;
}

function estimateWrappedLines(text: string, charsPerLine: number): number {
  const safeChars = Math.max(8, Math.floor(charsPerLine));
  const paragraphs = text.split("\n");
  let total = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      total += 1;
      continue;
    }
    // Simulate word-boundary wrapping so long words moving to a new line never under-estimate height
    const words = trimmed.split(/\s+/);
    let linesInPara = 1;
    let currentLen = 0;

    for (const word of words) {
      if (word.length > safeChars) {
        if (currentLen > 0) {
          linesInPara += 1;
          currentLen = 0;
        }
        const extra = Math.ceil(word.length / safeChars);
        linesInPara += extra - 1;
        currentLen = word.length % safeChars || safeChars;
      } else if (currentLen === 0) {
        currentLen = word.length;
      } else if (currentLen + 1 + word.length <= safeChars) {
        currentLen += 1 + word.length;
      } else {
        linesInPara += 1;
        currentLen = word.length;
      }
    }
    total += linesInPara;
  }

  return Math.max(1, total);
}

// ---------------------------------------------------------------------------
// Adaptive Table Metrics (Shared 1:1 by Layout Estimation & Skia/RN Renderer)
// ---------------------------------------------------------------------------
interface TableLayoutMetrics {
  headers: string[];
  rows: string[][];
  colCount: number;
  colWidths: number[];
  tableWidth: number;
  headerHeight: number;
  rowHeights: number[];
  gridHeight: number;
  needsHorizontalScroll: boolean;
  totalSlotHeight: number;
}

function computeTableMetrics(
  action: VisualAction,
  availableWidth: number
): TableLayoutMetrics {
  const rawHeaders = Array.isArray(action.headers)
    ? action.headers.map((h) => normalizeBlockText(h))
    : [];
  const headers = rawHeaders.length > 0 ? rawHeaders : ["Item", "Details"];
  const colCount = Math.max(1, headers.length);

  const rawRows = Array.isArray(action.rows) ? action.rows : [];
  const rows: string[][] = rawRows
    .filter((r) => Array.isArray(r) && r.some((cell) => normalizeBlockText(cell).length > 0))
    .map((row) => {
      const normalized = row.slice(0, colCount).map((cell) => normalizeBlockText(cell));
      while (normalized.length < colCount) {
        normalized.push("");
      }
      return normalized;
    });

  // Leave TABLE_CANVAS_BLEED (8px) on left & right so corner overshoots & double-strokes never clip
  const innerAvailW = Math.max(120, availableWidth - TABLE_CANVAS_BLEED * 2);
  const minTotalWidth = colCount * MIN_TABLE_COL_WIDTH;
  const needsHorizontalScroll = minTotalWidth > innerAvailW;
  const tableWidth = needsHorizontalScroll ? minTotalWidth : innerAvailW;
  const colWidth = tableWidth / colCount;
  const colWidths = Array.from({ length: colCount }, () => colWidth);

  const headerCharsPerLine = Math.max(8, Math.floor((colWidth - 16) / 8.2));
  let maxHeaderLines = 1;
  for (const h of headers) {
    maxHeaderLines = Math.max(
      maxHeaderLines,
      estimateWrappedLines(h || " ", headerCharsPerLine)
    );
  }
  // Includes +8px cross-platform safe bottom text buffer so Android/iOS cells never clip
  const headerHeight = Math.max(46, 26 + maxHeaderLines * 20);

  const cellCharsPerLine = Math.max(8, Math.floor((colWidth - 16) / 7.8));
  const rowHeights: number[] = rows.map((row) => {
    let maxLines = 1;
    for (const cell of row) {
      maxLines = Math.max(
        maxLines,
        estimateWrappedLines(cell || " ", cellCharsPerLine)
      );
    }
    return Math.max(44, 26 + maxLines * 19);
  });

  const gridHeight =
    headerHeight + rowHeights.reduce((sum, h) => sum + h, 0);
  // Extra bleed (TABLE_CANVAS_BLEED * 2) + bottom scroll hint clearance when horizontally scrollable
  const totalSlotHeight =
    gridHeight + TABLE_CANVAS_BLEED * 2 + (needsHorizontalScroll ? 24 : 4);

  return {
    headers,
    rows,
    colCount,
    colWidths,
    tableWidth,
    headerHeight,
    rowHeights,
    gridHeight,
    needsHorizontalScroll,
    totalSlotHeight,
  };
}

function estimateSlotHeight(
  items: ResolvedAction[] | undefined,
  slotWidth: number,
  isCompactColumn = false
): number {
  if (!items || items.length === 0 || slotWidth <= 0) return 0;
  const primary = items[0].action;

  if (primary.type === "wb_table") {
    return computeTableMetrics(primary, slotWidth).totalSlotHeight;
  }

  if (primary.type === "wb_note") {
    const clean = normalizeBlockText(primary.text);
    const charsPerLine = Math.max(11, Math.floor((slotWidth - 48) / 8.2));
    const lines = estimateWrappedLines(clean, charsPerLine);
    // Accounts for NOTE badge row + top/bottom padding + +8px safe cross-platform text buffer
    return Math.max(100, 70 + lines * 22);
  }

  if (primary.type === "wb_heading") {
    const clean = normalizeBlockText(primary.text);
    const iconReserve = primary.icon ? 44 : 0;
    const charsPerLine = Math.max(
      12,
      Math.floor((slotWidth - 32 - iconReserve) / 10.2)
    );
    const lines = estimateWrappedLines(clean, charsPerLine);
    // Generous vertical padding + +8px safe buffer above the rough Skia underline
    return Math.max(74, 52 + lines * 26);
  }

  if (primary.type === "wb_code") {
    const rawCode = primary.code || primary.text || "";
    const clean = normalizeBlockText(rawCode);
    const gutterAndPad = isCompactColumn ? 34 : 50;
    const codeInnerW = Math.max(108, slotWidth - gutterAndPad);
    const charWidth = isCompactColumn ? 6.8 : 7.4;
    const rowHeight = isCompactColumn ? 18.5 : 21.5;
    const wrappedLines = estimateWrappedLines(clean || " ", codeInnerW / charWidth);
    // 32px header + 42px vertical padding + per-line height
    return Math.max(132, 32 + 42 + wrappedLines * rowHeight);
  }

  if (primary.type === "wb_equation") {
    const clean = normalizeBlockText(primary.text);
    const charsPerLine = Math.max(12, Math.floor((slotWidth - 28) / 9.5));
    const lines = estimateWrappedLines(clean, charsPerLine);
    return Math.max(92, 56 + lines * 26);
  }

  if (primary.type === "wb_flow_card") {
    const clean = normalizeBlockText(primary.text);
    const iconReserve = primary.icon ? (isCompactColumn ? 30 : 38) : 0;
    const charsPerLine = Math.max(
      10,
      Math.floor((slotWidth - 28 - iconReserve) / 8.5)
    );
    const lines = estimateWrappedLines(clean, charsPerLine);
    return Math.max(112, 64 + lines * 23);
  }

  // Stacked wb_bullet items with conservative word-wrap estimate & +8px safe bottom text buffer
  const bulletCharsPerLine = Math.max(11, Math.floor((slotWidth - 46) / 8.5));
  let totalH = 58;
  for (const item of items) {
    const clean = normalizeBlockText(item.action.text);
    const lines = estimateWrappedLines(clean, bulletCharsPerLine);
    totalH += lines * 22 + 10;
  }
  return Math.max(112, totalH);
}

function computeCumulativeWhiteboardLayout(
  viewportW: number,
  viewportH: number,
  blocks: WhiteboardBlock[],
  topInset: number,
  bottomInset: number,
  isTablet: boolean
): CumulativeBoardLayout {
  const rowGap = isTablet ? 20 : 18;
  const bandGap = isTablet ? 28 : 24;
  const colGap = isTablet ? 32 : 28; // Clean channel for horizontal connector arrows

  const boardWidth = Math.max(viewportW, 340);
  const innerW = Math.max(0, boardWidth - 32);
  // Constrain active whiteboard content to 860px on tablets while keeping full-bleed paper grid
  const contentWidth = Math.min(innerW, 860);
  const padX = Math.max(16, (boardWidth - contentWidth) / 2);
  const halfW = Math.max(0, (contentWidth - colGap) / 2);

  const blockRects = new Map<string, RectFrame>();
  const bandsMap = new Map<number, Map<WhiteboardSlot, WhiteboardBlock>>();
  for (const block of blocks) {
    let slotMap = bandsMap.get(block.bandIndex);
    if (!slotMap) {
      slotMap = new Map();
      bandsMap.set(block.bandIndex, slotMap);
    }
    slotMap.set(block.slot, block);
  }

  const sortedBands = Array.from(bandsMap.keys()).sort((a, b) => a - b);
  let cursorY = topInset + 10;

  for (let bIdx = 0; bIdx < sortedBands.length; bIdx++) {
    const slotMap = bandsMap.get(sortedBands[bIdx])!;
    const headerBlock = slotMap.get("header");
    const mainTopBlock = slotMap.get("main_top");
    const leftBlock = slotMap.get("left_col");
    const rightBlock = slotMap.get("right_col");
    const bottomBlock = slotMap.get("bottom_summary");
    const fullBlock = slotMap.get("full_canvas");

    if (headerBlock) {
      const h = estimateSlotHeight(headerBlock.items, contentWidth);
      blockRects.set(headerBlock.blockId, {
        x: padX,
        y: cursorY,
        width: contentWidth,
        height: h,
      });
      cursorY += h + rowGap;
    }

    if (mainTopBlock) {
      const h = estimateSlotHeight(mainTopBlock.items, contentWidth);
      blockRects.set(mainTopBlock.blockId, {
        x: padX,
        y: cursorY,
        width: contentWidth,
        height: h,
      });
      cursorY += h + rowGap;
    }

    if (leftBlock || rightBlock) {
      const leftH = leftBlock
        ? estimateSlotHeight(leftBlock.items, halfW, true)
        : 0;
      const rightH = rightBlock
        ? estimateSlotHeight(rightBlock.items, halfW, true)
        : 0;
      const colsH = Math.max(leftH, rightH);

      if (leftBlock) {
        blockRects.set(leftBlock.blockId, {
          x: padX,
          y: cursorY,
          width: halfW,
          height: colsH,
        });
      }
      if (rightBlock) {
        blockRects.set(rightBlock.blockId, {
          x: padX + halfW + colGap,
          y: cursorY,
          width: halfW,
          height: colsH,
        });
      }
      cursorY += colsH + rowGap;
    }

    if (bottomBlock) {
      const h = estimateSlotHeight(bottomBlock.items, contentWidth);
      blockRects.set(bottomBlock.blockId, {
        x: padX,
        y: cursorY,
        width: contentWidth,
        height: h,
      });
      cursorY += h + rowGap;
    }

    if (fullBlock) {
      const h = estimateSlotHeight(fullBlock.items, contentWidth);
      blockRects.set(fullBlock.blockId, {
        x: padX,
        y: cursorY,
        width: contentWidth,
        height: h,
      });
      cursorY += h + rowGap;
    }

    if (bIdx < sortedBands.length - 1) {
      cursorY += bandGap - rowGap;
    }
  }

  const boardHeight = Math.max(viewportH, cursorY + bottomInset + 36);
  return { blockRects, boardWidth, boardHeight };
}

// ---------------------------------------------------------------------------
// Memoized Animated Skia Primitives (ZERO Path Rebuilds on 50ms Audio Ticks)
// ---------------------------------------------------------------------------
const AnimatedHighlightRect: React.FC<{
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  triggered: boolean;
  instantComplete: boolean;
  resetKey: string;
}> = React.memo(
  ({ x, y, width, height, color, triggered, instantComplete, resetKey }) => {
    const targetWidth = useSharedValue(width);
    const strokeProgress = useSharedValue(instantComplete ? 1 : 0);

    useEffect(() => {
      targetWidth.value = width;
    }, [width, targetWidth]);

    useEffect(() => {
      strokeProgress.value = instantComplete ? 1 : 0;
    }, [resetKey, instantComplete, strokeProgress]);

    useEffect(() => {
      if (instantComplete) {
        strokeProgress.value = 1;
        return;
      }
      if (triggered) {
        strokeProgress.value = withTiming(1, {
          duration: PDF_STROKE_DRAW_MS,
          easing: Easing.out(Easing.cubic),
        });
      } else {
        strokeProgress.value = 0;
      }
    }, [triggered, instantComplete, strokeProgress]);

    const animatedWidth = useDerivedValue(
      () => targetWidth.value * strokeProgress.value
    );

    return (
      <RoundedRect
        x={x}
        y={y}
        width={animatedWidth}
        height={height}
        r={6}
        color={color}
      />
    );
  }
);

const AnimatedCircleAnnotation: React.FC<{
  x: number;
  y: number;
  width: number;
  height: number;
  seed: number;
  strokeColor: string;
  triggered: boolean;
  instantComplete: boolean;
  resetKey: string;
}> = React.memo(
  ({
    x,
    y,
    width,
    height,
    seed,
    strokeColor,
    triggered,
    instantComplete,
    resetKey,
  }) => {
    const ovalPath = useMemo(
      () => createRoughCirclePath({ x, y, width, height }, seed, 1),
      [x, y, width, height, seed]
    );
    const strokeProgress = useSharedValue(instantComplete ? 1 : 0);

    useEffect(() => {
      strokeProgress.value = instantComplete ? 1 : 0;
    }, [resetKey, instantComplete, strokeProgress]);

    useEffect(() => {
      if (instantComplete) {
        strokeProgress.value = 1;
        return;
      }
      if (triggered) {
        strokeProgress.value = withTiming(1, {
          duration: PDF_STROKE_DRAW_MS,
          easing: Easing.out(Easing.cubic),
        });
      } else {
        strokeProgress.value = 0;
      }
    }, [triggered, instantComplete, strokeProgress]);

    return (
      <Path
        path={ovalPath}
        style="stroke"
        strokeWidth={3.5}
        strokeCap="round"
        strokeJoin="round"
        color={strokeColor}
        start={0}
        end={strokeProgress}
      />
    );
  }
);

const AnimatedCardFrame: React.FC<{
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  seed: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  isCode: boolean;
  isHeading: boolean;
  isNote: boolean;
  animate: boolean;
  borderProgress: SharedValue<number>;
}> = React.memo(
  ({
    x,
    y,
    width,
    height,
    radius,
    seed,
    fillColor,
    strokeColor,
    strokeWidth,
    isCode,
    isHeading,
    isNote,
    animate,
    borderProgress,
  }) => {
    const borderPath = useMemo(() => {
      const rect = { x, y, width, height };
      if (isCode) {
        return buildRoundedRectStrokePath(rect, radius);
      }
      return createRoughRectPath(rect, radius, seed, isNote ? 0.85 : 1);
    }, [x, y, width, height, radius, seed, isCode, isNote]);

    const underlinePath = useMemo(() => {
      if (!isHeading) return makeEmptySkiaPath();
      return createRoughUnderlinePath(
        { x, y, width, height },
        (seed ^ 0x51f15e) >>> 0,
        1
      );
    }, [x, y, width, height, seed, isHeading]);

    const noteAccentBarPath = useMemo(() => {
      if (!isNote) return makeEmptySkiaPath();
      return createRoughRectPath(
        {
          x: x + 4,
          y: y + 8,
          width: 4.2,
          height: Math.max(12, height - 16),
        },
        2,
        (seed ^ 0x9e3779b9) >>> 0,
        0.65
      );
    }, [x, y, height, seed, isNote]);

    const fillOpacity = useDerivedValue(() =>
      animate ? Math.min(1, borderProgress.value * 1.15) : 1
    );

    return (
      <>
        <RoundedRect
          x={x}
          y={y + 3}
          width={width}
          height={height}
          r={radius}
          color="rgba(15, 23, 42, 0.06)"
          opacity={fillOpacity}
        />
        <RoundedRect
          x={x}
          y={y}
          width={width}
          height={height}
          r={radius}
          color={fillColor}
          opacity={fillOpacity}
        />
        <Path
          path={borderPath}
          style="stroke"
          strokeWidth={isNote ? 1.2 : strokeWidth}
          strokeCap="round"
          strokeJoin="round"
          color={strokeColor}
          opacity={isNote ? 0.45 : 1}
          start={0}
          end={animate ? borderProgress : 1}
        />
        {isNote && (
          <Path
            path={noteAccentBarPath}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            strokeJoin="round"
            color={strokeColor}
            start={0}
            end={animate ? borderProgress : 1}
          />
        )}
        {isHeading && (
          <Path
            path={underlinePath}
            style="stroke"
            strokeWidth={2.35}
            strokeCap="round"
            strokeJoin="round"
            color={strokeColor}
            start={0}
            end={animate ? borderProgress : 1}
          />
        )}
      </>
    );
  }
);

const AnimatedSketchIcon: React.FC<{
  icon: SketchIcon;
  cx: number;
  cy: number;
  size: number;
  seed: number;
  strokeColor: string;
  animate: boolean;
  progress: SharedValue<number>;
}> = React.memo(({ icon, cx, cy, size, seed, strokeColor, animate, progress }) => {
  const iconPath = useMemo(
    () => createSketchIconPath(icon, cx, cy, size, seed),
    [icon, cx, cy, size, seed]
  );

  return (
    <Path
      path={iconPath}
      style="stroke"
      strokeWidth={1.9}
      strokeCap="round"
      strokeJoin="round"
      color={strokeColor}
      start={0}
      end={animate ? progress : 1}
    />
  );
});

const AnimatedArrowPath: React.FC<{
  fromX: number;
  fromY: number;
  fromW: number;
  fromH: number;
  toX: number;
  toY: number;
  toW: number;
  toH: number;
  seed: number;
  strokeColor: string;
  animate: boolean;
  progress: SharedValue<number>;
}> = React.memo(
  ({
    fromX,
    fromY,
    fromW,
    fromH,
    toX,
    toY,
    toW,
    toH,
    seed,
    strokeColor,
    animate,
    progress,
  }) => {
    const arrowPath = useMemo(
      () =>
        createRoughArrowPath(
          { x: fromX, y: fromY, width: fromW, height: fromH },
          { x: toX, y: toY, width: toW, height: toH },
          seed,
          1
        ),
      [fromX, fromY, fromW, fromH, toX, toY, toW, toH, seed]
    );

    return (
      <Path
        path={arrowPath}
        style="stroke"
        strokeWidth={2.5}
        strokeCap="round"
        strokeJoin="round"
        color={strokeColor}
        start={0}
        end={animate ? progress : 1}
      />
    );
  }
);

const AnimatedTableGrid: React.FC<{
  tableWidth: number;
  gridHeight: number;
  headerHeight: number;
  colWidthsKey: string;
  rowHeightsKey: string;
  colWidths: number[];
  rowHeights: number[];
  seed: number;
  fillColor: string;
  headerBgColor: string;
  strokeColor: string;
  animate: boolean;
  progress: SharedValue<number>;
}> = React.memo(
  ({
    tableWidth,
    gridHeight,
    headerHeight,
    colWidthsKey,
    rowHeightsKey,
    colWidths,
    rowHeights,
    seed,
    fillColor,
    headerBgColor,
    strokeColor,
    animate,
    progress,
  }) => {
    const gridPath = useMemo(
      () =>
        createRoughTableGridPath(
          {
            x: TABLE_CANVAS_BLEED,
            y: TABLE_CANVAS_BLEED,
            width: tableWidth,
            height: gridHeight,
          },
          colWidths,
          headerHeight,
          rowHeights,
          seed,
          1.0
        ),
      // colWidthsKey & rowHeightsKey deterministically represent colWidths & rowHeights
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [tableWidth, gridHeight, headerHeight, colWidthsKey, rowHeightsKey, seed]
    );

    const fillOpacity = useDerivedValue(() =>
      animate ? Math.min(1, progress.value * 1.2) : 1
    );

    return (
      <Canvas
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: tableWidth + TABLE_CANVAS_BLEED * 2,
          height: gridHeight + TABLE_CANVAS_BLEED * 2,
        }}
        pointerEvents="none"
      >
        <RoundedRect
          x={TABLE_CANVAS_BLEED}
          y={TABLE_CANVAS_BLEED + 3}
          width={tableWidth}
          height={gridHeight}
          r={10}
          color="rgba(15, 23, 42, 0.05)"
          opacity={fillOpacity}
        />
        <RoundedRect
          x={TABLE_CANVAS_BLEED}
          y={TABLE_CANVAS_BLEED}
          width={tableWidth}
          height={gridHeight}
          r={10}
          color={fillColor}
          opacity={fillOpacity}
        />
        <RoundedRect
          x={TABLE_CANVAS_BLEED}
          y={TABLE_CANVAS_BLEED}
          width={tableWidth}
          height={headerHeight}
          r={10}
          color={headerBgColor}
          opacity={fillOpacity}
        />
        <Path
          path={gridPath}
          style="stroke"
          strokeWidth={1.65}
          strokeCap="round"
          strokeJoin="round"
          color={strokeColor}
          start={0}
          end={animate ? progress : 1}
        />
      </Canvas>
    );
  }
);

// ---------------------------------------------------------------------------
// Progressive RN Table View (Adaptive Scroll + Rough Skia Grid + WordBoundary Sync)
// ---------------------------------------------------------------------------
const TableBlockView: React.FC<{
  blockId: string;
  action: VisualAction;
  slotWidth: number;
  isCurrentStep: boolean;
  stepProgress: number;
  currentTimeMs?: number;
  wordTimings?: WordTiming[];
  isPlaying: boolean;
  tableGridProgress: SharedValue<number>;
}> = ({
  blockId,
  action,
  slotWidth,
  isCurrentStep,
  stepProgress,
  currentTimeMs,
  wordTimings,
  isPlaying,
  tableGridProgress,
}) => {
  const token = getColorToken(action.color);
  const metrics = useMemo(
    () => computeTableMetrics(action, slotWidth),
    [action, slotWidth]
  );

  const colWidthsKey = useMemo(
    () => metrics.colWidths.map((w) => w.toFixed(1)).join(","),
    [metrics.colWidths]
  );
  const rowHeightsKey = useMemo(
    () => metrics.rowHeights.map((h) => h.toFixed(1)).join(","),
    [metrics.rowHeights]
  );
  const tableSeed = useMemo(() => hashSeed(`table-${blockId}`), [blockId]);

  // Precompute spoken trigger start_ms for each row once when action or wordTimings changes
  const rowTriggerMs = useMemo(() => {
    const rowTexts = metrics.rows.map((r) => r.join(" "));
    return computeItemTriggerMsList(rowTexts, wordTimings);
  }, [metrics.rows, wordTimings]);

  const clampedStep = clamp01(stepProgress);
  const canUseWordTiming =
    isCurrentStep &&
    typeof currentTimeMs === "number" &&
    Number.isFinite(currentTimeMs) &&
    Array.isArray(wordTimings) &&
    wordTimings.length > 0 &&
    (currentTimeMs > 0 || clampedStep <= 0.05);

  const headerOpacity = !isCurrentStep
    ? 1
    : clampedStep >= 0.995
    ? 1
    : clamp01((clampedStep - 0.02) / 0.14);

  const rowCount = Math.max(1, metrics.rows.length);

  const getRowRevealRatio = (rowIdx: number): number => {
    if (!isCurrentStep || clampedStep >= 0.995) return 1;
    const triggerMs = rowTriggerMs[rowIdx];
    if (canUseWordTiming && triggerMs !== null) {
      // +150ms leading edge so table rows appear right on or slightly ahead of speech
      const syncedTimeMs = (currentTimeMs as number) + WORD_SYNC_LEAD_MS;
      if (clampedStep >= 0.94) return 1;
      if (syncedTimeMs < triggerMs) return 0;
      return clamp01((syncedTimeMs - triggerMs) / WORD_SYNC_REVEAL_WINDOW_MS);
    }
    // Proportional stepProgress fallback (0.12 -> 0.86 across all rows)
    const start = 0.12 + (rowIdx / rowCount) * 0.68;
    const windowSpan = Math.max(0.1, 0.68 / rowCount);
    return clamp01((clampedStep - start) / windowSpan);
  };

  const tableInner = (
    <View
      style={{
        width: metrics.tableWidth + TABLE_CANVAS_BLEED * 2,
        height: metrics.gridHeight + TABLE_CANVAS_BLEED * 2,
      }}
    >
      <AnimatedTableGrid
        tableWidth={metrics.tableWidth}
        gridHeight={metrics.gridHeight}
        headerHeight={metrics.headerHeight}
        colWidthsKey={colWidthsKey}
        rowHeightsKey={rowHeightsKey}
        colWidths={metrics.colWidths}
        rowHeights={metrics.rowHeights}
        seed={tableSeed}
        fillColor="#FFFFFF"
        headerBgColor={token.badgeBg}
        strokeColor={token.stroke}
        animate={isCurrentStep}
        progress={tableGridProgress}
      />

      {/* RN Table Text Overlay aligned 1:1 with Skia Rough Table Grid */}
      <View
        style={{
          position: "absolute",
          left: TABLE_CANVAS_BLEED,
          top: TABLE_CANVAS_BLEED,
          width: metrics.tableWidth,
          height: metrics.gridHeight,
        }}
      >
        {/* Header Row */}
        <View
          style={[
            styles.tableRow,
            {
              height: metrics.headerHeight,
              opacity: headerOpacity,
            },
          ]}
        >
          {metrics.headers.map((header, cIdx) => (
            <View
              key={`th-${cIdx}`}
              style={[
                styles.tableCell,
                { width: metrics.colWidths[cIdx] },
              ]}
            >
              <Text
                style={[styles.tableHeaderText, { color: token.text }]}
              >
                {header}
              </Text>
            </View>
          ))}
        </View>

        {/* Data Rows (Progressive Reveal via WordBoundary Sync or Step Progress) */}
        {metrics.rows.map((row, rIdx) => {
          const ratio = getRowRevealRatio(rIdx);
          const rowOpacity = ratio <= 0 ? 0 : Math.min(1, ratio * 1.45);
          const isRowTyping = isCurrentStep && isPlaying && ratio > 0 && ratio < 0.995;

          return (
            <View
              key={`tr-${rIdx}`}
              style={[
                styles.tableRow,
                {
                  height: metrics.rowHeights[rIdx],
                  opacity: rowOpacity,
                  backgroundColor:
                    rIdx % 2 === 1 ? "rgba(15, 23, 42, 0.024)" : "transparent",
                },
              ]}
            >
              {row.map((cell, cIdx) => {
                const visibleCell =
                  ratio >= 0.995
                    ? cell
                    : cell.slice(0, Math.max(0, Math.round(cell.length * ratio)));
                const showCellCursor =
                  isRowTyping && cIdx === row.length - 1 && visibleCell.length > 0;

                return (
                  <View
                    key={`td-${rIdx}-${cIdx}`}
                    style={[
                      styles.tableCell,
                      { width: metrics.colWidths[cIdx] },
                    ]}
                  >
                    <Text
                      style={[
                        styles.tableCellText,
                        cIdx === 0 && styles.tableFirstColText,
                        { color: cIdx === 0 ? token.text : "#1E293B" },
                      ]}
                    >
                      {visibleCell}
                      {showCellCursor && (
                        <Text style={{ color: token.stroke }}>▍</Text>
                      )}
                    </Text>
                  </View>
                );
              })}
            </View>
          );
        })}
      </View>
    </View>
  );

  if (metrics.needsHorizontalScroll) {
    return (
      <View style={styles.tableWrapper}>
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
          directionalLockEnabled
          contentContainerStyle={styles.tableScrollContent}
        >
          {tableInner}
        </ScrollView>
        <Text style={styles.tableScrollHintText}>
          ↔ Swipe table horizontally
        </Text>
      </View>
    );
  }

  return <View style={styles.tableWrapperCentered}>{tableInner}</View>;
};

// ---------------------------------------------------------------------------
// Progressive RN Typewriter & Live Syntax-Highlighted Code Block
// ---------------------------------------------------------------------------
const CodeBlockView: React.FC<{
  action: VisualAction;
  revealRatio: number;
  showCursor: boolean;
  isCompact: boolean;
}> = ({ action, revealRatio, showCursor, isCompact }) => {
  const rawCode = action.code || action.text || "";
  const normalized = normalizeBlockText(rawCode);
  const fullLines = normalized ? normalized.split("\n") : ["# (no code provided)"];
  const highlighted = new Set(action.highlight_lines ?? []);
  const token = getColorToken(action.color);

  const totalChars = useMemo(
    () => fullLines.reduce((sum, l) => sum + Math.max(1, l.length), 0),
    [fullLines]
  );

  const visibleBudget =
    revealRatio >= 0.995
      ? totalChars
      : Math.floor(totalChars * clamp01(revealRatio));

  // Slice characters sequentially across lines so code types out live from line 1 downward
  let remaining = visibleBudget;
  const visibleRows: Array<{
    lineNum: number;
    text: string;
    isTypingTip: boolean;
  }> = [];

  for (let idx = 0; idx < fullLines.length; idx++) {
    const line = fullLines[idx];
    const lineCost = Math.max(1, line.length);
    if (remaining <= 0 && revealRatio < 0.995) {
      break;
    }
    if (remaining >= lineCost || revealRatio >= 0.995) {
      remaining -= lineCost;
      const isLastVisible =
        showCursor &&
        revealRatio < 0.995 &&
        (remaining <= 0 || idx === fullLines.length - 1);
      visibleRows.push({
        lineNum: idx + 1,
        text: line,
        isTypingTip: isLastVisible,
      });
    } else {
      visibleRows.push({
        lineNum: idx + 1,
        text: line.slice(0, remaining),
        isTypingTip: showCursor,
      });
      remaining = 0;
      break;
    }
  }

  return (
    <View style={styles.codeContainer}>
      <View style={styles.codeHeader}>
        <View style={styles.codeDotsRow}>
          <View style={[styles.codeDot, { backgroundColor: "#F87171" }]} />
          <View style={[styles.codeDot, { backgroundColor: "#FBBF24" }]} />
          <View style={[styles.codeDot, { backgroundColor: "#34D399" }]} />
        </View>
        <Text style={styles.codeLangBadge}>
          {(action.code_lang ?? "code").toUpperCase()}
        </Text>
        <Text style={styles.codeLineCount}>
          {fullLines.length} {fullLines.length === 1 ? "line" : "lines"}
        </Text>
      </View>

      <View style={[styles.codeBody, isCompact && styles.codeBodyCompact]}>
        {visibleRows.map((row) => {
          const isHighlighted = highlighted.has(row.lineNum);
          const spans = tokenizeCodeLine(row.text);
          return (
            <View
              key={row.lineNum}
              style={[
                styles.codeLineRow,
                isCompact && styles.codeLineRowCompact,
                isHighlighted && {
                  backgroundColor: "rgba(59, 130, 246, 0.24)",
                  borderLeftWidth: 3,
                  borderLeftColor: token.stroke,
                },
              ]}
            >
              <Text
                style={[
                  styles.codeLineNumber,
                  isCompact && styles.codeLineNumberCompact,
                ]}
              >
                {row.lineNum}
              </Text>
              <Text
                style={[
                  styles.codeLineText,
                  isCompact && styles.codeLineTextCompact,
                ]}
              >
                {spans.map((span, sIdx) => (
                  <Text
                    key={sIdx}
                    style={{
                      color: span.color,
                      fontStyle: span.italic ? "italic" : "normal",
                    }}
                  >
                    {span.text}
                  </Text>
                ))}
                {row.isTypingTip && (
                  <Text style={styles.codePenCursor}>▍</Text>
                )}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
};

// ---------------------------------------------------------------------------
// Slot Content View (Heading, Flow Card, Equation, Note, Code, Table, Bullets)
// ---------------------------------------------------------------------------
const SlotContentView: React.FC<{
  blockId: string;
  items: ResolvedAction[];
  slotWidth: number;
  stepProgress: number;
  textProgress: number;
  currentTimeMs?: number;
  wordTimings?: WordTiming[];
  isPlaying: boolean;
  isCompact: boolean;
  tableGridProgress: SharedValue<number>;
}> = ({
  blockId,
  items,
  slotWidth,
  stepProgress,
  textProgress,
  currentTimeMs,
  wordTimings,
  isPlaying,
  isCompact,
  tableGridProgress,
}) => {
  // Memoize WordBoundary trigger times for stacked current-step bullets
  const currentStepBullets = useMemo(
    () => items.filter((it) => it.isCurrentStep && it.action.type === "wb_bullet"),
    [items]
  );

  const bulletTriggerMap = useMemo(() => {
    const map = new Map<string, number | null>();
    if (currentStepBullets.length === 0) return map;
    const texts = currentStepBullets.map((it) => normalizeBlockText(it.action.text));
    const triggers = computeItemTriggerMsList(texts, wordTimings);
    currentStepBullets.forEach((it, idx) => {
      map.set(it.key, triggers[idx] ?? null);
    });
    return map;
  }, [currentStepBullets, wordTimings]);

  if (!items || items.length === 0) return null;
  const primaryItem = items[0];
  const primary = primaryItem.action;
  const primaryRatio = primaryItem.isCurrentStep ? textProgress : 1;
  const primaryShowCursor =
    primaryItem.isCurrentStep &&
    isPlaying &&
    textProgress > 0 &&
    textProgress < 0.995;

  if (primary.type === "wb_table") {
    return (
      <TableBlockView
        blockId={blockId}
        action={primary}
        slotWidth={slotWidth}
        isCurrentStep={primaryItem.isCurrentStep}
        stepProgress={stepProgress}
        currentTimeMs={currentTimeMs}
        wordTimings={wordTimings}
        isPlaying={isPlaying}
        tableGridProgress={tableGridProgress}
      />
    );
  }

  if (primary.type === "wb_code") {
    return (
      <CodeBlockView
        action={primary}
        revealRatio={primaryRatio}
        showCursor={primaryShowCursor}
        isCompact={isCompact}
      />
    );
  }

  if (primary.type === "wb_note") {
    const token = getColorToken(primary.color);
    const full = normalizeBlockText(primary.text);
    const visible =
      primaryRatio >= 0.995
        ? full
        : full.slice(0, Math.round(full.length * clamp01(primaryRatio)));
    return (
      <View style={styles.noteBox}>
        <View style={styles.noteHeaderRow}>
          <View style={[styles.noteBadge, { backgroundColor: token.badgeBg }]}>
            <Text style={[styles.noteBadgeText, { color: token.stroke }]}>
              NOTE
            </Text>
          </View>
        </View>
        <Text style={[styles.noteText, { color: token.text }]}>
          {visible}
          {primaryShowCursor && (
            <Text style={{ color: token.stroke }}>▍</Text>
          )}
        </Text>
      </View>
    );
  }

  if (primary.type === "wb_heading") {
    const token = getColorToken(primary.color);
    const full = normalizeBlockText(primary.text);
    const visible =
      primaryRatio >= 0.995
        ? full
        : full.slice(0, Math.round(full.length * clamp01(primaryRatio)));
    const hasIcon = Boolean(primary.icon);
    return (
      <View
        style={[
          styles.headingBox,
          hasIcon && styles.headingBoxWithIcon,
        ]}
      >
        <Text style={[styles.headingText, { color: token.text }]}>
          {visible}
          {primaryShowCursor && (
            <Text style={{ color: token.stroke }}>▍</Text>
          )}
        </Text>
      </View>
    );
  }

  if (primary.type === "wb_equation") {
    const token = getColorToken(primary.color);
    const full = normalizeBlockText(primary.text);
    const visible =
      primaryRatio >= 0.995
        ? full
        : full.slice(0, Math.round(full.length * clamp01(primaryRatio)));
    return (
      <View style={styles.equationBox}>
        <Text style={[styles.equationText, { color: token.text }]}>
          {visible}
          {primaryShowCursor && (
            <Text style={{ color: token.stroke }}>▍</Text>
          )}
        </Text>
      </View>
    );
  }

  if (primary.type === "wb_flow_card") {
    const token = getColorToken(primary.color);
    const full = normalizeBlockText(primary.text);
    const visible =
      primaryRatio >= 0.995
        ? full
        : full.slice(0, Math.round(full.length * clamp01(primaryRatio)));
    const hasIcon = Boolean(primary.icon);
    return (
      <View
        style={[
          styles.flowCardBox,
          hasIcon &&
            (isCompact
              ? styles.flowCardBoxWithIconCompact
              : styles.flowCardBoxWithIcon),
        ]}
      >
        <Text style={[styles.flowCardText, { color: token.text }]}>
          {visible}
          {primaryShowCursor && (
            <Text style={{ color: token.stroke }}>▍</Text>
          )}
        </Text>
      </View>
    );
  }

  // Stacked wb_bullet items:
  // - Completed prior bullets render at 100%
  // - Current-step bullets use exact WordBoundary sync when matched (280ms reveal window),
  //   gracefully falling back to proportional sequential textProgress when unmatched/empty.
  const clampedStep = clamp01(stepProgress);
  const canUseWordTiming =
    typeof currentTimeMs === "number" &&
    Number.isFinite(currentTimeMs) &&
    Array.isArray(wordTimings) &&
    wordTimings.length > 0 &&
    (currentTimeMs > 0 || clampedStep <= 0.05);

  const hasAnyBulletWordMatch =
    canUseWordTiming &&
    currentStepBullets.some((it) => bulletTriggerMap.get(it.key) != null);

  if (hasAnyBulletWordMatch) {
    const totalCurrent = Math.max(1, currentStepBullets.length);
    return (
      <View style={styles.bulletList}>
        {items.map((item) => {
          const token = getColorToken(item.action.color);
          const full = normalizeBlockText(item.action.text);

          if (!item.isCurrentStep || clampedStep >= 0.995) {
            return (
              <View key={item.key} style={styles.bulletRow}>
                <View
                  style={[styles.bulletDot, { backgroundColor: token.stroke }]}
                />
                <Text style={[styles.bulletText, { color: token.text }]}>
                  {full}
                </Text>
              </View>
            );
          }

          const triggerMs = bulletTriggerMap.get(item.key) ?? null;
          let ratio: number;
          if (triggerMs !== null) {
            // +150ms leading edge so bullets arrive crisp and never lag behind speech
            const syncedTimeMs = (currentTimeMs as number) + WORD_SYNC_LEAD_MS;
            if (clampedStep >= 0.94) {
              ratio = 1;
            } else if (syncedTimeMs < triggerMs) {
              ratio = 0;
            } else {
              ratio = clamp01(
                (syncedTimeMs - triggerMs) / WORD_SYNC_REVEAL_WINDOW_MS
              );
            }
          } else {
            const cIdx = Math.max(
              0,
              currentStepBullets.findIndex((b) => b.key === item.key)
            );
            const start = 0.08 + (cIdx / totalCurrent) * 0.7;
            const span = Math.max(0.12, 0.7 / totalCurrent);
            ratio = clamp01((clampedStep - start) / span);
          }

          if (ratio <= 0) {
            return null;
          }

          const visible =
            ratio >= 0.995
              ? full
              : full.slice(0, Math.max(1, Math.round(full.length * ratio)));
          const isTypingThisBullet = isPlaying && ratio > 0 && ratio < 0.995;

          return (
            <View
              key={item.key}
              style={[
                styles.bulletRow,
                { opacity: Math.min(1, ratio * 1.4) },
              ]}
            >
              <View
                style={[styles.bulletDot, { backgroundColor: token.stroke }]}
              />
              <Text style={[styles.bulletText, { color: token.text }]}>
                {visible}
                {isTypingThisBullet && (
                  <Text style={{ color: token.stroke }}>▍</Text>
                )}
              </Text>
            </View>
          );
        })}
      </View>
    );
  }

  // Default sequential typewriter budget fallback for stacked wb_bullet items
  const currentTotalChars = currentStepBullets.reduce(
    (sum, it) => sum + Math.max(1, normalizeBlockText(it.action.text).length),
    0
  );
  let bulletBudget =
    textProgress >= 0.995
      ? currentTotalChars
      : Math.floor(currentTotalChars * clamp01(textProgress));

  return (
    <View style={styles.bulletList}>
      {items.map((item) => {
        const token = getColorToken(item.action.color);
        const full = normalizeBlockText(item.action.text);

        if (!item.isCurrentStep || textProgress >= 0.995) {
          return (
            <View key={item.key} style={styles.bulletRow}>
              <View
                style={[styles.bulletDot, { backgroundColor: token.stroke }]}
              />
              <Text style={[styles.bulletText, { color: token.text }]}>
                {full}
              </Text>
            </View>
          );
        }

        if (bulletBudget <= 0) {
          return null;
        }

        const take = Math.min(full.length, bulletBudget);
        bulletBudget -= Math.max(1, take);
        const isTypingThisBullet =
          isPlaying && bulletBudget <= 0 && textProgress < 0.995;

        return (
          <View key={item.key} style={styles.bulletRow}>
            <View
              style={[styles.bulletDot, { backgroundColor: token.stroke }]}
            />
            <Text style={[styles.bulletText, { color: token.text }]}>
              {full.slice(0, take)}
              {isTypingThisBullet && (
                <Text style={{ color: token.stroke }}>▍</Text>
              )}
            </Text>
          </View>
        );
      })}
    </View>
  );
};

// ---------------------------------------------------------------------------
// Main Component: SmartBoardCanvas (Live Progressive Infinite Paper Canvas)
// ---------------------------------------------------------------------------
export const SmartBoardCanvas: React.FC<SmartBoardCanvasProps> = ({
  steps,
  currentStepIndex,
  slideImageUri,
  slideAspectRatio = 16 / 9,
  renderPdfLayer,
  stepProgress = 1,
  currentTimeMs,
  wordTimings,
  isPlaying = false,
  replayToken = 0,
  topInset = 76,
  bottomInset = 112,
}) => {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [detectedAspect, setDetectedAspect] = useState<number>(slideAspectRatio);

  // Dynamic responsive viewport dimensions (handles rotation & tablet Split View)
  const viewportWidth = canvasSize.width > 0 ? canvasSize.width : windowWidth;
  const viewportHeight = canvasSize.height > 0 ? canvasSize.height : windowHeight;
  const isTablet = viewportWidth >= 600;

  // 60fps UI-thread Pan & Pinch-to-Zoom Shared Values + Manual Override Flag
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const userHasManuallyPanned = useSharedValue(false);

  const resetViewport = useCallback(() => {
    userHasManuallyPanned.value = false;
    scale.value = withSpring(1, { damping: 18, stiffness: 180 });
    savedScale.value = 1;
    translateX.value = withSpring(0, { damping: 18, stiffness: 180 });
    translateY.value = withSpring(0, { damping: 18, stiffness: 180 });
    savedX.value = 0;
    savedY.value = 0;
  }, [
    userHasManuallyPanned,
    scale,
    savedScale,
    translateX,
    translateY,
    savedX,
    savedY,
  ]);

  // Reset viewport & manual override when switching to a brand-new slide
  useEffect(() => {
    userHasManuallyPanned.value = false;
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedX.value = 0;
    savedY.value = 0;
  }, [
    slideImageUri,
    userHasManuallyPanned,
    scale,
    savedScale,
    translateX,
    translateY,
    savedX,
    savedY,
  ]);

  useEffect(() => {
    setDetectedAspect(slideAspectRatio > 0 ? slideAspectRatio : 16 / 9);
  }, [slideAspectRatio]);

  const safeSteps = useMemo(() => (Array.isArray(steps) ? steps : []), [steps]);
  const safeIndex = Math.max(0, Math.min(currentStepIndex, safeSteps.length - 1));
  const currentStep = safeSteps[safeIndex];

  // Snappy decoupled marker stroke animations (fixed 400ms-650ms durations on UI thread)
  // so borders, underlines, table grids, and arrows never drag across a 10s-14s step!
  const clampedProgress = clamp01(stepProgress);
  const stepResetKey = `${safeIndex}-${currentStep?.step_id ?? "none"}-${replayToken}`;
  const isStaticComplete = !isPlaying && clampedProgress >= 0.99;

  const borderProgressSV = useSharedValue(isStaticComplete ? 1 : 0);
  const tableGridProgressSV = useSharedValue(isStaticComplete ? 1 : 0);
  const arrowProgressSV = useSharedValue(isStaticComplete ? 1 : 0);

  useEffect(() => {
    if (isStaticComplete) {
      borderProgressSV.value = 1;
      tableGridProgressSV.value = 1;
      arrowProgressSV.value = 1;
      return;
    }

    // Snap cleanly to 0 on step switch or replay, then sweep briskly in 440ms-580ms
    borderProgressSV.value = 0;
    tableGridProgressSV.value = 0;
    arrowProgressSV.value = 0;

    borderProgressSV.value = withTiming(1, {
      duration: CARD_BORDER_DRAW_MS,
      easing: Easing.out(Easing.cubic),
    });
    tableGridProgressSV.value = withTiming(1, {
      duration: TABLE_GRID_DRAW_MS,
      easing: Easing.out(Easing.cubic),
    });
    arrowProgressSV.value = withDelay(
      ARROW_DRAW_DELAY_MS,
      withTiming(1, {
        duration: ARROW_DRAW_MS,
        easing: Easing.out(Easing.cubic),
      })
    );
  }, [
    stepResetKey,
    isStaticComplete,
    borderProgressSV,
    tableGridProgressSV,
    arrowProgressSV,
  ]);

  useEffect(() => {
    if (clampedProgress >= 0.995) {
      borderProgressSV.value = 1;
      tableGridProgressSV.value = 1;
      arrowProgressSV.value = 1;
    }
  }, [clampedProgress, borderProgressSV, tableGridProgressSV, arrowProgressSV]);

  // Live RN text & code typewriter curve with leading edge: starts immediately (2% -> 86%)
  const textProgress = clamp01((clampedProgress - 0.02) / 0.84);

  // Simultaneous Pan + Pinch + Double-Tap Reset gestures (60fps UI thread)
  const composedGesture = useMemo(() => {
    const panGesture = Gesture.Pan()
      .minDistance(6)
      .onStart(() => {
        userHasManuallyPanned.value = true;
        savedX.value = translateX.value;
        savedY.value = translateY.value;
      })
      .onUpdate((e) => {
        translateX.value = savedX.value + e.translationX;
        translateY.value = savedY.value + e.translationY;
      })
      .onEnd(() => {
        savedX.value = translateX.value;
        savedY.value = translateY.value;
      });

    const pinchGesture = Gesture.Pinch()
      .onStart(() => {
        userHasManuallyPanned.value = true;
        savedScale.value = scale.value;
      })
      .onUpdate((e) => {
        const nextScale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, savedScale.value * e.scale)
        );
        scale.value = nextScale;
      })
      .onEnd(() => {
        savedScale.value = scale.value;
      });

    const doubleTapGesture = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => {
        userHasManuallyPanned.value = false;
        scale.value = withSpring(1, { damping: 18, stiffness: 180 });
        savedScale.value = 1;
        translateX.value = withSpring(0, { damping: 18, stiffness: 180 });
        translateY.value = withSpring(0, { damping: 18, stiffness: 180 });
        savedX.value = 0;
        savedY.value = 0;
      });

    return Gesture.Simultaneous(
      Gesture.Simultaneous(panGesture, pinchGesture),
      doubleTapGesture
    );
  }, [
    userHasManuallyPanned,
    scale,
    savedScale,
    translateX,
    translateY,
    savedX,
    savedY,
  ]);

  const viewportTransformStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // Floating "Reset View" button smoothly appears whenever zoomed/panned away from center
  const resetButtonAnimStyle = useAnimatedStyle(() => {
    const isMoved =
      Math.abs(scale.value - 1) > 0.04 ||
      Math.abs(translateX.value) > 14 ||
      Math.abs(translateY.value) > 14;
    return {
      opacity: withTiming(isMoved ? 1 : 0, { duration: 180 }),
      transform: [
        { translateY: withTiming(isMoved ? 0 : 80, { duration: 200 }) },
        { scale: withTiming(isMoved ? 1 : 0.88, { duration: 180 }) },
      ],
    };
  });

  const handleLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== canvasSize.width || height !== canvasSize.height) {
      setCanvasSize({ width, height });
    }
  };

  // Compute aspect-ratio-preserving rendered PDF image rect (locked source of truth for bboxes)
  const pdfDrawRect = useMemo(
    () =>
      computeContainRect(
        viewportWidth,
        viewportHeight,
        detectedAspect,
        topInset,
        bottomInset
      ),
    [viewportWidth, viewportHeight, detectedAspect, topInset, bottomInset]
  );

  // Memoize PDF actions & per-annotation WordBoundary trigger timestamps (Safeguard #4)
  const currentPdfActions = useMemo(() => {
    if (!currentStep || currentStep.mode !== "pdf_overlay") return [];
    return (currentStep.actions ?? []).filter(
      (a) =>
        a &&
        (a.type === "pdf_highlight" || a.type === "pdf_circle") &&
        a.bbox != null
    );
  }, [currentStep]);

  const pdfActionTriggerMs = useMemo(
    () =>
      computePdfActionTriggerMsList(currentPdfActions, currentStep, wordTimings),
    [currentPdfActions, currentStep, wordTimings]
  );

  // Compute cumulative multi-band whiteboard blocks & dynamic rects
  const wbBlocks = useMemo(
    () => resolveWhiteboardBlocks(safeSteps, safeIndex),
    [safeSteps, safeIndex]
  );

  const cumulativeLayout = useMemo(
    () =>
      computeCumulativeWhiteboardLayout(
        viewportWidth,
        viewportHeight,
        wbBlocks,
        topInset,
        bottomInset,
        isTablet
      ),
    [viewportWidth, viewportHeight, wbBlocks, topInset, bottomInset, isTablet]
  );

  // Gesture-Safe Auto-Pan Camera Follow: smoothly centers on active blocks below viewport
  useEffect(() => {
    if (
      !currentStep ||
      currentStep.mode !== "whiteboard" ||
      viewportHeight <= 0
    ) {
      return;
    }
    if (userHasManuallyPanned.value) return;

    const activeRects: RectFrame[] = [];
    for (const block of wbBlocks) {
      if (block.lastUpdatedStepIdx === safeIndex) {
        const rect = cumulativeLayout.blockRects.get(block.blockId);
        if (rect && rect.height > 0) {
          activeRects.push(rect);
        }
      }
    }
    if (activeRects.length === 0) return;

    let minY = Infinity;
    let maxY = -Infinity;
    for (const r of activeRects) {
      minY = Math.min(minY, r.y);
      maxY = Math.max(maxY, r.y + r.height);
    }

    const visibleTop = topInset + 8;
    const visibleBottom = viewportHeight - bottomInset - 12;
    const visibleCenterY = (visibleTop + visibleBottom) / 2;

    let targetY = translateY.value;
    if (maxY + translateY.value > visibleBottom) {
      const activeCenterY = (minY + maxY) / 2;
      targetY = Math.min(0, visibleCenterY - activeCenterY);
    } else if (minY + translateY.value < visibleTop) {
      targetY = Math.min(0, visibleTop - minY);
    } else if (minY <= visibleTop + 24 && maxY <= visibleBottom) {
      targetY = 0;
    }

    if (Math.abs(targetY - translateY.value) > 4) {
      translateY.value = withTiming(targetY, {
        duration: 460,
        easing: Easing.out(Easing.cubic),
      });
      savedY.value = targetY;
    }
  }, [
    safeIndex,
    currentStep,
    wbBlocks,
    cumulativeLayout.blockRects,
    viewportHeight,
    topInset,
    bottomInset,
    userHasManuallyPanned,
    translateY,
    savedY,
  ]);

  // Single-draw-call subtle warm paper grid covering an expanded infinite full-bleed area
  const gridOverscan = 480;
  const gridPath = useMemo(() => {
    if (cumulativeLayout.boardWidth <= 0 || cumulativeLayout.boardHeight <= 0) {
      return makeEmptySkiaPath();
    }
    const spacing = 28;
    const minX = -gridOverscan;
    const maxX = cumulativeLayout.boardWidth + gridOverscan;
    const minY = -gridOverscan;
    const maxY = cumulativeLayout.boardHeight + gridOverscan;

    return makePathFromBuilder((builder) => {
      for (let x = minX; x <= maxX; x += spacing) {
        builder.moveTo(x, minY);
        builder.lineTo(x, maxY);
      }
      for (let y = minY; y <= maxY; y += spacing) {
        builder.moveTo(minX, y);
        builder.lineTo(maxX, y);
      }
    });
  }, [cumulativeLayout.boardWidth, cumulativeLayout.boardHeight]);

  if (!currentStep) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No teaching step loaded.</Text>
      </View>
    );
  }

  // =========================================================================
  // MODE 1: PDF OVERLAY (Interactive Pan & Zoom Slide + Exact Centered Rough Skia)
  // =========================================================================
  if (currentStep.mode === "pdf_overlay") {
    const pdfActions = currentPdfActions;
    const canUsePdfWordTiming =
      typeof currentTimeMs === "number" &&
      Number.isFinite(currentTimeMs) &&
      Array.isArray(wordTimings) &&
      wordTimings.length > 0 &&
      (currentTimeMs > 0 || clampedProgress <= 0.05);
    const syncedPdfTimeMs =
      typeof currentTimeMs === "number" && Number.isFinite(currentTimeMs)
        ? currentTimeMs + WORD_SYNC_LEAD_MS
        : 0;

    return (
      <View style={styles.pdfRoot} onLayout={handleLayout}>
        <GestureDetector gesture={composedGesture}>
          <Animated.View style={[styles.gestureStage, viewportTransformStyle]}>
            {/* Layer 1: Underlying PDF slide locked strictly to pdfDrawRect */}
            {viewportWidth > 0 &&
              (renderPdfLayer ? (
                <View
                  style={[
                    styles.absoluteRect,
                    {
                      left: pdfDrawRect.x,
                      top: pdfDrawRect.y,
                      width: pdfDrawRect.width,
                      height: pdfDrawRect.height,
                    },
                  ]}
                >
                  {renderPdfLayer(pdfDrawRect)}
                </View>
              ) : slideImageUri ? (
                <Image
                  source={{ uri: slideImageUri }}
                  resizeMode="contain"
                  style={[
                    styles.absoluteRect,
                    {
                      left: pdfDrawRect.x,
                      top: pdfDrawRect.y,
                      width: pdfDrawRect.width,
                      height: pdfDrawRect.height,
                    },
                  ]}
                  onLoad={(event) => {
                    const source = event?.nativeEvent?.source;
                    if (source && source.width > 0 && source.height > 0) {
                      setDetectedAspect(source.width / source.height);
                    }
                  }}
                />
              ) : (
                <View
                  style={[
                    styles.pdfPlaceholder,
                    {
                      left: pdfDrawRect.x,
                      top: pdfDrawRect.y,
                      width: pdfDrawRect.width,
                      height: pdfDrawRect.height,
                    },
                  ]}
                >
                  <Text style={styles.pdfPlaceholderText}>
                    PDF Slide Canvas ({Math.round(pdfDrawRect.width)}×
                    {Math.round(pdfDrawRect.height)})
                  </Text>
                </View>
              ))}

            {/* Layer 2: Transparent 60fps Skia Vector Overlay locked strictly to pdfDrawRect */}
            {viewportWidth > 0 && (
              <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
                {pdfActions.map((action, idx) => {
                  const token = getColorToken(action.color);
                  const key = `pdf-${currentStep.step_id}-${idx}-${action.type}`;
                  const triggerMs = pdfActionTriggerMs[idx] ?? null;

                  // Per-annotation trigger: fires snappy 460ms stroke right when spoken
                  let triggered: boolean;
                  if (isStaticComplete || clampedProgress >= 0.94) {
                    triggered = true;
                  } else if (pdfActions.length <= 1) {
                    triggered = true;
                  } else if (canUsePdfWordTiming && triggerMs !== null) {
                    triggered = syncedPdfTimeMs >= triggerMs;
                  } else {
                    const threshold = (idx / pdfActions.length) * 0.52;
                    triggered = clampedProgress >= threshold;
                  }

                  if (action.type === "pdf_highlight") {
                    const hlRect = mapPdfHighlightRect(action.bbox!, pdfDrawRect);
                    return (
                      <AnimatedHighlightRect
                        key={key}
                        x={hlRect.x}
                        y={hlRect.y}
                        width={hlRect.width}
                        height={hlRect.height}
                        color={token.highlight}
                        triggered={triggered}
                        instantComplete={isStaticComplete}
                        resetKey={stepResetKey}
                      />
                    );
                  }
                  const circleRect = mapPdfCircleRect(action.bbox!, pdfDrawRect);
                  return (
                    <AnimatedCircleAnnotation
                      key={key}
                      x={circleRect.x}
                      y={circleRect.y}
                      width={circleRect.width}
                      height={circleRect.height}
                      seed={hashSeed(key)}
                      strokeColor={token.stroke}
                      triggered={triggered}
                      instantComplete={isStaticComplete}
                      resetKey={stepResetKey}
                    />
                  );
                })}
              </Canvas>
            )}
          </Animated.View>
        </GestureDetector>

        {/* Floating Reset View Button */}
        <Animated.View
          style={[
            styles.resetBtnWrap,
            { bottom: bottomInset + 14 },
            resetButtonAnimStyle,
          ]}
        >
          <Pressable style={styles.resetBtn} onPress={resetViewport}>
            <Text style={styles.resetBtnText}>⌖ Reset View</Text>
          </Pressable>
        </Animated.View>
      </View>
    );
  }

  // =========================================================================
  // MODE 2: LIVE PROGRESSIVE INFINITE WHITEBOARD (#FAF8F5 Paper + Rough Skia)
  // =========================================================================
  const { blockRects, boardWidth, boardHeight } = cumulativeLayout;
  const arrowBlocks = wbBlocks.filter(
    (block) =>
      block.items[0]?.action.type === "wb_flow_card" &&
      block.connectFromBlockId &&
      blockRects.has(block.connectFromBlockId)
  );

  return (
    <View style={styles.whiteboardRoot} onLayout={handleLayout}>
      <GestureDetector gesture={composedGesture}>
        <Animated.View style={[styles.gestureStage, viewportTransformStyle]}>
          <View
            style={{
              width: boardWidth,
              height: boardHeight,
            }}
          >
            {/* Layer 1: 60fps Skia Vector Layer (Full-Bleed Paper Grid, Rough Frames, Icons, Arrows) */}
            {viewportWidth > 0 && (
              <Canvas
                style={{
                  position: "absolute",
                  left: -gridOverscan,
                  top: -gridOverscan,
                  width: boardWidth + gridOverscan * 2,
                  height: boardHeight + gridOverscan * 2,
                }}
                pointerEvents="none"
              >
                {/* Expanded Infinite Paper Grid */}
                <Path
                  path={gridPath}
                  style="stroke"
                  strokeWidth={0.8}
                  color={PAPER_GRID_COLOR}
                  transform={[
                    { translateX: gridOverscan },
                    { translateY: gridOverscan },
                  ]}
                />

                {/* Progressive Rough Card Frames, Heading Underlines & Sketch Icons (0% -> 35%) */}
                {wbBlocks.map((block) => {
                  const rect = blockRects.get(block.blockId);
                  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
                  const primary = block.items[0]?.action;
                  if (!primary) return null;

                  // wb_table renders its own memoized rough Skia grid inside TableBlockView
                  // so horizontal scrolling on narrow phones keeps grid lines locked 1:1 with cells
                  if (primary.type === "wb_table") {
                    return null;
                  }

                  const token = getColorToken(primary.color);
                  const isCode = primary.type === "wb_code";
                  const isHeading = primary.type === "wb_heading";
                  const isNote = primary.type === "wb_note";
                  const isFlowCard = primary.type === "wb_flow_card";
                  const isCompact =
                    block.slot === "left_col" || block.slot === "right_col";
                  const radius = isHeading ? 12 : isNote ? 10 : 16;
                  const isNewCard = block.createdAtStepIdx === safeIndex;
                  const cardSeed = hashSeed(`frame-${block.blockId}`);

                  const shiftedX = rect.x + gridOverscan;
                  const shiftedY = rect.y + gridOverscan;

                  const showSketchIcon =
                    Boolean(primary.icon) && (isHeading || isFlowCard);
                  const iconSize = isHeading ? 24 : isCompact ? 18 : 22;
                  const iconCx = shiftedX + (isCompact ? 20 : 25);
                  const iconCy =
                    shiftedY + (isHeading ? (rect.height - 6) / 2 : rect.height / 2);

                  return (
                    <React.Fragment key={`frame-${block.blockId}`}>
                      <AnimatedCardFrame
                        x={shiftedX}
                        y={shiftedY}
                        width={rect.width}
                        height={rect.height}
                        radius={radius}
                        seed={cardSeed}
                        fillColor={
                          isCode
                            ? "#0F172A"
                            : isNote
                            ? token.noteFill
                            : token.fill
                        }
                        strokeColor={isCode ? "#334155" : token.stroke}
                        strokeWidth={isFlowCard ? 2 : 1.55}
                        isCode={isCode}
                        isHeading={isHeading}
                        isNote={isNote}
                        animate={isNewCard}
                        borderProgress={borderProgressSV}
                      />
                      {showSketchIcon && primary.icon && (
                        <AnimatedSketchIcon
                          icon={primary.icon}
                          cx={iconCx}
                          cy={iconCy}
                          size={iconSize}
                          seed={hashSeed(`icon-${block.blockId}-${primary.icon}`)}
                          strokeColor={token.stroke}
                          animate={isNewCard}
                          progress={borderProgressSV}
                        />
                      )}
                    </React.Fragment>
                  );
                })}

                {/* Hand-Drawn Cause-and-Effect Connector Arrows (75% -> 100% of stepProgress) */}
                {arrowBlocks.map((block) => {
                  const fromRect = blockRects.get(block.connectFromBlockId!);
                  const toRect = blockRects.get(block.blockId);
                  if (!fromRect || !toRect) return null;
                  const primary = block.items[0].action;
                  const token = getColorToken(primary.color);

                  return (
                    <AnimatedArrowPath
                      key={`arrow-${block.blockId}`}
                      fromX={fromRect.x + gridOverscan}
                      fromY={fromRect.y + gridOverscan}
                      fromW={fromRect.width}
                      fromH={fromRect.height}
                      toX={toRect.x + gridOverscan}
                      toY={toRect.y + gridOverscan}
                      toW={toRect.width}
                      toH={toRect.height}
                      seed={hashSeed(`arrow-${block.blockId}`)}
                      strokeColor={token.stroke}
                      animate={block.createdAtStepIdx === safeIndex}
                      progress={arrowProgressSV}
                    />
                  );
                })}
              </Canvas>
            )}

            {/* Layer 2: Live Typewriter RN Text, Notes, Tables & Syntax-Highlighted Code */}
            {viewportWidth > 0 &&
              wbBlocks.map((block) => {
                const rect = blockRects.get(block.blockId);
                if (!rect || rect.width <= 0 || rect.height <= 0) return null;
                const primaryType = block.items[0]?.action.type;
                const isCode = primaryType === "wb_code";
                const isTable = primaryType === "wb_table";
                const isCompact =
                  block.slot === "left_col" || block.slot === "right_col";

                return (
                  <View
                    key={`block-${block.blockId}`}
                    style={[
                      styles.slotContainer,
                      isCode && styles.codeSlotContainer,
                      isTable && styles.tableSlotContainer,
                      {
                        left: rect.x,
                        top: rect.y,
                        width: rect.width,
                        height: rect.height,
                      },
                    ]}
                  >
                    <SlotContentView
                      blockId={block.blockId}
                      items={block.items}
                      slotWidth={rect.width}
                      stepProgress={clampedProgress}
                      textProgress={textProgress}
                      currentTimeMs={currentTimeMs}
                      wordTimings={wordTimings}
                      isPlaying={isPlaying}
                      isCompact={isCompact}
                      tableGridProgress={tableGridProgressSV}
                    />
                  </View>
                );
              })}
          </View>
        </Animated.View>
      </GestureDetector>

      {/* Floating Reset View Button */}
      <Animated.View
        style={[
          styles.resetBtnWrap,
          { bottom: bottomInset + 14 },
          resetButtonAnimStyle,
        ]}
      >
        <Pressable style={styles.resetBtn} onPress={resetViewport}>
          <Text style={styles.resetBtnText}>⌖ Reset View</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
};

// ---------------------------------------------------------------------------
// Styles (with includeFontPadding: false & Platform.select Font Parity)
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: PAPER_BG,
  },
  emptyText: {
    color: "#64748B",
    fontSize: 14,
    includeFontPadding: false,
  },
  pdfRoot: {
    flex: 1,
    backgroundColor: "#141417",
    overflow: "hidden",
  },
  whiteboardRoot: {
    flex: 1,
    backgroundColor: PAPER_BG,
    overflow: "hidden",
  },
  gestureStage: {
    flex: 1,
  },
  absoluteRect: {
    position: "absolute",
    overflow: "hidden",
  },
  pdfPlaceholder: {
    position: "absolute",
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  pdfPlaceholderText: {
    color: "#94A3B8",
    fontSize: 13,
    includeFontPadding: false,
  },
  slotContainer: {
    position: "absolute",
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: "center",
  },
  codeSlotContainer: {
    paddingHorizontal: 0,
    paddingVertical: 0,
    justifyContent: "flex-start",
    overflow: "hidden",
    borderRadius: 16,
  },
  tableSlotContainer: {
    paddingHorizontal: 0,
    paddingVertical: 0,
    justifyContent: "flex-start",
  },
  headingBox: {
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: 8,
  },
  headingBoxWithIcon: {
    paddingLeft: 32,
    paddingRight: 10,
  },
  headingText: {
    fontSize: 17.5,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 24,
    includeFontPadding: false,
  },
  flowCardBox: {
    justifyContent: "center",
    alignItems: "center",
  },
  flowCardBoxWithIcon: {
    paddingLeft: 30,
    paddingRight: 6,
  },
  flowCardBoxWithIconCompact: {
    paddingLeft: 24,
    paddingRight: 4,
  },
  flowCardText: {
    fontSize: 14.5,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 21,
    includeFontPadding: false,
  },
  equationBox: {
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 6,
  },
  equationText: {
    fontSize: 16.5,
    fontWeight: "600",
    fontFamily: SERIF_FONT_FAMILY,
    textAlign: "center",
    lineHeight: 24,
    includeFontPadding: false,
  },
  noteBox: {
    paddingLeft: 12,
    paddingRight: 4,
    gap: 5,
    justifyContent: "center",
  },
  noteHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  noteBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  noteBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.9,
    includeFontPadding: false,
  },
  noteText: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: SERIF_FONT_FAMILY,
    fontStyle: "italic",
    fontWeight: "500",
    includeFontPadding: false,
  },
  tableWrapper: {
    width: "100%",
  },
  tableWrapperCentered: {
    width: "100%",
    alignItems: "center",
  },
  tableScrollContent: {
    paddingBottom: 2,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  tableCell: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    justifyContent: "center",
  },
  tableHeaderText: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
    textAlign: "center",
    includeFontPadding: false,
  },
  tableCellText: {
    fontSize: 12.5,
    fontWeight: "500",
    lineHeight: 18,
    textAlign: "center",
    includeFontPadding: false,
  },
  tableFirstColText: {
    fontWeight: "700",
  },
  tableScrollHintText: {
    marginTop: 2,
    fontSize: 10.5,
    fontWeight: "600",
    color: "#64748B",
    textAlign: "center",
    includeFontPadding: false,
  },
  bulletList: {
    gap: 8,
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
  },
  bulletDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginTop: 7,
  },
  bulletText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "500",
    includeFontPadding: false,
  },
  codeContainer: {
    flex: 1,
    backgroundColor: "#0F172A",
    borderRadius: 16,
    overflow: "hidden",
  },
  codeHeader: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: "#1E293B",
    borderBottomWidth: 1,
    borderBottomColor: "#334155",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  codeDotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  codeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  codeLangBadge: {
    color: "#93C5FD",
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 1,
    includeFontPadding: false,
  },
  codeLineCount: {
    color: "#94A3B8",
    fontSize: 10,
    fontWeight: "600",
    includeFontPadding: false,
  },
  codeBody: {
    paddingTop: 10,
    paddingBottom: 18,
    gap: 2,
  },
  codeBodyCompact: {
    paddingTop: 8,
    paddingBottom: 18,
    gap: 1.5,
  },
  codeLineRow: {
    flexDirection: "row",
    paddingHorizontal: 10,
    paddingVertical: 2,
    alignItems: "flex-start",
  },
  codeLineRowCompact: {
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  codeLineNumber: {
    width: 24,
    color: "#64748B",
    fontSize: 11.5,
    lineHeight: 19,
    fontFamily: CODE_FONT_FAMILY,
    includeFontPadding: false,
  },
  codeLineNumberCompact: {
    width: 18,
    fontSize: 10.5,
    lineHeight: 16,
  },
  codeLineText: {
    flex: 1,
    flexShrink: 1,
    color: "#F8FAFC",
    fontSize: 12,
    lineHeight: 19,
    fontFamily: CODE_FONT_FAMILY,
    includeFontPadding: false,
  },
  codeLineTextCompact: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  codePenCursor: {
    color: "#38BDF8",
    fontWeight: "800",
  },
  resetBtnWrap: {
    position: "absolute",
    right: 16,
    zIndex: 20,
  },
  resetBtn: {
    backgroundColor: "rgba(24, 24, 27, 0.88)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  resetBtnText: {
    color: "#FAF8F5",
    fontSize: 12,
    fontWeight: "700",
    includeFontPadding: false,
  },
});

export default SmartBoardCanvas;

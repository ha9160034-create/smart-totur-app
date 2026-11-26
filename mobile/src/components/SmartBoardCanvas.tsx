import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Image,
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
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
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type {
  BoundingBox,
  TeachingStep,
  VisualAction,
  WhiteboardSlot,
} from "../types/schema";

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
// Warm Paper Palette & Color Tokens
// ---------------------------------------------------------------------------
const PAPER_BG = "#FAF8F5";
const PAPER_GRID_COLOR = "rgba(148, 138, 122, 0.17)";
const MIN_SCALE = 0.6;
const MAX_SCALE = 3.0;

interface ColorToken {
  stroke: string;
  fill: string;
  highlight: string;
  text: string;
  badgeBg: string;
}

const COLOR_MAP: Record<VisualAction["color"], ColorToken> = {
  blue: {
    stroke: "#2563EB",
    fill: "#F0F6FF",
    highlight: "rgba(37, 99, 235, 0.24)",
    text: "#1E3A8A",
    badgeBg: "#DBEAFE",
  },
  red: {
    stroke: "#DC2626",
    fill: "#FEF2F2",
    highlight: "rgba(220, 38, 38, 0.24)",
    text: "#991B1B",
    badgeBg: "#FEE2E2",
  },
  green: {
    stroke: "#16A34A",
    fill: "#F0FDF4",
    highlight: "rgba(22, 163, 74, 0.24)",
    text: "#166534",
    badgeBg: "#DCFCE7",
  },
  yellow: {
    stroke: "#CA8A04",
    fill: "#FEFCE8",
    highlight: "rgba(250, 204, 21, 0.42)",
    text: "#854D0E",
    badgeBg: "#FEF9C3",
  },
  black: {
    stroke: "#1E293B",
    fill: "#FFFFFF",
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
// Text Normalization & Lightweight Multi-Language Syntax Highlighter
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
// Modern Skia Path Helpers (Compatible with Immutable SkPath / PathBuilder)
// ---------------------------------------------------------------------------
function makeEmptyPath() {
  if (typeof Skia?.PathBuilder?.Make === "function") {
    return Skia.PathBuilder.Make().build();
  }
  return Skia.Path.Make();
}

function makePathFromBuilder(
  draw: (builder: {
    moveTo: (x: number, y: number) => unknown;
    lineTo: (x: number, y: number) => unknown;
    quadTo: (x1: number, y1: number, x2: number, y2: number) => unknown;
    addOval: (rect: ReturnType<typeof Skia.XYWHRect>) => unknown;
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
    addOval?: (rect: ReturnType<typeof Skia.XYWHRect>) => unknown;
  };
  if (typeof legacyPath?.moveTo === "function") {
    draw(
      legacyPath as {
        moveTo: (x: number, y: number) => unknown;
        lineTo: (x: number, y: number) => unknown;
        quadTo: (x1: number, y1: number, x2: number, y2: number) => unknown;
        addOval: (rect: ReturnType<typeof Skia.XYWHRect>) => unknown;
      }
    );
  }
  return legacyPath as ReturnType<typeof Skia.Path.Make>;
}

/** Build a continuous clockwise rounded-rectangle stroke path for progressive border drawing */
function buildRoundedRectStrokePath(rect: RectFrame, radius: number) {
  const { x, y, width: w, height: h } = rect;
  if (w <= 0 || h <= 0) return makeEmptyPath();
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

function buildHeadingUnderlinePath(rect: RectFrame) {
  const { x, y, width: w, height: h } = rect;
  if (w <= 0 || h <= 0) return makeEmptyPath();
  const inset = Math.min(28, w * 0.1);
  const lineY = y + h - 4;
  return makePathFromBuilder((b) => {
    b.moveTo(x + inset, lineY);
    b.lineTo(x + w - inset, lineY);
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

function mapBboxToScreenRect(bbox: BoundingBox, contentRect: RectFrame): RectFrame {
  const ymin = Math.max(0, Math.min(1000, Math.min(bbox.ymin, bbox.ymax)));
  const ymax = Math.max(0, Math.min(1000, Math.max(bbox.ymin, bbox.ymax)));
  const xmin = Math.max(0, Math.min(1000, Math.min(bbox.xmin, bbox.xmax)));
  const xmax = Math.max(0, Math.min(1000, Math.max(bbox.xmin, bbox.xmax)));

  return {
    x: contentRect.x + (xmin / 1000) * contentRect.width,
    y: contentRect.y + (ymin / 1000) * contentRect.height,
    width: Math.max(4, ((xmax - xmin) / 1000) * contentRect.width),
    height: Math.max(4, ((ymax - ymin) / 1000) * contentRect.height),
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
      if (!action.slot) continue;

      // Always place wb_heading in a full-width slot so headings never wrap inside narrow half-width columns
      const targetSlot: WhiteboardSlot =
        action.type === "wb_heading" &&
        (action.slot === "left_col" || action.slot === "right_col")
          ? "header"
          : action.slot;

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
      if (targetSlot !== action.slot) {
        latestBySlot.set(action.slot, newBlock);
      }
    }
  }

  return blocks;
}

function estimateWrappedLines(text: string, charsPerLine: number): number {
  const safeChars = Math.max(10, Math.floor(charsPerLine));
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

function estimateSlotHeight(
  items: ResolvedAction[] | undefined,
  slotWidth: number,
  isCompactColumn = false
): number {
  if (!items || items.length === 0 || slotWidth <= 0) return 0;
  const primary = items[0].action;

  if (primary.type === "wb_heading") {
    const clean = normalizeBlockText(primary.text);
    const charsPerLine = Math.max(14, Math.floor((slotWidth - 32) / 10.2));
    const lines = estimateWrappedLines(clean, charsPerLine);
    // Generous vertical padding + bottom clearance above the Skia underline at y + height - 4
    return Math.max(64, 42 + lines * 26);
  }

  if (primary.type === "wb_code") {
    const rawCode = primary.code || primary.text || "";
    const clean = normalizeBlockText(rawCode);
    const gutterAndPad = isCompactColumn ? 34 : 50;
    const codeInnerW = Math.max(108, slotWidth - gutterAndPad);
    const charWidth = isCompactColumn ? 6.8 : 7.4;
    const rowHeight = isCompactColumn ? 18.5 : 21.5;
    const wrappedLines = estimateWrappedLines(clean || " ", codeInnerW / charWidth);
    // 32px header + 36px vertical padding (includes +12px bottom breathing room) + per-line height
    return Math.max(126, 32 + 36 + wrappedLines * rowHeight);
  }

  if (primary.type === "wb_equation") {
    const clean = normalizeBlockText(primary.text);
    const charsPerLine = Math.max(12, Math.floor((slotWidth - 28) / 9.5));
    const lines = estimateWrappedLines(clean, charsPerLine);
    return Math.max(84, 48 + lines * 26);
  }

  if (primary.type === "wb_flow_card") {
    const clean = normalizeBlockText(primary.text);
    // Conservative chars-per-line estimate + generous +24px padding so half-width cards never clip
    const charsPerLine = Math.max(11, Math.floor((slotWidth - 28) / 8.5));
    const lines = estimateWrappedLines(clean, charsPerLine);
    return Math.max(104, 56 + lines * 23);
  }

  // Stacked wb_bullet items with conservative word-wrap estimate & generous vertical padding
  const bulletCharsPerLine = Math.max(11, Math.floor((slotWidth - 46) / 8.5));
  let totalH = 50;
  for (const item of items) {
    const clean = normalizeBlockText(item.action.text);
    const lines = estimateWrappedLines(clean, bulletCharsPerLine);
    totalH += lines * 22 + 10;
  }
  return Math.max(104, totalH);
}

function computeCumulativeWhiteboardLayout(
  viewportW: number,
  viewportH: number,
  blocks: WhiteboardBlock[],
  topInset: number,
  bottomInset: number
): CumulativeBoardLayout {
  const padX = 16;
  const rowGap = 18;
  const bandGap = 24;
  const colGap = 28; // Clean channel for horizontal connector arrows

  const boardWidth = Math.max(viewportW, 340);
  const innerW = Math.max(0, boardWidth - padX * 2);
  const halfW = Math.max(0, (innerW - colGap) / 2);

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
      const h = estimateSlotHeight(headerBlock.items, innerW);
      blockRects.set(headerBlock.blockId, {
        x: padX,
        y: cursorY,
        width: innerW,
        height: h,
      });
      cursorY += h + rowGap;
    }

    if (mainTopBlock) {
      const h = estimateSlotHeight(mainTopBlock.items, innerW);
      blockRects.set(mainTopBlock.blockId, {
        x: padX,
        y: cursorY,
        width: innerW,
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
      const h = estimateSlotHeight(bottomBlock.items, innerW);
      blockRects.set(bottomBlock.blockId, {
        x: padX,
        y: cursorY,
        width: innerW,
        height: h,
      });
      cursorY += h + rowGap;
    }

    if (fullBlock) {
      const h = estimateSlotHeight(fullBlock.items, innerW);
      blockRects.set(fullBlock.blockId, {
        x: padX,
        y: cursorY,
        width: innerW,
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

function buildConnectorArrowPath(from: RectFrame, to: RectFrame) {
  if (!from || !to || from.width <= 0 || to.width <= 0) {
    return makeEmptyPath();
  }

  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;

  const dx = toCx - fromCx;
  const dy = toCy - fromCy;

  let startX = fromCx;
  let startY = fromCy;
  let endX = toCx;
  let endY = toCy;
  const margin = 5;

  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx > 0) {
      startX = from.x + from.width + margin;
      endX = to.x - margin;
    } else {
      startX = from.x - margin;
      endX = to.x + to.width + margin;
    }
  } else {
    if (dy > 0) {
      startY = from.y + from.height + margin;
      endY = to.y - margin;
    } else {
      startY = from.y - margin;
      endY = to.y + to.height + margin;
    }
  }

  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  const isDiagonal = Math.abs(startX - endX) > 12 && Math.abs(startY - endY) > 12;
  const ctrlX = midX;
  const ctrlY = isDiagonal ? startY : midY;

  const angle = Math.atan2(endY - ctrlY, endX - ctrlX);
  const headLen = 10;
  const spread = Math.PI / 6;

  return makePathFromBuilder((builder) => {
    builder.moveTo(startX, startY);
    builder.quadTo(ctrlX, ctrlY, endX, endY);

    builder.moveTo(endX, endY);
    builder.lineTo(
      endX - headLen * Math.cos(angle - spread),
      endY - headLen * Math.sin(angle - spread)
    );
    builder.moveTo(endX, endY);
    builder.lineTo(
      endX - headLen * Math.cos(angle + spread),
      endY - headLen * Math.sin(angle + spread)
    );
  });
}

// ---------------------------------------------------------------------------
// Animated Skia Primitives (60fps UI Thread Synchronized to stepProgress)
// ---------------------------------------------------------------------------
const AnimatedHighlightRect: React.FC<{
  rect: RectFrame;
  color: string;
  progress: SharedValue<number>;
}> = ({ rect, color, progress }) => {
  const targetWidth = useSharedValue(rect.width);
  useEffect(() => {
    targetWidth.value = rect.width;
  }, [rect.width, targetWidth]);

  const animatedWidth = useDerivedValue(
    () => targetWidth.value * progress.value
  );

  return (
    <RoundedRect
      x={rect.x}
      y={rect.y}
      width={animatedWidth}
      height={rect.height}
      r={6}
      color={color}
    />
  );
};

const AnimatedCircleAnnotation: React.FC<{
  rect: RectFrame;
  strokeColor: string;
  progress: SharedValue<number>;
}> = ({ rect, strokeColor, progress }) => {
  const ovalPath = useMemo(() => {
    const pad = 4;
    const ovalRect = Skia.XYWHRect(
      rect.x - pad,
      rect.y - pad,
      rect.width + pad * 2,
      rect.height + pad * 2
    );
    return makePathFromBuilder((builder) => {
      builder.addOval(ovalRect);
    });
  }, [rect.x, rect.y, rect.width, rect.height]);

  return (
    <Path
      path={ovalPath}
      style="stroke"
      strokeWidth={3.5}
      strokeCap="round"
      strokeJoin="round"
      color={strokeColor}
      start={0}
      end={progress}
    />
  );
};

const AnimatedCardFrame: React.FC<{
  rect: RectFrame;
  radius: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  isHeading: boolean;
  animate: boolean;
  borderProgress: SharedValue<number>;
}> = ({
  rect,
  radius,
  fillColor,
  strokeColor,
  strokeWidth,
  isHeading,
  animate,
  borderProgress,
}) => {
  const borderPath = useMemo(
    () => buildRoundedRectStrokePath(rect, radius),
    [rect, radius]
  );
  const underlinePath = useMemo(
    () => (isHeading ? buildHeadingUnderlinePath(rect) : makeEmptyPath()),
    [rect, isHeading]
  );

  const fillOpacity = useDerivedValue(() =>
    animate ? Math.min(1, borderProgress.value * 1.15) : 1
  );

  return (
    <>
      <RoundedRect
        x={rect.x}
        y={rect.y + 3}
        width={rect.width}
        height={rect.height}
        r={radius}
        color="rgba(15, 23, 42, 0.06)"
        opacity={fillOpacity}
      />
      <RoundedRect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        r={radius}
        color={fillColor}
        opacity={fillOpacity}
      />
      <Path
        path={borderPath}
        style="stroke"
        strokeWidth={strokeWidth}
        strokeCap="round"
        strokeJoin="round"
        color={strokeColor}
        start={0}
        end={animate ? borderProgress : 1}
      />
      {isHeading && (
        <Path
          path={underlinePath}
          style="stroke"
          strokeWidth={2.5}
          strokeCap="round"
          color={strokeColor}
          start={0}
          end={animate ? borderProgress : 1}
        />
      )}
    </>
  );
};

const AnimatedArrowPath: React.FC<{
  from: RectFrame;
  to: RectFrame;
  strokeColor: string;
  animate: boolean;
  progress: SharedValue<number>;
}> = ({ from, to, strokeColor, animate, progress }) => {
  const arrowPath = useMemo(() => buildConnectorArrowPath(from, to), [from, to]);
  return (
    <Path
      path={arrowPath}
      style="stroke"
      strokeWidth={2.75}
      strokeCap="round"
      strokeJoin="round"
      color={strokeColor}
      start={0}
      end={animate ? progress : 1}
    />
  );
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

const SlotContentView: React.FC<{
  items: ResolvedAction[];
  textProgress: number;
  isPlaying: boolean;
  isCompact: boolean;
}> = ({ items, textProgress, isPlaying, isCompact }) => {
  if (!items || items.length === 0) return null;
  const primaryItem = items[0];
  const primary = primaryItem.action;
  const primaryRatio = primaryItem.isCurrentStep ? textProgress : 1;
  const primaryShowCursor =
    primaryItem.isCurrentStep &&
    isPlaying &&
    textProgress > 0 &&
    textProgress < 0.995;

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

  if (primary.type === "wb_heading") {
    const token = getColorToken(primary.color);
    const full = normalizeBlockText(primary.text);
    const visible =
      primaryRatio >= 0.995
        ? full
        : full.slice(0, Math.round(full.length * clamp01(primaryRatio)));
    return (
      <View style={styles.headingBox}>
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
    return (
      <View style={styles.flowCardBox}>
        <Text style={[styles.flowCardText, { color: token.text }]}>
          {visible}
          {primaryShowCursor && (
            <Text style={{ color: token.stroke }}>▍</Text>
          )}
        </Text>
      </View>
    );
  }

  // Stacked wb_bullet items: completed prior bullets render at 100%,
  // current step's bullets reveal sequentially across textProgress
  const currentStepBullets = items.filter((it) => it.isCurrentStep);
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
  isPlaying = false,
  replayToken = 0,
  topInset = 76,
  bottomInset = 112,
}) => {
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [detectedAspect, setDetectedAspect] = useState<number>(slideAspectRatio);

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

  // Smooth 60fps Reanimated progress value synced to 50ms audio stepProgress (0 -> 1)
  const clampedProgress = clamp01(stepProgress);
  const activeProgressSV = useSharedValue(clampedProgress);

  useEffect(() => {
    // Snap cleanly to 0 on step switch or replay so borders/arrows never sweep backward
    activeProgressSV.value = 0;
  }, [safeIndex, currentStep?.step_id, replayToken, activeProgressSV]);

  useEffect(() => {
    if (clampedProgress <= 0.01) {
      activeProgressSV.value = 0;
    } else {
      activeProgressSV.value = withTiming(clampedProgress, {
        duration: 65,
        easing: Easing.linear,
      });
    }
  }, [clampedProgress, activeProgressSV]);

  // Choreography phase curves on the UI thread:
  // - Card borders & heading underlines: 0% -> 35%
  // - Connector arrows: 75% -> 100%
  // - PDF overlay highlights/circles: 0% -> 45%
  const borderProgressSV = useDerivedValue(() =>
    Math.max(0, Math.min(1, activeProgressSV.value / 0.35))
  );
  const arrowProgressSV = useDerivedValue(() =>
    Math.max(0, Math.min(1, (activeProgressSV.value - 0.75) / 0.25))
  );
  const pdfProgressSV = useDerivedValue(() =>
    Math.max(0, Math.min(1, activeProgressSV.value / 0.45))
  );

  // Live RN text & code typewriter curve: 15% -> 92% of stepProgress
  const textProgress = clamp01((clampedProgress - 0.15) / 0.77);

  // Simultaneous Pan + Pinch + Double-Tap Reset gestures (60fps UI thread)
  const composedGesture = useMemo(() => {
    const panGesture = Gesture.Pan()
      .minDistance(4)
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

  // Compute aspect-ratio-preserving rect for pdf_overlay
  const contentRect = useMemo(
    () =>
      computeContainRect(
        canvasSize.width,
        canvasSize.height,
        detectedAspect,
        topInset,
        bottomInset
      ),
    [canvasSize.width, canvasSize.height, detectedAspect, topInset, bottomInset]
  );

  // Compute cumulative multi-band whiteboard blocks & dynamic rects
  const wbBlocks = useMemo(
    () => resolveWhiteboardBlocks(safeSteps, safeIndex),
    [safeSteps, safeIndex]
  );

  const cumulativeLayout = useMemo(
    () =>
      computeCumulativeWhiteboardLayout(
        canvasSize.width,
        canvasSize.height,
        wbBlocks,
        topInset,
        bottomInset
      ),
    [canvasSize.width, canvasSize.height, wbBlocks, topInset, bottomInset]
  );

  // Gesture-Safe Auto-Pan Camera Follow: smoothly centers on active blocks below viewport
  useEffect(() => {
    if (
      !currentStep ||
      currentStep.mode !== "whiteboard" ||
      canvasSize.height <= 0
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
    const visibleBottom = canvasSize.height - bottomInset - 12;
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
    canvasSize.height,
    topInset,
    bottomInset,
    userHasManuallyPanned,
    translateY,
    savedY,
  ]);

  // Single-draw-call subtle warm paper grid covering an expanded infinite area
  const gridOverscan = 480;
  const gridPath = useMemo(() => {
    if (cumulativeLayout.boardWidth <= 0 || cumulativeLayout.boardHeight <= 0) {
      return makeEmptyPath();
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
  // MODE 1: PDF OVERLAY (Interactive Pan & Zoom Slide + Progressive Skia)
  // =========================================================================
  if (currentStep.mode === "pdf_overlay") {
    const pdfActions = (currentStep.actions ?? []).filter(
      (a) =>
        a &&
        (a.type === "pdf_highlight" || a.type === "pdf_circle") &&
        a.bbox != null
    );

    return (
      <View style={styles.pdfRoot} onLayout={handleLayout}>
        <GestureDetector gesture={composedGesture}>
          <Animated.View style={[styles.gestureStage, viewportTransformStyle]}>
            {/* Layer 1: Underlying PDF slide locked strictly to contentRect */}
            {canvasSize.width > 0 &&
              (renderPdfLayer ? (
                <View
                  style={[
                    styles.absoluteRect,
                    {
                      left: contentRect.x,
                      top: contentRect.y,
                      width: contentRect.width,
                      height: contentRect.height,
                    },
                  ]}
                >
                  {renderPdfLayer(contentRect)}
                </View>
              ) : slideImageUri ? (
                <Image
                  source={{ uri: slideImageUri }}
                  resizeMode="contain"
                  style={[
                    styles.absoluteRect,
                    {
                      left: contentRect.x,
                      top: contentRect.y,
                      width: contentRect.width,
                      height: contentRect.height,
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
                      left: contentRect.x,
                      top: contentRect.y,
                      width: contentRect.width,
                      height: contentRect.height,
                    },
                  ]}
                >
                  <Text style={styles.pdfPlaceholderText}>
                    PDF Slide Canvas ({Math.round(contentRect.width)}×
                    {Math.round(contentRect.height)})
                  </Text>
                </View>
              ))}

            {/* Layer 2: Transparent 60fps Skia Vector Overlay mapped via [0-1000] bbox */}
            {canvasSize.width > 0 && (
              <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
                {pdfActions.map((action, idx) => {
                  const screenRect = mapBboxToScreenRect(
                    action.bbox!,
                    contentRect
                  );
                  const token = getColorToken(action.color);
                  const key = `pdf-${currentStep.step_id}-${idx}-${action.type}`;

                  if (action.type === "pdf_highlight") {
                    return (
                      <AnimatedHighlightRect
                        key={key}
                        rect={screenRect}
                        color={token.highlight}
                        progress={pdfProgressSV}
                      />
                    );
                  }
                  return (
                    <AnimatedCircleAnnotation
                      key={key}
                      rect={screenRect}
                      strokeColor={token.stroke}
                      progress={pdfProgressSV}
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
  // MODE 2: LIVE PROGRESSIVE INFINITE WHITEBOARD (#FAF8F5 Paper + Auto-Pan)
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
            {/* Layer 1: 60fps Skia Vector Layer (Grid, Progressive Card Frames, Arrows) */}
            {canvasSize.width > 0 && (
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

                {/* Progressive Card Frames & Heading Underlines (0% -> 35% of stepProgress) */}
                {wbBlocks.map((block) => {
                  const rect = blockRects.get(block.blockId);
                  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
                  const primary = block.items[0]?.action;
                  if (!primary) return null;
                  const token = getColorToken(primary.color);
                  const isCode = primary.type === "wb_code";
                  const isHeading = primary.type === "wb_heading";
                  const radius = isHeading ? 12 : 16;
                  const isNewCard = block.createdAtStepIdx === safeIndex;

                  const shiftedRect: RectFrame = {
                    x: rect.x + gridOverscan,
                    y: rect.y + gridOverscan,
                    width: rect.width,
                    height: rect.height,
                  };

                  return (
                    <AnimatedCardFrame
                      key={`frame-${block.blockId}`}
                      rect={shiftedRect}
                      radius={radius}
                      fillColor={isCode ? "#0F172A" : token.fill}
                      strokeColor={isCode ? "#334155" : token.stroke}
                      strokeWidth={primary.type === "wb_flow_card" ? 2 : 1.5}
                      isHeading={isHeading}
                      animate={isNewCard}
                      borderProgress={borderProgressSV}
                    />
                  );
                })}

                {/* Cause-and-Effect Connector Arrows (75% -> 100% of stepProgress) */}
                {arrowBlocks.map((block) => {
                  const fromRect = blockRects.get(block.connectFromBlockId!);
                  const toRect = blockRects.get(block.blockId);
                  if (!fromRect || !toRect) return null;
                  const primary = block.items[0].action;
                  const token = getColorToken(primary.color);
                  const shiftedFrom: RectFrame = {
                    ...fromRect,
                    x: fromRect.x + gridOverscan,
                    y: fromRect.y + gridOverscan,
                  };
                  const shiftedTo: RectFrame = {
                    ...toRect,
                    x: toRect.x + gridOverscan,
                    y: toRect.y + gridOverscan,
                  };
                  return (
                    <AnimatedArrowPath
                      key={`arrow-${block.blockId}`}
                      from={shiftedFrom}
                      to={shiftedTo}
                      strokeColor={token.stroke}
                      animate={block.createdAtStepIdx === safeIndex}
                      progress={arrowProgressSV}
                    />
                  );
                })}
              </Canvas>
            )}

            {/* Layer 2: Live Typewriter RN Text & Syntax-Highlighted Code Overlays (15% -> 92%) */}
            {canvasSize.width > 0 &&
              wbBlocks.map((block) => {
                const rect = blockRects.get(block.blockId);
                if (!rect || rect.width <= 0 || rect.height <= 0) return null;
                const isCode = block.items[0]?.action.type === "wb_code";
                const isCompact =
                  block.slot === "left_col" || block.slot === "right_col";

                return (
                  <View
                    key={`block-${block.blockId}`}
                    style={[
                      styles.slotContainer,
                      isCode && styles.codeSlotContainer,
                      {
                        left: rect.x,
                        top: rect.y,
                        width: rect.width,
                        height: rect.height,
                      },
                    ]}
                  >
                    <SlotContentView
                      items={block.items}
                      textProgress={textProgress}
                      isPlaying={isPlaying}
                      isCompact={isCompact}
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
// Styles
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
  headingBox: {
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: 8,
  },
  headingText: {
    fontSize: 17.5,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 24,
  },
  flowCardBox: {
    justifyContent: "center",
    alignItems: "center",
  },
  flowCardText: {
    fontSize: 14.5,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 21,
  },
  equationBox: {
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 6,
  },
  equationText: {
    fontSize: 16.5,
    fontWeight: "600",
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
    textAlign: "center",
    lineHeight: 24,
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
  },
  codeLineCount: {
    color: "#94A3B8",
    fontSize: 10,
    fontWeight: "600",
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
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
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
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
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
  },
});

export default SmartBoardCanvas;

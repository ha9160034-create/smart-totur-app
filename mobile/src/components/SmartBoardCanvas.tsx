import React, { useEffect, useMemo, useState } from "react";
import {
  Image,
  LayoutChangeEvent,
  Platform,
  ScrollView,
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
import Animated, {
  Easing,
  FadeIn,
  SharedValue,
  useDerivedValue,
  useSharedValue,
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
}

// ---------------------------------------------------------------------------
// Color System (Strict Match to VisualAction["color"])
// ---------------------------------------------------------------------------
interface ColorToken {
  stroke: string;
  fill: string;
  highlight: string;
  text: string;
}

const COLOR_MAP: Record<VisualAction["color"], ColorToken> = {
  blue: {
    stroke: "#2563EB",
    fill: "#EFF6FF",
    highlight: "rgba(37, 99, 235, 0.24)",
    text: "#1E3A8A",
  },
  red: {
    stroke: "#DC2626",
    fill: "#FEF2F2",
    highlight: "rgba(220, 38, 38, 0.24)",
    text: "#991B1B",
  },
  green: {
    stroke: "#16A34A",
    fill: "#F0FDF4",
    highlight: "rgba(22, 163, 74, 0.24)",
    text: "#166534",
  },
  yellow: {
    stroke: "#CA8A04",
    fill: "#FEFCE8",
    highlight: "rgba(250, 204, 21, 0.42)",
    text: "#854D0E",
  },
  black: {
    stroke: "#0F172A",
    fill: "#F8FAFC",
    highlight: "rgba(15, 23, 42, 0.16)",
    text: "#0F172A",
  },
};

function getColorToken(color?: VisualAction["color"]): ColorToken {
  return (color && COLOR_MAP[color]) || COLOR_MAP.blue;
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

  // Fallback for older mutable SkPath versions
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

// ---------------------------------------------------------------------------
// Pure Geometry Math: Aspect-Ratio Contain & [0-1000] BBox Mapping
// ---------------------------------------------------------------------------
function computeContainRect(
  containerW: number,
  containerH: number,
  contentAspect: number
): RectFrame {
  if (containerW <= 0 || containerH <= 0 || contentAspect <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const containerAspect = containerW / containerH;
  if (contentAspect > containerAspect) {
    // Letterboxed top & bottom
    const width = containerW;
    const height = containerW / contentAspect;
    return { x: 0, y: (containerH - height) / 2, width, height };
  }
  // Pillarboxed left & right
  const height = containerH;
  const width = containerH * contentAspect;
  return { x: (containerW - width) / 2, y: 0, width, height };
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
// Pure Geometry Math: 6 Non-Overlapping Whiteboard Slots + Auto Arrows
// ---------------------------------------------------------------------------
interface ResolvedAction {
  key: string;
  action: VisualAction;
  isCurrentStep: boolean;
}

function computeWhiteboardSlots(
  canvasW: number,
  canvasH: number,
  activeSlots: Set<WhiteboardSlot>
): Record<WhiteboardSlot, RectFrame> {
  const pad = 12;
  const rowGap = 10;
  const colGap = 24; // Dedicated channel for left_col <-> right_col Skia arrows

  const innerW = Math.max(0, canvasW - pad * 2);
  const innerH = Math.max(0, canvasH - pad * 2);

  const hasHeader = activeSlots.has("header");
  const hasMainTop = activeSlots.has("main_top");
  const hasCols = activeSlots.has("left_col") || activeSlots.has("right_col");
  const hasBottom = activeSlots.has("bottom_summary");

  const headerH = hasHeader ? Math.max(44, Math.min(60, innerH * 0.11)) : 0;
  const bodyTop = pad + (hasHeader ? headerH + rowGap : 0);
  const bodyH = Math.max(0, pad + innerH - bodyTop);

  // Dynamically allocate vertical weights only to active rows (0% dead whitespace)
  const activeRows =
    (hasMainTop ? 1 : 0) + (hasCols ? 1 : 0) + (hasBottom ? 1 : 0);
  const totalGaps = Math.max(0, activeRows - 1) * rowGap;
  const usableBodyH = Math.max(0, bodyH - totalGaps);

  const wMain = hasMainTop ? 0.26 : 0;
  const wCols = hasCols ? 0.44 : 0;
  const wBottom = hasBottom ? 0.34 : 0;
  const weightSum = wMain + wCols + wBottom || 1;

  const mainTopH = hasMainTop ? (wMain / weightSum) * usableBodyH : 0;
  const colsH = hasCols ? (wCols / weightSum) * usableBodyH : 0;
  const bottomH = hasBottom ? (wBottom / weightSum) * usableBodyH : 0;

  let cursorY = bodyTop;
  const mainTopY = cursorY;
  if (hasMainTop) cursorY += mainTopH + rowGap;

  const colsY = cursorY;
  if (hasCols) cursorY += colsH + rowGap;

  const bottomY = cursorY;
  const halfW = Math.max(0, (innerW - colGap) / 2);

  return {
    header: { x: pad, y: pad, width: innerW, height: headerH },
    main_top: { x: pad, y: mainTopY, width: innerW, height: mainTopH },
    left_col: { x: pad, y: colsY, width: halfW, height: colsH },
    right_col: { x: pad + halfW + colGap, y: colsY, width: halfW, height: colsH },
    bottom_summary: { x: pad, y: bottomY, width: innerW, height: bottomH },
    full_canvas: { x: pad, y: bodyTop, width: innerW, height: bodyH },
  };
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
  const margin = 4;

  // Choose clean edge-to-edge anchor points so arrows never cross card text
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

  // Slight curve for diagonal connectors; straight crisp line for aligned slots
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  const isDiagonal = Math.abs(startX - endX) > 12 && Math.abs(startY - endY) > 12;
  const ctrlX = midX;
  const ctrlY = isDiagonal ? startY : midY;

  // Arrowhead aligned with incoming tangent vector
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
// Deterministic Step-State Replay (Handles clear_board & Progressive Building)
// ---------------------------------------------------------------------------
function resolveWhiteboardActions(
  steps: TeachingStep[],
  currentStepIndex: number
): ResolvedAction[] {
  const safeSteps = Array.isArray(steps) ? steps : [];
  let accumulated: ResolvedAction[] = [];

  for (let i = 0; i <= currentStepIndex; i++) {
    const step = safeSteps[i];
    if (!step) continue;

    if (step.mode !== "whiteboard") {
      // Leaving whiteboard resets accumulated canvas state
      accumulated = [];
      continue;
    }

    const isCurrent = i === currentStepIndex;
    const actions = Array.isArray(step.actions) ? step.actions : [];
    for (let j = 0; j < actions.length; j++) {
      const action = actions[j];
      if (!action) continue;
      if (action.type === "clear_board") {
        accumulated = [];
        continue;
      }
      if (!action.slot) continue;

      // Keep multiple bullets stacked inside the same slot; replace non-bullet slot items cleanly
      if (action.type !== "wb_bullet") {
        accumulated = accumulated.filter(
          (item) => item.action.slot !== action.slot
        );
      }

      accumulated.push({
        key: `s${step.step_id}-a${j}-${action.type}-${action.slot}`,
        action,
        isCurrentStep: isCurrent,
      });
    }
  }

  return accumulated;
}

// ---------------------------------------------------------------------------
// Animated Skia Primitives (60fps UI Thread via Reanimated SharedValues)
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
// Slot Content Renderers (Wrapped Text, Code Highlighting, Equations, Cards)
// ---------------------------------------------------------------------------
const CodeBlockView: React.FC<{ action: VisualAction }> = ({ action }) => {
  const lines = (action.text ?? "").split("\n");
  const highlighted = new Set(action.highlight_lines ?? []);
  const token = getColorToken(action.color);

  return (
    <View style={styles.codeContainer}>
      <View style={styles.codeHeader}>
        <Text style={styles.codeLangBadge}>
          {(action.code_lang ?? "code").toUpperCase()}
        </Text>
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        contentContainerStyle={styles.codeBody}
      >
        {lines.map((line, idx) => {
          const lineNum = idx + 1;
          const isHighlighted = highlighted.has(lineNum);
          return (
            <View
              key={lineNum}
              style={[
                styles.codeLineRow,
                isHighlighted && {
                  backgroundColor: "rgba(59, 130, 246, 0.25)",
                  borderLeftWidth: 3,
                  borderLeftColor: token.stroke,
                },
              ]}
            >
              <Text style={styles.codeLineNumber}>{lineNum}</Text>
              <Text style={styles.codeLineText}>{line || " "}</Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
};

const SlotContentView: React.FC<{ items: ResolvedAction[] }> = ({ items }) => {
  if (!items || items.length === 0) return null;
  const primary = items[0].action;

  if (primary.type === "wb_code") {
    return <CodeBlockView action={primary} />;
  }

  if (primary.type === "wb_heading") {
    const token = getColorToken(primary.color);
    return (
      <View style={styles.headingBox}>
        <Text
          numberOfLines={2}
          adjustsFontSizeToFit
          style={[styles.headingText, { color: token.text }]}
        >
          {primary.text ?? ""}
        </Text>
      </View>
    );
  }

  if (primary.type === "wb_equation") {
    const token = getColorToken(primary.color);
    return (
      <ScrollView
        contentContainerStyle={styles.equationBox}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        <Text style={[styles.equationText, { color: token.text }]}>
          {primary.text ?? ""}
        </Text>
      </ScrollView>
    );
  }

  if (primary.type === "wb_flow_card") {
    const token = getColorToken(primary.color);
    return (
      <ScrollView
        contentContainerStyle={styles.flowCardBox}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        <Text style={[styles.flowCardText, { color: token.text }]}>
          {primary.text ?? ""}
        </Text>
      </ScrollView>
    );
  }

  // Stacked wb_bullet items inside a single slot
  return (
    <ScrollView
      contentContainerStyle={styles.bulletList}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
    >
      {items.map((item) => {
        const token = getColorToken(item.action.color);
        return (
          <View key={item.key} style={styles.bulletRow}>
            <View
              style={[styles.bulletDot, { backgroundColor: token.stroke }]}
            />
            <Text style={[styles.bulletText, { color: token.text }]}>
              {item.action.text ?? ""}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
};

// ---------------------------------------------------------------------------
// Main Component: SmartBoardCanvas (60fps PDF Overlay + Smart Whiteboard)
// ---------------------------------------------------------------------------
export const SmartBoardCanvas: React.FC<SmartBoardCanvasProps> = ({
  steps,
  currentStepIndex,
  slideImageUri,
  slideAspectRatio = 16 / 9,
  renderPdfLayer,
}) => {
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [detectedAspect, setDetectedAspect] = useState<number>(slideAspectRatio);

  // Sync external aspect ratio prop if it changes across slides
  useEffect(() => {
    setDetectedAspect(slideAspectRatio > 0 ? slideAspectRatio : 16 / 9);
  }, [slideAspectRatio]);

  const safeSteps = useMemo(() => (Array.isArray(steps) ? steps : []), [steps]);
  const safeIndex = Math.max(0, Math.min(currentStepIndex, safeSteps.length - 1));
  const currentStep = safeSteps[safeIndex];

  // Reanimated shared value driving 60fps Skia path drawing for the active step
  const stepProgress = useSharedValue(0);
  useEffect(() => {
    stepProgress.value = 0;
    stepProgress.value = withTiming(1, {
      duration: 520,
      easing: Easing.out(Easing.cubic),
    });
  }, [safeIndex, currentStep?.step_id, stepProgress]);

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
        detectedAspect
      ),
    [canvasSize.width, canvasSize.height, detectedAspect]
  );

  // Compute accumulated whiteboard actions & slot geometry
  const wbActions = useMemo(
    () => resolveWhiteboardActions(safeSteps, safeIndex),
    [safeSteps, safeIndex]
  );

  const groupedBySlot = useMemo(() => {
    const map = new Map<WhiteboardSlot, ResolvedAction[]>();
    for (const item of wbActions) {
      const slot = item.action.slot;
      if (!slot) continue;
      const existing = map.get(slot) ?? [];
      existing.push(item);
      map.set(slot, existing);
    }
    return map;
  }, [wbActions]);

  const activeSlotSet = useMemo(
    () => new Set<WhiteboardSlot>(groupedBySlot.keys()),
    [groupedBySlot]
  );

  const slotRects = useMemo(
    () =>
      computeWhiteboardSlots(
        canvasSize.width,
        canvasSize.height,
        activeSlotSet
      ),
    [canvasSize.width, canvasSize.height, activeSlotSet]
  );

  // Single-draw-call subtle engineering grid path for 60fps whiteboard background
  const gridPath = useMemo(() => {
    if (canvasSize.width <= 0 || canvasSize.height <= 0) {
      return makeEmptyPath();
    }
    const spacing = 28;
    return makePathFromBuilder((builder) => {
      for (let x = spacing; x < canvasSize.width; x += spacing) {
        builder.moveTo(x, 0);
        builder.lineTo(x, canvasSize.height);
      }
      for (let y = spacing; y < canvasSize.height; y += spacing) {
        builder.moveTo(0, y);
        builder.lineTo(canvasSize.width, y);
      }
    });
  }, [canvasSize.width, canvasSize.height]);

  if (!currentStep) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No teaching step loaded.</Text>
      </View>
    );
  }

  // =========================================================================
  // MODE 1: PDF OVERLAY (Aspect-Ratio Locked Slide + 60fps Transparent Skia)
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
              style={StyleSheet.absoluteFill}
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
              const screenRect = mapBboxToScreenRect(action.bbox!, contentRect);
              const token = getColorToken(action.color);
              const key = `pdf-${currentStep.step_id}-${idx}-${action.type}`;

              if (action.type === "pdf_highlight") {
                return (
                  <AnimatedHighlightRect
                    key={key}
                    rect={screenRect}
                    color={token.highlight}
                    progress={stepProgress}
                  />
                );
              }
              return (
                <AnimatedCircleAnnotation
                  key={key}
                  rect={screenRect}
                  strokeColor={token.stroke}
                  progress={stepProgress}
                />
              );
            })}
          </Canvas>
        )}
      </View>
    );
  }

  // =========================================================================
  // MODE 2: SMART WHITEBOARD (6 Disjoint Slots + Skia Cards & Auto Arrows)
  // =========================================================================
  const arrowActions = wbActions.filter(
    (item) =>
      item.action.type === "wb_flow_card" &&
      item.action.slot &&
      item.action.connect_from_slot &&
      activeSlotSet.has(item.action.connect_from_slot)
  );

  return (
    <View style={styles.whiteboardRoot} onLayout={handleLayout}>
      {/* Layer 1: 60fps Skia Vector Layer (Dot Grid, Card Frames, Auto Arrows) */}
      {canvasSize.width > 0 && (
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          {/* Single-Draw-Call Academic Grid */}
          <Path
            path={gridPath}
            style="stroke"
            strokeWidth={0.75}
            color="rgba(148, 163, 184, 0.22)"
          />

          {/* Slot Card Vector Surfaces */}
          {Array.from(groupedBySlot.entries()).map(([slot, items]) => {
            const rect = slotRects[slot];
            if (!rect || rect.width <= 0 || rect.height <= 0) return null;
            const primary = items[0]?.action;
            if (!primary) return null;
            const token = getColorToken(primary.color);
            const isCode = primary.type === "wb_code";
            const radius = primary.type === "wb_heading" ? 10 : 14;

            return (
              <React.Fragment key={`frame-${slot}`}>
                <RoundedRect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  r={radius}
                  color={isCode ? "#0F172A" : token.fill}
                />
                <RoundedRect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  r={radius}
                  style="stroke"
                  strokeWidth={primary.type === "wb_flow_card" ? 2 : 1.5}
                  color={isCode ? "#334155" : token.stroke}
                />
              </React.Fragment>
            );
          })}

          {/* Cause-and-Effect Connector Arrows (connect_from_slot -> slot) */}
          {arrowActions.map((item) => {
            const fromRect = slotRects[item.action.connect_from_slot!];
            const toRect = slotRects[item.action.slot!];
            if (!fromRect || !toRect) return null;
            const token = getColorToken(item.action.color);
            return (
              <AnimatedArrowPath
                key={`arrow-${item.key}`}
                from={fromRect}
                to={toRect}
                strokeColor={token.stroke}
                animate={item.isCurrentStep}
                progress={stepProgress}
              />
            );
          })}
        </Canvas>
      )}

      {/* Layer 2: Mathematically Locked Slot Content (Zero Overlap, Crisp Text) */}
      {canvasSize.width > 0 &&
        Array.from(groupedBySlot.entries()).map(([slot, items]) => {
          const rect = slotRects[slot];
          if (!rect || rect.width <= 0 || rect.height <= 0) return null;
          const isNew = items.some((i) => i.isCurrentStep);

          return (
            <Animated.View
              key={`slot-${slot}-${items.map((i) => i.key).join("|")}`}
              entering={isNew ? FadeIn.duration(260) : undefined}
              style={[
                styles.slotContainer,
                {
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
              ]}
            >
              <SlotContentView items={items} />
            </Animated.View>
          );
        })}
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
    backgroundColor: "#F8FAFC",
  },
  emptyText: {
    color: "#64748B",
    fontSize: 14,
  },
  pdfRoot: {
    flex: 1,
    backgroundColor: "#0F172A",
    overflow: "hidden",
  },
  absoluteRect: {
    position: "absolute",
    overflow: "hidden",
  },
  pdfPlaceholder: {
    position: "absolute",
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  pdfPlaceholderText: {
    color: "#94A3B8",
    fontSize: 13,
  },
  whiteboardRoot: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
  },
  slotContainer: {
    position: "absolute",
    overflow: "hidden",
    padding: 10,
  },
  headingBox: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  headingText: {
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
  },
  flowCardBox: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  flowCardText: {
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 20,
  },
  equationBox: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  equationText: {
    fontSize: 16,
    fontWeight: "600",
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
    textAlign: "center",
  },
  bulletList: {
    gap: 6,
    paddingVertical: 2,
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  bulletDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginTop: 6,
  },
  bulletText: {
    flex: 1,
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: "500",
  },
  codeContainer: {
    flex: 1,
    margin: -10,
  },
  codeHeader: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "#1E293B",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    flexDirection: "row",
    alignItems: "center",
  },
  codeLangBadge: {
    color: "#93C5FD",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  codeBody: {
    paddingVertical: 6,
  },
  codeLineRow: {
    flexDirection: "row",
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignItems: "flex-start",
  },
  codeLineNumber: {
    width: 22,
    color: "#64748B",
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  codeLineText: {
    flex: 1,
    color: "#F8FAFC",
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
});

export default SmartBoardCanvas;

import { Skia } from "@shopify/react-native-skia";
import type { SkPath } from "@shopify/react-native-skia";
import type { DiagramStencil, SketchIcon } from "../types/schema";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------
export interface RoughRectFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PenTrailPoint {
  x: number;
  y: number;
}

export interface SkiaPathWithTrail {
  path: SkPath;
  trail: PenTrailPoint[];
}

export interface StencilLayerPaths {
  outlinePath: SkPath;
  fillPath: SkPath;
  trail: PenTrailPoint[];
}

// ---------------------------------------------------------------------------
// Deterministic Seeded PRNG (Zero Re-render Jitter)
// ---------------------------------------------------------------------------

/**
 * Deterministic 32-bit FNV-1a string hash returning an unsigned 32-bit seed.
 */
export function hashSeed(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic mulberry32 PRNG yielding numbers in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Modern Skia PathBuilder Wrapper (Skia v2.14.0 + Legacy Fallback)
// ---------------------------------------------------------------------------
interface PathDrawOps {
  moveTo: (x: number, y: number) => unknown;
  lineTo: (x: number, y: number) => unknown;
  quadTo: (x1: number, y1: number, x2: number, y2: number) => unknown;
}

/**
 * Creates a safe empty SkPath using PathBuilder when available,
 * falling back to Skia.Path.Make() for older runtimes.
 */
export function makeEmptySkiaPath(): SkPath {
  if (typeof Skia?.PathBuilder?.Make === "function") {
    return Skia.PathBuilder.Make().build();
  }
  return Skia.Path.Make();
}

function makePathFromBuilder(draw: (builder: PathDrawOps) => void): SkPath {
  if (typeof Skia?.PathBuilder?.Make === "function") {
    const builder = Skia.PathBuilder.Make();
    draw(builder);
    return builder.build();
  }

  const legacyPath = Skia.Path.Make() as unknown as Partial<PathDrawOps>;
  if (typeof legacyPath?.moveTo === "function") {
    draw(legacyPath as PathDrawOps);
  }
  return legacyPath as SkPath;
}

// ---------------------------------------------------------------------------
// Low-Level Hand-Drawn Stroke Primitives
// ---------------------------------------------------------------------------
function jitter(rng: () => number, amplitude: number): number {
  return (rng() * 2 - 1) * amplitude;
}

function clampRoughness(roughness: number): number {
  if (!Number.isFinite(roughness) || roughness < 0) return 0;
  return Math.min(roughness, 4);
}

/**
 * Draws a single gently bowed hand-drawn stroke from (x1, y1) to (x2, y2).
 * Enforces a deterministic signed minimum bow so short/narrow phone edges
 * never collapse into ruler-straight segments on 3x Retina displays.
 */
function addBowedSegment(
  b: PathDrawOps,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rng: () => number,
  roughness: number,
  moveFirst: boolean,
  preferredSign?: number
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;

  const r = clampRoughness(roughness);
  const maxOffset = Math.min(len * 0.085, 2.8 * r);
  const minBow = Math.min(maxOffset * 0.85, Math.min(len * 0.032, 1.35 * r));
  const nx = -dy / len;
  const ny = dx / len;

  const t = 0.43 + rng() * 0.14;
  const sign =
    preferredSign !== undefined && preferredSign !== 0
      ? preferredSign > 0
        ? 1
        : -1
      : rng() > 0.5
      ? 1
      : -1;
  const bowMag = minBow + rng() * Math.max(0, maxOffset - minBow);
  const bow = sign * bowMag;
  const cx = x1 + dx * t + nx * bow;
  const cy = y1 + dy * t + ny * bow;

  if (moveFirst) {
    b.moveTo(x1, y1);
  }
  b.quadTo(cx, cy, x2, y2);
}

/**
 * Draws a rough hand-drawn line with optional visibly separated double-stroke pass
 * (2.2px-3.0px perpendicular separation on standard roughness).
 */
function addRoughLine(
  b: PathDrawOps,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rng: () => number,
  roughness: number,
  doubleStroke: boolean
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;

  const r = clampRoughness(roughness);
  const endAmp = Math.min(len * 0.04, 1.0 * r);
  const sign1 = rng() > 0.5 ? 1 : -1;

  addBowedSegment(
    b,
    x1 + jitter(rng, endAmp),
    y1 + jitter(rng, endAmp),
    x2 + jitter(rng, endAmp),
    y2 + jitter(rng, endAmp),
    rng,
    r,
    true,
    sign1
  );

  if (doubleStroke) {
    const nx = -dy / len;
    const ny = dx / len;
    const sep = Math.min(len * 0.09, (2.2 + rng() * 0.85) * r) * (rng() > 0.5 ? 1 : -1);
    const secondAmp = Math.min(len * 0.045, 1.15 * r);
    addBowedSegment(
      b,
      x1 + nx * sep + jitter(rng, secondAmp),
      y1 + ny * sep + jitter(rng, secondAmp),
      x2 + nx * sep + jitter(rng, secondAmp),
      y2 + ny * sep + jitter(rng, secondAmp),
      rng,
      r * 1.1,
      true,
      -sign1
    );
  }
}

/**
 * Draws a smooth organic quadratic curve through a sequence of (x, y) sample points.
 */
function addSmoothPolyCurve(
  b: PathDrawOps,
  points: ReadonlyArray<{ x: number; y: number }>
): void {
  if (points.length < 2) return;
  b.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    b.lineTo(points[1].x, points[1].y);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const curr = points[i];
    const next = points[i + 1];
    const midX = (curr.x + next.x) * 0.5;
    const midY = (curr.y + next.y) * 0.5;
    b.quadTo(curr.x, curr.y, midX, midY);
  }
  const last = points[points.length - 1];
  b.lineTo(last.x, last.y);
}

// ---------------------------------------------------------------------------
// 1. Hand-Drawn Rounded Rectangle (Double-Stroke Marker + Corner Overshoots)
// ---------------------------------------------------------------------------
function addRoughRoundedRectPass(
  b: PathDrawOps,
  rect: RoughRectFrame,
  radius: number,
  rng: () => number,
  roughness: number,
  overshoot: number,
  passIndex = 0
): void {
  const { x, y, width: w, height: h } = rect;
  const rad = Math.max(0, Math.min(radius, w / 2, h / 2));
  const r = clampRoughness(roughness);
  const cornerJit = Math.min(Math.min(w, h) * 0.038, 1.55 * r);

  // Intentional 2.2px-3.2px directional separation on secondary pass so double-strokes
  // stay clearly distinct on high-DPI (3x Retina iPhone) screens
  const sepMag =
    passIndex > 0 ? Math.min(Math.min(w, h) * 0.06, (2.2 + rng() * 1.0) * r) : 0;
  const sepSignX = passIndex > 0 ? (rng() > 0.5 ? 1 : -1) : 0;
  const sepSignY = passIndex > 0 ? (rng() > 0.5 ? 1 : -1) : 0;
  const ox = sepSignX * sepMag * 0.78;
  const oy = sepSignY * sepMag * 0.78;
  const bowBias = passIndex === 0 ? 1 : -1;

  // Corner anchor points with organic variation + directional pass offset
  const tlTopX = x + rad + ox + jitter(rng, cornerJit);
  const tlTopY = y + oy + jitter(rng, cornerJit);

  const trTopX = x + w - rad + ox + jitter(rng, cornerJit);
  const trTopY = y + oy + jitter(rng, cornerJit);
  const trRightX = x + w + ox + jitter(rng, cornerJit);
  const trRightY = y + rad + oy + jitter(rng, cornerJit);

  const brRightX = x + w + ox + jitter(rng, cornerJit);
  const brRightY = y + h - rad + oy + jitter(rng, cornerJit);
  const brBotX = x + w - rad + ox + jitter(rng, cornerJit);
  const brBotY = y + h + oy + jitter(rng, cornerJit);

  const blBotX = x + rad + ox + jitter(rng, cornerJit);
  const blBotY = y + h + oy + jitter(rng, cornerJit);
  const blLeftX = x + ox + jitter(rng, cornerJit);
  const blLeftY = y + h - rad + oy + jitter(rng, cornerJit);

  const tlLeftX = x + ox + jitter(rng, cornerJit);
  const tlLeftY = y + rad + oy + jitter(rng, cornerJit);

  b.moveTo(tlTopX, tlTopY);

  // Top edge -> Top-right corner
  addBowedSegment(b, tlTopX, tlTopY, trTopX, trTopY, rng, r, false, bowBias);
  if (rad > 0.5) {
    b.quadTo(
      x + w + ox + jitter(rng, cornerJit * 0.85),
      y + oy + jitter(rng, cornerJit * 0.85),
      trRightX,
      trRightY
    );
  }

  // Right edge -> Bottom-right corner
  addBowedSegment(b, trRightX, trRightY, brRightX, brRightY, rng, r, false, -bowBias);
  if (rad > 0.5) {
    b.quadTo(
      x + w + ox + jitter(rng, cornerJit * 0.85),
      y + h + oy + jitter(rng, cornerJit * 0.85),
      brBotX,
      brBotY
    );
  }

  // Bottom edge -> Bottom-left corner
  addBowedSegment(b, brBotX, brBotY, blBotX, blBotY, rng, r, false, bowBias);
  if (rad > 0.5) {
    b.quadTo(
      x + ox + jitter(rng, cornerJit * 0.85),
      y + h + oy + jitter(rng, cornerJit * 0.85),
      blLeftX,
      blLeftY
    );
  }

  // Left edge -> Top-left corner
  addBowedSegment(b, blLeftX, blLeftY, tlLeftX, tlLeftY, rng, r, false, -bowBias);
  if (rad > 0.5) {
    b.quadTo(
      x + ox + jitter(rng, cornerJit * 0.85),
      y + oy + jitter(rng, cornerJit * 0.85),
      tlTopX + jitter(rng, cornerJit * 0.65),
      tlTopY + jitter(rng, cornerJit * 0.65)
    );
  } else {
    b.lineTo(
      tlTopX + jitter(rng, cornerJit * 0.65),
      tlTopY + jitter(rng, cornerJit * 0.65)
    );
  }

  // Natural marker closure overshoot + crisp 3px-4px architectural corner overshoots
  if (overshoot > 0 && w - rad * 2 > overshoot * 2) {
    b.lineTo(
      tlTopX + overshoot + jitter(rng, cornerJit * 0.45),
      tlTopY + jitter(rng, cornerJit * 0.5)
    );
  }

  // Add subtle 3px-4px hand-drawn marker corner overshoots on primary pass for card/table frames
  if (passIndex === 0 && overshoot > 0 && w >= 48 && h >= 28 && r >= 0.55) {
    const tick = Math.min(4.0, (3.0 + rng() * 1.0) * Math.min(1.1, r));
    // Top-right outward horizontal nib flick
    b.moveTo(trTopX - 1, trTopY);
    b.lineTo(trTopX + tick, trTopY + jitter(rng, 0.5 * r));
    // Bottom-left outward vertical nib flick
    b.moveTo(blLeftX, blLeftY - 1);
    b.lineTo(blLeftX + jitter(rng, 0.5 * r), blLeftY + tick);
  }
}

/**
 * Creates an organic double-stroke hand-drawn marker rounded rectangle
 * with guaranteed curve bow, 2.2px-3.2px secondary pass separation, and 3px-4px corner overshoots.
 */
export function createRoughRectPath(
  rect: RoughRectFrame,
  radius: number,
  seed: number,
  roughness = 1
): SkPath {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return makeEmptySkiaPath();
  }
  const rng = mulberry32(seed);
  const safeRough = Math.min(
    clampRoughness(roughness),
    Math.min(rect.width, rect.height) / 14
  );

  return makePathFromBuilder((b) => {
    // Primary continuous clockwise marker stroke with crisp corner overshoots
    addRoughRoundedRectPass(b, rect, radius, rng, safeRough, 4.0, 0);
    // Secondary separated sketchy over-stroke (2.2px-3.2px offset) for iPhone/Android parity
    addRoughRoundedRectPass(b, rect, radius, rng, safeRough * 1.15, 0, 1);
  });
}

// ---------------------------------------------------------------------------
// 2. Hand-Drawn Double-Stroke Curved Marker Underline
// ---------------------------------------------------------------------------

/**
 * Creates an organic double-stroke curved marker underline anchored cleanly near y + height - 4.
 */
export function createRoughUnderlinePath(
  rect: RoughRectFrame,
  seed: number,
  roughness = 1
): SkPath {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return makeEmptySkiaPath();
  }

  const rng = mulberry32(seed);
  const r = clampRoughness(roughness);
  const inset = Math.min(24, rect.width * 0.08);
  const xStart = rect.x + inset;
  const xEnd = rect.x + rect.width - inset;
  const span = xEnd - xStart;
  if (span <= 2) return makeEmptySkiaPath();

  const baseY = rect.y + rect.height - 5;
  const bow1 = (1.5 + rng() * 1.4) * r * (rng() > 0.5 ? -1 : 1);
  const bow2 = (1.3 + rng() * 1.3) * r * (bow1 > 0 ? -1 : 1);

  return makePathFromBuilder((b) => {
    // First confident marker sweep left -> right
    const y1Start = baseY + jitter(rng, 0.8 * r);
    const y1End = baseY + jitter(rng, 0.9 * r);
    const mid1X = xStart + span * (0.44 + rng() * 0.12);
    const mid1Y = baseY + bow1;
    b.moveTo(xStart, y1Start);
    b.quadTo(mid1X, mid1Y, xEnd, y1End);

    // Second visibly separated (2.4px-3.2px) underline pass
    const extraInset = Math.min(14, span * 0.06);
    const yOffset = 2.4 + rng() * 0.8;
    const x2Start = xStart + extraInset + jitter(rng, 1.6 * r);
    const x2End = xEnd - extraInset * 0.75 + jitter(rng, 1.6 * r);
    const y2Start = baseY + yOffset + jitter(rng, 0.8 * r);
    const y2End = baseY + yOffset + jitter(rng, 0.8 * r);
    const mid2X = (x2Start + x2End) * (0.46 + rng() * 0.08);
    const mid2Y = baseY + yOffset + bow2;
    b.moveTo(x2Start, y2Start);
    b.quadTo(mid2X, mid2Y, x2End, y2End);
  });
}

// ---------------------------------------------------------------------------
// 3. Hand-Drawn Curved Connector Arrow + Sketchy Arrowhead
// ---------------------------------------------------------------------------

/**
 * Creates a hand-drawn curved connector shaft from edge to edge of `from` -> `to`
 * plus a double-stroke sketchy arrowhead.
 */
export function createRoughArrowPath(
  from: RoughRectFrame,
  to: RoughRectFrame,
  seed: number,
  roughness = 1
): SkPath {
  if (
    !from ||
    !to ||
    from.width <= 0 ||
    from.height <= 0 ||
    to.width <= 0 ||
    to.height <= 0
  ) {
    return makeEmptySkiaPath();
  }

  const rng = mulberry32(seed);
  const r = clampRoughness(roughness);

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

  const spanX = endX - startX;
  const spanY = endY - startY;
  const dist = Math.hypot(spanX, spanY);
  if (dist < 2) return makeEmptySkiaPath();

  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  const isDiagonal = Math.abs(spanX) > 12 && Math.abs(spanY) > 12;

  const nx = -spanY / dist;
  const ny = spanX / dist;
  const bowMag = Math.min(dist * 0.12, 8) * (rng() > 0.5 ? 1 : -1) * Math.max(0.4, r);

  const ctrlX = (isDiagonal ? midX : midX + nx * bowMag) + jitter(rng, 2.2 * r);
  const ctrlY = (isDiagonal ? startY : midY + ny * bowMag) + jitter(rng, 2.2 * r);

  // Tangent direction at end of quadratic Bezier is (end - ctrl)
  const angle = Math.atan2(endY - ctrlY, endX - ctrlX);
  const headLen = Math.min(12, Math.max(7, dist * 0.28));
  const spread = Math.PI / 6;

  const sep = Math.min(dist * 0.08, (2.2 + rng() * 0.9) * r) * (rng() > 0.5 ? 1 : -1);

  return makePathFromBuilder((b) => {
    // Pass 1: primary curved shaft
    b.moveTo(startX + jitter(rng, 0.8 * r), startY + jitter(rng, 0.8 * r));
    b.quadTo(ctrlX, ctrlY, endX, endY);

    // Pass 2: visibly separated (2.2px-3.1px) companion hand-drawn shaft
    b.moveTo(
      startX + nx * sep + jitter(rng, 0.9 * r),
      startY + ny * sep + jitter(rng, 0.9 * r)
    );
    b.quadTo(
      ctrlX + nx * sep * 1.15 + jitter(rng, 1.8 * r),
      ctrlY + ny * sep * 1.15 + jitter(rng, 1.8 * r),
      endX + nx * sep * 0.55 + jitter(rng, 0.9 * r),
      endY + ny * sep * 0.55 + jitter(rng, 0.9 * r)
    );

    // Double-stroke sketchy arrowhead wings
    for (let pass = 0; pass < 2; pass++) {
      const tipX = endX + jitter(rng, (0.6 + pass * 0.5) * r);
      const tipY = endY + jitter(rng, (0.6 + pass * 0.5) * r);
      const lenLeft = headLen * (0.94 + rng() * 0.14);
      const lenRight = headLen * (0.94 + rng() * 0.14);
      const spreadLeft = spread + jitter(rng, 0.08 * r);
      const spreadRight = spread + jitter(rng, 0.08 * r);

      const leftX = tipX - lenLeft * Math.cos(angle - spreadLeft);
      const leftY = tipY - lenLeft * Math.sin(angle - spreadLeft);
      const rightX = tipX - lenRight * Math.cos(angle + spreadRight);
      const rightY = tipY - lenRight * Math.sin(angle + spreadRight);

      addBowedSegment(b, tipX, tipY, leftX, leftY, rng, r * 0.65, true);
      addBowedSegment(b, tipX, tipY, rightX, rightY, rng, r * 0.65, true);
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Hand-Drawn Slightly-Overlapping Marker Oval (pdf_circle)
// ---------------------------------------------------------------------------

/**
 * Creates an organic slightly-overlapping (~375 deg) hand-drawn marker oval
 * with subtle radial wobble, ideal for pdf_circle annotations.
 */
export function createRoughCirclePath(
  rect: RoughRectFrame,
  seed: number,
  roughness = 1
): SkPath {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return makeEmptySkiaPath();
  }

  const rng = mulberry32(seed);
  const r = clampRoughness(roughness);

  // Symmetric centering directly from caller-padded rect (no hidden extra offset)
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = rect.width / 2;
  const ry = rect.height / 2;

  const steps = 28;
  // ~375 degrees total sweep (with small organic variance) so ends cross naturally
  const totalSweep = ((375 + jitter(rng, 8)) * Math.PI) / 180;
  const startAngle = -Math.PI * 0.62 + jitter(rng, 0.25);
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;

  const wobbleAmpX = Math.min(rx * 0.08, 2.4 * r);
  const wobbleAmpY = Math.min(ry * 0.08, 2.4 * r);

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const theta = startAngle + t * totalSweep;

    // Gentle low-frequency radial harmonic wobble + micro hand jitter
    const harmonic =
      Math.sin(theta * 2 + phase1) * 0.55 + Math.cos(theta * 3 + phase2) * 0.35;
    // Slight spiral lift at the overlap tail so the stroke crosses visibly
    const overlapDrift = t > 0.85 ? (t - 0.85) * 9.5 * r : 0;

    const localRx = rx + harmonic * wobbleAmpX + jitter(rng, wobbleAmpX * 0.35) + overlapDrift;
    const localRy = ry + harmonic * wobbleAmpY + jitter(rng, wobbleAmpY * 0.35) - overlapDrift * 0.5;

    points.push({
      x: cx + Math.cos(theta) * localRx,
      y: cy + Math.sin(theta) * localRy,
    });
  }

  return makePathFromBuilder((b) => {
    addSmoothPolyCurve(b, points);
  });
}

// ---------------------------------------------------------------------------
// 5. Hand-Drawn Table Grid (Outer Border, Double Header Rule, Dividers)
// ---------------------------------------------------------------------------

/**
 * Creates a rough hand-drawn table grid path containing:
 * - Organic rough outer border
 * - Double horizontal header rule at `rect.y + headerHeight`
 * - Internal vertical column dividers and horizontal row dividers
 */
export function createRoughTableGridPath(
  rect: RoughRectFrame,
  colWidths: number[],
  headerHeight: number,
  rowHeights: number[],
  seed: number,
  roughness = 1
): SkPath {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return makeEmptySkiaPath();
  }

  const rng = mulberry32(seed);
  const safeRough = Math.min(
    clampRoughness(roughness),
    Math.min(rect.width, rect.height) / 18
  );

  const { x, y, width: w, height: h } = rect;
  const cornerRadius = Math.min(10, w * 0.04, h * 0.08);

  return makePathFromBuilder((b) => {
    // 1. Rough outer border (double-stroke marker frame with 2.2-3.2px separation & corner overshoots)
    addRoughRoundedRectPass(b, rect, cornerRadius, rng, safeRough, 3.8, 0);
    addRoughRoundedRectPass(b, rect, cornerRadius, rng, safeRough * 1.15, 0, 1);

    // 2. Double horizontal header rule
    const clampedHeaderH =
      Number.isFinite(headerHeight) && headerHeight > 2 && headerHeight < h - 2
        ? headerHeight
        : 0;

    if (clampedHeaderH > 0) {
      const headerY = y + clampedHeaderH;
      addRoughLine(b, x + 2, headerY - 1.3, x + w - 2, headerY - 1.3, rng, safeRough * 0.9, false);
      addRoughLine(b, x + 2, headerY + 1.4, x + w - 2, headerY + 1.4, rng, safeRough * 0.9, false);
    }

    // 3. Internal column dividers
    if (Array.isArray(colWidths) && colWidths.length > 1) {
      let colX = x;
      for (let i = 0; i < colWidths.length - 1; i++) {
        const cw = colWidths[i];
        if (!Number.isFinite(cw) || cw <= 0) continue;
        colX += cw;
        if (colX <= x + 2 || colX >= x + w - 2) continue;
        addRoughLine(b, colX, y + 2, colX, y + h - 2, rng, safeRough * 0.75, false);
      }
    }

    // 4. Internal row dividers below the header
    if (Array.isArray(rowHeights) && rowHeights.length > 1) {
      let rowY = y + clampedHeaderH;
      for (let i = 0; i < rowHeights.length - 1; i++) {
        const rh = rowHeights[i];
        if (!Number.isFinite(rh) || rh <= 0) continue;
        rowY += rh;
        if (rowY <= y + clampedHeaderH + 2 || rowY >= y + h - 2) continue;
        addRoughLine(b, x + 2, rowY, x + w - 2, rowY, rng, safeRough * 0.7, false);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 6. Hand-Drawn Vector Sketch Icons
// ---------------------------------------------------------------------------

/**
 * Creates a deterministic hand-drawn vector icon path centered at (cx, cy) within `size`.
 * Supports: "lightbulb" | "brain" | "check" | "warning" | "code" | "compare".
 */
export function createSketchIconPath(
  icon: SketchIcon,
  cx: number,
  cy: number,
  size: number,
  seed: number
): SkPath {
  if (!Number.isFinite(size) || size <= 0) {
    return makeEmptySkiaPath();
  }

  const rng = mulberry32((seed ^ hashSeed(icon)) >>> 0);
  const r = size / 2;
  const amp = Math.max(0.25, size * 0.022);
  const rough = Math.max(0.35, size / 26);

  // Coordinate helper mapping normalized [-1, 1] icon space -> canvas space with subtle hand jitter
  const pt = (nx: number, ny: number, jScale = 1) => ({
    x: cx + nx * r + jitter(rng, amp * jScale),
    y: cy + ny * r + jitter(rng, amp * jScale),
  });

  const line = (
    b: PathDrawOps,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    doubleStroke = false
  ) => {
    const p1 = pt(x1, y1, 0.7);
    const p2 = pt(x2, y2, 0.7);
    addRoughLine(b, p1.x, p1.y, p2.x, p2.y, rng, rough * 0.7, doubleStroke);
  };

  return makePathFromBuilder((b) => {
    switch (icon) {
      case "lightbulb": {
        // Glass bulb contour (arc from lower-left up around dome to lower-right)
        const bulbPts = [
          pt(-0.26, 0.34, 0.6),
          pt(-0.48, 0.08, 0.8),
          pt(-0.56, -0.22, 0.8),
          pt(-0.36, -0.56, 0.8),
          pt(0.0, -0.66, 0.8),
          pt(0.36, -0.56, 0.8),
          pt(0.56, -0.22, 0.8),
          pt(0.48, 0.08, 0.8),
          pt(0.26, 0.34, 0.6),
        ];
        addSmoothPolyCurve(b, bulbPts);

        // Screw base lines + small tip
        line(b, -0.26, 0.36, 0.26, 0.36, false);
        line(b, -0.24, 0.56, 0.24, 0.56, false);
        line(b, -0.16, 0.74, 0.16, 0.74, false);

        // Tiny inner filament spark
        line(b, -0.12, 0.06, 0.0, -0.14, false);
        line(b, 0.0, -0.14, 0.12, 0.06, false);

        // 3 radiating rays around the top
        line(b, 0.0, -0.82, 0.0, -0.98, false);
        line(b, -0.66, -0.58, -0.82, -0.72, false);
        line(b, 0.66, -0.58, 0.82, -0.72, false);
        break;
      }

      case "brain": {
        // Left hemisphere outer silhouette
        const leftLobe = [
          pt(-0.04, -0.66, 0.6),
          pt(-0.44, -0.68, 0.8),
          pt(-0.74, -0.4, 0.8),
          pt(-0.78, 0.02, 0.8),
          pt(-0.68, 0.44, 0.8),
          pt(-0.34, 0.68, 0.8),
          pt(-0.04, 0.58, 0.6),
        ];
        addSmoothPolyCurve(b, leftLobe);

        // Right hemisphere outer silhouette
        const rightLobe = [
          pt(0.04, -0.66, 0.6),
          pt(0.44, -0.68, 0.8),
          pt(0.74, -0.4, 0.8),
          pt(0.78, 0.02, 0.8),
          pt(0.68, 0.44, 0.8),
          pt(0.34, 0.68, 0.8),
          pt(0.04, 0.58, 0.6),
        ];
        addSmoothPolyCurve(b, rightLobe);

        // Central longitudinal fissure
        line(b, 0.0, -0.62, 0.0, 0.58, false);

        // Characteristic inner sulci folds on left & right hemispheres
        addSmoothPolyCurve(b, [
          pt(-0.46, -0.24, 0.6),
          pt(-0.24, -0.32, 0.6),
          pt(-0.18, -0.06, 0.6),
        ]);
        addSmoothPolyCurve(b, [
          pt(-0.48, 0.24, 0.6),
          pt(-0.24, 0.16, 0.6),
          pt(-0.18, 0.38, 0.6),
        ]);
        addSmoothPolyCurve(b, [
          pt(0.46, -0.24, 0.6),
          pt(0.24, -0.32, 0.6),
          pt(0.18, -0.06, 0.6),
        ]);
        addSmoothPolyCurve(b, [
          pt(0.48, 0.24, 0.6),
          pt(0.24, 0.16, 0.6),
          pt(0.18, 0.38, 0.6),
        ]);
        break;
      }

      case "check": {
        // Subtle open sketchy circle halo
        const haloPts: Array<{ x: number; y: number }> = [];
        const haloSteps = 16;
        for (let i = 0; i <= haloSteps; i++) {
          const theta = -0.35 + (i / haloSteps) * (Math.PI * 1.85);
          haloPts.push({
            x: cx + Math.cos(theta) * r * 0.84 + jitter(rng, amp * 0.8),
            y: cy + Math.sin(theta) * r * 0.84 + jitter(rng, amp * 0.8),
          });
        }
        addSmoothPolyCurve(b, haloPts);

        // Bold double-stroke checkmark
        for (let pass = 0; pass < 2; pass++) {
          const j = 0.6 + pass * 0.5;
          const pStart = pt(-0.4, 0.02, j);
          const pMid = pt(-0.08, 0.36, j);
          const pEnd = pt(0.56, -0.44, j);
          addBowedSegment(b, pStart.x, pStart.y, pMid.x, pMid.y, rng, rough * 0.6, true);
          addBowedSegment(b, pMid.x, pMid.y, pEnd.x, pEnd.y, rng, rough * 0.6, false);
        }
        break;
      }

      case "warning": {
        // Double-stroke sketchy warning triangle
        for (let pass = 0; pass < 2; pass++) {
          const j = 0.6 + pass * 0.55;
          const top = pt(0.0, -0.78, j);
          const br = pt(0.82, 0.72, j);
          const bl = pt(-0.82, 0.72, j);
          addBowedSegment(b, top.x, top.y, br.x, br.y, rng, rough * 0.75, true);
          addBowedSegment(b, br.x, br.y, bl.x, bl.y, rng, rough * 0.75, false);
          addBowedSegment(b, bl.x, bl.y, top.x, top.y, rng, rough * 0.75, false);
        }

        // Exclamation vertical bar + dot
        line(b, 0.0, -0.32, 0.0, 0.24, true);
        const dotTop = pt(0.0, 0.44, 0.4);
        const dotBot = pt(0.0, 0.54, 0.4);
        b.moveTo(dotTop.x, dotTop.y);
        b.lineTo(dotBot.x, dotBot.y);
        break;
      }

      case "code": {
        // Left chevron "<"
        line(b, -0.34, -0.44, -0.82, 0.0, true);
        line(b, -0.82, 0.0, -0.34, 0.44, true);

        // Center forward slash "/"
        line(b, 0.16, -0.58, -0.16, 0.58, true);

        // Right chevron ">"
        line(b, 0.34, -0.44, 0.82, 0.0, true);
        line(b, 0.82, 0.0, 0.34, 0.44, true);
        break;
      }

      case "compare": {
        // Upper arrow pointing right: --->
        line(b, -0.74, -0.32, 0.72, -0.32, true);
        line(b, 0.34, -0.64, 0.74, -0.32, false);
        line(b, 0.34, 0.0, 0.74, -0.32, false);

        // Lower arrow pointing left: <---
        line(b, 0.74, 0.34, -0.72, 0.34, true);
        line(b, -0.34, 0.02, -0.74, 0.34, false);
        line(b, -0.34, 0.66, -0.74, 0.34, false);
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 7. Hand-Drawn Nested Diagram Primitives (Containers, Diamonds, Smart Arrows)
// ---------------------------------------------------------------------------

/**
 * Draws a sequence of organic hand-drawn marker dashes along a straight segment.
 */
function addRoughDashedSegment(
  b: PathDrawOps,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rng: () => number,
  roughness: number,
  dashLen = 10,
  gapLen = 6.5
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;

  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const r = clampRoughness(roughness);

  let pos = 0;
  while (pos < len) {
    const segEnd = Math.min(len, pos + dashLen * (0.9 + rng() * 0.22));
    const sx = x1 + ux * pos + nx * jitter(rng, 0.65 * r);
    const sy = y1 + uy * pos + ny * jitter(rng, 0.65 * r);
    const ex = x1 + ux * segEnd + nx * jitter(rng, 0.65 * r);
    const ey = y1 + uy * segEnd + ny * jitter(rng, 0.65 * r);
    addBowedSegment(b, sx, sy, ex, ey, rng, r * 0.55, true);
    pos = segEnd + gapLen * (0.88 + rng() * 0.24);
  }
}

/**
 * Creates a deterministic hand-drawn dashed rounded rectangle for enclosing
 * `container` nodes in wb_diagram.
 */
export function createRoughDashedRectPath(
  rect: RoughRectFrame,
  radius: number,
  seed: number,
  roughness = 0.95
): SkPath {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return makeEmptySkiaPath();
  }

  const { x, y, width: w, height: h } = rect;
  const rad = Math.max(0, Math.min(radius, w / 4, h / 4));
  const rng = mulberry32(seed);
  const safeRough = Math.min(
    clampRoughness(roughness),
    Math.min(w, h) / 18
  );

  return makePathFromBuilder((b) => {
    // Four dashed edges
    addRoughDashedSegment(b, x + rad, y, x + w - rad, y, rng, safeRough);
    addRoughDashedSegment(b, x + w, y + rad, x + w, y + h - rad, rng, safeRough);
    addRoughDashedSegment(b, x + w - rad, y + h, x + rad, y + h, rng, safeRough);
    addRoughDashedSegment(b, x, y + h - rad, x, y + rad, rng, safeRough);

    // Subtle organic rounded corner arcs so container corners feel hand-sketched
    if (rad > 1) {
      const jit = 0.6 * safeRough;
      // Top-right corner
      b.moveTo(x + w - rad, y + jitter(rng, jit));
      b.quadTo(x + w + jitter(rng, jit), y + jitter(rng, jit), x + w + jitter(rng, jit), y + rad);
      // Bottom-right corner
      b.moveTo(x + w + jitter(rng, jit), y + h - rad);
      b.quadTo(x + w + jitter(rng, jit), y + h + jitter(rng, jit), x + w - rad, y + h + jitter(rng, jit));
      // Bottom-left corner
      b.moveTo(x + rad, y + h + jitter(rng, jit));
      b.quadTo(x + jitter(rng, jit), y + h + jitter(rng, jit), x + jitter(rng, jit), y + h - rad);
      // Top-left corner
      b.moveTo(x + jitter(rng, jit), y + rad);
      b.quadTo(x + jitter(rng, jit), y + jitter(rng, jit), x + rad, y + jitter(rng, jit));
    }
  });
}

/**
 * Clean closed diamond polygon path for tinted fill inside `decision` nodes.
 */
export function createDiamondFillPath(rect: RoughRectFrame): SkPath {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return makeEmptySkiaPath();
  }
  const { x, y, width: w, height: h } = rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return makePathFromBuilder((b) => {
    b.moveTo(cx, y);
    b.lineTo(x + w, cy);
    b.lineTo(cx, y + h);
    b.lineTo(x, cy);
    b.lineTo(cx, y);
  });
}

/**
 * Creates a deterministic double-stroke hand-drawn diamond path for `decision` nodes
 * with guaranteed minimum curve bow and 2.2px-3.0px secondary pass separation.
 */
export function createRoughDiamondPath(
  rect: RoughRectFrame,
  seed: number,
  roughness = 1
): SkPath {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return makeEmptySkiaPath();
  }

  const { x, y, width: w, height: h } = rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rng = mulberry32(seed);
  const safeRough = Math.min(
    clampRoughness(roughness),
    Math.min(w, h) / 14
  );

  return makePathFromBuilder((b) => {
    for (let pass = 0; pass < 2; pass++) {
      const sep = pass === 0 ? 0 : Math.min(Math.min(w, h) * 0.055, (2.2 + rng() * 0.8) * safeRough);
      const ox = pass === 0 ? 0 : (rng() > 0.5 ? 1 : -1) * sep * 0.78;
      const oy = pass === 0 ? 0 : (rng() > 0.5 ? 1 : -1) * sep * 0.78;
      const jit = Math.min(Math.min(w, h) * 0.035, 1.4 * safeRough);
      const bowBias = pass === 0 ? 1 : -1;

      const top = { x: cx + ox + jitter(rng, jit), y: y + oy + jitter(rng, jit) };
      const right = { x: x + w + ox + jitter(rng, jit), y: cy + oy + jitter(rng, jit) };
      const bottom = { x: cx + ox + jitter(rng, jit), y: y + h + oy + jitter(rng, jit) };
      const left = { x: x + ox + jitter(rng, jit), y: cy + oy + jitter(rng, jit) };

      b.moveTo(top.x, top.y);
      addBowedSegment(b, top.x, top.y, right.x, right.y, rng, safeRough, false, bowBias);
      addBowedSegment(b, right.x, right.y, bottom.x, bottom.y, rng, safeRough, false, -bowBias);
      addBowedSegment(b, bottom.x, bottom.y, left.x, left.y, rng, safeRough, false, bowBias);
      addBowedSegment(b, left.x, left.y, top.x, top.y, rng, safeRough, false, -bowBias);
    }
  });
}

export interface SmartArrowGeometry {
  startX: number;
  startY: number;
  ctrlX: number;
  ctrlY: number;
  endX: number;
  endY: number;
  labelX: number;
  labelY: number;
}

/**
 * Computes optimal box-edge face anchors, Bezier control point (automatically
 * curving upward feedback loops or bidirectional edges), and exact curve midpoint
 * for placing edge labels cleanly without overlap.
 */
export function computeSmartDiagramArrowGeometry(
  from: RoughRectFrame,
  to: RoughRectFrame,
  curveOffset = 0
): SmartArrowGeometry {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;

  const dx = toCx - fromCx;
  const dy = toCy - fromCy;

  // Normalized directional dominance accounts for wide landscape boxes stacked vertically
  const normDx = Math.abs(dx) / Math.max(1, (from.width + to.width) * 0.5);
  const normDy = Math.abs(dy) / Math.max(1, (from.height + to.height) * 0.5);

  const margin = 4;
  let startX = fromCx;
  let startY = fromCy;
  let endX = toCx;
  let endY = toCy;

  if (normDx >= normDy) {
    if (dx >= 0) {
      startX = from.x + from.width + margin;
      endX = to.x - margin;
    } else {
      startX = from.x - margin;
      endX = to.x + to.width + margin;
    }
  } else {
    if (dy >= 0) {
      startY = from.y + from.height + margin;
      endY = to.y - margin;
    } else {
      startY = from.y - margin;
      endY = to.y + to.height + margin;
    }
  }

  const spanX = endX - startX;
  const spanY = endY - startY;
  const dist = Math.hypot(spanX, spanY);
  const midX = (startX + endX) * 0.5;
  const midY = (startY + endY) * 0.5;

  let effectiveCurve = curveOffset;
  // Automatically curve upward feedback / loop edges so they arc cleanly around interior boxes
  if (effectiveCurve === 0 && fromCy > toCy + 16) {
    effectiveCurve = Math.min(44, Math.max(24, dist * 0.22));
  } else if (effectiveCurve === 0 && Math.abs(spanX) > 20 && Math.abs(spanY) > 20) {
    effectiveCurve = Math.min(18, dist * 0.08) * (dx >= 0 ? -1 : 1);
  }

  const nx = dist > 0.5 ? -spanY / dist : 0;
  const ny = dist > 0.5 ? spanX / dist : -1;
  const ctrlX = midX + nx * effectiveCurve;
  const ctrlY = midY + ny * effectiveCurve;

  // Exact quadratic Bezier midpoint at t = 0.5
  const labelX = 0.25 * startX + 0.5 * ctrlX + 0.25 * endX;
  const labelY = 0.25 * startY + 0.5 * ctrlY + 0.25 * endY;

  return { startX, startY, ctrlX, ctrlY, endX, endY, labelX, labelY };
}

/**
 * Creates a hand-drawn smart diagram connector arrow (solid or dashed curved shaft
 * + double-stroke sketchy arrowhead) connecting the closest faces of `from` -> `to`.
 */
export function createSmartDiagramArrowPath(
  from: RoughRectFrame,
  to: RoughRectFrame,
  seed: number,
  curveOffset = 0,
  dashed = false,
  roughness = 0.95
): SkPath {
  if (
    !from ||
    !to ||
    from.width <= 0 ||
    from.height <= 0 ||
    to.width <= 0 ||
    to.height <= 0
  ) {
    return makeEmptySkiaPath();
  }

  const geom = computeSmartDiagramArrowGeometry(from, to, curveOffset);
  const dist = Math.hypot(geom.endX - geom.startX, geom.endY - geom.startY);
  if (dist < 4) return makeEmptySkiaPath();

  const rng = mulberry32(seed);
  const r = clampRoughness(roughness);

  const nx = -(geom.endY - geom.startY) / dist;
  const ny = (geom.endX - geom.startX) / dist;
  const sep = Math.min(dist * 0.06, (2.0 + rng() * 0.7) * r) * (rng() > 0.5 ? 1 : -1);

  // Tangent at end of quadratic Bezier is (end - ctrl)
  const angle = Math.atan2(geom.endY - geom.ctrlY, geom.endX - geom.ctrlX);
  const headLen = Math.min(11, Math.max(7, dist * 0.24));
  const spread = Math.PI / 6;

  return makePathFromBuilder((b) => {
    if (dashed) {
      // Sample quadratic Bezier into clean hand-drawn dashes
      const steps = Math.max(10, Math.round(dist / 7.5));
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const omt = 1 - t;
        pts.push({
          x:
            omt * omt * geom.startX +
            2 * omt * t * geom.ctrlX +
            t * t * geom.endX +
            jitter(rng, 0.55 * r),
          y:
            omt * omt * geom.startY +
            2 * omt * t * geom.ctrlY +
            t * t * geom.endY +
            jitter(rng, 0.55 * r),
        });
      }
      for (let i = 0; i < pts.length - 1; i += 2) {
        const p0 = pts[i];
        const p1 = pts[Math.min(pts.length - 1, i + 1)];
        b.moveTo(p0.x, p0.y);
        b.lineTo(p1.x, p1.y);
      }
    } else {
      // Primary curved marker shaft
      b.moveTo(geom.startX + jitter(rng, 0.65 * r), geom.startY + jitter(rng, 0.65 * r));
      b.quadTo(
        geom.ctrlX + jitter(rng, 1.2 * r),
        geom.ctrlY + jitter(rng, 1.2 * r),
        geom.endX,
        geom.endY
      );
      // Companion double-stroke shaft for Retina hand-drawn feel
      b.moveTo(
        geom.startX + nx * sep * 0.7 + jitter(rng, 0.7 * r),
        geom.startY + ny * sep * 0.7 + jitter(rng, 0.7 * r)
      );
      b.quadTo(
        geom.ctrlX + nx * sep + jitter(rng, 1.4 * r),
        geom.ctrlY + ny * sep + jitter(rng, 1.4 * r),
        geom.endX + nx * sep * 0.4 + jitter(rng, 0.7 * r),
        geom.endY + ny * sep * 0.4 + jitter(rng, 0.7 * r)
      );
    }

    // Double-stroke sketchy arrowhead wings
    for (let pass = 0; pass < 2; pass++) {
      const tipX = geom.endX + jitter(rng, (0.5 + pass * 0.45) * r);
      const tipY = geom.endY + jitter(rng, (0.5 + pass * 0.45) * r);
      const lenL = headLen * (0.94 + rng() * 0.14);
      const lenR = headLen * (0.94 + rng() * 0.14);
      const spreadL = spread + jitter(rng, 0.08 * r);
      const spreadR = spread + jitter(rng, 0.08 * r);

      addBowedSegment(
        b,
        tipX,
        tipY,
        tipX - lenL * Math.cos(angle - spreadL),
        tipY - lenL * Math.sin(angle - spreadL),
        rng,
        r * 0.6,
        true
      );
      addBowedSegment(
        b,
        tipX,
        tipY,
        tipX - lenR * Math.cos(angle + spreadR),
        tipY - lenR * Math.sin(angle + spreadR),
        rng,
        r * 0.6,
        true
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 8. Stage 15: Pre-Sampled Worklet-Safe Pen Trails, Highlighter, Plotter & Stencils
// ---------------------------------------------------------------------------

function pushQuadTrail(
  trail: PenTrailPoint[],
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  steps = 8
): void {
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const omt = 1 - t;
    trail.push({
      x: omt * omt * x0 + 2 * omt * t * cx + t * t * x1,
      y: omt * omt * y0 + 2 * omt * t * cy + t * t * y1,
    });
  }
}

/**
 * Hand-drawn bold double-stroke underline with an exact pre-sampled PenTrailPoint[]
 * so the live pen nib glides smoothly along the underline on the UI thread at 60fps.
 */
export function createRoughUnderlineWithTrail(
  xStart: number,
  xEnd: number,
  baseY: number,
  seed: number,
  roughness = 1
): SkiaPathWithTrail {
  const span = xEnd - xStart;
  if (span <= 4) {
    return { path: makeEmptySkiaPath(), trail: [] };
  }

  const rng = mulberry32(seed);
  const r = clampRoughness(roughness);
  const bow1 = (1.4 + rng() * 1.3) * r * (rng() > 0.5 ? -1 : 1);
  const bow2 = (1.1 + rng() * 1.1) * r * (bow1 > 0 ? -1 : 1);

  const y1Start = baseY + jitter(rng, 0.7 * r);
  const y1End = baseY + jitter(rng, 0.8 * r);
  const mid1X = xStart + span * (0.45 + rng() * 0.1);
  const mid1Y = baseY + bow1;

  const extraInset = Math.min(12, span * 0.06);
  const yOffset = 2.6 + rng() * 0.7;
  const x2Start = xStart + extraInset + jitter(rng, 1.2 * r);
  const x2End = xEnd - extraInset * 0.7 + jitter(rng, 1.2 * r);
  const y2Start = baseY + yOffset + jitter(rng, 0.7 * r);
  const y2End = baseY + yOffset + jitter(rng, 0.7 * r);
  const mid2X = (x2Start + x2End) * (0.47 + rng() * 0.06);
  const mid2Y = baseY + yOffset + bow2;

  const trail: PenTrailPoint[] = [];
  pushQuadTrail(trail, xStart, y1Start, mid1X, mid1Y, xEnd, y1End, 14);
  pushQuadTrail(trail, x2Start, y2Start, mid2X, mid2Y, x2End, y2End, 10);

  const path = makePathFromBuilder((b) => {
    b.moveTo(xStart, y1Start);
    b.quadTo(mid1X, mid1Y, xEnd, y1End);
    b.moveTo(x2Start, y2Start);
    b.quadTo(mid2X, mid2Y, x2End, y2End);
  });

  return { path, trail };
}

/**
 * Broad hand-drawn yellow highlighter sweep left-to-right behind key results/equations.
 */
export function createRoughHighlighterPath(
  rect: RoughRectFrame,
  seed: number
): SkiaPathWithTrail {
  if (!rect || rect.width <= 4 || rect.height <= 4) {
    return { path: makeEmptySkiaPath(), trail: [] };
  }
  const rng = mulberry32(seed);
  const x0 = rect.x + 2;
  const x1 = rect.x + rect.width - 2;
  const cy = rect.y + rect.height * 0.52;
  const slant = jitter(rng, 1.6);
  const bow = (1.2 + rng() * 1.4) * (rng() > 0.5 ? 1 : -1);
  const cx = (x0 + x1) * (0.48 + rng() * 0.06);
  const cpy = cy + bow;

  const trail: PenTrailPoint[] = [];
  pushQuadTrail(trail, x0, cy - slant, cx, cpy, x1, cy + slant, 14);

  const path = makePathFromBuilder((b) => {
    b.moveTo(x0, cy - slant);
    b.quadTo(cx, cpy, x1, cy + slant);
  });

  return { path, trail };
}

/**
 * Hand-drawn rounded rectangle paired with a clockwise perimeter PenTrailPoint[]
 * so the live pen nib traces newly drawn cards smoothly.
 */
export function createRoughRectWithTrail(
  rect: RoughRectFrame,
  radius: number,
  seed: number,
  roughness = 1
): SkiaPathWithTrail {
  const path = createRoughRectPath(rect, radius, seed, roughness);
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { path, trail: [] };
  }
  const { x, y, width: w, height: h } = rect;
  const trail: PenTrailPoint[] = [];
  pushQuadTrail(trail, x, y, x + w * 0.5, y - 1, x + w, y, 8);
  pushQuadTrail(trail, x + w, y, x + w + 1, y + h * 0.5, x + w, y + h, 6);
  pushQuadTrail(trail, x + w, y + h, x + w * 0.5, y + h + 1, x, y + h, 8);
  pushQuadTrail(trail, x, y + h, x - 1, y + h * 0.5, x, y, 6);
  return { path, trail };
}

/**
 * Hand-drawn coordinate axes (Y-axis bottom->top + arrowhead, X-axis left->right + arrowhead,
 * plus organic tick marks) with exact PenTrailPoint[] for wb_plot.
 */
export function createPlotAxesWithTrail(
  plotRect: RoughRectFrame,
  originX: number,
  originY: number,
  xTicks: number[],
  yTicks: number[],
  seed: number
): SkiaPathWithTrail {
  if (!plotRect || plotRect.width <= 20 || plotRect.height <= 20) {
    return { path: makeEmptySkiaPath(), trail: [] };
  }
  const rng = mulberry32(seed);
  const { x, y, width: w, height: h } = plotRect;
  const clampedOX = Math.max(x, Math.min(x + w, originX));
  const clampedOY = Math.max(y, Math.min(y + h, originY));

  const trail: PenTrailPoint[] = [];
  // Trace Y-axis from bottom to top, then X-axis from left to right
  pushQuadTrail(
    trail,
    clampedOX,
    y + h,
    clampedOX + jitter(rng, 1.3),
    y + h * 0.5,
    clampedOX,
    y,
    12
  );
  pushQuadTrail(
    trail,
    x,
    clampedOY,
    x + w * 0.5,
    clampedOY + jitter(rng, 1.3),
    x + w,
    clampedOY,
    12
  );

  const path = makePathFromBuilder((b) => {
    // Y-axis line + top arrowhead
    addRoughLine(b, clampedOX, y + h, clampedOX, y, rng, 0.75, false);
    addBowedSegment(b, clampedOX, y, clampedOX - 5.5, y + 9, rng, 0.55, true);
    addBowedSegment(b, clampedOX, y, clampedOX + 5.5, y + 9, rng, 0.55, true);

    // X-axis line + right arrowhead
    addRoughLine(b, x, clampedOY, x + w, clampedOY, rng, 0.75, false);
    addBowedSegment(b, x + w, clampedOY, x + w - 9, clampedOY - 5.5, rng, 0.55, true);
    addBowedSegment(b, x + w, clampedOY, x + w - 9, clampedOY + 5.5, rng, 0.55, true);

    // Short hand-sketched tick marks
    for (const tx of xTicks) {
      if (tx <= x + 4 || tx >= x + w - 10) continue;
      b.moveTo(tx, clampedOY - 3.5);
      b.lineTo(tx + jitter(rng, 0.5), clampedOY + 3.5);
    }
    for (const ty of yTicks) {
      if (ty <= y + 10 || ty >= y + h - 4) continue;
      b.moveTo(clampedOX - 3.5, ty);
      b.lineTo(clampedOX + 3.5, ty + jitter(rng, 0.5));
    }
  });

  return { path, trail };
}

/**
 * Hand-drawn mathematical curve through sampled screen-space polyline segments
 * with subtle organic Bezier perturbation + exact PenTrailPoint[].
 */
export function createPlotCurveWithTrail(
  segments: ReadonlyArray<ReadonlyArray<PenTrailPoint>>,
  seed: number,
  roughness = 0.75
): SkiaPathWithTrail {
  const rng = mulberry32(seed);
  const r = clampRoughness(roughness);
  const trail: PenTrailPoint[] = [];

  const path = makePathFromBuilder((b) => {
    for (const seg of segments) {
      if (!seg || seg.length < 2) continue;
      const perturbed = seg.map((pt, idx) => ({
        x: pt.x + (idx === 0 || idx === seg.length - 1 ? 0 : jitter(rng, 0.55 * r)),
        y: pt.y + (idx === 0 || idx === seg.length - 1 ? 0 : jitter(rng, 0.55 * r)),
      }));
      addSmoothPolyCurve(b, perturbed);
      for (const pt of perturbed) {
        trail.push(pt);
      }
    }
  });

  return { path, trail };
}

/**
 * Multi-layer colored vector stencils for wb_diagram nodes (outlines trace first,
 * then soft pastel fills fade in). Supports: force_block, circuit, cell, atom, wave, tree_node.
 */
export function createDiagramStencilPaths(
  stencil: DiagramStencil,
  rect: RoughRectFrame,
  seed: number
): StencilLayerPaths {
  if (!rect || rect.width <= 12 || rect.height <= 12) {
    return {
      outlinePath: makeEmptySkiaPath(),
      fillPath: makeEmptySkiaPath(),
      trail: [],
    };
  }

  const rng = mulberry32((seed ^ hashSeed(`stencil-${stencil}`)) >>> 0);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = rect.width * 0.44;
  const ry = rect.height * 0.4;
  const trail: PenTrailPoint[] = [];

  const fillPath = makePathFromBuilder((b) => {
    switch (stencil) {
      case "force_block": {
        const bx = cx - rx * 0.62;
        const by = cy - ry * 0.48;
        const bw = rx * 1.24;
        const bh = ry * 0.96;
        b.moveTo(bx, by);
        b.lineTo(bx + bw, by);
        b.lineTo(bx + bw, by + bh);
        b.lineTo(bx, by + bh);
        b.lineTo(bx, by);
        break;
      }
      case "cell": {
        // Organic outer membrane fill + inner nucleus oval
        const steps = 20;
        const pts: PenTrailPoint[] = [];
        for (let i = 0; i <= steps; i++) {
          const theta = (i / steps) * Math.PI * 2;
          const wob = 1 + Math.sin(theta * 3) * 0.08;
          pts.push({ x: cx + Math.cos(theta) * rx * wob, y: cy + Math.sin(theta) * ry * wob });
        }
        addSmoothPolyCurve(b, pts);
        break;
      }
      case "atom":
      case "tree_node": {
        const rad = Math.min(rx, ry) * (stencil === "atom" ? 0.34 : 0.78);
        const steps = 18;
        const pts: PenTrailPoint[] = [];
        for (let i = 0; i <= steps; i++) {
          const theta = (i / steps) * Math.PI * 2;
          pts.push({ x: cx + Math.cos(theta) * rad, y: cy + Math.sin(theta) * rad });
        }
        addSmoothPolyCurve(b, pts);
        break;
      }
      case "circuit":
      case "wave":
      default: {
        const bx = rect.x + 4;
        const by = rect.y + 4;
        const bw = rect.width - 8;
        const bh = rect.height - 8;
        b.moveTo(bx, by);
        b.lineTo(bx + bw, by);
        b.lineTo(bx + bw, by + bh);
        b.lineTo(bx, by + bh);
        b.lineTo(bx, by);
        break;
      }
    }
  });

  const outlinePath = makePathFromBuilder((b) => {
    switch (stencil) {
      case "force_block": {
        // Ground surface line + block + rightward force arrow
        const bx = cx - rx * 0.62;
        const by = cy - ry * 0.48;
        const bw = rx * 1.24;
        const bh = ry * 0.96;
        addRoughRoundedRectPass(b, { x: bx, y: by, width: bw, height: bh }, 5, rng, 0.75, 2.5, 0);
        // Surface baseline
        addRoughLine(b, rect.x + 6, by + bh + 4, rect.x + rect.width - 6, by + bh + 4, rng, 0.7, false);
        // Force vector arrow pulling right
        const fx0 = bx + bw + 3;
        const fx1 = rect.x + rect.width - 4;
        if (fx1 - fx0 > 8) {
          addRoughLine(b, fx0, cy, fx1, cy, rng, 0.7, false);
          addBowedSegment(b, fx1, cy, fx1 - 6, cy - 4, rng, 0.5, true);
          addBowedSegment(b, fx1, cy, fx1 - 6, cy + 4, rng, 0.5, true);
        }
        pushQuadTrail(trail, bx, by, bx + bw * 0.5, by, bx + bw, by, 6);
        pushQuadTrail(trail, bx + bw, by, bx + bw, by + bh, bx, by + bh, 8);
        break;
      }
      case "circuit": {
        // Closed rectangular loop with top resistor zigzag & left battery plates
        const lx = rect.x + 8;
        const rx2 = rect.x + rect.width - 8;
        const ty = rect.y + 10;
        const by = rect.y + rect.height - 10;
        const zigStart = lx + (rx2 - lx) * 0.28;
        const zigEnd = lx + (rx2 - lx) * 0.72;
        addRoughLine(b, lx, ty, zigStart, ty, rng, 0.65, false);
        // Resistor zigzag (5 peaks)
        const segW = (zigEnd - zigStart) / 6;
        let zx = zigStart;
        b.moveTo(zx, ty);
        for (let k = 0; k < 6; k++) {
          const nx = zx + segW;
          const ny = k % 2 === 0 ? ty - 5 : ty + 5;
          b.lineTo(k === 5 ? zigEnd : nx, k === 5 ? ty : ny);
          trail.push({ x: nx, y: ny });
          zx = nx;
        }
        addRoughLine(b, zigEnd, ty, rx2, ty, rng, 0.65, false);
        addRoughLine(b, rx2, ty, rx2, by, rng, 0.65, false);
        addRoughLine(b, rx2, by, lx, by, rng, 0.65, false);
        // Battery symbol on left side
        const midY = (ty + by) * 0.5;
        addRoughLine(b, lx, by, lx, midY + 4, rng, 0.65, false);
        addRoughLine(b, lx - 6, midY - 3, lx + 6, midY - 3, rng, 0.65, false);
        addRoughLine(b, lx - 3.5, midY + 3, lx + 3.5, midY + 3, rng, 0.65, false);
        addRoughLine(b, lx, midY - 4, lx, ty, rng, 0.65, false);
        break;
      }
      case "cell": {
        const steps = 22;
        const outerPts: PenTrailPoint[] = [];
        for (let i = 0; i <= steps; i++) {
          const theta = (i / steps) * Math.PI * 2;
          const wob = 1 + Math.sin(theta * 3) * 0.08 + jitter(rng, 0.02);
          const pt = { x: cx + Math.cos(theta) * rx * wob, y: cy + Math.sin(theta) * ry * wob };
          outerPts.push(pt);
          trail.push(pt);
        }
        addSmoothPolyCurve(b, outerPts);
        // Inner nucleus circle
        const nucPts: PenTrailPoint[] = [];
        for (let i = 0; i <= 14; i++) {
          const theta = (i / 14) * Math.PI * 2;
          nucPts.push({
            x: cx - rx * 0.14 + Math.cos(theta) * rx * 0.28,
            y: cy - ry * 0.08 + Math.sin(theta) * ry * 0.3,
          });
        }
        addSmoothPolyCurve(b, nucPts);
        break;
      }
      case "atom": {
        // 3 tilted elliptical electron orbits + central nucleus
        const orbits = [0, Math.PI / 3, (2 * Math.PI) / 3];
        const a = Math.min(rx, ry) * 0.96;
        const bRad = a * 0.38;
        for (const rot of orbits) {
          const cosR = Math.cos(rot);
          const sinR = Math.sin(rot);
          const pts: PenTrailPoint[] = [];
          for (let i = 0; i <= 20; i++) {
            const theta = (i / 20) * Math.PI * 2;
            const ex = Math.cos(theta) * a;
            const ey = Math.sin(theta) * bRad;
            const pt = {
              x: cx + ex * cosR - ey * sinR + jitter(rng, 0.4),
              y: cy + ex * sinR + ey * cosR + jitter(rng, 0.4),
            };
            pts.push(pt);
            if (rot === 0) trail.push(pt);
          }
          addSmoothPolyCurve(b, pts);
        }
        break;
      }
      case "wave": {
        // Baseline + hand-drawn 2-cycle transverse sine wave
        const x0 = rect.x + 8;
        const x1 = rect.x + rect.width - 8;
        const amp = Math.max(8, ry * 0.62);
        addRoughLine(b, x0, cy, x1, cy, rng, 0.55, false);
        const pts: PenTrailPoint[] = [];
        for (let i = 0; i <= 28; i++) {
          const t = i / 28;
          const pt = {
            x: x0 + t * (x1 - x0),
            y: cy - Math.sin(t * Math.PI * 4) * amp + jitter(rng, 0.5),
          };
          pts.push(pt);
          trail.push(pt);
        }
        addSmoothPolyCurve(b, pts);
        break;
      }
      case "tree_node": {
        const rad = Math.min(rx, ry) * 0.78;
        const pts: PenTrailPoint[] = [];
        for (let i = 0; i <= 20; i++) {
          const theta = -Math.PI * 0.5 + (i / 20) * Math.PI * 2.08;
          const pt = {
            x: cx + Math.cos(theta) * rad + jitter(rng, 0.7),
            y: cy + Math.sin(theta) * rad + jitter(rng, 0.7),
          };
          pts.push(pt);
          trail.push(pt);
        }
        addSmoothPolyCurve(b, pts);
        break;
      }
    }
  });

  return { outlinePath, fillPath, trail };
}

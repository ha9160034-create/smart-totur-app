import { Skia } from "@shopify/react-native-skia";
import type { SkPath } from "@shopify/react-native-skia";
import type { SketchIcon } from "../types/schema";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------
export interface RoughRectFrame {
  x: number;
  y: number;
  width: number;
  height: number;
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

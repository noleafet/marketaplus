import { roundRectPath, type Pixel, type Rect } from "@/lib/canvas";
import { CANDLE_PANE_TOP, type Palette } from "@/lib/market/constants";
import type { PatternMatch, PatternPoint } from "./pattern-analysis";

/** Small caption on a pill so labels stay readable on top of any background. */
function paintPatternLabel(
  context: CanvasRenderingContext2D,
  text: string,
  point: Pixel,
  rect: Rect,
  scale: number,
  colors: Palette,
) {
  context.save();
  context.font = `500 ${Math.round(10 * scale)}px "Geist", system-ui, sans-serif`;
  const textWidth = context.measureText(text).width;
  const width = textWidth + 10 * scale;
  const height = 15 * scale;
  const left = Math.min(
    Math.max(point.x - width / 2, rect.x + 3),
    rect.x + rect.width - width - 3,
  );
  let top = point.y - height - 8 * scale;
  // Keep the caption inside the price pane, flipping below the point when it would clip.
  if (top < rect.y + 3) top = point.y + 8 * scale;
  const radius = 4 * scale;
  context.globalAlpha = 0.92;
  context.fillStyle = colors.bg;
  roundRectPath(context, left, top, width, height, radius);
  context.fill();
  context.globalAlpha = 1;
  context.fillStyle = colors.text;
  context.textBaseline = "middle";
  context.fillText(text, left + 5 * scale, top + height / 2);
  context.restore();
}

/** Draws a detected pattern over an exported chart image, clipped to the price pane. */
export function paintPattern(
  context: CanvasRenderingContext2D,
  match: PatternMatch,
  toPixel: (point: PatternPoint) => Pixel | null,
  rect: Rect,
  scale: number,
  colors: Palette,
) {
  const accent = match.bias === "bullish" ? colors.green : colors.red;
  // "projection" is a swing that has not printed yet and "trigger" is the level that confirms it,
  // so both are drawn fainter than real geometry to keep the finished shape legible.
  const paint = {
    outline: colors.blue,
    boundary: colors.amber,
    trigger: colors.amber,
    pole: colors.text,
    target: accent,
    projection: colors.blue,
  };
  const dash = {
    outline: [5 * scale, 4 * scale],
    boundary: [],
    trigger: [4 * scale, 4 * scale],
    pole: [],
    target: [7 * scale, 5 * scale],
    projection: [2 * scale, 4 * scale],
  };
  const alpha = {
    outline: 0.85,
    boundary: 1,
    trigger: 1,
    pole: 1,
    target: 1,
    projection: 0.6,
  };
  const width = {
    outline: 1.5,
    boundary: 1.8,
    trigger: 1.8,
    pole: 2.4,
    target: 1.5,
    projection: 1.3,
  };
  context.save();
  context.beginPath();
  // Clipped to the candle area only. A measured target can sit below the visible low, and painting
  // it over the whole pane would draw it straight across the volume histogram.
  context.rect(rect.x, rect.y, rect.width, rect.height * CANDLE_PANE_TOP);
  context.clip();
  context.lineCap = "round";
  for (const segment of match.segments) {
    const from = toPixel(segment.from);
    const to = toPixel(segment.to);
    if (!from || !to) continue;
    context.save();
    context.strokeStyle = paint[segment.role];
    context.lineWidth = width[segment.role] * scale;
    context.setLineDash(dash[segment.role]);
    context.globalAlpha = alpha[segment.role];
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.restore();
  }
  for (const marker of match.markers) {
    const point = toPixel(marker);
    if (!point) continue;
    context.save();
    context.fillStyle = colors.bg;
    context.strokeStyle = accent;
    context.lineWidth = 1.6 * scale;
    context.beginPath();
    context.arc(point.x, point.y, 3.6 * scale, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }
  for (const label of match.labels) {
    const point = toPixel(label);
    // Labels are decoration only; one outside the candle area is simply not captioned, which keeps a
    // target that sits below the visible low off the volume histogram.
    const bottom = rect.y + rect.height * CANDLE_PANE_TOP;
    if (
      !point ||
      point.x < rect.x ||
      point.x > rect.x + rect.width ||
      point.y < rect.y ||
      point.y > bottom
    ) {
      continue;
    }
    paintPatternLabel(context, label.text, point, rect, scale, colors);
  }
  context.restore();
}

/** A partial shape is named apart from a finished one so the two are never confused in a list. */
export function matchName(match: PatternMatch) {
  return match.forming ? `${match.label} (forming)` : match.label;
}

/**
 * Paints the detected pattern's name on the chart itself, so the result is visible without a
 * caption beside the controls. The pill sits at the top right of the price pane and keeps the
 * bullish/bearish accent used by the pattern geometry.
 */
export function paintPatternCaption(
  context: CanvasRenderingContext2D,
  match: PatternMatch,
  rect: Rect,
  scale: number,
  colors: Palette,
) {
  const text = matchName(match);
  const accent = match.bias === "bullish" ? colors.green : colors.red;
  context.save();
  context.font = `600 ${Math.round(10 * scale)}px "Geist", system-ui, sans-serif`;
  const width = context.measureText(text).width + 14 * scale;
  const height = 18 * scale;
  // Right-aligned keeps the caption clear of the OHLC legend in the top-left corner.
  const left = Math.max(rect.x + 3, rect.x + rect.width - width - 8 * scale);
  const top = rect.y + 8 * scale;
  context.globalAlpha = 0.95;
  context.fillStyle = accent;
  roundRectPath(context, left, top, width, height, 4 * scale);
  context.fill();
  context.globalAlpha = 1;
  context.fillStyle = colors.bg;
  context.textBaseline = "middle";
  context.fillText(text, left + 7 * scale, top + height / 2);
  context.restore();
}

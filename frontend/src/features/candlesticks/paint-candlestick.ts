import { roundRectPath, type Rect } from "@/lib/canvas";
import { CANDLE_PANE_TOP, type Palette } from "@/lib/market/constants";
import type { CandlestickMatch } from "./patterns";

/**
 * Draws a soft band around the candles the monitor matched, with a caption naming the shape.
 * It is deliberately lighter than the chart-pattern overlay: the candles themselves should stay
 * readable because the shape is the point.
 */
export function paintCandlestick(
  context: CanvasRenderingContext2D,
  match: CandlestickMatch,
  xAt: (time: number) => number | null,
  yAt: (price: number) => number | null,
  rect: Rect,
  scale: number,
  colors: Palette,
) {
  const left = xAt(match.startTime);
  const right = xAt(match.endTime);
  const top = yAt(match.high);
  const bottom = yAt(match.low);
  if (left === null || right === null || top === null || bottom === null) return;

  const paneBottom = rect.y + rect.height * CANDLE_PANE_TOP;
  const accent = match.bias === "bullish" ? colors.green : colors.red;
  const padding = 8 * scale;
  const x = Math.max(rect.x + 2, Math.min(left, right) - padding);
  const width = Math.min(rect.x + rect.width - 2, Math.max(left, right) + padding) - x;
  const y = Math.max(rect.y + 2, Math.min(top, bottom) - padding);
  const height = Math.min(paneBottom - 2, Math.max(top, bottom) + padding) - y;
  if (width < 2 || height < 2) return;

  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.width, rect.height * CANDLE_PANE_TOP);
  context.clip();

  const radius = Math.min(6 * scale, width / 2, height / 2);
  roundRectPath(context, x, y, width, height, radius);
  context.globalAlpha = 0.1;
  context.fillStyle = accent;
  context.fill();
  context.globalAlpha = 0.85;
  context.strokeStyle = accent;
  context.lineWidth = Math.max(1, 1.3 * scale);
  context.setLineDash([5 * scale, 4 * scale]);
  context.stroke();
  context.setLineDash([]);

  const label = `${match.label} Â· ${match.success}% ${match.bias}`;
  context.font = `600 ${Math.round(10 * scale)}px "Geist", system-ui, sans-serif`;
  const textWidth = context.measureText(label).width;
  const pillWidth = textWidth + 12 * scale;
  const pillHeight = 17 * scale;
  const pillX = Math.min(
    Math.max(x + 4 * scale, rect.x + 3),
    rect.x + rect.width - pillWidth - 3,
  );
  const pillY = Math.max(rect.y + 3, y - pillHeight - 4 * scale);
  context.globalAlpha = 0.96;
  context.fillStyle = accent;
  roundRectPath(context, pillX, pillY, pillWidth, pillHeight, 4 * scale);
  context.fill();
  context.globalAlpha = 1;
  context.fillStyle = colors.bg;
  context.textBaseline = "middle";
  context.fillText(label, pillX + 6 * scale, pillY + pillHeight / 2);
  context.restore();
}

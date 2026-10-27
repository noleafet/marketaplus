import type { Timeframe } from "@/types/market";

export const fmt = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "–";
  const magnitude = Math.abs(value);
  return value.toLocaleString(undefined, {
    // Sub-unit prices keep at least four decimals in the crosshair legend, not just the axis.
    minimumFractionDigits: value !== 0 && magnitude < 1 ? 4 : 0,
    maximumFractionDigits: magnitude >= 100 ? 2 : magnitude >= 1 ? 4 : 8,
  });
};

/**
 * Precision for the chart's price scale and crosshair label. Low-priced pairs need more than the
 * library's default two decimals; below 1 the minimum is four, growing as the tick size shrinks.
 */
export function pricePrecision(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return 2;
  if (value >= 100) return 2;
  if (value >= 1) return 4;
  if (value >= 0.1) return 5;
  if (value >= 0.01) return 6;
  if (value >= 0.001) return 7;
  return 8;
}

/** Candle timestamps are UTC, so the legend names the same zone as the time axis. */
export function candleTimeLabel(time: number, timeframe: Timeframe) {
  const intraday = timeframe !== "1d" && timeframe !== "1w";
  return `${new Date(time * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
    ...(intraday ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  })} UTC`;
}

export const percentText = (value: number | null) =>
  value === null || !Number.isFinite(value)
    ? "–"
    : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

export const idFor = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

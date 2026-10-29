import type { Bar, Timeframe } from "@/types/market";
import { intervalSeconds } from "./constants";

/** Most exchanges include the candle that is still forming; it must not drive a signal. */
export function isCandleClosed(
  bar: Pick<Bar, "time">,
  timeframe: Timeframe,
  nowSeconds = Date.now() / 1000,
) {
  return Number(bar.time) + intervalSeconds[timeframe] <= nowSeconds;
}

/**
 * The bars up to and including the newest closed candle. Everything that produces a signal
 * (trend bias, key levels, watchlist scans, pattern detection) reads these rather than the bar
 * that is still moving, so a result cannot be repainted by a tick that lands a second later.
 */
export function closedBars(
  bars: readonly Bar[],
  timeframe: Timeframe,
  nowSeconds = Date.now() / 1000,
): Bar[] {
  let end = bars.length;
  while (end > 0 && !isCandleClosed(bars[end - 1], timeframe, nowSeconds)) end -= 1;
  return bars.slice(0, end);
}

/** Whether the newest loaded bar is the live, still-forming candle. */
export function liveBarIndex(
  bars: readonly Bar[],
  timeframe: Timeframe,
  nowSeconds = Date.now() / 1000,
) {
  if (!bars.length) return -1;
  return isCandleClosed(bars[bars.length - 1], timeframe, nowSeconds) ? -1 : bars.length - 1;
}

/**
 * Merges incoming candles into an existing ascending series.
 *
 * A candle with the same timestamp replaces the stored one (the live candle keeps growing), and
 * anything newer is appended. Older candles are kept when `keepOlder` is set, which is what the
 * history loader needs; the quote poll passes the default so it cannot reorder the series.
 */
export function mergeBars(
  incoming: readonly Bar[],
  existing: readonly Bar[],
  keepOlder = false,
): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of existing) byTime.set(Number(bar.time), bar);
  for (const bar of incoming) {
    const time = Number(bar.time);
    if (!keepOlder && existing.length && time < Number(existing[0].time)) continue;
    byTime.set(time, bar);
  }
  return [...byTime.values()].sort((left, right) => Number(left.time) - Number(right.time));
}

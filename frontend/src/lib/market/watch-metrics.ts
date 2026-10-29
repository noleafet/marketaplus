import type {
  Bar, OpenInterestPoint, Timeframe, WatchMetrics, WatchReading,
} from "@/types/market";
import { closedBars } from "./candles";
import { ema, macdValues, rsi } from "./indicators";

/** A reading that could not be measured, and therefore has no change either. */
const emptyReading: WatchReading = { value: null, change: null };

/** Readings for a pair that has not printed enough candles yet. */
export const emptyWatchMetrics: WatchMetrics = {
  vol: emptyReading,
  rsi: emptyReading,
  ema: emptyReading,
  macd: emptyReading,
  oi: emptyReading,
};

/**
 * Pairs a reading with its change from the previous closed candle, as a percentage of the
 * previous value's magnitude. A zero or missing previous value has no meaningful percentage,
 * so the reading is still shown but the change is left blank.
 */
function reading(value: number | null, previous: number | null): WatchReading {
  if (value === null || previous === null || previous === 0) {
    return { value, change: null };
  }
  return { value, change: ((value - previous) / Math.abs(previous)) * 100 };
}

/** Volume at one candle as a percentage of the twenty candles before it. */
function volumeRatio(bars: Bar[], index: number): number | null {
  if (index < 20) return null;
  const previous = bars.slice(index - 20, index);
  const average = previous.reduce((sum, bar) => sum + bar.volume, 0) / previous.length;
  return average > 0 ? (bars[index].volume / average) * 100 : null;
}

/**
 * Reads one pair's watchlist columns from its candles and recent open interest.
 *
 * Both exchanges leave the newest candle open, so it is dropped before anything is measured.
 * That also matches what the columns mean: they describe what already closed, rather than a
 * number that keeps moving with the live price. Each reading also carries its change from the
 * candle before that one, which is the second-latest closed candle. The volume percentage
 * compares a closed candle with the twenty candles before it, which is why 21 closed bars are
 * needed for a reading.
 */
export function watchMetrics(
  bars: Bar[],
  openInterest: OpenInterestPoint[] = [],
  timeframe: Timeframe = "1h",
  nowSeconds = Date.now() / 1000,
): WatchMetrics {
  const closed = closedBars(bars, timeframe, nowSeconds);
  // A pair needs at least two closed candles for a reading and a change to compare it with.
  if (closed.length < 2) return emptyWatchMetrics;
  const lastClosed = closed.length - 1;
  const previousClosed = lastClosed - 1;
  const closes = closed.map((bar) => bar.close);
  const rsiValues = rsi(closes, 14);
  const emaValues = ema(closes, 100);
  const histogram = macdValues(closes).histogram;
  // Open interest comes from a separate futures endpoint, so match it to the candle timestamps
  // instead of assuming both series line up by index.
  const openInterestByTime = new Map(openInterest.map((point) => [point.time, point.value]));
  const lastClosedTime = Number(closed[lastClosed].time);
  const previousClosedTime = Number(closed[previousClosed].time);

  return {
    vol: reading(volumeRatio(closed, lastClosed), volumeRatio(closed, previousClosed)),
    rsi: reading(rsiValues[lastClosed] ?? null, rsiValues[previousClosed] ?? null),
    ema: reading(emaValues[lastClosed] ?? null, emaValues[previousClosed] ?? null),
    // The histogram is the crossover difference: one sign before the cross, the other after it.
    macd: reading(histogram[lastClosed] ?? null, histogram[previousClosed] ?? null),
    oi: reading(
      openInterestByTime.get(lastClosedTime) ?? null,
      openInterestByTime.get(previousClosedTime) ?? null,
    ),
  };
}

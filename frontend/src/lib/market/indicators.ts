import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import type { Bar } from "@/types/market";

export function ema(values: number[], length: number): (number | null)[] {
  const result: (number | null)[] = Array(values.length).fill(null);
  const alpha = 2 / (length + 1);
  let seed = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (index < length) {
      seed += values[index];
      if (index === length - 1) result[index] = seed / length;
    } else {
      result[index] =
        values[index] * alpha + (result[index - 1] ?? values[index]) * (1 - alpha);
    }
  }
  return result;
}

/** Wilder's RSI over the supplied closes; the first reading lands after `period` changes. */
export function rsi(values: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  result[period] =
    averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] =
      averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

/** Wilder's ATR; true range includes gaps from the previous close, not just the bar's own range. */
export function atr(bars: Bar[], period = 14): (number | null)[] {
  const result: (number | null)[] = Array(bars.length).fill(null);
  if (bars.length <= period) return result;
  const trueRanges = bars.map((bar, index) => {
    const previous = index > 0 ? bars[index - 1].close : bar.open;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous),
      Math.abs(bar.low - previous),
    );
  });
  let value =
    trueRanges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  result[period - 1] = value;
  for (let index = period; index < bars.length; index += 1) {
    value = (value * (period - 1) + trueRanges[index]) / period;
    result[index] = value;
  }
  return result;
}

/** MACD line, signal, and histogram, all aligned to the close array. */
export function macdValues(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): {
  line: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
} {
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const line = closes.map((_, index) =>
    fast[index] !== null && slow[index] !== null
      ? fast[index]! - slow[index]!
      : null,
  );
  const signal: (number | null)[] = Array(line.length).fill(null);
  const seed: number[] = [];
  const alpha = 2 / (signalPeriod + 1);
  for (let index = slowPeriod - 1; index < line.length; index += 1) {
    const value = line[index];
    if (value === null) continue;
    if (seed.length < signalPeriod) {
      seed.push(value);
      if (seed.length === signalPeriod) {
        signal[index] =
          seed.reduce((sum, item) => sum + item, 0) / signalPeriod;
      }
    } else {
      signal[index] = value * alpha + (signal[index - 1] ?? value) * (1 - alpha);
    }
  }
  const histogram = line.map((value, index) =>
    value !== null && signal[index] !== null ? value - signal[index]! : null,
  );
  return { line, signal, histogram };
}

/** Nearest candle to a crosshair position, so the legend works between candles and in the future space. */
export function barIndexForLogical(
  logical: number | null | undefined,
  start: number,
  count: number,
) {
  if (logical === null || logical === undefined || !count) return null;
  return Math.min(count - 1, Math.max(0, Math.round(logical) + start));
}

/** Bollinger Bands: a 20-bar SMA with a band two standard deviations either side of it. */
export function bollingerBands(bars: Bar[], length = 20, multiplier = 2) {
  const middle: (number | null)[] = Array(bars.length).fill(null);
  const upper: (number | null)[] = Array(bars.length).fill(null);
  const lower: (number | null)[] = Array(bars.length).fill(null);
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const close = bars[index].close;
    sum += close;
    sumSquares += close * close;
    if (index >= length) {
      const leaving = bars[index - length].close;
      sum -= leaving;
      sumSquares -= leaving * leaving;
    }
    if (index < length - 1) continue;
    const mean = sum / length;
    // Variance around the window's own mean; clamped at zero so rounding cannot produce NaN.
    const deviation = Math.sqrt(Math.max(0, sumSquares / length - mean * mean));
    middle[index] = mean;
    upper[index] = mean + multiplier * deviation;
    lower[index] = mean - multiplier * deviation;
  }
  return { middle, upper, lower };
}

/** Turns a per-bar indicator value into the sparse points the chart series expect. */
export function indicatorPoints(bars: Bar[], values: (number | null)[]) {
  return bars.flatMap((bar, index) =>
    values[index] === null ? [] : [{ time: bar.time, value: values[index]! }],
  );
}

export function heikinAshi(bars: Bar[]): CandlestickData<UTCTimestamp>[] {
  const result: CandlestickData<UTCTimestamp>[] = [];
  bars.forEach((bar) => {
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const previous = result.at(-1);
    const open = previous
      ? (previous.open + previous.close) / 2
      : (bar.open + bar.close) / 2;
    result.push({
      time: bar.time,
      open,
      close,
      high: Math.max(bar.high, open, close),
      low: Math.min(bar.low, open, close),
    });
  });
  return result;
}

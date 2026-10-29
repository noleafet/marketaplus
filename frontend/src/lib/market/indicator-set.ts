import type { Bar } from "@/types/market";
import { atr, bollingerBands, ema, macdValues, rsi } from "./indicators";

export type IndicatorSet = {
  closes: number[];
  ema100: (number | null)[];
  ema200: (number | null)[];
  rsi: (number | null)[];
  atr: (number | null)[];
  bands: ReturnType<typeof bollingerBands>;
  macd: ReturnType<typeof macdValues>;
};

/**
 * Every per-bar indicator the chart shows, calculated once per candle set.
 *
 * The price pane, the MACD/RSI/ATR panes and the legend all read this object. Recomputing the
 * same arrays per pane used to double the work on every poll and made it easy for a legend and a
 * series to disagree about which bar they were describing.
 */
export function computeIndicators(bars: readonly Bar[]): IndicatorSet {
  const closes = bars.map((bar) => bar.close);
  return {
    closes,
    ema100: ema(closes, 100),
    ema200: ema(closes, 200),
    rsi: rsi(closes),
    atr: atr(bars as Bar[]),
    bands: bollingerBands(bars as Bar[]),
    macd: macdValues(closes),
  };
}

/** Index of the first non-null reading, used to align a lower pane's logical index to a bar. */
export function firstValueIndex(values: readonly (number | null)[]) {
  const index = values.findIndex((value) => value !== null);
  return index < 0 ? 0 : index;
}

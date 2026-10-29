import type { UTCTimestamp } from "lightweight-charts";
import { describe, expect, it } from "vitest";
import type { Bar } from "@/types/market";
import { macdValues } from "../indicators";
import { emptyWatchMetrics, watchMetrics } from "../watch-metrics";

const NOW = 1_700_000_000;
const HOUR = 3600;

/**
 * 35 closed 1H candles plus one live candle. Volumes are flat at 100 except the last closed
 * candle, and the live candle carries an absurd volume that must not leak into the reading.
 */
function scenario() {
  const count = 35;
  const bars: Bar[] = Array.from({ length: count }, (_, index) => {
    // The wave keeps MACD moving, while its slope (1 + cos) never goes negative: RSI stays at 100.
    const close = 100 + index + 2 * Math.sin(index / 2);
    return {
      time: (NOW - (count - index) * HOUR) as UTCTimestamp,
      open: close - 0.5,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: index === count - 1 ? 150 : 100,
    };
  });
  const live: Bar = {
    time: (NOW - HOUR / 2) as UTCTimestamp,
    open: 124,
    high: 300,
    low: 50,
    close: 60,
    volume: 9999,
  };
  return { bars: [...bars, live], closed: bars, lastClosedTime: NOW - HOUR, previousClosedTime: NOW - 2 * HOUR };
}

describe("watchMetrics", () => {
  it("measures the last closed candle, not the live one", () => {
    const { bars, closed, lastClosedTime, previousClosedTime } = scenario();
    const metrics = watchMetrics(
      bars,
      [{ time: lastClosedTime, value: 500 }, { time: previousClosedTime, value: 400 }],
      "1h",
      NOW,
    );

    // Last closed volume is 150 against a 100 average -> 150%, up from the previous 100%.
    expect(metrics.vol.value).toBeCloseTo(150, 10);
    expect(metrics.vol.change).toBeCloseTo(50, 10);

    // Every close rises, so there are no losses and RSI pins at 100.
    expect(metrics.rsi.value).toBeCloseTo(100, 10);
    expect(metrics.rsi.change).toBeCloseTo(0, 10);

    // Not enough closed candles for a 100-period EMA yet.
    expect(metrics.ema).toEqual({ value: null, change: null });

    // The MACD reading is aligned to the last closed candle.
    const last = closed.length - 1;
    const expected = macdValues(closed.map((bar) => bar.close)).histogram[last];
    expect(expected).not.toBeNull();
    expect(metrics.macd.value).toBe(expected);
    expect(metrics.macd.change).not.toBeNull();

    // Open interest is matched by candle timestamp, not by array position.
    expect(metrics.oi.value).toBe(500);
    expect(metrics.oi.change).toBeCloseTo(25, 10);
  });

  it("leaves open interest blank when there is no point at the candle's timestamp", () => {
    const { bars, lastClosedTime } = scenario();
    const metrics = watchMetrics(bars, [{ time: lastClosedTime - 7, value: 500 }], "1h", NOW);
    expect(metrics.oi).toEqual({ value: null, change: null });
  });

  it("returns empty readings when fewer than two candles have closed", () => {
    const bars = [
      { time: (NOW - HOUR + 10) as UTCTimestamp, open: 1, high: 2, low: 1, close: 2, volume: 10 },
    ];
    expect(watchMetrics(bars, [], "1h", NOW)).toEqual(emptyWatchMetrics);
  });
});

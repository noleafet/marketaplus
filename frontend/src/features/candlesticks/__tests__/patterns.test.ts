import { describe, expect, it } from "vitest";
import type { CandleBar } from "../patterns";
import { detectCandlestickPattern } from "../patterns";

const START = 1_700_000_000;

function candle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
): CandleBar {
  return { time: START + index * 3600, open, high, low, close };
}

describe("detectCandlestickPattern", () => {
  it("finds a bullish engulfing after a decline on the newest closed candles", () => {
    const bars: CandleBar[] = [
      candle(0, 110.5, 111, 109, 110),
      candle(1, 109.5, 110, 108, 109),
      candle(2, 108.5, 109, 107, 108),
      candle(3, 107.5, 108, 106, 107),
      candle(4, 106.5, 107, 105, 106),
      candle(5, 105.5, 106, 104, 105),
      candle(6, 104.5, 105, 103, 104),
      candle(7, 103.5, 104, 102, 103),
      // Bearish candle that the next one engulfs.
      candle(8, 100.5, 101, 98.8, 99),
      candle(9, 98.5, 101.5, 98.4, 101),
    ];

    const match = detectCandlestickPattern(bars);
    expect(match).not.toBeNull();
    expect(match!.key).toBe("bullish_engulfing");
    expect(match!.bias).toBe("bullish");
    expect(match!.startIndex).toBe(8);
    expect(match!.endIndex).toBe(9);
    expect(match!.candles).toBe(2);
    expect(match!.endTime).toBe(START + 9 * 3600);
    expect(match!.formationPrice).toBe(101);
    expect(match!.summary).toContain("completed candles");
  });

  it("does not report a shape older than the recent window", () => {
    const bars: CandleBar[] = [
      candle(0, 110.5, 111, 109, 110),
      candle(1, 109.5, 110, 108, 109),
      candle(2, 108.5, 109, 107, 108),
      candle(3, 107.5, 108, 106, 107),
      candle(4, 106.5, 107, 105, 106),
      candle(5, 100.5, 101, 98.8, 99),
      candle(6, 98.5, 101.5, 98.4, 101),
      // Too flat to form any of the recent shapes.
      candle(7, 101, 101.1, 100.9, 101),
      candle(8, 101, 101.1, 100.9, 101),
      candle(9, 101, 101.1, 100.9, 101),
      candle(10, 101, 101.1, 100.9, 101),
      candle(11, 101, 101.1, 100.9, 101),
    ];
    expect(detectCandlestickPattern(bars)).toBeNull();
  });

  it("needs at least four candles", () => {
    expect(detectCandlestickPattern([candle(0, 1, 1, 1, 1)])).toBeNull();
  });
});

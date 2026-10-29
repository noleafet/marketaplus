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

/**
 * Ten bars of context in the direction the shape is supposed to reverse. The reversal detectors
 * read that trend, so a shape appended to the wrong context is a continuation, not a signal.
 */
function series(direction: "up" | "down", rows: [number, number, number, number][]): CandleBar[] {
  const context: CandleBar[] = [];
  for (let index = 0; index < 10; index += 1) {
    const open = direction === "down" ? 120 - index * 1.2 : 100 + index * 1.2;
    const close = direction === "down" ? open - 1 : open + 1;
    context.push(candle(index, open, Math.max(open, close) + 0.2, Math.min(open, close) - 0.2, close));
  }
  return [...context, ...rows.map(([open, high, low, close], index) =>
    candle(context.length + index, open, high, low, close))];
}

type Case = {
  name: string;
  key: string;
  bias: "bullish" | "bearish";
  candles: number;
  direction: "up" | "down";
  rows: [number, number, number, number][];
};

const CASES: Case[] = [
  {
    name: "morning star", key: "morning_star", bias: "bullish", candles: 3, direction: "down",
    rows: [
      [108.4, 108.8, 106.7, 106.9],
      [106.7, 107.0, 106.4, 106.75],
      [106.9, 108.8, 106.8, 108.6],
    ],
  },
  {
    name: "evening star", key: "evening_star", bias: "bearish", candles: 3, direction: "up",
    rows: [
      [111.6, 113.1, 111.2, 113.0],
      [113.1, 113.4, 112.9, 113.15],
      [113.0, 113.2, 110.9, 111.1],
    ],
  },
  {
    name: "three black crows", key: "three_black_crows", bias: "bearish", candles: 3, direction: "up",
    rows: [
      [113.0, 113.2, 110.7, 110.9],
      [111.9, 112.0, 109.6, 109.8],
      [110.7, 110.8, 108.5, 108.7],
    ],
  },
  {
    name: "three outside up", key: "three_outside_up", bias: "bullish", candles: 3, direction: "down",
    rows: [
      [108.3, 108.7, 106.4, 106.6],
      [106.4, 108.8, 106.2, 108.6],
      [108.5, 109.6, 108.4, 109.4],
    ],
  },
  {
    name: "three outside down", key: "three_outside_down", bias: "bearish", candles: 3, direction: "up",
    rows: [
      [111.5, 113.4, 111.4, 113.2],
      [113.4, 113.5, 111.0, 111.2],
      [111.3, 111.5, 110.0, 110.2],
    ],
  },
  {
    name: "piercing line", key: "piercing_line", bias: "bullish", candles: 2, direction: "down",
    rows: [
      [108.6, 108.9, 106.6, 106.8],
      [106.6, 108.4, 106.4, 108.0],
    ],
  },
  {
    name: "dark cloud cover", key: "dark_cloud_cover", bias: "bearish", candles: 2, direction: "up",
    rows: [
      [111.4, 113.5, 111.3, 113.2],
      [113.3, 113.4, 111.6, 112.0],
    ],
  },
  {
    name: "hammer", key: "hammer", bias: "bullish", candles: 1, direction: "down",
    rows: [[108.0, 108.3, 106.0, 108.2]],
  },
  {
    name: "shooting star", key: "shooting_star", bias: "bearish", candles: 1, direction: "up",
    rows: [[112.5, 114.4, 112.1, 112.2]],
  },
  {
    name: "bearish engulfing", key: "bearish_engulfing", bias: "bearish", candles: 2, direction: "up",
    rows: [
      [111.8, 113.1, 111.6, 113.0],
      [113.2, 113.3, 111.3, 111.4],
    ],
  },
  {
    name: "bullish engulfing", key: "bullish_engulfing", bias: "bullish", candles: 2, direction: "down",
    rows: [
      [108.5, 108.7, 106.6, 106.8],
      [106.5, 108.9, 106.4, 108.7],
    ],
  },
  {
    name: "three-bar reversal (bullish)", key: "three_bar_reversal", bias: "bullish", candles: 3, direction: "down",
    rows: [
      [108.8, 109.0, 107.2, 107.3],
      [107.7, 107.8, 107.4, 107.6],
      [107.65, 108.65, 107.55, 108.45],
    ],
  },
  {
    name: "three-bar reversal (bearish)", key: "three_bar_reversal", bias: "bearish", candles: 3, direction: "up",
    rows: [
      [111.6, 113.4, 111.4, 113.2],
      [112.6, 113.0, 112.4, 112.5],
      [112.55, 112.7, 111.3, 111.4],
    ],
  },
];

describe("candlestick detectors", () => {
  for (const item of CASES) {
    it(`recognises ${item.name} after a ${item.direction === "up" ? "rise" : "decline"}`, () => {
      const bars = series(item.direction, item.rows);
      const match = detectCandlestickPattern(bars);

      expect(match).not.toBeNull();
      expect(match!.key).toBe(item.key);
      expect(match!.bias).toBe(item.bias);
      expect(match!.candles).toBe(item.candles);
      expect(match!.startIndex).toBe(bars.length - item.candles);
      expect(match!.endIndex).toBe(bars.length - 1);
      expect(match!.endTime).toBe(START + (bars.length - 1) * 3600);
      expect(match!.formationPrice).toBe(item.rows.at(-1)![3]);
      // The band has to cover every wick of the formation, not just the bodies.
      expect(match!.high).toBe(Math.max(...item.rows.map((row) => row[1])));
      expect(match!.low).toBe(Math.min(...item.rows.map((row) => row[2])));
    });
  }

  it("does not call three bearish candles a reversal at the end of a decline", () => {
    // The same three candles in a falling market are continuation, not Three Black Crows.
    const rows: [number, number, number, number][] = [
      [109.0, 109.2, 106.7, 106.9],
      [107.9, 108.0, 105.6, 105.8],
      [106.7, 106.8, 104.5, 104.7],
    ];
    expect(detectCandlestickPattern(series("down", rows))).toBeNull();
  });
});

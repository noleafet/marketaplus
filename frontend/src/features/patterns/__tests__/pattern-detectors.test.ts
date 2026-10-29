import { describe, expect, it } from "vitest";
import type { PatternBar, PatternMatch, PatternSegment } from "../pattern-analysis";
import { detectPatterns } from "../pattern-analysis";

const START = 1_700_000_000;
const HOUR = 3600;

/**
 * Builds a clean OHLC series from turning points. Straight legs give every anchor one clear
 * pivot: rising and falling stretches never produce a swing on their own, so the detectors see
 * exactly the structure the anchors describe.
 */
function anchorsAt(points: [number, number][], length: number): PatternBar[] {
  const prices = new Array<number>(length).fill(Number.NaN);
  for (let step = 0; step < points.length - 1; step += 1) {
    const [fromIndex, fromPrice] = points[step];
    const [toIndex, toPrice] = points[step + 1];
    const span = Math.max(1, toIndex - fromIndex);
    for (let index = fromIndex; index <= toIndex; index += 1) {
      prices[index] = fromPrice + ((toPrice - fromPrice) * (index - fromIndex)) / span;
    }
  }
  return prices.map((price, index) => ({
    time: START + index * HOUR,
    open: price,
    high: price + 0.25,
    low: price - 0.25,
    close: price,
  }));
}

function only(key: Parameters<typeof detectPatterns>[0][number], bars: PatternBar[]): PatternMatch {
  const matches = detectPatterns([key], bars);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function segmentRole(match: PatternMatch, role: PatternSegment["role"]) {
  const segment = match.segments.find((item) => item.role === role);
  expect(segment).toBeDefined();
  return segment!;
}

/** Price on a straight segment at an arbitrary time, used to check quoted trigger levels. */
function priceAt(segment: PatternSegment, time: number) {
  const span = segment.to.time - segment.from.time;
  return segment.from.price + ((segment.to.price - segment.from.price) * (time - segment.from.time)) / span;
}

function triggerPrice(trigger: string | undefined) {
  expect(trigger).toBeDefined();
  const number = /([\d,]+(?:\.\d+)?)/.exec(trigger!)![1];
  return Number(number.replace(/,/g, ""));
}

const HOUR_MS = HOUR;
const LAST_TIME = (index: number) => START + index * HOUR_MS;

describe("head and shoulders family", () => {
  it("confirms a head and shoulders only after a neckline break", () => {
    // Left shoulder 105, head 112, right shoulder 105, neckline 100, then a break below it.
    const bars = anchorsAt(
      [[0, 98], [8, 105], [14, 100], [20, 112], [26, 100], [32, 105], [45, 96], [49, 96]],
      50,
    );
    const match = only("head_and_shoulders", bars);

    expect(match.forming).toBe(false);
    expect(match.bias).toBe("bearish");
    expect(match.trigger).toBeUndefined();
    expect(match.entry).toMatch(/Neckline broke below 99\.75/);
    expect(match.invalidation).toContain("112.25");
    expect(match.summary).toMatch(/Neckline|neckline/);
    expect(match.summary).toContain("target");

    // The head is the highest swing; both shoulders sit at the same level.
    const peaks = match.markers.filter((marker) => marker.kind === "peak");
    expect(peaks.map((peak) => peak.price)).toEqual([105.25, 112.25, 105.25]);
    expect(peaks.map((peak) => peak.time)).toEqual([LAST_TIME(8), LAST_TIME(20), LAST_TIME(32)]);
    expect(match.labels.map((label) => label.text)).toEqual(
      expect.arrayContaining(["LS", "Head", "RS", "Neckline"]),
    );
  });

  it("projects a missing right shoulder and names the current neckline as the trigger", () => {
    const bars = anchorsAt([[0, 102], [8, 105], [14, 100], [20, 112], [30, 100], [34, 104]], 35);
    const match = only("head_and_shoulders", bars);

    expect(match.forming).toBe(true);
    // The trigger is the neckline where price is now, not at a projected future bar.
    expect(match.trigger).toBe("Close below 99.75 to confirm.");
    expect(match.entry).toBe(match.trigger);
    expect(match.segments.some((segment) => segment.role === "projection")).toBe(true);
    expect(match.labels.map((label) => label.text)).toContain("Projected RS");
    expect(match.summary).toContain("forming");
  });

  it("confirms an inverse head and shoulders on a close above the neckline", () => {
    const bars = anchorsAt(
      [[0, 112], [8, 105], [14, 110], [20, 96], [26, 110], [32, 105], [45, 114], [49, 114]],
      50,
    );
    const match = only("inverse_head_and_shoulders", bars);

    expect(match.forming).toBe(false);
    expect(match.bias).toBe("bullish");
    expect(match.entry).toMatch(/Neckline broke above 110\.25/);
    expect(match.invalidation).toContain("95.75");
    const troughs = match.markers.filter((marker) => marker.kind === "trough");
    expect(troughs.map((trough) => trough.price)).toEqual([104.75, 95.75, 104.75]);
    // The measured move is above the range, so it is named in the summary but not drawn.
    expect(match.summary).toMatch(/target 124\.75/);
  });
});

describe("double top and double bottom", () => {
  it("confirms a double bottom once price closes above the reaction high", () => {
    const bars = anchorsAt([[0, 100], [8, 90], [14, 100], [20, 90], [45, 110], [49, 110]], 50);
    const match = only("double_bottom", bars);

    expect(match.forming).toBe(false);
    expect(match.bias).toBe("bullish");
    expect(match.entry).toBe("Reaction level broke at 100.25.");
    expect(match.invalidation).toContain("below 89.75");
    const target = segmentRole(match, "target");
    expect(target.from.price).toBeCloseTo(110.75, 10);
    expect(target.from.price).toBeGreaterThan(100.25);
    expect(match.summary).toMatch(/target 110\.75/);
  });
});

describe("flags", () => {
  // A 10% pole, then a tight parallel channel that leans the other way for 20 bars.
  const bullFlag = anchorsAt(
    [[0, 100], [9, 110], [11, 110.25], [13, 108.65], [15, 109.35], [17, 107.75],
      [19, 108.45], [21, 106.85], [23, 107.55], [29, 105.5]],
    30,
  );
  const bearFlag = anchorsAt(
    [[0, 110], [9, 100], [11, 100], [13, 101.35], [15, 100.9], [17, 102.25],
      [19, 101.8], [21, 103.15], [23, 102.45], [29, 104.5]],
    30,
  );

  it("quotes the bull flag trigger at the channel edge on the newest bar", () => {
    const match = only("bull_flag", bullFlag);

    expect(match.forming).toBe(true);
    expect(match.bias).toBe("bullish");
    expect(match.entry).toBe(match.trigger);
    expect(match.invalidation).toContain("pole low");
    expect(match.summary).toContain("target");
    // The channel lines are the two boundaries after the pole.
    const upper = match.segments.filter((segment) => segment.role === "boundary")[0];
    const expected = priceAt(upper, LAST_TIME(29));
    expect(triggerPrice(match.trigger)).toBeCloseTo(expected, 2);
    // The confirming close must be above today's price; the projected edge would not be.
    expect(triggerPrice(match.trigger)).toBeGreaterThan(bullFlag.at(-1)!.close);
  });

  it("quotes the bear flag trigger at the channel edge on the newest bar", () => {
    const match = only("bear_flag", bearFlag);

    expect(match.forming).toBe(true);
    expect(match.bias).toBe("bearish");
    expect(match.invalidation).toContain("pole high");
    const lower = match.segments.filter((segment) => segment.role === "boundary")[1];
    const expected = priceAt(lower, LAST_TIME(29));
    expect(triggerPrice(match.trigger)).toBeCloseTo(expected, 2);
    // A bear flag confirms below the current floor, never at a projected future one.
    expect(triggerPrice(match.trigger)).toBeLessThan(bearFlag.at(-1)!.close);
  });
});

describe("triangles and wedges", () => {
  it("keeps a forming ascending triangle bullish with the flat resistance as the trigger", () => {
    const bars = anchorsAt(
      [[0, 101], [5, 99], [10, 110], [15, 102], [20, 110], [25, 105], [30, 110], [35, 109], [39, 109]],
      40,
    );
    const match = only("ascending_triangle", bars);

    expect(match.forming).toBe(true);
    expect(match.bias).toBe("bullish");
    expect(match.trigger).toBe("Close above 110.25 to confirm.");
    expect(match.invalidation).toMatch(/below 108\.95.*upside setup/);
  });

  it("keeps a forming descending triangle bearish with the flat support as the trigger", () => {
    const bars = anchorsAt(
      [[0, 110], [5, 100], [10, 110], [15, 100], [20, 107], [25, 100], [30, 104], [35, 101], [39, 101]],
      40,
    );
    const match = only("descending_triangle", bars);

    expect(match.forming).toBe(true);
    expect(match.bias).toBe("bearish");
    expect(match.trigger).toBe("Close below 99.75 to confirm.");
    expect(match.invalidation).toMatch(/above 101\.55.*downside setup/);
  });

  it("does not claim a side for a symmetrical triangle that has not broken out", () => {
    const bars = anchorsAt(
      [[0, 105], [5, 100], [10, 110], [15, 101], [20, 109], [25, 102], [30, 108], [35, 105], [39, 105]],
      40,
    );
    const match = only("symmetrical_triangle", bars);

    expect(match.forming).toBe(true);
    expect(match.trigger).toMatch(/^Close outside /);
    // Neither edge can invalidate a shape that has not picked a direction yet.
    expect(match.invalidation).toMatch(/close back inside/i);
    expect(match.summary).toContain("target");
  });

  it("confirms a rising wedge to the downside and names the break level", () => {
    const bars = anchorsAt(
      [[0, 98], [5, 100], [10, 104], [15, 103], [20, 106], [25, 105.2], [30, 108], [34, 105]],
      35,
    );
    const match = only("rising_wedge", bars);

    expect(match.forming).toBe(false);
    expect(match.bias).toBe("bearish");
    expect(match.entry).toMatch(/^Break below /);
    expect(match.invalidation).toMatch(/above 109\.05.*downside setup/);
  });

  it("confirms a falling wedge to the upside and keeps its measured target", () => {
    const bars = anchorsAt(
      [[0, 111], [5, 100], [10, 110], [15, 99], [20, 107], [25, 98], [30, 104], [34, 106]],
      35,
    );
    const match = only("falling_wedge", bars);

    expect(match.forming).toBe(false);
    expect(match.bias).toBe("bullish");
    expect(match.entry).toMatch(/^Break above /);
    expect(match.invalidation).toMatch(/below .*upside setup/);
    expect(match.summary).toContain("target");
  });
});

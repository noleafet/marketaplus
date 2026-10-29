import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCandles, fetchOpenInterest, fetchQuotes, isRateLimitError, MarketDataError } from "../market-data";

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function mockFetch(payload: unknown, status = 200) {
  const spy = vi.fn(async (..._args: FetchArgs) => jsonResponse(payload, status));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCandles", () => {
  it("parses Binance candles, converts to seconds, and sorts ascending", () => {
    const spy = mockFetch([
      [1_700_000_000_000, "100", "110", "90", "105", "12.5"],
      [1_700_003_600_000, "105", "115", "95", "110", "7"],
    ]);
    return fetchCandles("BTCUSDT", "1h", 500, "binance", 1_700_003_600_000).then((bars) => {
      expect(bars).toEqual([
        { time: 1_700_000_000, open: 100, high: 110, low: 90, close: 105, volume: 12.5 },
        { time: 1_700_003_600, open: 105, high: 115, low: 95, close: 110, volume: 7 },
      ]);
      const url = String(spy.mock.calls[0][0]);
      expect(url).toContain("symbol=BTCUSDT");
      expect(url).toContain("interval=1h");
      expect(url).toContain("limit=500");
      expect(url).toContain("endTime=1700003600000");
    });
  });

  it("reverses Bybit's newest-first list and caps the page at 1000", async () => {
    const spy = mockFetch({
      result: {
        list: [
          ["1700003600000", "105", "115", "95", "110", "7"],
          ["1700000000000", "100", "110", "90", "105", "12.5"],
        ],
      },
    });
    const bars = await fetchCandles("BTCUSDT", "1h", 5000, "bybit");
    expect(bars.map((bar) => bar.time)).toEqual([1_700_000_000, 1_700_003_600]);
    expect(String(spy.mock.calls[0][0])).toContain("limit=1000");
    expect(String(spy.mock.calls[0][0])).toContain("interval=60");
  });

  it("drops partial rows instead of poisoning the scale", async () => {
    mockFetch([
      [1_700_000_000_000, "100", "110", "90", "105", "12.5"],
      [1_700_003_600_000, "bad", "115", "95", "110", "7"],
    ]);
    const bars = await fetchCandles("BTCUSDT", "1h", 500, "binance");
    expect(bars).toHaveLength(1);
  });

  it("reports a rate limit with a retryable status", async () => {
    mockFetch({ msg: "Too many requests" }, 429);
    const error = await fetchCandles("BTCUSDT", "1h", 500, "binance").catch((reason) => reason);
    expect(error).toBeInstanceOf(MarketDataError);
    expect((error as MarketDataError).status).toBe(429);
    expect(isRateLimitError(error)).toBe(true);
  });
});

describe("fetchQuotes", () => {
  it("batches Binance pairs into one request and computes the 24H change", async () => {
    const spy = mockFetch([
      { symbol: "BTCUSDT", lastPrice: "110", openPrice: "100" },
      { symbol: "ETHUSDT", lastPrice: "50", openPrice: "0" },
      { symbol: "SOLUSDT", lastPrice: "20", openPrice: "25" },
    ]);
    const quotes = await fetchQuotes(["btcusdt", "ETHUSDT"], "binance");
    expect(quotes).toEqual({
      BTCUSDT: { price: 110, change: 10 },
      ETHUSDT: { price: 50, change: 0 },
    });
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("type=MINI");
    expect(url).toContain(encodeURIComponent(JSON.stringify(["BTCUSDT", "ETHUSDT"])));
  });

  it("reads Bybit's percentage field", async () => {
    mockFetch({
      result: { list: [{ symbol: "BTCUSDT", lastPrice: "110", price24hPcnt: "0.05" }] },
    });
    expect(await fetchQuotes(["BTCUSDT"], "bybit")).toEqual({
      BTCUSDT: { price: 110, change: 5 },
    });
  });

  it("returns an empty map without calling the exchange when there are no pairs", async () => {
    const spy = mockFetch([]);
    expect(await fetchQuotes([], "binance")).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("fetchOpenInterest", () => {
  it("normalises Binance points to seconds", async () => {
    mockFetch([{ sumOpenInterest: "1234.5", timestamp: 1_700_000_000_000 }]);
    expect(await fetchOpenInterest("BTCUSDT", "1h", 30, "binance")).toEqual([
      { time: 1_700_000_000, value: 1234.5 },
    ]);
  });

  it("returns nothing for weekly candles, which have no futures period", async () => {
    const spy = mockFetch([]);
    expect(await fetchOpenInterest("BTCUSDT", "1w", 30, "binance")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

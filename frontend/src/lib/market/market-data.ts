import type { UTCTimestamp } from "lightweight-charts";
import type { Bar, Exchange, OpenInterestPoint, Timeframe } from "@/types/market";
import { bybitIntervals, exchangeBases, exchangeName } from "./constants";

type RawCandle = [string, string, string, string, string, string, ...string[]];
type RawOpenInterest = {
  openInterest?: string;
  sumOpenInterest?: string;
  timestamp?: string | number;
};

/**
 * Open interest is a derivatives metric, so it comes from the futures APIs rather than the spot
 * candle endpoints. The weekly interval has no matching period and is left unsupported.
 */
const binanceOpenInterestPeriods: Partial<Record<Timeframe, string>> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

const bybitOpenInterestIntervals: Partial<Record<Timeframe, string>> = {
  "5m": "5min",
  "15m": "15min",
  "1h": "1h",
  "4h": "4h",
  "1d": "24h",
};

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function messageOf(payload: unknown, fallback: string) {
  const detail = (payload as { retMsg?: unknown; msg?: unknown } | null) ?? {};
  const text = [detail.retMsg, detail.msg].find(
    (value) => typeof value === "string" && value,
  );
  return (text as string) || fallback;
}

/** Normalised OHLCV — both exchanges expose the same array indices, only ordering differs. */
export async function fetchCandles(
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  exchange: Exchange,
  /** Optional inclusive end of the requested window, in milliseconds. */
  endTime?: number,
): Promise<Bar[]> {
  const bybit = exchange === "bybit";
  const end = endTime && Number.isFinite(endTime) ? Math.floor(endTime) : null;
  const url = bybit
    ? `${exchangeBases.bybit}/kline?category=spot&symbol=${encodeURIComponent(symbol)}&interval=${bybitIntervals[timeframe]}&limit=${limit}${end ? `&end=${end}` : ""}`
    : `${exchangeBases.binance}/klines?symbol=${encodeURIComponent(symbol)}&interval=${timeframe}&limit=${limit}${end ? `&endTime=${end}` : ""}`;
  const response = await fetch(url, { cache: "no-store" });
  const payload = await readJson<unknown>(response);
  const list = bybit
    ? (payload as { result?: { list?: RawCandle[] } })?.result?.list
    : Array.isArray(payload)
      ? (payload as RawCandle[])
      : null;
  if (!response.ok || !Array.isArray(list) || !list.length) {
    throw new Error(
      messageOf(payload, `Market data is unavailable for ${symbol} on ${exchangeName[exchange]}.`),
    );
  }
  // Bybit lists newest-first; Binance is already oldest-first.
  const ordered = bybit ? [...list].reverse() : list;
  return ordered.flatMap((candle) => {
    const bar = {
      time: Math.floor(Number(candle[0]) / 1000) as UTCTimestamp,
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5]),
    };
    // A partial or empty row would poison the chart scale.
    return Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      bar.time > 0
      ? [bar]
      : [];
  });
}

export async function fetchQuote(
  symbol: string,
  exchange: Exchange,
): Promise<{ price: number; change: number }> {
  const bybit = exchange === "bybit";
  const url = bybit
    ? `${exchangeBases.bybit}/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`
    : `${exchangeBases.binance}/ticker/24hr?type=MINI&symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url, { cache: "no-store" });
  const payload = await readJson<unknown>(response);
  const item = bybit
    ? (payload as { result?: { list?: Record<string, string>[] } })?.result?.list?.[0]
    : (payload as Record<string, string> | null);
  const price = Number(item?.lastPrice);
  if (!response.ok || !Number.isFinite(price)) {
    throw new Error(
      messageOf(payload, `${symbol} is not available on ${exchangeName[exchange]}.`),
    );
  }
  if (bybit) return { price, change: Number(item!.price24hPcnt) * 100 };
  const opening = Number(item!.openPrice);
  return { price, change: opening ? ((price - opening) / opening) * 100 : 0 };
}

/**
 * Fetch recent open-interest observations for the selected interval.
 *
 * Binance returns oldest-first, Bybit newest-first; both are normalised to ascending timestamps
 * so the caller can match a point to a closed candle. Intervals without a futures period (1w)
 * return an empty list, which leaves the OI column blank instead of showing a reading from a
 * different timeframe.
 */
export async function fetchOpenInterest(
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  exchange: Exchange,
): Promise<OpenInterestPoint[]> {
  const bybit = exchange === "bybit";
  const period = bybit
    ? bybitOpenInterestIntervals[timeframe]
    : binanceOpenInterestPeriods[timeframe];
  if (!period) return [];
  const url = bybit
    ? `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${encodeURIComponent(symbol)}&intervalTime=${period}&limit=${limit}`
    : `https://fapi.binance.com/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`;
  const response = await fetch(url, { cache: "no-store" });
  const payload = await readJson<unknown>(response);
  const list: RawOpenInterest[] | null = bybit
    ? (payload as { result?: { list?: RawOpenInterest[] } })?.result?.list ?? null
    : Array.isArray(payload)
      ? (payload as RawOpenInterest[])
      : null;
  if (!response.ok || !list) {
    throw new Error(
      messageOf(payload, `Open interest is unavailable for ${symbol} on ${exchangeName[exchange]}.`),
    );
  }
  const points = list.flatMap((point) => {
    const value = Number(point.openInterest ?? point.sumOpenInterest);
    const timestamp = Number(point.timestamp);
    return Number.isFinite(value) && Number.isFinite(timestamp) && timestamp > 0
      ? [{ time: Math.floor(timestamp / 1000), value }]
      : [];
  });
  return bybit ? points.reverse() : points;
}

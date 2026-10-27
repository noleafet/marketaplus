import type { UTCTimestamp } from "lightweight-charts";
import type { Bar, Exchange, Timeframe } from "@/types/market";
import { bybitIntervals, exchangeBases, exchangeName } from "./constants";

type RawCandle = [string, string, string, string, string, string, ...string[]];

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

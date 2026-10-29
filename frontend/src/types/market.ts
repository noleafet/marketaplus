import type { UTCTimestamp } from "lightweight-charts";

/** Intervals supported by both exchanges and the alert engine. */
export const intervals = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
export type Timeframe = (typeof intervals)[number];
/** The chart deliberately omits 1m: candles are refreshed on a 60-second cadence. */
export const chartIntervals: readonly Timeframe[] = intervals.filter((interval) => interval !== "1m");

export type Exchange = "binance" | "bybit";

/** Normalised OHLCV bar used by the chart and all indicator calculations. */
export type Bar = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** One scan reading plus its change from the previous closed candle, as a percentage. */
export type WatchReading = {
  value: number | null;
  /** (value − previous value) ÷ |previous value| × 100; null when the previous value is zero. */
  change: number | null;
};

/** One open-interest observation, timestamped at the start of its candle. */
export type OpenInterestPoint = {
  /** Unix seconds, matching `Bar.time`. */
  time: number;
  value: number;
};

/** Watchlist scan readings, all measured on the last fully closed candle of the selected interval. */
export type WatchMetrics = {
  /** Last closed candle's volume as a percentage of the previous 20 candles' average. */
  vol: WatchReading;
  rsi: WatchReading;
  ema: WatchReading;
  /** MACD line minus its signal line: positive after a bullish cross, negative after a bearish one. */
  macd: WatchReading;
  /** Open interest at the last closed candle, with its change from the candle before it. */
  oi: WatchReading;
};

export const lineTools = ["trend", "ray", "hline", "hray"] as const;
export type Tool = (typeof lineTools)[number];

export type TradeDirection = "long" | "short";

/** One tinted price band inside a calculator setup, such as the stop-loss or target side. */
export type DrawingZone = {
  low: number;
  high: number;
  tone: TradeDirection;
  label: string;
  /** Boundary price shown on the zone pill; the entry itself is shared by both zones. */
  price: number;
};

export type Drawing = {
  id: string;
  symbol: string;
  type: Tool;
  t1: number;
  p1: number;
  t2?: number;
  p2?: number;
  hidden?: boolean;
  extend?: boolean;
  width: number;
  opacity: number;
  repeat?: boolean;
  /** Calculator drawings are replaced on the next draw instead of accumulating. */
  origin?: "calculator";
  /** Direction colour for a calculator entry zone. */
  tone?: TradeDirection;
  /** Legacy single calculator band; `p1` remains the entry price. */
  zoneLow?: number;
  zoneHigh?: number;
  /**
   * Calculator risk and reward bands. `p1` stays at the entry where the red stop-loss zone and
   * the green take-profit zone meet.
   */
  zones?: DrawingZone[];
  /** Human-readable name shown in the Drawings tab. */
  label?: string;
};

/** A calculator setup that should be projected onto the price chart. */
export type TradeEntryDrawing = {
  symbol: string;
  direction: TradeDirection;
  entry: number;
  stop: number;
  target: number;
};

export type LineAlert = {
  id: number;
  symbol: string;
  kind: "price" | "macd" | "ema" | "prediction";
  price: string | null;
  line_type?: string;
  line_t1?: string | null;
  line_price1?: string | null;
  line_t2?: string | null;
  line_price2?: string | null;
  line_extend?: boolean;
  active: boolean;
  condition: string;
  frequency: string;
};

export type Preferences = {
  timeframe: Timeframe;
  candleType: "candles" | "ha";
  indicators: {
    ema: boolean;
    vol: boolean;
    macd: boolean;
    rsi: boolean;
    atr: boolean;
    bb: boolean;
    keyLevel: boolean;
  };
  drawingsVisible: boolean;
  alertsVisible: boolean;
  magnet: boolean;
};

/** A pattern picture as the server returns it; the bytes stay behind the image URL. */
export type PatternShot = {
  id: number;
  symbol: string;
  /** Chart-pattern pictures and candlestick-monitor captures share the table. */
  category?: "chart" | "candlestick";
  pattern: string;
  timeframe: string;
  summary: string;
  created_at: string;
  image_url: string;
  size: number;
};

export type AnnotateTab = "drawings" | "pattern" | "candlestick" | "calculator";

/** An upcoming CoinMarketCal event scraped for one watchlist pair. */
export type MarketEvent = {
  id: number;
  external_id: string;
  symbol: string;
  coin_symbol: string;
  title: string;
  description: string;
  /** ISO timestamp of the event date. */
  date: string;
  date_end: string | null;
  displayed_date: string;
  impact: "low" | "mid" | "high" | "critical" | "unknown";
  impact_score: number | null;
  impact_summary: string;
  source_url: string;
  categories: string[];
  is_estimated: boolean;
  updated_at: string;
};

export type MarketWorkspaceProps = {
  symbol: string;
  exchange?: Exchange;
  onExchangeChange?: (exchange: Exchange) => void;
  theme?: "light" | "dark";
  onSymbolChange: (symbol: string) => void;
  onPriceSelect: (price: string) => void;
  alerts: LineAlert[];
  onCreateLineAlert: (drawing: Drawing, condition: string, frequency: string) => Promise<void>;
  onUpdateLineAlert: (drawing: Drawing) => void;
  onDeleteLineAlert: (drawing: Drawing) => void;
};

import type { Exchange, Preferences, Timeframe } from "@/types/market";

/** Public REST bases — market data is read straight from the exchange in the browser. */
export const exchangeBases: Record<Exchange, string> = {
  binance: "https://data-api.binance.vision/api/v3",
  bybit: "https://api.bybit.com/v5/market",
};

export const exchangeName: Record<Exchange, string> = {
  binance: "Binance",
  bybit: "Bybit",
};

/** Bybit v5 takes minutes as a string, and days/weeks as single letters. */
export const bybitIntervals: Record<Timeframe, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
  "1w": "W",
};

export const intervalSeconds: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

/** Bars kept in view when a pair or timeframe is loaded. */
export const INITIAL_VISIBLE_BARS = 160;
/** Empty bars kept to the right of the newest candle, for drawings and projected targets. */
export const TRAILING_BARS = 8;
/** Share of the price pane the candles get; the volume histogram is drawn underneath it. */
export const CANDLE_PANE_TOP = 0.82;
/** How long a Clear all button stays armed before it has to be clicked a second time. */
export const CLEAR_ARM_MS = 4000;
/** Candle refresh cadence. Drawings are kept in their own state and are never reloaded by this poll. */
export const CHART_REFRESH_MS = 60000;
export const KEPT_PER_SYMBOL = 10;

export const defaultPreferences: Preferences = {
  timeframe: "1h",
  candleType: "candles",
  indicators: {
    ema: true,
    vol: true,
    macd: false,
    rsi: false,
    atr: false,
    bb: false,
    keyLevel: false,
    trendBias: false,
  },
};

export const palettes = {
  light: {
    bg: "#ffffff",
    grid: "#f4f4f5",
    text: "#71717a",
    green: "#0f7a55",
    red: "#dc2626",
    amber: "#d97706",
    blue: "#2563eb",
    line: "#e4e4e7",
  },
  dark: {
    bg: "#09090b",
    grid: "#1c1c1f",
    text: "#a1a1aa",
    green: "#34d399",
    red: "#f87171",
    amber: "#fbbf24",
    blue: "#60a5fa",
    line: "#27272a",
  },
};

export type Palette = typeof palettes.light;

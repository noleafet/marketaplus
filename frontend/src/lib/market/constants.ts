import type { Exchange, Preferences, Timeframe } from "@/types/market";

/** Public REST bases — market data is read straight from the exchange in the browser. */
export const exchangeBases: Record<Exchange, string> = {
  binance: "https://www.binance.com/fapi/v1",
  bybit: "https://api.bybit.com/v5/market",
};

export const exchangeName: Record<Exchange, string> = {
  binance: "Binance",
  bybit: "Bybit",
};

/** Bybit v5 takes minutes as a string, and days/weeks as single letters. */
export const bybitIntervals: Record<Timeframe, string> = {
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
  "1w": "W",
};

export const intervalSeconds: Record<Timeframe, number> = {
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
    purple: "#8b5cf6",
    line: "#e4e4e7",
    volumeUp: "rgba(15,122,85,.28)",
    volumeDown: "rgba(220,38,38,.28)",
    macdUp: "rgba(15,122,85,.65)",
    macdDown: "rgba(220,38,38,.65)",
  },
  dark: {
    bg: "#171717",
    grid: "#1c1c1f",
    text: "#a1a1aa",
    green: "#34d399",
    red: "#f87171",
    amber: "#fbbf24",
    blue: "#60a5fa",
    purple: "#a78bfa",
    line: "#27272a",
    volumeUp: "rgba(52,211,153,.28)",
    volumeDown: "rgba(248,113,113,.28)",
    macdUp: "rgba(52,211,153,.65)",
    macdDown: "rgba(248,113,113,.65)",
  },
};

export type Palette = typeof palettes.light;
export type ChartTheme = keyof typeof palettes;

/** Token triplets used only when a CSS variable is unavailable (SSR and tests). */
const paletteTriplets: Record<ChartTheme, Record<keyof Omit<Palette, "volumeUp" | "volumeDown" | "macdUp" | "macdDown">, string>> = {
  light: {
    bg: "0 0% 100%",
    grid: "240 4.8% 95.9%",
    text: "240 3.8% 46.1%",
    green: "160 84% 30%",
    red: "0 72% 51%",
    amber: "38 92% 50%",
    blue: "221 83% 53%",
    purple: "262 83% 58%",
    line: "240 5.9% 90%",
  },
  dark: {
    bg: "0 0% 9%",
    grid: "0 0% 14%",
    text: "0 0% 68%",
    green: "158 64% 52%",
    red: "0 91% 71%",
    amber: "43 96% 56%",
    blue: "217 91% 60%",
    purple: "258 90% 66%",
    line: "0 0% 16%",
  },
};

const tokenName: Record<keyof typeof paletteTriplets.light, string> = {
  bg: "--card",
  grid: "--muted",
  text: "--muted-foreground",
  green: "--bullish",
  red: "--bearish",
  amber: "--warning",
  blue: "--chart-1",
  purple: "--chart-4",
  line: "--border",
};

function readTriplet(theme: ChartTheme, key: keyof typeof tokenName) {
  if (typeof document === "undefined") return paletteTriplets[theme][key];
  const value = getComputedStyle(document.documentElement).getPropertyValue(tokenName[key]).trim();
  return value || paletteTriplets[theme][key];
}

const hsl = (triplet: string) => `hsl(${triplet})`;
const hslAlpha = (triplet: string, alpha: number) => `hsl(${triplet} / ${alpha})`;

/**
 * Canvas and Lightweight Charts need concrete colour strings, so the palette is read back
 * from the same custom properties the UI uses. The static `palettes` object remains the
 * fallback for server rendering and unit tests.
 */
export function chartPalette(theme: ChartTheme): Palette {
  if (typeof document === "undefined") return palettes[theme];
  const triplets = Object.fromEntries(
    (Object.keys(tokenName) as (keyof typeof tokenName)[]).map((key) => [key, readTriplet(theme, key)]),
  ) as Record<keyof typeof tokenName, string>;
  return {
    bg: hsl(triplets.bg),
    grid: hsl(triplets.grid),
    text: hsl(triplets.text),
    green: hsl(triplets.green),
    red: hsl(triplets.red),
    amber: hsl(triplets.amber),
    blue: hsl(triplets.blue),
    purple: hsl(triplets.purple),
    line: hsl(triplets.line),
    volumeUp: hslAlpha(triplets.green, 0.28),
    volumeDown: hslAlpha(triplets.red, 0.28),
    macdUp: hslAlpha(triplets.green, 0.65),
    macdDown: hslAlpha(triplets.red, 0.65),
  };
}

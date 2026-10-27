import { intervalSeconds } from "@/lib/market/constants";
import type { Timeframe } from "@/types/market";

const intervalByMinutes: Record<number, Timeframe> = {
  1: "1m",
  5: "5m",
  15: "15m",
  60: "1h",
  240: "4h",
};

/**
 * Links use the chart spelling (`15m`, `1h`), while older links used bare minutes (`interval=15`).
 * Both are accepted; an unknown value falls back to the chart default.
 */
export function parseReportInterval(raw: string | undefined): Timeframe {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "1h";
  if (value === "d" || value === "1d") return "1d";
  if (value === "w" || value === "1w") return "1w";

  const hourMatch = /^(\d+)h$/.exec(value);
  if (hourMatch) return intervalByMinutes[Number(hourMatch[1]) * 60] ?? "1h";

  const minuteMatch = /^(\d+)m?$/.exec(value);
  if (minuteMatch) return intervalByMinutes[Number(minuteMatch[1])] ?? "1h";

  return value === "1h" || value === "4h" ? value : "1h";
}

/**
 * The backend writes `MM/DD/YYYYTHH:mm` in UTC. ISO timestamps are accepted too so a report link
 * can also be composed by hand. Returns seconds since the Unix epoch.
 */
export function parseReportTime(raw: string | undefined): number | null {
  if (!raw) return null;
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* Already decoded. */
  }
  value = value.replace(" ", "T");

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (iso) {
    const [, year, month, day, hour, minute, second = "0"] = iso;
    return Math.floor(Date.UTC(
      Number(year), Number(month) - 1, Number(day),
      Number(hour), Number(minute), Number(second),
    ) / 1000);
  }

  const display = /^(\d{1,2})\/(\d{1,2})\/(\d{4})T(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (display) {
    const [, month, day, year, hour, minute, second = "0"] = display;
    return Math.floor(Date.UTC(
      Number(year), Number(month) - 1, Number(day),
      Number(hour), Number(minute), Number(second),
    ) / 1000);
  }

  const fallback = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  return Number.isNaN(fallback) ? null : Math.floor(fallback / 1000);
}

/** Millisecond window end that includes the candle opening at `barTime`. */
export function reportWindowEnd(barTime: number, timeframe: Timeframe) {
  return (barTime + intervalSeconds[timeframe]) * 1000 - 1;
}

/** Drops the still-forming candle when a live report is opened without a timestamp. */
export function closedBars<T extends { time: number }>(bars: T[], timeframe: Timeframe): T[] {
  const now = Date.now() / 1000;
  return bars.filter((bar) => bar.time + intervalSeconds[timeframe] <= now);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatReportTime(seconds: number) {
  const date = new Date(seconds * 1000);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()]} ${day}, ${date.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

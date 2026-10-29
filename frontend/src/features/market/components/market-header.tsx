import type { FormEvent } from "react";
import { fmt } from "@/lib/format";
import { chartIntervals } from "@/types/market";
import type { Exchange, MarketEvent, Timeframe } from "@/types/market";
import MarketEvents from "./market-events";

type Props = {
  symbol: string;
  exchange: Exchange;
  /** Whether the newest candles came from a successful poll, are still loading, or went stale. */
  connection?: "loading" | "live" | "stale";
  quote: number | null;
  dayChange: number | null;
  events: MarketEvent[];
  timeframe: Timeframe;
  draft: string;
  onExchangeChange?: (exchange: Exchange) => void;
  onTimeframeChange: (timeframe: Timeframe) => void;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

const CONNECTION_TITLES = {
  loading: "Fetching candles from the exchange.",
  live: "The newest candles were confirmed by the latest refresh.",
  stale: "The last refresh failed; the chart shows the last good candles.",
} as const;

export default function MarketHeader({
  symbol,
  exchange,
  connection = "live",
  quote,
  dayChange,
  events,
  timeframe,
  draft,
  onExchangeChange,
  onTimeframeChange,
  onDraftChange,
  onSubmit,
}: Props) {
  return (
    <div className="market-head">
      <div className="market-identity">
        <span className="eyebrow">
          LIVE MARKET · {exchange.toUpperCase()} SPOT
          <span
            className={`chart-connection ${connection}`}
            title={CONNECTION_TITLES[connection]}
          >
            {connection === "live" ? "LIVE" : connection === "loading" ? "LOADING" : "STALE"}
          </span>
        </span>
        <div>
          <strong>{symbol}</strong>
          {quote !== null && <b>{fmt(quote)}</b>}
          {dayChange !== null && (
            <small className={dayChange >= 0 ? "positive" : "negative"}>
              {dayChange >= 0 ? "+" : ""}
              {dayChange.toFixed(2)}% 24H
            </small>
          )}
        </div>
        <MarketEvents events={events} />
      </div>
      <div className="chart-tools">
        <select
          aria-label="Exchange"
          value={exchange}
          onChange={(event) => onExchangeChange?.(event.target.value as Exchange)}
        >
          <option value="binance">Binance</option>
          <option value="bybit">Bybit</option>
        </select>
        <div className="timeframes">
          {chartIntervals.map((interval) => (
            <button
              key={interval}
              aria-pressed={timeframe === interval}
              className={timeframe === interval ? "chosen" : ""}
              onClick={() => onTimeframeChange(interval)}
            >
              {interval}
            </button>
          ))}
        </div>
        <form className="chart-symbol" onSubmit={onSubmit}>
          <span>PAIR</span>
          <input
            aria-label="Market symbol"
            value={draft}
            maxLength={24}
            onChange={(event) =>
              onDraftChange(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
            }
          />
          <button type="submit">Go</button>
        </form>
      </div>
    </div>
  );
}

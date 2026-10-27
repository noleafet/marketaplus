import type { FormEvent } from "react";
import { fmt } from "@/lib/format";
import { chartIntervals } from "@/types/market";
import type { Exchange, MarketEvent, Timeframe } from "@/types/market";
import MarketEvents from "./market-events";

type Props = {
  symbol: string;
  exchange: Exchange;
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

export default function MarketHeader({
  symbol,
  exchange,
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
        <span className="eyebrow">LIVE MARKET · {exchange.toUpperCase()} SPOT</span>
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

import type { FormEvent } from "react";
import { fmt } from "@/lib/format";
import type { Timeframe, WatchMetrics, WatchReading } from "@/types/market";

type Quote = { price: number; change: number };

type Props = {
  watchlist: string[];
  quotes: Record<string, Quote>;
  metrics: Record<string, WatchMetrics>;
  enabled: string[];
  timeframe: Timeframe;
  current: string;
  loaded: boolean;
  notice: string;
  draft: string;
  onSelect: (pair: string) => void;
  onRemove: (pair: string) => void;
  onToggleMetrics: (pair: string) => void;
  onDraftChange: (value: string) => void;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
};

/** Why each scan column exists, used on the headers and on the cells themselves. */
const METRIC_TITLES = {
  vol: "Volume of the last closed candle as a percentage of the previous 20 candles' average",
  rsi: "RSI-14 on the last closed candle",
  ema: "EMA-100 on the last closed candle",
  macd: "MACD crossover difference: the MACD line minus its signal line on the last closed candle. Positive is a bullish cross, negative a bearish one",
  oi: "Open interest at the last closed candle, with its change from the closed candle before it",
} as const;

/**
 * A short change label. Large swings (a MACD cross can be many hundred percent) drop their
 * decimals so the small line under each reading never overflows the column.
 */
function changeLabel(change: number) {
  const magnitude = Math.abs(change);
  const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return `${change >= 0 ? "+" : ""}${change.toFixed(digits)}%`;
}

/**
 * A short numeric cell. The side panel is only a third of the screen, so full precision would
 * either overflow or wrap; four decimals are plenty for a scan and the cell title keeps the
 * meaning visible.
 */
function compact(value: number, digits = 2) {
  const magnitude = Math.abs(value);
  if (magnitude >= 10000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  if (magnitude >= 1) {
    return value.toLocaleString(undefined, { maximumFractionDigits: digits });
  }
  if (magnitude === 0) return "0";
  const places = Math.min(8, Math.max(digits, Math.ceil(-Math.log10(magnitude)) + 2));
  return value.toLocaleString(undefined, { maximumFractionDigits: places });
}

export default function WatchlistPanel({
  watchlist,
  quotes,
  metrics,
  enabled,
  timeframe,
  current,
  loaded,
  notice,
  draft,
  onSelect,
  onRemove,
  onToggleMetrics,
  onDraftChange,
  onAdd,
}: Props) {
  /**
   * Turns a reading into a cell: the value on top, and beneath it the change from the
   * second-latest closed candle. A spinner while the scan runs, a dash when it cannot read.
   */
  const reading = (
    value: WatchReading | undefined,
    title: string,
    format: (value: number) => string,
    valueClass?: (value: number) => string,
  ) => {
    if (value === undefined) {
      return <span className="watch-metric" title={title}>…</span>;
    }
    const { value: current, change } = value;
    return (
      <span className="watch-metric" title={title}>
        <span className={current === null ? undefined : valueClass?.(current)}>
          {current === null ? "–" : format(current)}
        </span>
        {change !== null && (
          <small
            className={`watch-change ${change >= 0 ? "positive" : "negative"}`}
            title="Change from the previous closed candle"
          >
            {changeLabel(change)}
          </small>
        )}
      </span>
    );
  };

  return (
    <section className="panel workspace-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">MARKETS</p>
          <h2>Watchlist</h2>
        </div>
        <span className="count">{watchlist.length} PAIRS</span>
      </div>
      {watchlist.length > 0 && (
        <div className="watch-table">
          <div className="watch-head">
            <span />
            <span className="watch-pair">Pair</span>
            <span>Last</span>
            <span>24H</span>
            <span title={METRIC_TITLES.vol}>Vol</span>
            <span title={METRIC_TITLES.rsi}>RSI</span>
            <span title={METRIC_TITLES.ema}>EMA</span>
            <span title={METRIC_TITLES.macd}>MACD</span>
            <span title={METRIC_TITLES.oi}>OI</span>
            <span />
          </div>
          <div className="watchlist">
            {watchlist.map((pair) => {
              const quote = quotes[pair];
              const on = enabled.includes(pair);
              const metric = on ? metrics[pair] : undefined;
              const macd = metric?.macd;
              return (
                <div
                  className={`watch-row ${pair === current ? "current" : ""}`.trim()}
                  key={pair}
                >
                  <button
                    type="button"
                    className={`watch-toggle ${on ? "active" : ""}`}
                    aria-pressed={on}
                    aria-label={`${on ? "Stop" : "Start"} the watchlist scan for ${pair}`}
                    title={
                      on
                        ? `Stop scanning Vol, RSI-14, EMA-100, MACD and OI for ${pair}`
                        : `Scan Vol, RSI-14, EMA-100, MACD and OI for ${pair} on ${timeframe.toUpperCase()}`
                    }
                    onClick={() => onToggleMetrics(pair)}
                  >
                    #
                  </button>
                  <button className="watch-pair" onClick={() => onSelect(pair)}>
                    {pair}
                  </button>
                  <span>{fmt(quote?.price ?? null)}</span>
                  <small className={(quote?.change ?? 0) >= 0 ? "positive" : "negative"}>
                    {quote ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%` : "–"}
                  </small>
                  {on
                    ? reading(
                        metric?.vol,
                        METRIC_TITLES.vol,
                        (value) => `${Math.round(value)}%`,
                      )
                    : ""}
                  {on
                    ? reading(metric?.rsi, METRIC_TITLES.rsi, (value) => value.toFixed(1))
                    : ""}
                  {on
                    ? reading(metric?.ema, METRIC_TITLES.ema, (value) => compact(value, 4))
                    : ""}
                  {on
                    ? reading(
                        macd,
                        METRIC_TITLES.macd,
                        (value) => `${value >= 0 ? "+" : ""}${compact(value, 4)}`,
                        (value) => (value >= 0 ? "positive" : "negative"),
                      )
                    : ""}
                  {on
                    ? reading(metric?.oi, METRIC_TITLES.oi, (value) => compact(value, 2))
                    : ""}
                  <button
                    className="remove-watch"
                    disabled={!loaded}
                    aria-label={`Remove ${pair}`}
                    onClick={() => onRemove(pair)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {enabled.length > 0 && (
        <p className="watch-scan">
          Indicators tracking - Last closed {timeframe.toUpperCase()} candle over closed candle before it.
        </p>
      )}
      <form className="watch-add" onSubmit={onAdd}>
        <input
          aria-label="Add symbol to watchlist"
          value={draft}
          disabled={!loaded}
          placeholder="Add symbol, e.g. ADAUSDT"
          onChange={(event) =>
            onDraftChange(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
          }
        />
        <button type="submit" disabled={!loaded}>
          Add
        </button>
      </form>
      {notice && <p className="watch-notice" role="status">{notice}</p>}
    </section>
  );
}

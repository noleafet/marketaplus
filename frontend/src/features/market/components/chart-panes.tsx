import type { PointerEventHandler, RefObject } from "react";
import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import { fmt } from "@/lib/format";
import type { Bar, Preferences, Timeframe, Tool } from "@/types/market";
import ChartLegend, { type LegendTone } from "./chart-legend";

type MacdLegend = {
  line: number | null;
  signal: number | null;
  histogram: number | null;
};

type Props = {
  host: RefObject<HTMLDivElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
  patternCanvas: RefObject<HTMLCanvasElement | null>;
  macdHost: RefObject<HTMLDivElement | null>;
  rsiHost: RefObject<HTMLDivElement | null>;
  atrHost: RefObject<HTMLDivElement | null>;
  preferences: Preferences;
  timeframe: Timeframe;
  selected: string | null;
  tool: Tool | null;
  legendBar: Bar | CandlestickData<UTCTimestamp> | null;
  legendTime: number | null;
  legendMacd: MacdLegend | null;
  legendRsi: number | null;
  legendAtr: number | null;
  /** True while the bar under the pointer is the still-forming newest candle. */
  live: boolean;
  message: string;
  patternNote: string;
  /** Persistent description of the detected pattern: entry, invalidation and summary. */
  patternDetail: string;
  /** Higher-timeframe direction with its slope and pivot count. */
  trendBiasDetail: string;
  connection: "loading" | "live" | "stale";
  historyLoading: boolean;
  onRetry: () => void;
  onPointerDown: PointerEventHandler<HTMLCanvasElement>;
  onPointerMove: PointerEventHandler<HTMLCanvasElement>;
  onPointerUp: PointerEventHandler<HTMLCanvasElement>;
};

export default function ChartPanes({
  host,
  canvas,
  patternCanvas,
  macdHost,
  rsiHost,
  atrHost,
  preferences,
  timeframe,
  selected,
  tool,
  legendBar,
  legendTime,
  legendMacd,
  legendRsi,
  legendAtr,
  live,
  message,
  patternNote,
  patternDetail,
  trendBiasDetail,
  connection,
  historyLoading,
  onRetry,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: Props) {
  const legendReady = legendBar !== null && legendTime !== null;
  // A candle is bullish when it closes above its open, which is the same direction used by the
  // candle body colours. Doji candles stay neutral rather than pretending to have a bias.
  const candleTone: LegendTone | undefined =
    legendBar === null
      ? undefined
      : legendBar.close > legendBar.open
        ? "bullish"
        : legendBar.close < legendBar.open
          ? "bearish"
          : undefined;
  const macdTone: LegendTone | undefined =
    legendMacd?.line == null ||
    legendMacd.signal == null ||
    legendMacd.line === legendMacd.signal
      ? undefined
      : legendMacd.line > legendMacd.signal
        ? "bullish"
        : "bearish";
  const histogramTone: LegendTone | undefined =
    legendMacd?.histogram == null || legendMacd.histogram === 0
      ? undefined
      : legendMacd.histogram > 0
        ? "bullish"
        : "bearish";
  const rsiTone: LegendTone | undefined =
    legendRsi === null || legendRsi === 50
      ? undefined
      : legendRsi > 50
        ? "bullish"
        : "bearish";

  return (
    <>
      <div className="chart-area workspace-chart-area">
        <div ref={host} className="chart-container workspace-chart" />
        <canvas
          ref={canvas}
          className={`drawing-overlay ${selected && !tool ? "interactive" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Selected chart drawing; drag to edit"
        />
        <canvas ref={patternCanvas} className="pattern-overlay" aria-hidden="true" />
        {legendReady && (
          <ChartLegend
            ariaLabel="Candle details"
            time={legendTime}
            timeframe={timeframe}
            live={live}
            entries={[
              { label: "Entry", value: fmt(legendBar.open), title: "Candle open", tone: candleTone },
              { label: "High", value: fmt(legendBar.high), tone: candleTone },
              { label: "Low", value: fmt(legendBar.low), tone: candleTone },
            ]}
          />
        )}
        {message && (
          <div className="chart-message" role="status">
            <div className="chart-message-box">
              <span>{message}</span>
              {connection === "stale" && (
                <button type="button" className="chart-retry" onClick={onRetry}>
                  Retry
                </button>
              )}
            </div>
          </div>
        )}
        {patternNote && <div className="pattern-note" role="status">{patternNote}</div>}
      </div>
      <div className="indicator-pane" hidden={!preferences.indicators.macd}>
        <div ref={macdHost} className="macd-chart" hidden={!preferences.indicators.macd} />
        {legendReady && (
          <ChartLegend
            ariaLabel="MACD details"
            time={legendTime}
            timeframe={timeframe}
            pane
            entries={[
              { label: "MACD", value: fmt(legendMacd?.line ?? null), tone: macdTone },
              { label: "Signal", value: fmt(legendMacd?.signal ?? null), tone: macdTone },
              { label: "Hist", value: fmt(legendMacd?.histogram ?? null), tone: histogramTone },
            ]}
          />
        )}
      </div>
      <div className="indicator-pane" hidden={!preferences.indicators.rsi}>
        <div ref={rsiHost} className="rsi-chart" hidden={!preferences.indicators.rsi} />
        {legendReady && (
          <ChartLegend
            ariaLabel="RSI details"
            time={legendTime}
            timeframe={timeframe}
            pane
            entries={[{ label: "RSI 14", value: fmt(legendRsi), tone: rsiTone }]}
          />
        )}
      </div>
      <div className="indicator-pane" hidden={!preferences.indicators.atr}>
        <div ref={atrHost} className="atr-chart" hidden={!preferences.indicators.atr} />
        {legendReady && (
          <ChartLegend
            ariaLabel="ATR details"
            time={legendTime}
            timeframe={timeframe}
            pane
            entries={[{ label: "ATR 14", value: fmt(legendAtr) }]}
          />
        )}
      </div>
      <p className="chart-hint" role="status">
        {[
          connection === "stale" ? "Live data delayed — showing the last good candles." : null,
          historyLoading ? "Loading older candles…" : null,
          trendBiasDetail ? `Trend bias (context): ${trendBiasDetail}` : null,
          patternDetail || null,
        ].filter(Boolean).join(" · ") || "\u00a0"}
      </p>
    </>
  );
}

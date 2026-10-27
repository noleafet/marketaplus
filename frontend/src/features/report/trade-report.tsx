"use client";

import { useEffect, useMemo, useState } from "react";
import { API } from "@/lib/api/client";
import { fmt, percentText, pricePrecision } from "@/lib/format";
import { exchangeName } from "@/lib/market/constants";
import { atr, ema, macdValues, rsi } from "@/lib/market/indicators";
import { findKeyLevels, MIN_DISPLAY_STRENGTH, type KeyLevel } from "@/lib/market/key-levels";
import { fetchCandles } from "@/lib/market/market-data";
import type { Bar, Exchange } from "@/types/market";
import {
  closedBars, formatReportTime, parseReportInterval, parseReportTime, reportWindowEnd,
} from "./report-utils";

type Props = {
  token: string;
  interval: string;
  time: string;
  exchange?: string;
  subject?: string;
};

type Direction = "long" | "short";

type BiasState = "Bullish" | "Bearish" | "Bullish-Balanced" | "Bearish-Balanced";

type TradePlan = {
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  reward: number;
  stopPercent: number;
  targetPercent: number;
};

type ReportLevel = KeyLevel & { distance: number };

type ReportData = {
  price: number;
  rsi: number | null;
  rsiState: BiasState | null;
  ema: number | null;
  emaState: BiasState | null;
  atr: number | null;
  volume: number;
  volumePercent: number | null;
  volumeAverage: number | null;
  macdDiff: number | null;
  macdStatus: "Bullish" | "Bearish" | null;
  distance: number | null;
  levels: ReportLevel[];
  /** Nearest scored support below price, or null when none qualifies. */
  support: ReportLevel | null;
  /** Nearest scored resistance above price, or null when none qualifies. */
  resistance: ReportLevel | null;
  plans: TradePlan[];
  suggested: Direction;
  barTime: number;
  barCount: number;
};

const ATR_MULTIPLE = 1.5;
const RISK_REWARD = 3;
const VOLUME_AVERAGE_BARS = 20;
const VOLUME_HOT_PERCENT = 150;

const priceText = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "–" : `$${fmt(value)}`;

const exchangeValue = (value: string | undefined): Exchange | null =>
  value === "binance" || value === "bybit" ? value : null;

function classifyRsi(value: number | null): BiasState | null {
  if (value === null) return null;
  if (value >= 70) return "Bullish";
  if (value <= 30) return "Bearish";
  return value >= 50 ? "Bullish-Balanced" : "Bearish-Balanced";
}

function classifyEma(price: number, emaValue: number | null): BiasState | null {
  if (emaValue === null) return null;
  const tolerance = emaValue * 0.001;
  if (price > emaValue + tolerance) return "Bullish";
  if (price < emaValue - tolerance) return "Bearish";
  return price >= emaValue ? "Bullish-Balanced" : "Bearish-Balanced";
}

function buildPlan(direction: Direction, entry: number, risk: number): TradePlan | null {
  const stop = direction === "long" ? entry - risk : entry + risk;
  const target = direction === "long" ? entry + risk * RISK_REWARD : entry - risk * RISK_REWARD;
  if (!Number.isFinite(stop) || !Number.isFinite(target) || stop <= 0 || target <= 0) return null;
  return {
    direction,
    entry,
    stop,
    target,
    risk,
    reward: risk * RISK_REWARD,
    stopPercent: ((stop - entry) / entry) * 100,
    targetPercent: ((target - entry) / entry) * 100,
  };
}

function levelRows(levels: KeyLevel[], price: number) {
  return levels
    .map((level) => ({ ...level, distance: ((level.price - price) / price) * 100 }))
    .sort((left, right) => Math.abs(left.distance) - Math.abs(right.distance));
}

type LevelEdge = { price: number; percent: number };

/**
 * The two edges of a level band, ordered from the entry so a range always reads nearest edge first.
 * A stop below a long entry is the band's upper edge; the wider edge follows.
 */
function levelEdges(level: KeyLevel, entry: number): LevelEdge[] {
  return [level.low, level.high]
    .map((price) => ({ price, percent: ((price - entry) / entry) * 100 }))
    .sort((left, right) => Math.abs(left.percent) - Math.abs(right.percent));
}

function levelEdgeList(edges: LevelEdge[]) {
  return edges.map((edge, index) => (
    <span className="level-edge" key={edge.price}>
      {index > 0 && <span className="edge-sep">–</span>}
      <span className="edge-price">{priceText(edge.price)}</span>
      <small className={edge.percent >= 0 ? "tone-bullish" : "tone-bearish"}>
        {percentText(edge.percent)}
      </small>
    </span>
  ));
}

export default function TradeReport({ token, interval, time, exchange: exchangeParam, subject }: Props) {
  const timeframe = useMemo(() => parseReportInterval(interval), [interval]);
  const barTime = useMemo(() => parseReportTime(time), [time]);
  const symbol = token.trim().toUpperCase();
  const reportSubject = subject?.trim() || `${symbol || "Market"}(${timeframe}) MACD Crossed`;

  const [exchange, setExchange] = useState<Exchange | null>(exchangeValue(exchangeParam));
  const [exchangeNote, setExchangeNote] = useState("");
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entryTab, setEntryTab] = useState<Direction>("long");

  // The alert does not carry an exchange, so follow the one the backend is configured to use.
  useEffect(() => {
    const fixed = exchangeValue(exchangeParam);
    if (fixed) {
      setExchange(fixed);
      return;
    }
    let active = true;
    fetch(`${API}/exchange/`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { exchange?: string } | null) => {
        if (!active) return;
        setExchange(payload?.exchange === "bybit" ? "bybit" : "binance");
      })
      .catch(() => {
        if (!active) return;
        setExchange("binance");
        setExchangeNote("The configured exchange could not be read; Binance public data is shown.");
      });
    return () => { active = false; };
  }, [exchangeParam]);

  useEffect(() => {
    if (!symbol) {
      setLoading(false);
      setError("This report link does not name a market symbol.");
      return;
    }
    if (!exchange) return;

    let active = true;
    setLoading(true);
    setError("");
    const endTime = barTime !== null ? reportWindowEnd(barTime, timeframe) : undefined;
    fetchCandles(symbol, timeframe, 1000, exchange, endTime)
      .then((candles) => {
        if (!active) return;
        const selected = barTime !== null
          ? candles.filter((bar) => bar.time <= barTime)
          : candles;
        // Every metric — including volume — comes from completed candles, so a link
        // opened while a candle is forming cannot shift the 20-candle baseline.
        const window = closedBars(selected, timeframe);
        if (window.length < 30) {
          throw new Error(`Not enough completed ${timeframe} candles are available for this report.`);
        }
        setBars(window);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setBars([]);
        setError(reason instanceof Error ? reason.message : "Market data could not be loaded.");
        setLoading(false);
      });
    return () => { active = false; };
  }, [symbol, timeframe, barTime, exchange]);

  const report = useMemo<ReportData | null>(() => {
    if (bars.length < 30) return null;
    const closes = bars.map((bar) => bar.close);
    const price = closes[closes.length - 1];
    const emaValue = ema(closes, 100).at(-1) ?? null;
    const rsiValue = rsi(closes).at(-1) ?? null;
    const atrValue = atr(bars).at(-1) ?? null;
    const macd = macdValues(closes);
    const macdLine = macd.line.at(-1) ?? null;
    const signalLine = macd.signal.at(-1) ?? null;
    const macdDiff = macdLine !== null && signalLine !== null ? macdLine - signalLine : null;
    const macdStatus = macdDiff === null ? null : macdDiff >= 0 ? "Bullish" : "Bearish";
    const distance = macdDiff !== null && atrValue !== null && atrValue > 0
      ? (Math.abs(macdDiff) / atrValue) * 100
      : null;
    const risk = atrValue !== null && atrValue > 0 ? atrValue * ATR_MULTIPLE : null;
    const plans = risk === null
      ? []
      : [buildPlan("long", price, risk), buildPlan("short", price, risk)]
        .filter((plan): plan is TradePlan => plan !== null);
    // Match the alert notification: the last completed candle against the previous 20.
    const baselineVolumes = bars
      .slice(-VOLUME_AVERAGE_BARS - 1, -1)
      .map((bar) => bar.volume);
    const volumeAverage = baselineVolumes.length
      ? baselineVolumes.reduce((total, volume) => total + volume, 0) / baselineVolumes.length
      : null;
    const volumePercent = volumeAverage !== null && volumeAverage > 0
      ? (bars[bars.length - 1].volume / volumeAverage) * 100
      : null;
    const levels = findKeyLevels(bars);
    const rows = levelRows([...levels.supports, ...levels.resistances], price);
    const suggested: Direction = macdStatus === "Bearish"
      ? "short"
      : macdStatus === "Bullish"
        ? "long"
        : emaValue !== null && price < emaValue ? "short" : "long";
    return {
      price,
      rsi: rsiValue,
      rsiState: classifyRsi(rsiValue),
      ema: emaValue,
      emaState: classifyEma(price, emaValue),
      atr: atrValue,
      volume: bars[bars.length - 1].volume,
      volumePercent,
      volumeAverage,
      macdDiff,
      macdStatus,
      distance,
      levels: rows,
      support: rows.find((level) => level.kind === "support") ?? null,
      resistance: rows.find((level) => level.kind === "resistance") ?? null,
      plans,
      suggested,
      barTime: bars[bars.length - 1].time,
      barCount: bars.length,
    };
  }, [bars]);

  const statusTone = report?.macdStatus?.toLowerCase() ?? "neutral";
  const activePlan = report?.plans.find((plan) => plan.direction === entryTab) ?? null;
  // A short is stopped above price at resistance and targets the support below; a long reverses both.
  const stopLevel = report ? (entryTab === "short" ? report.resistance : report.support) : null;
  const targetLevel = report ? (entryTab === "short" ? report.support : report.resistance) : null;
  const stopEdges = report && stopLevel ? levelEdges(stopLevel, report.price) : [];
  const targetEdges = report && targetLevel ? levelEdges(targetLevel, report.price) : [];
  const subjectTime = report?.barTime ?? barTime;
  const subjectText = subjectTime !== null
    ? `${reportSubject} at ${formatReportTime(subjectTime)}`
    : reportSubject;

  useEffect(() => {
    if (report?.suggested) setEntryTab(report.suggested);
  }, [report?.suggested]);

  return (
    <>
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b bg-background/80 px-4 backdrop-blur-md md:px-6">
        <a href="/" className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-[11px] font-semibold text-primary-foreground">
            M+
          </span>
          <span className="truncate text-sm font-semibold tracking-tight">Marketa+</span>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            Alert report
          </span>
        </a>
        <a
          href="/"
          className="inline-flex h-8 shrink-0 items-center rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Back to dashboard
        </a>
      </header>

      <main className="shell report-page">

      <section className="report-hero">
        <div>
          <p className="report-subject">
            {subjectText}
          </p>
        </div>
      </section>

      {loading && (
        <section className="report-card report-message">
          <b>Loading market data…</b>
          <p>Fetching {symbol || "the market"} {timeframe} candles from {exchange ? exchangeName[exchange] : "the exchange"}.</p>
        </section>
      )}

      {!loading && error && (
        <section className="report-card report-message error">
          <b>Report unavailable</b>
          <p>{error}</p>
          <a className="report-action" href="/">Return to the dashboard</a>
        </section>
      )}

      {!loading && !error && report && (
        <div className="report-layout">
          <div className="report-main">
            {exchangeNote && <p className="report-note">{exchangeNote}</p>}

            <section className="report-card">
              <div className="report-card-head">
                <div className="report-entry-tabs" role="tablist" aria-label="Entry direction">
                  {(["long", "short"] as Direction[]).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      role="tab"
                      aria-selected={entryTab === direction}
                      className={`${direction}${entryTab === direction ? " active" : ""}`}
                      onClick={() => setEntryTab(direction)}
                    >
                      {direction === "long" ? "Long" : "Short"}
                    </button>
                  ))}
                </div>
              </div>

              {activePlan ? (
                <article
                  className={`report-plan ${activePlan.direction}${
                    activePlan.direction === report.suggested ? " suggested" : ""
                  }`}
                >
                  <dl>
                    <div>
                      <dt>Entry</dt>
                      <dd>{priceText(activePlan.entry)}</dd>
                    </div>
                    <div>
                      <dt>Stop loss</dt>
                      <dd>
                        {priceText(activePlan.stop)}
                        <small>{percentText(activePlan.stopPercent)}</small>
                      </dd>
                    </div>
                    <div>
                      <dt>Take profit</dt>
                      <dd>
                        {priceText(activePlan.target)}
                        <small>{percentText(activePlan.targetPercent)}</small>
                      </dd>
                    </div>
                    <div>
                      <dt>Risk</dt>
                      <dd>{priceText(activePlan.risk)}</dd>
                    </div>
                    <div>
                      <dt>Reward</dt>
                      <dd>{priceText(activePlan.reward)}</dd>
                    </div>
                  </dl>
                </article>
              ) : (
                <p className="report-note">
                  ATR is not available yet, so a stop and target cannot be calculated.
                </p>
              )}

              {(stopLevel || targetLevel) && (
                <div className="report-level-plan">
                  <div className="report-level-plan-head">
                    <h3>Key-level stop &amp; target</h3>
                    <span>{entryTab === "short" ? "Short entry" : "Long entry"}</span>
                  </div>
                  <dl>
                    {stopLevel && (
                      <div>
                        <dt>
                          Stop loss <em>({stopLevel.kind})</em>
                        </dt>
                        <dd>{levelEdgeList(stopEdges)}</dd>
                      </div>
                    )}
                    {targetLevel && (
                      <div>
                        <dt>
                          Take profit <em>({targetLevel.kind})</em>
                        </dt>
                        <dd>{levelEdgeList(targetEdges)}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
            </section>
          </div>

          <aside className="report-side">
            <section className="report-card" aria-label="Market snapshot">
              <div className="report-metrics">
                <div className="report-metric">
                  <span>Price</span>
                  <b>{priceText(report.price)}</b>
                </div>
                <div className="report-metric">
                  <span>MACD</span>
                  <b className={`tone-${statusTone}`}>{report.macdStatus ?? "–"}</b>
                </div>
                <div className="report-metric report-metric-wide">
                  <span>RSI 14</span>
                  <b className={report.rsiState ? `tone-${report.rsiState.toLowerCase()}` : undefined}>
                    {report.rsi === null
                      ? "–"
                      : `${report.rsi.toFixed(1)}${report.rsiState ? ` (${report.rsiState})` : ""}`}
                  </b>
                </div>
                <div className="report-metric report-metric-wide">
                  <span>EMA 100</span>
                  <b className={report.emaState ? `tone-${report.emaState.toLowerCase()}` : undefined}>
                    {report.ema === null
                      ? "–"
                      : `${priceText(report.ema)}${report.emaState ? ` (${report.emaState})` : ""}`}
                  </b>
                </div>
                <div className="report-metric">
                  <span>ATR 14</span>
                  <b>{report.atr === null ? "–" : report.atr.toFixed(pricePrecision(report.atr))}</b>
                </div>
                <div className="report-metric">
                  <span>Volume</span>
                  <b
                    className={
                      report.volumePercent !== null && report.volumePercent >= VOLUME_HOT_PERCENT
                        ? "tone-bullish"
                        : undefined
                    }
                  >
                    {report.volumePercent === null ? "–" : `${report.volumePercent.toFixed(0)}%`}
                  </b>
                </div>
              </div>
            </section>

            <section className="report-card">

              {report.levels.length ? (
                <div className="report-level-list">
                  {report.levels.map((level) => (
                    <div className="report-level-row" key={`${level.kind}-${level.price}`}>
                      <span className={`level-kind ${level.kind}`}>{level.kind}</span>
                      <b>{priceText(level.price)}</b>
                      <span className={level.distance >= 0 ? "tone-bullish" : "tone-bearish"}>
                        {percentText(level.distance)}
                      </span>
                      <span className="report-strength" title={`Strength ${level.strength}/100`}>
                        <i style={{ width: `${level.strength}%` }} />
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="report-note">
                  No support or resistance level in range scored {MIN_DISPLAY_STRENGTH} or higher.
                </p>
              )}
            </section>
          </aside>
        </div>
      )}
      </main>
    </>
  );
}

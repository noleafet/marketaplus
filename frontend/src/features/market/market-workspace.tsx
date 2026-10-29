"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType, CrosshairMode, LineStyle, createChart,
  type IChartApi, type MouseEventParams,
} from "lightweight-charts";
import { API, readJson } from "@/lib/api/client";
import { copyWindowSoon, drawingCoordinate } from "@/lib/chart";
import { fmt, idFor, pricePrecision } from "@/lib/format";
import {
  CANDLE_PANE_TOP, CHART_REFRESH_MS, CLEAR_ARM_MS, INITIAL_VISIBLE_BARS, KEPT_PER_SYMBOL,
  TRAILING_BARS, defaultPreferences, exchangeName, intervalSeconds, palettes,
} from "@/lib/market/constants";
import {
  atr, barIndexForLogical, bollingerBands, ema, heikinAshi, indicatorPoints,
  macdValues, rsi,
} from "@/lib/market/indicators";
import { findKeyLevels } from "@/lib/market/key-levels";
import { fetchCandles, fetchOpenInterest, fetchQuote } from "@/lib/market/market-data";
import {
  findTrendBias, TREND_BIAS_TIMEFRAMES, type TrendBiasTimeframe,
} from "@/lib/market/trend-bias";
import { emptyWatchMetrics, watchMetrics } from "@/lib/market/watch-metrics";
import { readSaved } from "@/lib/storage";
import CandlestickGuide from "@/features/candlesticks/components/candlestick-guide";
import CandlestickMonitor from "@/features/candlesticks/components/candlestick-monitor";
import { paintCandlestick } from "@/features/candlesticks/paint-candlestick";
import {
  CANDLESTICK_RECENT_BARS, detectCandlestickPattern, type CandlestickMatch,
} from "@/features/candlesticks/patterns";
import PatternGuide from "@/features/patterns/components/pattern-guide";
import {
  bestPattern, detectPatterns, patternChoices, patternFileName,
  type PatternBar, type PatternMatch,
} from "@/features/patterns/pattern-analysis";
import { matchName, paintPattern, paintPatternCaption } from "@/features/patterns/paint-pattern";
import { chartIntervals } from "@/types/market";
import type {
  AnnotateTab, Bar, Drawing, DrawingZone, MarketEvent, MarketWorkspaceProps, PatternShot,
  Preferences, Tool, TradeEntryDrawing, WatchMetrics,
} from "@/types/market";
import AnnotatePanel from "./components/annotate-panel";
import { IndicatorControls, PatternControls } from "./components/chart-controls";
import ChartPanes from "./components/chart-panes";
import DrawingToolbar from "./components/drawing-toolbar";
import MarketHeader from "./components/market-header";
import WatchlistPanel from "./components/watchlist-panel";

const STORED_IMAGE_WIDTH = 1400;
/** The backend column is 240 characters, so a verbose summary is trimmed rather than rejected. */
const STORED_SUMMARY_CHARS = 240;
/** Candlestick-monitor cadence; the monitor starts paused so it never runs by surprise. */
const CANDLESTICK_CHECK_MS = 60000;
/** Pattern analysis reads only the newest 50 candles, refreshed on the same cadence. */
const PATTERN_RECENT_BARS = 50;
const PATTERN_CHECK_MS = 60000;
/** Every detector is tried; the controls no longer offer a single-pattern filter. */
const PATTERN_KEYS = patternChoices.map((item) => item.value);
/** One watchlist scan needs enough candles for EMA-100, RSI-14 and the MACD warm-up. */
const WATCH_METRIC_BARS = 160;
/** Open interest is matched to the two latest closed candles, so a couple of periods suffice. */
const WATCH_OI_POINTS = 4;
/** Enabled watchlist rows rescan once a minute, apart from the 8-second quote poll. */
const WATCH_METRIC_MS = 60000;
/** Calculator entry zones mostly sit behind the latest candle, with a little room to the right. */
const ENTRY_ZONE_PAST_BARS = 18;
const ENTRY_ZONE_FUTURE_BARS = 6;
/** Higher-timeframe candles used to fit the Trend Bias channels. */
const TREND_BIAS_BARS = 320;

/** Calculator drawings drawn before stop/target zones existed still use a single entry band. */
function entryZones(line: Drawing): DrawingZone[] {
  if (line.zones?.length) return line.zones;
  if (line.zoneLow === undefined || line.zoneHigh === undefined) return [];
  return [{
    low: line.zoneLow,
    high: line.zoneHigh,
    tone: line.tone ?? "long",
    label: line.label ?? "Entry",
    price: line.p1,
  }];
}

type PaneIndicatorValues = {
  rsi: (number | null)[];
  atr: (number | null)[];
  macd: ReturnType<typeof macdValues>;
};
export default function MarketWorkspace({ symbol, exchange = "binance", onExchangeChange, theme = "light", onSymbolChange, onPriceSelect, alerts, onCreateLineAlert, onUpdateLineAlert, onDeleteLineAlert }: MarketWorkspaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const colors = palettes[theme];
  const macdHost = useRef<HTMLDivElement>(null);
  const rsiHost = useRef<HTMLDivElement>(null);
  const atrHost = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** Layer the pattern overlay is drawn on, kept apart from the user's drawings. */
  const patternCanvas = useRef<HTMLCanvasElement>(null);
  const chartApi = useRef<ReturnType<typeof createChart> | null>(null);
  const macdApi = useRef<ReturnType<typeof createChart> | null>(null);
  const rsiApi = useRef<ReturnType<typeof createChart> | null>(null);
  const atrApi = useRef<ReturnType<typeof createChart> | null>(null);
  const series = useRef<{ candles: ReturnType<ReturnType<typeof createChart>["addCandlestickSeries"]>; volume: ReturnType<ReturnType<typeof createChart>["addHistogramSeries"]>; ema100: ReturnType<ReturnType<typeof createChart>["addLineSeries"]>; ema200: ReturnType<ReturnType<typeof createChart>["addLineSeries"]>; bbUpper: ReturnType<ReturnType<typeof createChart>["addLineSeries"]>; bbMiddle: ReturnType<ReturnType<typeof createChart>["addLineSeries"]>; bbLower: ReturnType<ReturnType<typeof createChart>["addLineSeries"]> } | null>(null);
  const macdSeries = useRef<{ histogram: ReturnType<ReturnType<typeof createChart>["addHistogramSeries"]>; line: ReturnType<ReturnType<typeof createChart>["addLineSeries"]>; signal: ReturnType<ReturnType<typeof createChart>["addLineSeries"]> } | null>(null);
  const rsiSeries = useRef<{ line: ReturnType<ReturnType<typeof createChart>["addLineSeries"]> } | null>(null);
  const atrSeries = useRef<{ line: ReturnType<ReturnType<typeof createChart>["addLineSeries"]> } | null>(null);
  const barsRef = useRef<Bar[]>([]);
  const modeRef = useRef<Tool | null>(null);
  const pendingRef = useRef<{ time: number; price: number } | null>(null);
  const dragRef = useRef<{ id: string; part: "p1" | "p2" | "body"; start: { time: number; price: number }; original: Drawing } | null>(null);
  const modifiers = useRef({ ctrl: false, shift: false });
  const syncing = useRef(false);
  /** Latest indicator arrays, used to put a meaningful horizontal crosshair in each pane. */
  const indicatorValues = useRef<PaneIndicatorValues>({
    rsi: [],
    atr: [],
    macd: { line: [], signal: [], histogram: [] },
  });
  /** Moving between panes fires a leave then an enter; delay the clear so it cannot win. */
  const crosshairClearTimer = useRef<number | undefined>(undefined);
  /** Keeps the stacked panes on one plot width so a synced crosshair lands on the same x. */
  const equalizeScaleWidths = useRef<() => void>(() => {});
  /**
   * The pair and interval that barsRef actually holds. Switching either tears the chart down and
   * fetches again, and until that lands the old bars are still in the ref â€” without this tag the
   * pattern export would happily measure five-minute bars and caption the picture "1D".
   */
  const barsFor = useRef<{ symbol: string; timeframe: Preferences["timeframe"] } | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  /** Declared before the effects because several of them key off the selected interval. */
  const timeframe = preferences.timeframe;
  const [bars, setBars] = useState<Bar[]>([]);
  /** Higher-timeframe candles for the Trend Bias overlay; fetched only while it is enabled. */
  const [trendBiasBars, setTrendBiasBars] = useState<Partial<Record<TrendBiasTimeframe, Bar[]>>>({});
  /** Index of the candle under the crosshair in any pane; null falls back to the newest bar. */
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  /** First non-null value in each lower pane, so a pane's logical index can be mapped to a bar. */
  const paneStarts = useRef({ macd: 0, rsi: 0, atr: 0 });
  const [quote, setQuote] = useState<number | null>(null);
  const [change, setChange] = useState<number | null>(null);
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [draft, setDraft] = useState(symbol);
  const [message, setMessage] = useState("");
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchQuotes, setWatchQuotes] = useState<Record<string, { price: number; change: number }>>({});
  /** Pairs whose scan columns are switched on; the rest stay off until their # is clicked. */
  const [watchEnabled, setWatchEnabled] = useState<string[]>([]);
  const [watchScans, setWatchScans] = useState<Record<string, WatchMetrics>>({});
  const [watchDraft, setWatchDraft] = useState("");
  const [watchNotice, setWatchNotice] = useState("");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const [pendingPoint, setPendingPoint] = useState(false);
  const [magnet, setMagnet] = useState(false);
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [patternNote, setPatternNote] = useState("");
  const [patternBusy, setPatternBusy] = useState(false);
  /** Starts the periodic scan; the detected shape is painted on the live chart. */
  const [patternRunning, setPatternRunning] = useState(false);
  const [patternOnChart, setPatternOnChart] = useState<PatternMatch | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [annotateTab, setAnnotateTab] = useState<AnnotateTab>("drawings");
  const [patternShots, setPatternShots] = useState<PatternShot[]>([]);
  const [patternShotsNotice, setPatternShotsNotice] = useState("");
  const [patternShotsVersion, setPatternShotsVersion] = useState(0);
  /** Symbol whose Clear all button is waiting for a second click, and the one being deleted. */
  const [clearArmed, setClearArmed] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  const clearArmRef = useRef<HTMLButtonElement | null>(null);
  /** Candlestick monitor: paused by default, checks every 60 seconds once started. */
  const [candlestickRunning, setCandlestickRunning] = useState(false);
  const [candlestickBusy, setCandlestickBusy] = useState(false);
  const [candlestickMatch, setCandlestickMatch] = useState<CandlestickMatch | null>(null);
  const [candlestickNote, setCandlestickNote] = useState("");
  const [candlestickGuideOpen, setCandlestickGuideOpen] = useState(false);
  const [candlestickShots, setCandlestickShots] = useState<PatternShot[]>([]);
  const [candlestickShotsNotice, setCandlestickShotsNotice] = useState("");
  const [candlestickShotsVersion, setCandlestickShotsVersion] = useState(0);
  const [candlestickClearArmed, setCandlestickClearArmed] = useState<string | null>(null);
  const [candlestickClearing, setCandlestickClearing] = useState<string | null>(null);
  const candlestickArmRef = useRef<HTMLButtonElement | null>(null);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => setDraft(symbol), [symbol]);
  // An armed Clear all stands down on its own after a moment, or as soon as the user touches
  // anything else, so a stray second click cannot delete a picture group by accident.
  useEffect(() => {
    if (!clearArmed) return;
    const timer = window.setTimeout(() => setClearArmed(null), CLEAR_ARM_MS);
    const disarm = (event: Event) => {
      // The armed button handles its own clicks; the second one has to reach it.
      if (clearArmRef.current?.contains(event.target as Node)) return;
      setClearArmed(null);
    };
    window.addEventListener("pointerdown", disarm);
    return () => { window.clearTimeout(timer); window.removeEventListener("pointerdown", disarm); };
  }, [clearArmed]);
  // Moving to another pair leaves nothing armed, because the button is not shown for that pair.
  useEffect(() => { setClearArmed(null); }, [symbol]);
  useEffect(() => {
    if (!candlestickClearArmed) return;
    const timer = window.setTimeout(() => setCandlestickClearArmed(null), CLEAR_ARM_MS);
    const disarm = (event: Event) => {
      if (candlestickArmRef.current?.contains(event.target as Node)) return;
      setCandlestickClearArmed(null);
    };
    window.addEventListener("pointerdown", disarm);
    return () => { window.clearTimeout(timer); window.removeEventListener("pointerdown", disarm); };
  }, [candlestickClearArmed]);
  useEffect(() => { setCandlestickClearArmed(null); }, [symbol]);
  // A new pair or interval invalidates the highlighted shapes and their notes.
  useEffect(() => {
    setCandlestickMatch(null);
    setCandlestickNote("");
    setPatternOnChart(null);
    setPatternNote("");
  }, [symbol, timeframe]);
  useEffect(() => {
    const legacyView = readSaved("cd.view", { drawings: true, alerts: true });
    const legacyPreferences: Preferences = {
      ...defaultPreferences,
      timeframe: readSaved("cd.tf", defaultPreferences.timeframe),
      candleType: readSaved("cd.ctype", defaultPreferences.candleType),
      indicators: { ...defaultPreferences.indicators, ...readSaved("cd.ind", {}) },
      drawingsVisible: legacyView.drawings,
      alertsVisible: legacyView.alerts,
      magnet: readSaved("cd.magnet", false),
    };
    const saved = readSaved<Preferences>("tradechart.preferences", legacyPreferences);
    // Merge over the defaults so a preference added after the user last saved still gets a value.
    const restored = { ...legacyPreferences, ...saved, indicators: { ...legacyPreferences.indicators, ...saved.indicators } };
    // 1m was removed from the chart, so migrate a saved selection rather than loading an unreachable interval.
    setPreferences({
      ...restored,
      timeframe: chartIntervals.includes(restored.timeframe) ? restored.timeframe : defaultPreferences.timeframe,
    });
    setDrawings(readSaved("tradechart.drawings", readSaved("cd.lines", [])));
  }, []);
  useEffect(() => { try { localStorage.setItem("tradechart.preferences", JSON.stringify(preferences)); } catch { /* Storage can be unavailable. */ } }, [preferences]);
  useEffect(() => { try { localStorage.setItem("tradechart.drawings", JSON.stringify(drawings)); } catch { /* Storage can be unavailable. */ } }, [drawings]);
  useEffect(() => {
    let active = true;
    async function loadWatchlist() {
      // The backend owns the list; nothing browser-side may seed or re-add pairs.
      try {
        const response = await fetch(`${API}/watchlist/`, { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load the database watchlist.");
        const rows = await response.json() as { symbol: string }[];
        if (!active) return;
        setWatchlist(rows.map((row) => row.symbol));
        setWatchNotice("");
      } catch {
        if (!active) return;
        setWatchlist([]);
        setWatchNotice("Could not load the watchlist from the backend.");
        setMessage("Could not load the saved watchlist from the backend.");
      } finally {
        if (active) setWatchlistLoaded(true);
      }
    }
    void loadWatchlist();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    async function loadMarketEvents() {
      try {
        const response = await fetch(
          `${API}/market/events/?symbol=${encodeURIComponent(symbol)}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("Could not load market events.");
        const rows = await response.json() as MarketEvent[];
        if (active) setEvents(Array.isArray(rows) ? rows : []);
      } catch {
        if (active) setEvents([]);
      }
    }
    void loadMarketEvents();
    return () => { active = false; };
  }, [symbol]);
  useEffect(() => { setMagnet(preferences.magnet); }, [preferences.magnet]);
  useEffect(() => {
    let active = true;
    async function loadPatternShots() {
      try {
        const response = await fetch(`${API}/pattern-shots/?limit=${KEPT_PER_SYMBOL}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load the saved pattern pictures.");
        const rows = await response.json() as PatternShot[];
        if (!active) return;
        setPatternShots(rows); setPatternShotsNotice("");
      } catch { if (active) setPatternShotsNotice("Could not load the saved pattern pictures."); }
    }
    void loadPatternShots();
    return () => { active = false; };
  }, [patternShotsVersion]);
  useEffect(() => {
    let active = true;
    async function loadCandlestickShots() {
      try {
        const response = await fetch(
          `${API}/pattern-shots/?category=candlestick&limit=${KEPT_PER_SYMBOL}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("Could not load the saved candlestick pictures.");
        const rows = await response.json() as PatternShot[];
        if (!active) return;
        setCandlestickShots(rows); setCandlestickShotsNotice("");
      } catch {
        if (active) setCandlestickShotsNotice("Could not load the saved candlestick pictures.");
      }
    }
    void loadCandlestickShots();
    return () => { active = false; };
  }, [candlestickShotsVersion]);
  useEffect(() => {
    if (!patternNote) return;
    const timer = window.setTimeout(() => setPatternNote(""), 12000);
    return () => window.clearTimeout(timer);
  }, [patternNote]);
  useEffect(() => {
    const update = (event: KeyboardEvent) => { modifiers.current = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }; };
    const clear = () => { modifiers.current = { ctrl: false, shift: false }; };
    window.addEventListener("keydown", update); window.addEventListener("keyup", update); window.addEventListener("blur", clear);
    return () => { window.removeEventListener("keydown", update); window.removeEventListener("keyup", update); window.removeEventListener("blur", clear); };
  }, []);

  // Key levels are calculated from raw OHLC, not the displayed Heikin Ashi bars: averaging
  // candles would move the wick highs and lows that define the reactions.
  const keyLevels = useMemo(
    () => preferences.indicators.keyLevel ? findKeyLevels(bars) : null,
    [bars, preferences.indicators.keyLevel],
  );
  // Trend Bias reads the 4H and 1D structure directly, so it keeps its own candle cache instead of
  // borrowing whichever interval the chart happens to be showing.
  useEffect(() => {
    if (!preferences.indicators.trendBias) return;
    let active = true;
    // Drop the previous pair's channels immediately; the next fetch fills them back in.
    setTrendBiasBars({});
    const load = async () => {
      const entries = await Promise.all(TREND_BIAS_TIMEFRAMES.map(async (biasTimeframe) => {
        try {
          const data = await fetchCandles(symbol, biasTimeframe, TREND_BIAS_BARS, exchange);
          return [biasTimeframe, data] as const;
        } catch {
          // One unreachable timeframe should not hide the other.
          return [biasTimeframe, []] as const;
        }
      }));
      if (active) {
        setTrendBiasBars(
          Object.fromEntries(entries) as Partial<Record<TrendBiasTimeframe, Bar[]>>,
        );
      }
    };
    void load();
    const timer = window.setInterval(load, CHART_REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [symbol, exchange, preferences.indicators.trendBias]);
  const trendBias = useMemo(
    () => preferences.indicators.trendBias
      ? TREND_BIAS_TIMEFRAMES.flatMap((biasTimeframe) => {
        const data = trendBiasBars[biasTimeframe];
        const bias = data?.length ? findTrendBias(data, biasTimeframe) : null;
        return bias ? [bias] : [];
      })
      : [],
    [trendBiasBars, preferences.indicators.trendBias],
  );
  useEffect(() => {
    const chartElement = host.current;
    const macdElement = macdHost.current;
    const rsiElement = rsiHost.current;
    const atrElement = atrHost.current;
    if (!chartElement || !macdElement || !rsiElement || !atrElement) return;
    setHoveredIndex(null);
    let active = true;
    let poller: number | undefined;
    const makeChart = (element: HTMLDivElement) => createChart(element, {
      // Let the library own its own ResizeObserver. Hidden indicator panes are 0Ã—0 when they are
      // created, and the library notices when they are shown; explicit sizes are only the fallback
      // for browsers where ResizeObserver is unavailable.
      autoSize: true,
      width: element.clientWidth, height: element.clientHeight,
      layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontFamily: "Geist, sans-serif" },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } }, crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: colors.line }, timeScale: { borderColor: colors.line, timeVisible: true, rightOffset: 8 },
    });
    const chart = makeChart(chartElement);
    const candles = chart.addCandlestickSeries({ upColor: colors.green, downColor: colors.red, wickUpColor: colors.green, wickDownColor: colors.red, borderVisible: false });
    const volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: CANDLE_PANE_TOP, bottom: 0 } });
    // Two EMAs: a medium and a long trend, each with its own colour.
    const ema100Series = chart.addLineSeries({ color: colors.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const ema200Series = chart.addLineSeries({ color: "#a06fb8", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    // Bollinger Bands sit on the price pane: a solid middle SMA with dashed outer bands.
    const bbMiddleSeries = chart.addLineSeries({ color: colors.blue, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const bbUpperSeries = chart.addLineSeries({ color: colors.blue, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const bbLowerSeries = chart.addLineSeries({ color: colors.blue, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const macdChart = makeChart(macdElement);
    const histogram = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    const macdLine = macdChart.addLineSeries({ color: colors.blue, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const signalLine = macdChart.addLineSeries({ color: colors.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const rsiChart = makeChart(rsiElement);
    const rsiLine = rsiChart.addLineSeries({
      color: colors.blue, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      // A fixed 0-100 scale keeps the overbought and oversold bands in place as the pair changes.
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    });
    rsiLine.createPriceLine({ price: 70, color: colors.line, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    rsiLine.createPriceLine({ price: 30, color: colors.line, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    const atrChart = makeChart(atrElement);
    const atrLine = atrChart.addLineSeries({ color: colors.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chartApi.current = chart; macdApi.current = macdChart; rsiApi.current = rsiChart; atrApi.current = atrChart;
    series.current = { candles, volume, ema100: ema100Series, ema200: ema200Series, bbUpper: bbUpperSeries, bbMiddle: bbMiddleSeries, bbLower: bbLowerSeries };
    macdSeries.current = { histogram, line: macdLine, signal: signalLine };
    rsiSeries.current = { line: rsiLine };
    atrSeries.current = { line: atrLine };
    // The bar spacing of a window comes from the pane width, so a window cannot be worked out
    // until the pane has one. Asking before then is not merely ignored: the library clamps the
    // right offset against a width of zero and leaves the whole history squeezed against the left
    // edge. The bar count is parked here instead and applied once the chart has a real width.
    let pendingWindow = 0;
    function applyLatestWindow() {
      if (!pendingWindow || !chart.timeScale().width()) return;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, pendingWindow - INITIAL_VISIBLE_BARS),
        to: pendingWindow + TRAILING_BARS,
      });
      // Cleared so a later resize never yanks the view back to the newest candle.
      pendingWindow = 0;
    }
    /**
     * Applies the parked window once the chart has been sized. A chart adopts a new width on the
     * frame after it is asked for one, and only measures its price axis once it has painted, so the
     * work is retried on later frames until the pane reports a width. The attempt count is bounded
     * so a pane that never appears cannot spin.
     */
    function applyLatestWindowSoon(attempt = 0) {
      if (!pendingWindow || attempt > 30) return;
      if (attempt > 0 && chart.timeScale().width()) { applyLatestWindow(); return; }
      requestAnimationFrame(() => applyLatestWindowSoon(attempt + 1));
    }
    /**
     * `autoSize` normally handles this. The explicit check is a safety net for the case where the
     * library could not install its own observer, so the indicator canvases never keep the size
     * they happened to have when the pane was hidden.
     */
    const fitChart = (api: IChartApi, element: HTMLDivElement) => {
      if (api.autoSizeActive()) return;
      if (element.clientWidth && element.clientHeight) {
        api.resize(element.clientWidth, element.clientHeight);
      }
    };
    /**
     * Lightweight Charts sizes each price scale from its own labels. A BTC axis is much wider than
     * an RSI axis, which would shift the plot area and put the same bar at a different x in every
     * pane. Sharing the widest scale across the stack keeps the time axes (and the crosshair) lined
     * up. The second pass catches panes that only receive a width on the frame after they are shown.
     */
    const equalizePriceScales = (attempt = 0) => {
      if (!active) return;
      requestAnimationFrame(() => {
        if (!active) return;
        const scales = [chart, macdChart, rsiChart, atrChart].map((api) => api.priceScale("right"));
        const width = Math.max(...scales.map((scale) => scale.width()));
        if (width > 0) {
          for (const scale of scales) {
            if (scale.options().minimumWidth !== width) scale.applyOptions({ minimumWidth: width });
          }
        }
        if (attempt < 2) equalizePriceScales(attempt + 1);
      });
    };
    equalizeScaleWidths.current = () => equalizePriceScales();
    const observer = new ResizeObserver(() => {
      fitChart(chart, chartElement);
      fitChart(macdChart, macdElement);
      fitChart(rsiChart, rsiElement);
      fitChart(atrChart, atrElement);
      applyLatestWindowSoon();
      copyWindowSoon(chart, macdChart);
      copyWindowSoon(chart, rsiChart);
      copyWindowSoon(chart, atrChart);
      equalizePriceScales();
    });
    observer.observe(chartElement); observer.observe(macdElement); observer.observe(rsiElement); observer.observe(atrElement);
    chart.subscribeClick((param) => {
      if (!param.point) return;
      const price = candles.coordinateToPrice(param.point.y);
      const activeTool = modeRef.current;
      if (price !== null && !activeTool && param.time) onPriceSelect(String(Number(price.toPrecision(10))));
      if (!activeTool) return;
      const logical = chart.timeScale().coordinateToLogical(param.point.x);
      if (logical === null) return;
      const data = barsRef.current;
      if (!data.length || price === null) return;
      const logicalIndex = Math.max(0, Math.round(logical));
      const index = Math.min(data.length - 1, logicalIndex);
      const bar = data[index];
      const candle = preferencesRef.current.candleType === "ha" ? heikinAshi(data)[index] : bar;
      const snappedPrice = preferencesRef.current.magnet || modifiers.current.ctrl ? [candle.open, candle.high, candle.low, candle.close].sort((a, b) => Math.abs(a - price) - Math.abs(b - price))[0] : price;
      const finalPrice = modifiers.current.shift && pendingRef.current ? pendingRef.current.price : snappedPrice;
      const last = data.at(-1)!;
      const time = logicalIndex < data.length
        ? Number(data[logicalIndex].time)
        : Number(last.time) + (logicalIndex - data.length + 1) * intervalSeconds[timeframe];
      const point = { time, price: finalPrice };
      if (activeTool === "hline" || activeTool === "hray") {
        const line: Drawing = { id: idFor(), symbol, type: activeTool, t1: point.time, p1: point.price, width: 2, opacity: 1 };
        setDrawings((current) => [...current, line]); setSelected(line.id); setTool(null); modeRef.current = null; pendingRef.current = null; setPendingPoint(false);
      } else if (!pendingRef.current) { pendingRef.current = point; setPendingPoint(true); }
      else {
        const first = pendingRef.current;
        if (first.time === point.time) return;
        const [left, right] = first.time < point.time ? [first, point] : [point, first];
        const line: Drawing = { id: idFor(), symbol, type: activeTool, t1: left.time, p1: left.price, t2: right.time, p2: right.price, width: 2, opacity: 1 };
        setDrawings((current) => [...current, line]); setSelected(line.id); setTool(null); modeRef.current = null; pendingRef.current = null; setPendingPoint(false);
      }
    });
    const clearCrosshairs = () => {
      chart.clearCrosshairPosition();
      macdChart.clearCrosshairPosition();
      rsiChart.clearCrosshairPosition();
      atrChart.clearCrosshairPosition();
    };
    const scheduleCrosshairClear = () => {
      window.clearTimeout(crosshairClearTimer.current);
      crosshairClearTimer.current = window.setTimeout(() => {
        crosshairClearTimer.current = undefined;
        setHoveredIndex(null);
        clearCrosshairs();
      }, 40);
    };
    // Each pane reports the logical index under the crosshair, including the gaps between bars.
    // Lower panes start later than the candles, so their first data point is added to the index.
    // The same time is then projected into every other pane with a real value for that bar, so the
    // vertical line runs through the whole stack instead of only the pane under the pointer.
    const follow = (
      source: "price" | "macd" | "rsi" | "atr",
      sourceChart: IChartApi,
      param: MouseEventParams,
      start: number,
    ) => {
      if (!param.point) { scheduleCrosshairClear(); return; }
      window.clearTimeout(crosshairClearTimer.current);
      crosshairClearTimer.current = undefined;
      const logical = param.logical ?? sourceChart.timeScale().coordinateToLogical(param.point.x);
      const index = barIndexForLogical(logical, start, barsRef.current.length);
      if (index === null) return;
      setHoveredIndex((current) => current === index ? current : index);

      const data = barsRef.current;
      const bar = data[index];
      const time = param.time ?? bar?.time;
      if (!bar || !time) return;
      const indicators = preferencesRef.current.indicators;
      const values = indicatorValues.current;

      if (source !== "price") {
        try { chart.setCrosshairPosition(bar.close, time, candles); } catch { chart.clearCrosshairPosition(); }
      }
      if (source !== "macd") {
        const value = indicators.macd
          && values.macd.line.length === data.length
          && index >= paneStarts.current.macd
          ? values.macd.line[index] ?? values.macd.signal[index]
          : null;
        if (value === null) macdChart.clearCrosshairPosition();
        else try { macdChart.setCrosshairPosition(value, time, macdLine); } catch { macdChart.clearCrosshairPosition(); }
      }
      if (source !== "rsi") {
        const value = indicators.rsi
          && values.rsi.length === data.length
          && index >= paneStarts.current.rsi
          ? values.rsi[index]
          : null;
        if (value === null) rsiChart.clearCrosshairPosition();
        else try { rsiChart.setCrosshairPosition(value, time, rsiLine); } catch { rsiChart.clearCrosshairPosition(); }
      }
      if (source !== "atr") {
        const value = indicators.atr
          && values.atr.length === data.length
          && index >= paneStarts.current.atr
          ? values.atr[index]
          : null;
        if (value === null) atrChart.clearCrosshairPosition();
        else try { atrChart.setCrosshairPosition(value, time, atrLine); } catch { atrChart.clearCrosshairPosition(); }
      }
    };
    chart.subscribeCrosshairMove((param) => follow("price", chart, param, 0));
    macdChart.subscribeCrosshairMove((param) => follow("macd", macdChart, param, paneStarts.current.macd));
    rsiChart.subscribeCrosshairMove((param) => follow("rsi", rsiChart, param, paneStarts.current.rsi));
    atrChart.subscribeCrosshairMove((param) => follow("atr", atrChart, param, paneStarts.current.atr));
    // The two charts hold different bars: the MACD series start after the EMA warm-up, so their
    // logical indices point at different timestamps. The price pane drives the MACD pane rather
    // than the other way round: the copy is queued and applied on a later frame, so a two-way sync
    // would bounce between the panes and neither would settle. Following one way also means the
    // price chart is free to be dragged past the newest candle, which is the point.
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      if (syncing.current) return;
      const indicators = preferencesRef.current.indicators;
      if (indicators.macd) copyWindowSoon(chart, macdChart);
      if (indicators.rsi) copyWindowSoon(chart, rsiChart);
      if (indicators.atr) copyWindowSoon(chart, atrChart);
    });

    async function requestCandles(limit: number): Promise<Bar[]> {
      return fetchCandles(symbol, timeframe, limit, exchange);
    }

    function renderBars(data: Bar[]) {
      barsRef.current = data; setBars(data);
      barsFor.current = { symbol, timeframe };
      // Low-priced pairs need more than the library's default two decimals on the price axis and
      // crosshair label. This follows the latest close so it also adapts after a big price move.
      const precision = pricePrecision(data.at(-1)?.close ?? null);
      const priceFormat = { type: "price" as const, precision, minMove: 10 ** -precision };
      candles.applyOptions({ priceFormat });
      ema100Series.applyOptions({ priceFormat });
      ema200Series.applyOptions({ priceFormat });
      bbUpperSeries.applyOptions({ priceFormat });
      bbMiddleSeries.applyOptions({ priceFormat });
      bbLowerSeries.applyOptions({ priceFormat });
      candles.setData(preferencesRef.current.candleType === "ha" ? heikinAshi(data) : data);
      volume.setData(data.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "rgba(77,148,104,.28)" : "rgba(191,102,88,.28)" })));
      if (data.at(-1)) setQuote(data.at(-1)!.close);
      equalizePriceScales();
    }

    async function load() {
      setMessage("Loading market dataâ€¦"); setQuote(null); setChange(null);
      // Bars belonging to the previous pair or interval go now, not when the next fetch lands.
      // Until then the chart is empty while the ref still holds the old series, and every reader of
      // it â€” the pattern export and the drawing overlay â€” would work on the wrong interval.
      barsRef.current = []; setBars([]); barsFor.current = null;
      try {
        const data = await requestCandles(1000);
        if (!active) return;
        renderBars(data);
        // Show the newest bars rather than the whole history, unless the pane has not been laid
        // out yet, in which case the resize observer does it once the width is known.
        pendingWindow = data.length;
        applyLatestWindow();
        applyLatestWindowSoon();
        poller = window.setInterval(() => {
          // The poll replaces candles only. Drawings live in their own state and are never reloaded
          // or cleared here; pause while a point is being placed or an existing line is being dragged.
          if (modeRef.current || pendingRef.current || dragRef.current) return;
          void requestCandles(2).then((latest) => {
            if (!active || !latest.length) return;
            const merged = [...barsRef.current];
            for (const bar of latest) {
              const last = merged.at(-1);
              if (last?.time === bar.time) merged[merged.length - 1] = bar;
              else if (!last || bar.time > last.time) merged.push(bar);
            }
            renderBars(merged);
          }).catch(() => { if (active) setMessage("Live market data is temporarily unavailable."); });
        }, CHART_REFRESH_MS);
        setMessage("");
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : "Could not load market data."); }
    }
    void load();
    return () => {
      active = false;
      if (poller !== undefined) window.clearInterval(poller);
      window.clearTimeout(crosshairClearTimer.current);
      crosshairClearTimer.current = undefined;
      equalizeScaleWidths.current = () => {};
      observer.disconnect();
      chart.remove(); macdChart.remove(); rsiChart.remove(); atrChart.remove();
      chartApi.current = null; macdApi.current = null; rsiApi.current = null; atrApi.current = null;
      series.current = null; macdSeries.current = null; rsiSeries.current = null; atrSeries.current = null;
    };
  }, [symbol, exchange, timeframe, theme, onPriceSelect]);

  useEffect(() => {
    const chart = chartApi.current; const macdChart = macdApi.current; const rsiChart = rsiApi.current; const atrChart = atrApi.current;
    const current = series.current; const macd = macdSeries.current; const rsiPane = rsiSeries.current; const atrPane = atrSeries.current;
    if (!chart || !macdChart || !rsiChart || !atrChart || !current || !macd || !rsiPane || !atrPane) return;
    const data = bars;
    current.candles.setData(preferences.candleType === "ha" ? heikinAshi(data) : data);
    current.volume.setData(preferences.indicators.vol ? data.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "rgba(77,148,104,.28)" : "rgba(191,102,88,.28)" })) : []);
    const closes = data.map((bar) => bar.close);
    const rsiValues = rsi(closes);
    const atrValues = atr(data);
    const macdAll = macdValues(closes);
    indicatorValues.current = { rsi: rsiValues, atr: atrValues, macd: macdAll };
    const firstValue = (values: (number | null)[]) => {
      const index = values.findIndex((value) => value !== null);
      return index < 0 ? 0 : index;
    };
    /** Largest recent magnitude, so tiny MACD/ATR values do not collapse to "0.00" on the axes. */
    const maxAbs = (values: (number | null)[], lookback = 200) => {
      let max = 0;
      for (let index = Math.max(0, values.length - lookback); index < values.length; index += 1) {
        const value = values[index];
        if (value !== null) max = Math.max(max, Math.abs(value));
      }
      return max;
    };
    const valueFormat = (value: number) => {
      const precision = pricePrecision(value || null);
      return { type: "price" as const, precision, minMove: 10 ** -precision };
    };
    const macdFormat = valueFormat(Math.max(
      maxAbs(macdAll.line), maxAbs(macdAll.signal), maxAbs(macdAll.histogram),
    ));
    macd.histogram.applyOptions({ priceFormat: macdFormat });
    macd.line.applyOptions({ priceFormat: macdFormat });
    macd.signal.applyOptions({ priceFormat: macdFormat });
    atrPane.line.applyOptions({ priceFormat: valueFormat(maxAbs(atrValues)) });
    paneStarts.current = {
      macd: firstValue(macdAll.line), rsi: firstValue(rsiValues), atr: firstValue(atrValues),
    };
    const emaEnabled = preferences.indicators.ema;
    current.ema100.setData(emaEnabled ? indicatorPoints(data, ema(closes, 100)) : []);
    current.ema200.setData(emaEnabled ? indicatorPoints(data, ema(closes, 200)) : []);
    const bands = bollingerBands(data);
    current.bbUpper.setData(preferences.indicators.bb ? indicatorPoints(data, bands.upper) : []);
    current.bbMiddle.setData(preferences.indicators.bb ? indicatorPoints(data, bands.middle) : []);
    current.bbLower.setData(preferences.indicators.bb ? indicatorPoints(data, bands.lower) : []);
    const macdEnabled = preferences.indicators.macd;
    const rsiEnabled = preferences.indicators.rsi;
    const atrEnabled = preferences.indicators.atr;
    if (macdHost.current) macdHost.current.hidden = !macdEnabled;
    if (rsiHost.current) rsiHost.current.hidden = !rsiEnabled;
    if (atrHost.current) atrHost.current.hidden = !atrEnabled;
    // A hidden pane must not keep an old synthetic crosshair to show when it is enabled again.
    if (!macdEnabled) macdChart.clearCrosshairPosition();
    if (!rsiEnabled) rsiChart.clearCrosshairPosition();
    if (!atrEnabled) atrChart.clearCrosshairPosition();
    // Only the bottom-most visible pane shows a time axis; the price pane hides its own when any lower pane is open.
    chart.applyOptions({ timeScale: { visible: !macdEnabled && !rsiEnabled && !atrEnabled } });
    macdChart.applyOptions({ timeScale: { visible: macdEnabled && !rsiEnabled && !atrEnabled } });
    rsiChart.applyOptions({ timeScale: { visible: rsiEnabled && !atrEnabled } });
    atrChart.applyOptions({ timeScale: { visible: atrEnabled } });
    rsiPane.line.setData(rsiEnabled ? indicatorPoints(data, rsiValues) : []);
    atrPane.line.setData(atrEnabled ? indicatorPoints(data, atrValues) : []);
    if (rsiEnabled) copyWindowSoon(chart, rsiChart);
    if (atrEnabled) copyWindowSoon(chart, atrChart);
    if (!macdEnabled || data.length < 35) {
      macd.histogram.setData([]); macd.line.setData([]); macd.signal.setData([]);
      equalizeScaleWidths.current();
      return;
    }
    macd.histogram.setData(data.flatMap((bar, index) => macdAll.histogram[index] === null ? [] : [{
      time: bar.time,
      value: macdAll.histogram[index]!,
      color: macdAll.line[index]! >= macdAll.signal[index]! ? "rgba(77,148,104,.65)" : "rgba(191,102,88,.65)",
    }]));
    macd.line.setData(indicatorPoints(data, macdAll.line));
    macd.signal.setData(indicatorPoints(data, macdAll.signal));
    // The MACD series start later than the candles, so the panes cannot share logical indices;
    // copying the window keeps them on the same stretch of time, future space included.
    if (macdEnabled) copyWindowSoon(chart, macdChart);
    equalizeScaleWidths.current();
  }, [bars, preferences]);

  useEffect(() => {
    const candles = series.current?.candles;
    if (!candles) return;
    const lines = preferences.alertsVisible ? alerts.filter((item) => item.kind === "price" && item.symbol === symbol && item.active && !item.line_type && item.price) : [];
    const rendered = lines.map((item) => candles.createPriceLine({ price: Number(item.price), color: colors.amber, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `Alert Â· ${item.condition.replaceAll("_", " ")}` }));
    return () => rendered.forEach((line) => candles.removePriceLine(line));
  }, [alerts, symbol, theme, preferences.alertsVisible]);

  // The pattern monitor runs only while started; starting it checks immediately instead of waiting.
  // Every pass reads the newest 50 candles, so scrolling never changes what is being analysed.
  useEffect(() => {
    if (!patternRunning) return;
    let active = true;
    let timer: number | undefined;
    const schedule = (delay: number) => {
      timer = window.setTimeout(check, delay);
    };
    const check = () => {
      if (!active) return;
      const ready = barsRef.current.length > 0
        && barsFor.current?.symbol === symbol
        && barsFor.current?.timeframe === timeframe;
      if (!ready) {
        schedule(5000);
        return;
      }
      setPatternOnChart(bestPattern(detectPatterns(PATTERN_KEYS, recentPatternBars())));
      schedule(PATTERN_CHECK_MS);
    };
    check();
    return () => { active = false; window.clearTimeout(timer); };
  }, [patternRunning, symbol, timeframe, exchange, preferences.candleType]);

  // The monitor runs only while started; starting it also checks immediately instead of waiting.
  // A pair switch can beat the first candle fetch, so an unready chart is retried briefly.
  useEffect(() => {
    if (!candlestickRunning) return;
    let active = true;
    let timer: number | undefined;
    const schedule = (delay: number) => {
      timer = window.setTimeout(check, delay);
    };
    const check = () => {
      if (!active) return;
      const ready = barsRef.current.length > 0
        && barsFor.current?.symbol === symbol
        && barsFor.current?.timeframe === timeframe;
      if (!ready) {
        setCandlestickNote(`Waiting for ${symbol} ${timeframe.toUpperCase()} candlesâ€¦`);
        schedule(5000);
        return;
      }
      void previewCandlesticks();
      schedule(CANDLESTICK_CHECK_MS);
    };
    check();
    return () => { active = false; window.clearTimeout(timer); };
  }, [candlestickRunning, symbol, timeframe, exchange, theme]);

  useEffect(() => {
    const chart = chartApi.current; const canvasElement = canvas.current; const current = series.current;
    if (!chart || !canvasElement || !current) return;
    let animation = 0;
    const paint = () => {
      const bounds = canvasElement.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1;
      canvasElement.width = Math.round(bounds.width * ratio); canvasElement.height = Math.round(bounds.height * ratio);
      const context = canvasElement.getContext("2d"); if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, bounds.width, bounds.height);
      // Key levels sit under user drawings: their bands should not make the editable lines harder
      // to see, and they stay visible when the Drawings tab is hidden.
      if (keyLevels) {
        // Stop at the plot edge so the bands do not wash over the price-axis labels.
        const plotWidth = chart.timeScale().width() || bounds.width;
        const paneBottom = bounds.height * CANDLE_PANE_TOP;
        const usedPills: number[] = [];
        const pillHeight = 18;
        for (const level of [...keyLevels.resistances, ...keyLevels.supports]) {
          const top = current.candles.priceToCoordinate(level.high);
          const bottom = current.candles.priceToCoordinate(level.low);
          if (top === null || bottom === null) continue;
          // Keep the painted band readable at every zoom level instead of letting the price-space
          // width turn into a thin line or a large block. The centre still tracks the level.
          const rawTop = Number(top);
          const rawBottom = Number(bottom);
          const height = Math.min(18, Math.max(4, Math.abs(rawBottom - rawTop)));
          const y = (rawTop + rawBottom) / 2 - height / 2;
          const strength = level.strength / 100;
          const tone = level.kind === "support" ? colors.green : colors.red;
          context.save();
          context.beginPath();
          context.rect(0, 0, bounds.width, paneBottom);
          context.clip();
          context.globalAlpha = 0.06 + 0.08 * strength;
          context.fillStyle = tone;
          context.fillRect(0, y, plotWidth, height);
          context.globalAlpha = 0.35 + 0.35 * strength;
          context.strokeStyle = tone;
          context.lineWidth = 1;
          context.setLineDash([5, 4]);
          context.beginPath(); context.moveTo(0, y + 0.5); context.lineTo(plotWidth, y + 0.5); context.stroke();
          context.beginPath(); context.moveTo(0, y + height - 0.5); context.lineTo(plotWidth, y + height - 0.5); context.stroke();
          context.setLineDash([]);
          const label = `${level.kind === "support" ? "Support" : "Resistance"} ${fmt(level.price)} Â· ${level.strength}/100`;
          context.font = '600 10px "Geist", system-ui, sans-serif';
          const pillWidth = context.measureText(label).width + 14;
          // Right-aligned keeps the pills clear of the OHLC legend in the chart's top-left corner.
          const pillX = Math.max(6, plotWidth - pillWidth - 6);
          // Resistance labels sit near the top edge, support labels near the bottom edge. Two
          // levels on the same side can be close together, so nudge overlapping pills inward.
          let pillY = level.kind === "resistance"
            ? (height >= pillHeight + 8 ? y + 4 : Math.max(4, y - pillHeight - 4))
            : (height >= pillHeight + 8
              ? y + height - pillHeight - 4
              : Math.max(4, Math.min(paneBottom - pillHeight - 4, y + height + 4)));
          const direction = level.kind === "resistance" ? -1 : 1;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const overlaps = usedPills.some((used) =>
              pillY < used + pillHeight + 4 && pillY + pillHeight + 4 > used);
            if (!overlaps) break;
            pillY = Math.max(4, Math.min(paneBottom - pillHeight - 4, pillY + direction * (pillHeight + 4)));
          }
          usedPills.push(pillY);
          context.globalAlpha = 0.95;
          context.fillStyle = tone;
          context.fillRect(pillX, pillY, pillWidth, pillHeight);
          context.globalAlpha = 1;
          // The palette background reads well on both the dark light-theme tones and the bright
          // dark-theme tones, unlike a fixed white label.
          context.fillStyle = colors.bg;
          context.textBaseline = "middle";
          context.fillText(label, pillX + 7, pillY + pillHeight / 2);
          context.restore();
        }
      }
      // Trend Bias is a higher-timeframe reading: the 4H and 1D regression channels are projected
      // onto whatever interval the chart is showing and run one day past the newest candle.
      if (trendBias.length) {
        const plotWidth = chart.timeScale().width() || bounds.width;
        const paneBottom = bounds.height * CANDLE_PANE_TOP;
        const firstBarTime = Number(barsRef.current[0]?.time ?? 0);
        const labels: { x: number; y: number; text: string; tone: string; up: boolean }[] = [];
        context.save();
        context.beginPath();
        context.rect(0, 0, plotWidth, paneBottom);
        context.clip();
        for (const bias of trendBias) {
          const tone = bias.direction === "bullish"
            ? colors.green
            : bias.direction === "bearish" ? colors.red : colors.amber;
          for (const line of bias.lines) {
            // The chart may not hold enough history to reach the first pivot, so the segment starts
            // at its oldest bar and the fitted slope is read at that later time.
            const startTime = firstBarTime ? Math.max(line.t1, firstBarTime) : line.t1;
            const startX = drawingCoordinate(chart, startTime, barsRef.current, timeframe);
            const endX = drawingCoordinate(chart, line.t2, barsRef.current, timeframe);
            if (startX === null || endX === null || Number(endX) <= Number(startX)) continue;
            const startPrice = line.p1 + line.slope * (startTime - line.t1);
            const startY = current.candles.priceToCoordinate(startPrice);
            const endY = current.candles.priceToCoordinate(line.p2);
            if (startY === null || endY === null) continue;
            context.globalAlpha = 0.7;
            context.strokeStyle = tone;
            context.lineWidth = 1.5;
            context.setLineDash([7, 5]);
            context.beginPath();
            context.moveTo(Number(startX), Number(startY));
            context.lineTo(Number(endX), Number(endY));
            context.stroke();
            context.setLineDash([]);
            // One pill per timeframe, carried by the upper line (or the only line when the other
            // side had too few pivots).
            if (line.kind === "high" || bias.lines.length === 1) {
              const labelX = Math.min(Number(endX), plotWidth - 4);
              const progress = (labelX - Number(startX)) / (Number(endX) - Number(startX));
              labels.push({
                x: labelX,
                y: Number(startY) + (Number(endY) - Number(startY)) * progress,
                text: `${bias.timeframe.toUpperCase()} ${bias.direction}`,
                tone,
                up: line.kind === "high",
              });
            }
          }
        }
        context.globalAlpha = 1;
        context.font = '600 9px "Geist", system-ui, sans-serif';
        const pillHeight = 16;
        const usedPills: number[] = [];
        for (const label of labels) {
          const pillWidth = context.measureText(label.text).width + 12;
          const x = Math.max(4, Math.min(plotWidth - pillWidth - 4, label.x - pillWidth - 8));
          const direction = label.up ? -1 : 1;
          let y = label.up ? label.y - pillHeight - 5 : label.y + 5;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const overlaps = usedPills.some((used) =>
              y < used + pillHeight + 3 && y + pillHeight + 3 > used);
            if (!overlaps) break;
            y += direction * (pillHeight + 3);
          }
          y = Math.max(2, Math.min(paneBottom - pillHeight - 2, y));
          usedPills.push(y);
          context.globalAlpha = 0.92;
          context.fillStyle = label.tone;
          context.fillRect(x, y, pillWidth, pillHeight);
          context.globalAlpha = 1;
          context.fillStyle = colors.bg;
          context.textBaseline = "middle";
          context.fillText(label.text, x + 6, y + pillHeight / 2);
        }
        context.restore();
      }
      for (const line of drawings) {
        if (line.symbol !== symbol || line.hidden || !preferences.drawingsVisible) continue;
        // Calculator setups are drawn as two zones that meet at the entry: red down to the stop
        // and green out to the target. They deliberately do not fall through to the line painter,
        // otherwise the shared entry edge would also get a stray line.
        if (line.origin === "calculator") {
          const zones = entryZones(line);
          if (!zones.length) continue;
          const left = drawingCoordinate(chart, line.t1, barsRef.current, timeframe);
          // The right edge is deliberately in the trailing empty space. If it is off-screen, the
          // zones should still run to the edge rather than vanish.
          const right = line.t2 === undefined
            ? bounds.width
            : drawingCoordinate(chart, line.t2, barsRef.current, timeframe) ?? bounds.width;
          if (left === null) continue;
          const x = Math.min(Number(left), Number(right));
          const width = Math.abs(Number(right) - Number(left));
          if (width < 1) continue;
          context.save();
          context.beginPath();
          context.rect(0, 0, bounds.width, bounds.height * CANDLE_PANE_TOP);
          context.clip();
          for (const zone of zones) {
            const top = current.candles.priceToCoordinate(zone.high);
            const bottom = current.candles.priceToCoordinate(zone.low);
            if (top === null || bottom === null) continue;
            const y = Math.min(Number(top), Number(bottom));
            const height = Math.abs(Number(bottom) - Number(top));
            if (height < 1) continue;
            const tone = zone.tone === "long" ? colors.green : colors.red;
            context.globalAlpha = 0.08 + 0.12 * line.opacity;
            context.fillStyle = tone;
            context.fillRect(x, y, width, height);
            context.globalAlpha = 0.55 + 0.45 * line.opacity;
            context.strokeStyle = tone;
            context.lineWidth = line.width;
            context.strokeRect(
              x + line.width / 2,
              y + line.width / 2,
              Math.max(0, width - line.width),
              Math.max(0, height - line.width),
            );
            const label = `${zone.label} Â· ${fmt(zone.price)}`;
            context.font = '600 10px "Geist", system-ui, sans-serif';
            const textWidth = context.measureText(label).width;
            const pillWidth = textWidth + 14;
            const pillHeight = 18;
            if (width > pillWidth + 10 && height > pillHeight + 10) {
              context.globalAlpha = 1;
              context.fillStyle = tone;
              context.fillRect(x + 5, y + 5, pillWidth, pillHeight);
              context.fillStyle = colors.bg;
              context.textBaseline = "middle";
              context.fillText(label, x + 12, y + 5 + pillHeight / 2);
            }
            if (selected === line.id) {
              context.globalAlpha = 1;
              context.strokeStyle = colors.blue;
              context.lineWidth = 1;
              context.setLineDash([4, 3]);
              context.strokeRect(x + 3.5, y + 3.5, Math.max(0, width - 7), Math.max(0, height - 7));
            }
          }
          context.restore();
          continue;
        }
        const x1 = drawingCoordinate(chart, line.t1, barsRef.current, timeframe); const y1 = current.candles.priceToCoordinate(line.p1);
        if (x1 === null || y1 === null) continue;
        const endX = line.t2 === undefined ? bounds.width : drawingCoordinate(chart, line.t2, barsRef.current, timeframe);
        const endY = line.p2 === undefined ? y1 : current.candles.priceToCoordinate(line.p2);
        if (endX === null || endY === null) continue;
        let x2 = Number(endX); let y2 = Number(endY);
        let drawX1 = Number(x1);
        if (line.type === "hline") drawX1 = 0;
        if (line.type === "hline" || line.type === "hray") { x2 = bounds.width; y2 = Number(y1); }
        if ((line.type === "ray" || (line.type === "trend" && line.extend)) && line.t2 !== undefined && line.p2 !== undefined && x2 !== Number(x1)) {
          y2 = Number(y1) + ((y2 - Number(y1)) * (bounds.width - Number(x1))) / (x2 - Number(x1)); x2 = bounds.width;
        }
        const attached = alerts.find((alert) => alert.line_type === line.type && alert.line_t1 && Math.abs(Number(alert.line_price1) - line.p1) < 1e-10 && Math.abs(new Date(alert.line_t1).getTime() / 1000 - line.t1) < 2);
        const tone = line.tone === "long" ? colors.green : line.tone === "short" ? colors.red : colors.blue;
        context.globalAlpha = line.opacity; context.strokeStyle = attached?.active && preferences.alertsVisible ? colors.amber : tone; context.lineWidth = line.width;
        context.beginPath(); context.moveTo(drawX1, y1); context.lineTo(x2, y2); context.stroke(); context.globalAlpha = 1;
        if (selected === line.id) for (const [x, y] of [[x1, y1], [line.t2 === undefined ? x1 : drawingCoordinate(chart, line.t2, barsRef.current, timeframe) ?? x1, line.p2 === undefined ? y1 : current.candles.priceToCoordinate(line.p2) ?? y1]]) {
          context.fillStyle = colors.bg; context.strokeStyle = colors.blue; context.beginPath(); context.arc(x, y, 4, 0, Math.PI * 2); context.fill(); context.stroke();
        }
      }
      // The pattern gets its own layer above the chart rather than joining the drawing overlay,
      // because the exported picture composites that overlay and would pick the pattern up twice.
      const layer = patternCanvas.current;
      if (layer) {
        layer.width = Math.round(bounds.width * ratio); layer.height = Math.round(bounds.height * ratio);
        const patternContext = layer.getContext("2d");
        if (patternContext) {
          patternContext.setTransform(ratio, 0, 0, ratio, 0, 0); patternContext.clearRect(0, 0, bounds.width, bounds.height);
          // Drawn by the same routine the export uses, so screen and picture are identical.
          if (patternOnChart) {
            paintPattern(patternContext, patternOnChart, (point) => {
              const x = drawingCoordinate(chart, point.time, barsRef.current, timeframe);
              const y = current.candles.priceToCoordinate(point.price);
              return x === null || y === null ? null : { x, y };
            }, { x: 0, y: 0, width: bounds.width, height: bounds.height }, ratio, colors);
            // The name belongs to the chart, not to the controls: the pill sits at the top of the
            // price pane and follows the bullish/bearish accent of the geometry.
            paintPatternCaption(
              patternContext, patternOnChart,
              { x: 0, y: 0, width: bounds.width, height: bounds.height }, ratio, colors,
            );
          }
          // The monitor's shape shares the same overlay, drawn second so its caption sits on top.
          if (candlestickMatch) {
            paintCandlestick(
              patternContext,
              candlestickMatch,
              (time) => drawingCoordinate(chart, time, barsRef.current, timeframe),
              (value) => current.candles.priceToCoordinate(value),
              { x: 0, y: 0, width: bounds.width, height: bounds.height },
              ratio,
              colors,
            );
          }
        }
      }
      animation = requestAnimationFrame(paint);
    };
    paint(); return () => cancelAnimationFrame(animation);
  }, [bars, drawings, symbol, selected, theme, timeframe, keyLevels, trendBias, preferences.drawingsVisible, preferences.alertsVisible, alerts, patternOnChart, candlestickMatch]);

  useEffect(() => {
    let valid = true;
    async function updateQuotes() {
      const symbols = [...new Set([...watchlist, symbol])];
      await Promise.all(symbols.map(async (pair) => {
        try {
          const item = await fetchQuote(pair, exchange);
          if (valid) setWatchQuotes((quotes) => ({ ...quotes, [pair]: item }));
        } catch { /* A missing quote does not interrupt the chart. */ }
      }));
    }
    void updateQuotes(); const timer = window.setInterval(() => void updateQuotes(), 8000);
    return () => { valid = false; window.clearInterval(timer); };
  }, [symbol, watchlist, exchange]);

  // Restore which rows had their scan switched on. It has to be read in an effect rather than in
  // useState, because the dashboard is prerendered with no storage and would otherwise mismatch.
  useEffect(() => { setWatchEnabled(readSaved<string[]>("tradechart.watch-metrics", [])); }, []);
  useEffect(() => {
    try { localStorage.setItem("tradechart.watch-metrics", JSON.stringify(watchEnabled)); }
    catch { /* Storage can be unavailable. */ }
  }, [watchEnabled]);
  // A pair that leaves the watchlist cannot keep scanning; wait for the list before pruning, or
  // the initial empty list would clear the restored selection.
  useEffect(() => {
    if (!watchlistLoaded) return;
    setWatchEnabled((enabled) => enabled.filter((pair) => watchlist.includes(pair)));
  }, [watchlist, watchlistLoaded]);

  // A reading belongs to the interval it was measured on, so a switch starts from blank cells.
  useEffect(() => { setWatchScans({}); }, [timeframe, exchange]);

  /**
   * Scans the enabled rows on the chart's interval. The exchange includes the candle that is still
   * forming, so the helper reads the one before it; a missing pair must not stop the others.
   */
  useEffect(() => {
    if (!watchEnabled.length || !watchlistLoaded) return;
    let active = true;
    async function scan() {
      await Promise.all(watchEnabled.map(async (pair) => {
        try {
          const [data, openInterest] = await Promise.all([
            fetchCandles(pair, timeframe, WATCH_METRIC_BARS, exchange),
            // A pair without a futures market still gets the candle columns.
            fetchOpenInterest(pair, timeframe, WATCH_OI_POINTS, exchange).catch(() => []),
          ]);
          if (active) setWatchScans((all) => ({ ...all, [pair]: watchMetrics(data, openInterest) }));
        } catch {
          if (active) setWatchScans((all) => ({ ...all, [pair]: emptyWatchMetrics }));
        }
      }));
    }
    void scan();
    const timer = window.setInterval(() => void scan(), WATCH_METRIC_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [watchEnabled, timeframe, exchange, watchlistLoaded]);

  useEffect(() => {
    if (quote === null) return;
    const seconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 }[timeframe];
    const previous = bars[Math.max(0, bars.length - Math.ceil(86400 / seconds))]?.close;
    if (previous) setChange((quote - previous) / previous * 100);
  }, [quote, bars, timeframe]);

  /**
   * The newest candles, regardless of the viewport. Pattern analysis is deliberately capped to the
   * latest 50 bars so a shape is judged on the market that is live now rather than old history.
   */
  function recentPatternBars(): PatternBar[] {
    const raw = barsRef.current; const owner = barsFor.current;
    // Refuse bars from any other pair or interval. A mismatch means the chart is mid-reload, and
    // measuring the old series would paint one interval's shape onto another interval's candles.
    if (!raw.length || !owner || owner.symbol !== symbol || owner.timeframe !== timeframe) return [];
    // Detect on the candles the user is looking at. In Heikin Ashi mode the chart series is the
    // transformed data, so raw swings would sit between the displayed candles and look misplaced.
    const data = preferencesRef.current.candleType === "ha" ? heikinAshi(raw) : raw;
    return data.slice(-PATTERN_RECENT_BARS).map((bar) => ({ ...bar, time: Number(bar.time) }));
  }
  /** One screenshot pass over the live chart, shared by every picture a run paints. */
  function captureChart() {
    const chart = chartApi.current; const candles = series.current?.candles;
    const chartHost = host.current;
    if (!chart || !candles || !chartHost || !barsRef.current.length) return null;
    const price = chart.takeScreenshot();
    const shot = (api: typeof macdApi.current, element: HTMLDivElement | null, enabled: boolean) =>
      api && element && enabled && !element.hidden ? api.takeScreenshot() : null;
    // Read the live preferences rather than the render that started the monitor, so adding an
    // indicator pane while it runs is reflected in the next picture.
    const indicators = preferencesRef.current.indicators;
    const lower = [
      shot(macdApi.current, macdHost.current, indicators.macd),
      shot(rsiApi.current, rsiHost.current, indicators.rsi),
      shot(atrApi.current, atrHost.current, indicators.atr),
    ].filter((image): image is HTMLCanvasElement => image !== null);
    // Every screenshot is rendered at the chart's own pixel ratio, so one scale covers everything.
    const ratio = price.width / Math.max(1, chartHost.clientWidth);
    const padding = Math.round(16 * ratio);
    const titleHeight = Math.round(46 * ratio);
    return { chart, candles, price, lower, ratio, padding, gap: lower.length ? Math.round(8 * ratio) : 0, titleHeight, top: titleHeight + padding };
  }
  /** The chart as displayed with one pattern drawn on top. */
  function composePatternPicture(match: PatternMatch, shot: NonNullable<ReturnType<typeof captureChart>>) {
    const { chart, candles, price, lower, ratio, padding, gap, titleHeight, top } = shot;
    const width = padding * 2 + price.width;
    const height = titleHeight + padding * 2 + price.height + lower.reduce((sum, pane) => sum + gap + pane.height, 0);
    const picture = document.createElement("canvas");
    picture.width = width; picture.height = height;
    const context = picture.getContext("2d");
    if (!context) return null;
    context.fillStyle = colors.bg;
    context.fillRect(0, 0, width, height);
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.fillStyle = colors.text;
    context.font = `600 ${Math.round(17 * ratio)}px "Geist", system-ui, sans-serif`;
    context.fillText(`${symbol} Â· ${timeframe.toUpperCase()} Â· ${match.label}${match.forming ? " (forming)" : ""}`, padding, titleHeight / 2);
    context.font = `400 ${Math.round(10 * ratio)}px "DM Mono", ui-monospace, monospace`;
    context.textAlign = "right";
    context.fillText(`${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, width - padding, titleHeight / 2);
    // The break level and the projected target are spelled out here because a target outside the
    // visible range is clipped away from the chart below and would otherwise be unreadable.
    context.textAlign = "left";
    context.fillText(match.summary, padding, titleHeight + Math.round(6 * ratio), width - padding * 2);
    // The chart as displayed, the drawing overlay, the lower panes, then the pattern.
    context.drawImage(price, padding, top);
    if (canvas.current) context.drawImage(canvas.current, padding, top, price.width, price.height);
    let paneTop = top + price.height + gap;
    for (const pane of lower) {
      context.drawImage(pane, padding, paneTop);
      paneTop += pane.height + gap;
    }
    paintPattern(context, match, (point) => {
      const x = drawingCoordinate(chart, point.time, barsRef.current, timeframe);
      const y = candles.priceToCoordinate(point.price);
      return x === null || y === null ? null : { x: padding + x * ratio, y: top + y * ratio };
    }, { x: padding, y: top, width: price.width, height: price.height }, ratio, colors);
    context.strokeStyle = colors.line;
    context.lineWidth = Math.max(1, ratio);
    context.strokeRect(0.5, 0.5, width - 1, height - 1);
    return picture;
  }
  function downloadPicture(picture: HTMLCanvasElement, fileName: string) {
    const link = document.createElement("a");
    link.download = fileName;
    link.href = picture.toDataURL("image/png");
    document.body.append(link);
    link.click();
    link.remove();
  }
  /** Finds every pattern in the latest 50 candles and saves a picture of each match.
   *  Partial shapes count as matches, so a forming pattern is reported rather than left out. */
  async function exportPatternPicture() {
    if (patternBusy) return;
    const recent = recentPatternBars();
    // Nothing to measure means the chart is still between pairs or intervals, which is not the
    // same as finding no pattern in the bars that are loaded.
    if (!recent.length) { setPatternNote(`Loading ${symbol} on ${timeframe.toUpperCase()}â€¦ try again in a moment.`); return; }
    const matches = detectPatterns(PATTERN_KEYS, recent);
    if (!matches.length) {
      setPatternNote(`None of the patterns matched the latest ${PATTERN_RECENT_BARS} candles. Try another timeframe.`);
      return;
    }
    const shot = captureChart();
    if (!shot) { setPatternNote("The chart is still loading, so there is nothing to picture yet."); return; }
    const ready = matches.flatMap((match) => { const picture = composePatternPicture(match, shot); return picture ? [{ match, picture }] : []; });
    if (!ready.length) { setPatternNote("This browser could not create the picture."); return; }
    setPatternBusy(true);
    const fileName = patternFileName(ready[0].match.key, symbol, timeframe);
    setPatternNote(`Drawing ${ready.length} pattern${ready.length === 1 ? "" : "s"}â€¦`);
    try {
      // Browsers block a burst of downloads, so a run hands over its first picture and leaves the
      // rest to the Pattern tab.
      downloadPicture(ready[0].picture, fileName);
      let stored = 0;
      for (const { match, picture } of [...ready].reverse()) {
        if (await storePatternPicture(picture, match)) stored += 1;
      }
      setPatternShotsVersion((version) => version + 1);
      // The pictures are only useful if they are on screen, so show them.
      setAnnotateTab("pattern");
      setPatternNote(stored
        ? `Found ${ready.length} pattern${ready.length === 1 ? "" : "s"} (${ready.map((item) => matchName(item.match)).join(", ")}) and saved ${stored} for ${symbol}.`
        : `Found ${ready.length} pattern${ready.length === 1 ? "" : "s"}, but the server could not store them.`);
    } finally { setPatternBusy(false); }
  }
  async function deletePatternShot(id: number) {
    try {
      const response = await fetch(`${API}/pattern-shots/${id}/`, { method: "DELETE", cache: "no-store" });
      if (!response.ok) throw new Error("Could not delete that picture.");
      setPatternShots((current) => current.filter((shot) => shot.id !== id));
      setPatternShotsNotice("");
    } catch { setPatternShotsNotice("Could not delete that picture."); }
  }
  /**
   * First click arms the button, second one clears the pair. Pictures are only kept for the
   * selected pair, so nothing outside that group is ever in reach of this.
   */
  async function clearPatternPictures(target: string) {
    if (clearArmed !== target) { setClearArmed(target); return; }
    setClearing(target);
    try {
      const response = await fetch(`${API}/pattern-shots/?symbol=${encodeURIComponent(target)}`, { method: "DELETE", cache: "no-store" });
      if (!response.ok) throw new Error("Could not clear those pictures.");
      const payload = await readJson<{ deleted?: number }>(response);
      const removed = payload?.deleted ?? 0;
      setPatternShots((current) => current.filter((shot) => shot.symbol !== target));
      setPatternShotsNotice(removed ? `Cleared ${removed} picture${removed === 1 ? "" : "s"} for ${target}.` : `There was nothing to clear for ${target}.`);
    } catch { setPatternShotsNotice(`Could not clear the pictures for ${target}.`); }
    finally { setClearing(null); }
  }
  /** Keeps one picture on the server, where the newest ten per pair and category are retained. */
  async function storePatternPicture(
    picture: HTMLCanvasElement,
    match: { key: string; summary: string },
    category: "chart" | "candlestick" = "chart",
  ) {
    let stored = picture;
    if (picture.width > STORED_IMAGE_WIDTH) {
      const scaled = document.createElement("canvas");
      scaled.width = STORED_IMAGE_WIDTH;
      scaled.height = Math.round(picture.height * (STORED_IMAGE_WIDTH / picture.width));
      const scaledContext = scaled.getContext("2d");
      // Without a drawing context the full picture is stored rather than a blank thumbnail.
      if (scaledContext) {
        scaledContext.drawImage(picture, 0, 0, scaled.width, scaled.height);
        stored = scaled;
      }
    }
    try {
      const response = await fetch(`${API}/pattern-shots/`, {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({
          symbol, category, pattern: match.key, timeframe,
          summary: match.summary.slice(0, STORED_SUMMARY_CHARS),
          image: stored.toDataURL("image/png"),
        }),
      });
      return response.ok;
    } catch { return false; }
  }
  /** The chart as displayed with a band around the candlestick shape the monitor found. */
  function composeCandlestickPicture(
    match: CandlestickMatch,
    shot: NonNullable<ReturnType<typeof captureChart>>,
  ) {
    const { chart, candles, price, lower, ratio, padding, gap, titleHeight, top } = shot;
    const width = padding * 2 + price.width;
    const height = titleHeight + padding * 2 + price.height + lower.reduce((sum, pane) => sum + gap + pane.height, 0);
    const picture = document.createElement("canvas");
    picture.width = width; picture.height = height;
    const context = picture.getContext("2d");
    if (!context) return null;
    context.fillStyle = colors.bg;
    context.fillRect(0, 0, width, height);
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.fillStyle = colors.text;
    context.font = `600 ${Math.round(17 * ratio)}px "Geist", system-ui, sans-serif`;
    context.fillText(`${symbol} Â· ${timeframe.toUpperCase()} Â· ${match.label}`, padding, titleHeight / 2);
    context.font = `400 ${Math.round(10 * ratio)}px "DM Mono", ui-monospace, monospace`;
    context.textAlign = "right";
    context.fillText(`${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, width - padding, titleHeight / 2);
    context.textAlign = "left";
    context.fillText(match.summary, padding, titleHeight + Math.round(6 * ratio), width - padding * 2);
    // The chart, the user's drawings, the lower panes, then the monitor's highlight band.
    context.drawImage(price, padding, top);
    if (canvas.current) context.drawImage(canvas.current, padding, top, price.width, price.height);
    let paneTop = top + price.height + gap;
    for (const pane of lower) {
      context.drawImage(pane, padding, paneTop);
      paneTop += pane.height + gap;
    }
    paintCandlestick(
      context,
      match,
      (time) => {
        const x = drawingCoordinate(chart, time, barsRef.current, timeframe);
        return x === null ? null : padding + x * ratio;
      },
      (value) => {
        const y = candles.priceToCoordinate(value);
        return y === null ? null : top + y * ratio;
      },
      { x: padding, y: top, width: price.width, height: price.height },
      ratio,
      colors,
    );
    context.strokeStyle = colors.line;
    context.lineWidth = Math.max(1, ratio);
    context.strokeRect(0.5, 0.5, width - 1, height - 1);
    return picture;
  }
  /** Whether the loaded candles belong to the pair and interval currently on screen. */
  function candlestickShapeReady() {
    const owner = barsFor.current;
    return barsRef.current.length > 0 && owner?.symbol === symbol && owner?.timeframe === timeframe;
  }
  /** Detection shared by the monitor overlay and the explicit picture button. */
  function detectCandlestickShape() {
    const raw = barsRef.current;
    const displayed = preferencesRef.current.candleType === "ha" ? heikinAshi(raw) : raw;
    return detectCandlestickPattern(displayed);
  }
  /**
   * One monitor pass. It only finds the newest shape and paints it; monitoring never takes a
   * picture, so starting the monitor cannot save anything on its own. Pictures come from the
   * picture button below.
   */
  function previewCandlesticks() {
    if (!candlestickShapeReady()) {
      setCandlestickNote(`Waiting for ${symbol} ${timeframe.toUpperCase()} candlesâ€¦`);
      return;
    }
    const match = detectCandlestickShape();
    setCandlestickMatch(match);
    setCandlestickNote(
      match ? "" : `No candlestick pattern in the latest ${CANDLESTICK_RECENT_BARS} candles.`,
    );
  }
  /**
   * The picture button: paints the newest shape, then captures and stores it. This is the only
   * path that takes a screenshot, and it leaves the chart's viewport exactly where the user left it.
   */
  async function captureCandlestickPicture() {
    const chart = chartApi.current;
    if (!chart || !candlestickShapeReady()) {
      setCandlestickNote(`Waiting for ${symbol} ${timeframe.toUpperCase()} candlesâ€¦`);
      return;
    }
    const match = detectCandlestickShape();
    setCandlestickMatch(match);
    setCandlestickNote("");
    if (!match) {
      setCandlestickNote(
        `No candlestick pattern in the latest ${CANDLESTICK_RECENT_BARS} candles.`,
      );
      return;
    }
    setCandlestickBusy(true);
    try {
      // The overlay paints on the next frames, so let it land before taking the picture.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const shot = captureChart();
      if (!shot) {
        setCandlestickNote("The chart is still loading, so there is nothing to picture yet.");
        return;
      }
      const picture = composeCandlestickPicture(match, shot);
      if (!picture) {
        setCandlestickNote("This browser could not create the picture.");
        return;
      }
      const fileName = `${symbol}-${timeframe}-${match.key}.png`.toLowerCase();
      downloadPicture(picture, fileName);
      const stored = await storePatternPicture(picture, match, "candlestick");
      setCandlestickShotsVersion((version) => version + 1);
      // A manual picture is the user asking for it, so open the tab where it landed.
      setAnnotateTab("candlestick");
      setCandlestickNote(stored
        ? `Saved ${match.label} to Candlesticks.`
        : `Saved ${fileName} Â· the server copy failed.`);
    } finally { setCandlestickBusy(false); }
  }
  async function deleteCandlestickShot(id: number) {
    try {
      const response = await fetch(`${API}/pattern-shots/${id}/`, { method: "DELETE", cache: "no-store" });
      if (!response.ok) throw new Error("Could not delete that picture.");
      setCandlestickShots((current) => current.filter((shot) => shot.id !== id));
      setCandlestickShotsNotice("");
    } catch { setCandlestickShotsNotice("Could not delete that picture."); }
  }
  /** Same two-click guard as the Pattern tab, scoped to the candlestick category. */
  async function clearCandlestickPictures(target: string) {
    if (candlestickClearArmed !== target) { setCandlestickClearArmed(target); return; }
    setCandlestickClearing(target);
    try {
      const response = await fetch(
        `${API}/pattern-shots/?category=candlestick&symbol=${encodeURIComponent(target)}`,
        { method: "DELETE", cache: "no-store" },
      );
      if (!response.ok) throw new Error("Could not clear those pictures.");
      const payload = await readJson<{ deleted?: number }>(response);
      const removed = payload?.deleted ?? 0;
      setCandlestickShots((current) => current.filter((shot) => shot.symbol !== target));
      setCandlestickShotsNotice(removed
        ? `Cleared ${removed} candlestick picture${removed === 1 ? "" : "s"} for ${target}.`
        : `There was nothing to clear for ${target}.`);
    } catch { setCandlestickShotsNotice(`Could not clear the candlestick pictures for ${target}.`); }
    finally { setCandlestickClearing(null); }
  }
  /** Start/Pause for the pattern monitor; pausing also takes its shape off the chart. */
  function togglePatternMonitor() {
    if (patternRunning) {
      setPatternOnChart(null);
      setPatternNote("");
    }
    setPatternRunning(!patternRunning);
  }
  /** Start/Pause for the candlestick monitor; pausing also takes its shape off the chart. */
  function toggleCandlestickMonitor() {
    if (candlestickRunning) {
      setCandlestickMatch(null);
      setCandlestickNote("");
    }
    setCandlestickRunning(!candlestickRunning);
  }
  function changePreferences(update: Partial<Preferences>) { setPreferences((current) => ({ ...current, ...update })); }
  function toggleIndicator(key: keyof Preferences["indicators"]) { setPreferences((current) => ({ ...current, indicators: { ...current.indicators, [key]: !current.indicators[key] } })); }
  function submitSymbol(event: FormEvent) { event.preventDefault(); if (draft.trim()) onSymbolChange(draft.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")); }
  async function addWatch(event: FormEvent) {
    event.preventDefault();
    const pair = watchDraft.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!pair) { setWatchNotice("Enter a market symbol, for example ADAUSDT."); return; }
    if (pair.length > 24) { setWatchNotice("Use a symbol of 24 characters or fewer."); return; }
    if (watchlist.includes(pair)) { setWatchNotice(`${pair} is already on the watchlist.`); return; }
    setWatchNotice(`Saving ${pair}â€¦`);
    try {
      // The database is the source of truth, so the pair is stored before anything else is attempted.
      const response = await fetch(`${API}/watchlist/`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: pair }), cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not save this pair to the database watchlist.");
      const saved = await response.json() as { symbol?: string };
      const symbol = saved.symbol || pair;
      setWatchlist((items) => items.includes(symbol) ? items : [...items, symbol]);
      setWatchDraft("");
      // The quote only fills the price column. A rate-limited, blocked, or temporarily down
      // exchange must not undo the save, so this is best effort and the row is polled again shortly.
      try {
        const quote = await fetchQuote(symbol, exchange);
        setWatchQuotes((quotes) => ({ ...quotes, [symbol]: quote }));
        setWatchNotice(`${symbol} added to the saved watchlist.`);
      } catch { setWatchNotice(`${symbol} saved. Its price is not available on ${exchangeName[exchange]} right now.`); }
    } catch (error) { setWatchNotice(error instanceof Error ? error.message : "Could not add this pair."); }
  }
  async function removeWatch(pair: string) {
    try {
      const response = await fetch(`${API}/watchlist/${encodeURIComponent(pair)}/`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not remove this pair from the database watchlist.");
      setWatchlist((items) => items.filter((item) => item !== pair));
      setWatchEnabled((items) => items.filter((item) => item !== pair));
      setWatchNotice(`${pair} removed from the saved watchlist.`);
    } catch (error) { setWatchNotice(error instanceof Error ? error.message : "Could not remove this pair."); }
  }

  /** The # beside a pair switches its scan columns on or off; off also drops its readings. */
  function toggleWatchMetrics(pair: string) {
    const turningOn = !watchEnabled.includes(pair);
    setWatchEnabled((enabled) =>
      turningOn ? [...enabled, pair] : enabled.filter((item) => item !== pair));
    if (!turningOn) {
      setWatchScans((all) => {
        const next = { ...all };
        delete next[pair];
        return next;
      });
    }
  }
  function chooseTool(next: Tool) { const value = tool === next ? null : next; setTool(value); modeRef.current = value; pendingRef.current = null; setPendingPoint(false); }
  function removeDrawing(id: string) {
    const drawing = drawings.find((line) => line.id === id);
    if (drawing) onDeleteLineAlert(drawing);
    setDrawings((items) => items.filter((line) => line.id !== id)); if (selected === id) setSelected(null);
  }
  function drawTradeEntry(request: TradeEntryDrawing) {
    const lastTime = Number(barsRef.current.at(-1)?.time ?? Date.now() / 1000);
    const step = intervalSeconds[timeframe];
    // Use a real bar for the left edge. A computed time can fall in a gap, where the time scale
    // has no coordinate and the whole zone would disappear.
    const startIndex = Math.max(0, barsRef.current.length - 1 - ENTRY_ZONE_PAST_BARS);
    const line: Drawing = {
      id: idFor(),
      symbol: request.symbol,
      type: "hline",
      t1: Number(barsRef.current[startIndex]?.time ?? lastTime),
      p1: request.entry,
      t2: lastTime + ENTRY_ZONE_FUTURE_BARS * step,
      width: 1,
      opacity: 1,
      origin: "calculator",
      tone: request.direction,
      zones: [
        {
          low: Math.min(request.entry, request.stop),
          high: Math.max(request.entry, request.stop),
          tone: "short",
          label: "Stop loss",
          price: request.stop,
        },
        {
          low: Math.min(request.entry, request.target),
          high: Math.max(request.entry, request.target),
          tone: "long",
          label: "Take profit",
          price: request.target,
        },
      ],
      label: request.direction === "long" ? "Long setup" : "Short setup",
    };
    // One calculator setup per symbol: drawing again replaces the previous boxes instead of stacking.
    const previous = drawings.filter(
      (item) => item.symbol === request.symbol && item.origin === "calculator",
    );
    for (const drawing of previous) onDeleteLineAlert(drawing);
    setDrawings((items) => [
      ...items.filter((item) => !(item.symbol === request.symbol && item.origin === "calculator")),
      line,
    ]);
    setSelected(line.id);
    if (!preferences.drawingsVisible) changePreferences({ drawingsVisible: true });
  }
  function clearTradeEntry(target: string) {
    const previous = drawings.filter(
      (item) => item.symbol === target && item.origin === "calculator",
    );
    if (!previous.length) return;
    for (const drawing of previous) onDeleteLineAlert(drawing);
    setDrawings((items) => items.filter(
      (item) => !(item.symbol === target && item.origin === "calculator"),
    ));
    setSelected((current) => previous.some((drawing) => drawing.id === current) ? null : current);
  }
  function pointAt(clientX: number, clientY: number) {
    const chart = chartApi.current; const candleSeries = series.current?.candles; const element = host.current;
    if (!chart || !candleSeries || !element || !barsRef.current.length) return null;
    const bounds = element.getBoundingClientRect(); const x = clientX - bounds.left; const y = clientY - bounds.top;
    const logical = chart.timeScale().coordinateToLogical(x); const price = candleSeries.coordinateToPrice(y);
    if (logical === null || price === null) return null;
    const index = Math.round(logical); const data = barsRef.current;
    const step = intervalSeconds[timeframe];
    const time = index < 0 ? Number(data[0].time) + index * step : index >= data.length ? Number(data.at(-1)!.time) + (index - data.length + 1) * step : Number(data[index].time);
    let value = Number(price);
    if (preferencesRef.current.magnet || modifiers.current.ctrl) {
      const bar = preferencesRef.current.candleType === "ha" ? heikinAshi(data)[Math.max(0, Math.min(data.length - 1, index))] : data[Math.max(0, Math.min(data.length - 1, index))];
      value = [bar.open, bar.high, bar.low, bar.close].sort((a, b) => Math.abs(a - value) - Math.abs(b - value))[0];
    }
    return { time, price: modifiers.current.shift && dragRef.current?.part === "p2" ? dragRef.current.original.p1 : value };
  }
  function handleDrawingPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!selected || tool) return;
    const line = drawings.find((item) => item.id === selected && item.symbol === symbol);
    const chart = chartApi.current; const candleSeries = series.current?.candles; const element = host.current;
    if (!line || !chart || !candleSeries || !element) { setSelected(null); return; }
    const bounds = element.getBoundingClientRect(); const x = event.clientX - bounds.left; const y = event.clientY - bounds.top;
    // A calculator setup is grabbed anywhere inside either box, not only near a diagonal line.
    if (line.origin === "calculator") {
      const zones = entryZones(line);
      if (!zones.length) return;
      const left = drawingCoordinate(chart, line.t1, barsRef.current, timeframe);
      const right = line.t2 === undefined
        ? bounds.width
        : drawingCoordinate(chart, line.t2, barsRef.current, timeframe) ?? bounds.width;
      const low = Math.min(...zones.map((zone) => zone.low));
      const high = Math.max(...zones.map((zone) => zone.high));
      const top = candleSeries.priceToCoordinate(high);
      const bottom = candleSeries.priceToCoordinate(low);
      if (left === null || top === null || bottom === null) return;
      const inside = x >= Math.min(Number(left), Number(right)) && x <= Math.max(Number(left), Number(right))
        && y >= Math.min(Number(top), Number(bottom)) && y <= Math.max(Number(top), Number(bottom));
      if (!inside) { setSelected(null); return; }
      const start = pointAt(event.clientX, event.clientY); if (!start) return;
      dragRef.current = { id: line.id, part: "body", start, original: { ...line } };
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
      return;
    }
    const x1 = drawingCoordinate(chart, line.t1, barsRef.current, timeframe); const y1 = candleSeries.priceToCoordinate(line.p1);
    const x2 = line.t2 === undefined ? bounds.width : drawingCoordinate(chart, line.t2, barsRef.current, timeframe);
    const y2 = line.p2 === undefined ? y1 : candleSeries.priceToCoordinate(line.p2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) { setSelected(null); return; }
    const distance = (ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax; const dy = by - ay; const length = dx * dx + dy * dy;
      const fraction = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
      return Math.hypot(x - (ax + fraction * dx), y - (ay + fraction * dy));
    };
    const firstDistance = Math.hypot(x - Number(x1), y - Number(y1));
    const secondDistance = line.t2 === undefined ? Infinity : Math.hypot(x - Number(x2), y - Number(y2));
    const bodyDistance = distance(Number(x1), Number(y1), Number(x2), Number(y2));
    const part = firstDistance < 11 ? "p1" : secondDistance < 11 ? "p2" : bodyDistance < 8 ? "body" : null;
    if (!part) { setSelected(null); return; }
    const start = pointAt(event.clientX, event.clientY); if (!start) return;
    dragRef.current = { id: line.id, part, start, original: { ...line } };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  }
  function handleDrawingPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current; if (!drag) return;
    const point = pointAt(event.clientX, event.clientY); if (!point) return;
    const original = drag.original; const hasSecond = original.t2 !== undefined && original.p2 !== undefined;
    let next: Drawing;
    if (drag.part === "p1") {
      next = { ...original, t1: point.time, p1: point.price };
      if (hasSecond && next.t2 !== undefined && next.p2 !== undefined && next.t1 > next.t2) { [next.t1, next.t2] = [next.t2, next.t1]; [next.p1, next.p2] = [next.p2, next.p1]; }
    } else if (drag.part === "p2" && hasSecond) {
      next = { ...original, t2: point.time, p2: point.price };
      if (next.t2 !== undefined && next.p2 !== undefined && next.t2 < next.t1) { [next.t1, next.t2] = [next.t2, next.t1]; [next.p1, next.p2] = [next.p2, next.p1]; }
    } else {
      const deltaTime = point.time - drag.start.time; const deltaPrice = point.price - drag.start.price;
      // A plain horizontal line is pinned in time; a calculator zone moves as a whole box.
      const movesTime = original.type !== "hline" || original.origin === "calculator";
      next = { ...original, t1: movesTime ? original.t1 + deltaTime : original.t1, p1: original.p1 + deltaPrice };
      if (original.zones?.length) {
        // Keep the stop/target boxes attached to the entry when the setup is dragged vertically.
        const shift = Math.max(deltaPrice, -Math.min(...original.zones.map((zone) => zone.low)));
        next.zones = original.zones.map((zone) => ({
          ...zone,
          low: Math.max(0, zone.low + shift),
          high: Math.max(0, zone.high + shift),
          price: Math.max(0, zone.price + shift),
        }));
      } else if (original.zoneLow !== undefined && original.zoneHigh !== undefined) {
        next.zoneLow = Math.max(0, original.zoneLow + deltaPrice);
        next.zoneHigh = Math.max(next.zoneLow, original.zoneHigh + deltaPrice);
      }
      if (hasSecond) { next.t2 = original.t2! + deltaTime; next.p2 = original.p2! + deltaPrice; }
    }
    setDrawings((items) => items.map((item) => item.id === drag.id ? next : item));
  }
  function handleDrawingPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current; if (!drag) return;
    dragRef.current = null;
    const line = drawings.find((item) => item.id === drag.id);
    const linked = alerts.find((item) => item.symbol === drag.original.symbol && item.line_type === drag.original.type && item.line_t1 && Math.abs(new Date(item.line_t1).getTime() / 1000 - drag.original.t1) < 2 && Math.abs(Number(item.line_price1) - drag.original.p1) < 1e-10);
    if (line && linked) onUpdateLineAlert({ ...line, id: linked.id.toString() });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function updateDrawing(id: string, update: Partial<Drawing>) {
    setDrawings((items) => items.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...update };
      const attached = alerts.find((alert) => alert.line_type === next.type && alert.line_t1 && Math.abs(Number(alert.line_price1) - next.p1) < 1e-10 && Math.abs(new Date(alert.line_t1).getTime() / 1000 - next.t1) < 2);
      if (attached && (update.t1 !== undefined || update.p1 !== undefined || update.t2 !== undefined || update.p2 !== undefined || update.extend !== undefined || update.repeat !== undefined)) onUpdateLineAlert({ ...next, id: attached.id.toString() } as Drawing);
      return next;
    }));
  }

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.target instanceof HTMLElement && event.target.matches("input, select, textarea")) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") { setTool(null); modeRef.current = null; pendingRef.current = null; setPendingPoint(false); setSelected(null); return; }
      if ((event.key === "Delete" || event.key === "Backspace") && selected) { event.preventDefault(); removeDrawing(selected); return; }
      const keyTools: Record<string, Tool> = { t: "trend", r: "ray", h: "hline", j: "hray" };
      const next = keyTools[event.key.toLowerCase()];
      if (next) chooseTool(next);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selected, tool]);
  const dayChange = watchQuotes[symbol]?.change ?? change;
  /** The candle under the crosshair, or the newest one until the pointer enters a pane. */
  const legendIndex = bars.length ? Math.min(bars.length - 1, Math.max(0, hoveredIndex ?? bars.length - 1)) : -1;
  const displayedBars = useMemo(
    () => preferences.candleType === "ha" ? heikinAshi(bars) : bars,
    [bars, preferences.candleType],
  );
  const legendBar = legendIndex >= 0 ? displayedBars[legendIndex] ?? null : null;
  const indicatorLegend = useMemo(() => {
    if (!bars.length) return null;
    const closes = bars.map((bar) => bar.close);
    return { macd: macdValues(closes), rsi: rsi(closes), atr: atr(bars), ema100: ema(closes, 100) };
  }, [bars]);
  const legendMacd = indicatorLegend && legendIndex >= 0 ? {
    line: indicatorLegend.macd.line[legendIndex] ?? null,
    signal: indicatorLegend.macd.signal[legendIndex] ?? null,
    histogram: indicatorLegend.macd.histogram[legendIndex] ?? null,
  } : null;
  const legendRsi = indicatorLegend && legendIndex >= 0 ? indicatorLegend.rsi[legendIndex] ?? null : null;
  const legendAtr = indicatorLegend && legendIndex >= 0 ? indicatorLegend.atr[legendIndex] ?? null : null;
  const legendTime = legendBar ? Number(legendBar.time) : null;
  const symbolDrawings = drawings.filter((line) => line.symbol === symbol);
  /** Newest pictures first, with the current pair's group ahead of the rest of the watchlist.
   The API already answers newest first, so grouping only has to keep that order. */
  const shotsBySymbol = new Map<string, PatternShot[]>();
  for (const shot of patternShots) shotsBySymbol.set(shot.symbol, [...shotsBySymbol.get(shot.symbol) ?? [], shot]);
  const shotSymbols = [...shotsBySymbol.keys()].sort((left, right) => left === symbol ? -1 : right === symbol ? 1 : left.localeCompare(right));
  const candlestickBySymbol = new Map<string, PatternShot[]>();
  for (const shot of candlestickShots) {
    candlestickBySymbol.set(shot.symbol, [...candlestickBySymbol.get(shot.symbol) ?? [], shot]);
  }
  const candlestickSymbols = [...candlestickBySymbol.keys()].sort(
    (left, right) => left === symbol ? -1 : right === symbol ? 1 : left.localeCompare(right),
  );

  return (
    <>
      <div className="workspace-grid">
        <section className="market panel" id="market">
          <MarketHeader
            symbol={symbol}
            exchange={exchange}
            quote={quote}
            dayChange={dayChange}
            events={events}
            timeframe={timeframe}
            draft={draft}
            onExchangeChange={onExchangeChange}
            onTimeframeChange={(next) => changePreferences({ timeframe: next })}
            onDraftChange={setDraft}
            onSubmit={submitSymbol}
          />
          <div className="chart-control-grid">
            <IndicatorControls
              preferences={preferences}
              onChange={changePreferences}
              onToggleIndicator={toggleIndicator}
            />
            <PatternControls
              running={patternRunning}
              busy={patternBusy}
              note={patternNote}
              onToggle={togglePatternMonitor}
              onExportPicture={() => void exportPatternPicture()}
              onOpenGuide={() => setGuideOpen(true)}
            />
            <DrawingToolbar
              tool={tool}
              magnet={magnet}
              pendingPoint={pendingPoint}
              preferences={preferences}
              onChooseTool={chooseTool}
              onChange={changePreferences}
              onMagnetChange={(next) => {
                setMagnet(next);
                changePreferences({ magnet: next });
              }}
            />
            <CandlestickMonitor
              running={candlestickRunning}
              busy={candlestickBusy}
              note={candlestickNote}
              onToggle={toggleCandlestickMonitor}
              onCapture={() => void captureCandlestickPicture()}
              onOpenGuide={() => setCandlestickGuideOpen(true)}
            />
          </div>
          <ChartPanes
            host={host}
            canvas={canvas}
            patternCanvas={patternCanvas}
            macdHost={macdHost}
            rsiHost={rsiHost}
            atrHost={atrHost}
            preferences={preferences}
            timeframe={timeframe}
            selected={selected}
            tool={tool}
            legendBar={legendBar}
            legendTime={legendTime}
            legendMacd={legendMacd}
            legendRsi={legendRsi}
            legendAtr={legendAtr}
            message={message}
            patternNote={patternNote}
            onPointerDown={handleDrawingPointerDown}
            onPointerMove={handleDrawingPointerMove}
            onPointerUp={handleDrawingPointerUp}
          />
        </section>
        <aside className="workspace-side">
          <WatchlistPanel
            watchlist={watchlist}
            quotes={watchQuotes}
            metrics={watchScans}
            enabled={watchEnabled}
            timeframe={timeframe}
            current={symbol}
            loaded={watchlistLoaded}
            notice={watchNotice}
            draft={watchDraft}
            onSelect={onSymbolChange}
            onRemove={(pair) => void removeWatch(pair)}
            onToggleMetrics={toggleWatchMetrics}
            onDraftChange={setWatchDraft}
            onAdd={addWatch}
          />
          <AnnotatePanel
            symbol={symbol}
            timeframe={timeframe}
            tab={annotateTab}
            onTabChange={setAnnotateTab}
            drawings={symbolDrawings}
            alerts={alerts}
            selected={selected}
            onSelectDrawing={setSelected}
            onUpdateDrawing={updateDrawing}
            onRemoveDrawing={removeDrawing}
            onCreateLineAlert={onCreateLineAlert}
            onDeleteLineAlert={onDeleteLineAlert}
            patternGroups={shotsBySymbol}
            patternOrder={shotSymbols}
            patternNotice={patternShotsNotice}
            onDeletePattern={(id) => void deletePatternShot(id)}
            onClearPatterns={(target) => void clearPatternPictures(target)}
            clearingPatterns={clearing}
            armedPatterns={clearArmed}
            patternArmRef={clearArmRef}
            candlestickGroups={candlestickBySymbol}
            candlestickOrder={candlestickSymbols}
            candlestickNotice={candlestickShotsNotice}
            onDeleteCandlestick={(id) => void deleteCandlestickShot(id)}
            onClearCandlesticks={(target) => void clearCandlestickPictures(target)}
            clearingCandlesticks={candlestickClearing}
            armedCandlesticks={candlestickClearArmed}
            candlestickArmRef={candlestickArmRef}
            calculator={{
              price: quote ?? bars.at(-1)?.close ?? null,
              ema100: indicatorLegend?.ema100.at(-1) ?? null,
              rsi14: indicatorLegend?.rsi.at(-1) ?? null,
              atr14: indicatorLegend?.atr.at(-1) ?? null,
            }}
            hasEntryDrawing={symbolDrawings.some((line) => line.origin === "calculator")}
            onDrawEntry={drawTradeEntry}
            onClearEntry={() => clearTradeEntry(symbol)}
          />
        </aside>
      </div>
      {guideOpen && <PatternGuide onClose={() => setGuideOpen(false)} />}
      {candlestickGuideOpen && <CandlestickGuide onClose={() => setCandlestickGuideOpen(false)} />}
    </>
  );
}
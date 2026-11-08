"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, readJson } from "@/lib/api/client";
import {
  CLEAR_ARM_MS, KEPT_PER_SYMBOL, defaultPreferences, exchangeName,
} from "@/lib/market/constants";
import {
  fetchCandles, fetchOpenInterest, fetchQuote, fetchQuotes,
} from "@/lib/market/market-data";
import { emptyWatchMetrics, watchMetrics } from "@/lib/market/watch-metrics";
import { readSaved } from "@/lib/storage";
import { MAX_CHART_TABS } from "@/types/market";
import type {
  AnnotateTab, ChartLiveInfo, ChartTabsState, Drawing, MarketChartHandle,
  MarketWorkspaceProps, PatternShot, TradeEntryDrawing, WatchMetrics,
} from "@/types/market";
import AnnotatePanel from "./components/annotate-panel";
import ChartTabs from "./components/chart-tabs";
import WatchlistPanel from "./components/watchlist-panel";
import MarketChart from "./market-chart";
import { drawingActions } from "./use-drawing-actions";

/** One watchlist scan needs enough candles for EMA-100, RSI-14 and the MACD warm-up. */
const WATCH_METRIC_BARS = 160;
/** Open interest is matched to the two latest closed candles, so a couple of periods suffice. */
const WATCH_OI_POINTS = 4;
/** Enabled watchlist rows rescan once a minute, apart from the quote poll. */
const WATCH_METRIC_MS = 60000;
/** Quotes are cheaper batched, so the whole watchlist plus open tabs refresh in one request. */
const QUOTE_REFRESH_MS = 10000;
const TAB_STORAGE_KEY = "tradechart.tabs";

/**
 * The market section shell: the tab strip, one mounted MarketChart per open pair, and the shared
 * watchlist and annotate panels. Charts own their candles, drawings interactions and monitors;
 * this component owns what spans tabs — the tab list itself, the watchlist, the drawings store
 * and the saved pictures.
 */
export default function MarketWorkspace({
  symbol, exchange = "binance", onExchangeChange, theme = "light",
  onSymbolChange, onPriceSelect, alerts,
  onCreateLineAlert, onUpdateLineAlert, onDeleteLineAlert,
}: MarketWorkspaceProps) {
  const [tabState, setTabState] = useState<ChartTabsState>({ tabs: [], active: "" });
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;
  /** False until the stored strip has been read; persistence waits so it cannot clobber it. */
  const [tabsReady, setTabsReady] = useState(false);
  const [tabNotice, setTabNotice] = useState("");
  /** Latest readings the visible chart reports for the calculator and the watchlist scan. */
  const [chartInfo, setChartInfo] = useState<(ChartLiveInfo & { symbol: string }) | null>(null);
  /** Draw-entry handles keyed by pair, registered by each mounted chart. */
  const chartHandles = useRef(new Map<string, MarketChartHandle>());
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchQuotes, setWatchQuotes] = useState<Record<string, { price: number; change: number }>>({});
  /** Pairs whose scan columns are switched on; the rest stay off until their # is clicked. */
  const [watchEnabled, setWatchEnabled] = useState<string[]>([]);
  const [watchScans, setWatchScans] = useState<Record<string, WatchMetrics>>({});
  const [watchDraft, setWatchDraft] = useState("");
  const [watchNotice, setWatchNotice] = useState("");
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [quotesStale, setQuotesStale] = useState(false);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  const [annotateTab, setAnnotateTab] = useState<AnnotateTab>("drawings");
  const [patternShots, setPatternShots] = useState<PatternShot[]>([]);
  const [patternShotsNotice, setPatternShotsNotice] = useState("");
  const [patternShotsVersion, setPatternShotsVersion] = useState(0);
  const [candlestickShots, setCandlestickShots] = useState<PatternShot[]>([]);
  const [candlestickShotsNotice, setCandlestickShotsNotice] = useState("");
  const [candlestickShotsVersion, setCandlestickShotsVersion] = useState(0);
  /** Symbol whose Clear all button is waiting for a second click, and the one being deleted. */
  const [clearArmed, setClearArmed] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  const clearArmRef = useRef<HTMLButtonElement | null>(null);
  const [candlestickClearArmed, setCandlestickClearArmed] = useState<string | null>(null);
  const [candlestickClearing, setCandlestickClearing] = useState<string | null>(null);
  const candlestickArmRef = useRef<HTMLButtonElement | null>(null);

  const activeTab = tabState.active || null;
  /** Readings count only while they describe the pair on screen; a stale report is ignored. */
  const activeInfo = chartInfo && chartInfo.symbol === activeTab ? chartInfo : null;
  /** The watchlist scan runs on the visible chart's interval. */
  const scanTimeframe = activeInfo?.timeframe ?? defaultPreferences.timeframe;

  const openTab = useCallback((raw: string) => {
    const pair = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!pair) return;
    const { tabs, active } = tabStateRef.current;
    if (tabs.includes(pair)) {
      if (active !== pair) setTabState({ tabs, active: pair });
      setTabNotice("");
      return;
    }
    if (tabs.length >= MAX_CHART_TABS) {
      setTabNotice(`Maximum of ${MAX_CHART_TABS} charts is open. Close a tab first.`);
      window.setTimeout(() => setTabNotice(""), 4000);
      return;
    }
    setTabState({ tabs: [...tabs, pair], active: pair });
    setTabNotice("");
  }, []);

  const closeTab = useCallback((pair: string) => {
    const { tabs, active } = tabStateRef.current;
    const index = tabs.indexOf(pair);
    if (index < 0) return;
    const next = tabs.filter((item) => item !== pair);
    // Closing the visible tab hands the screen to its neighbour; the last one closes to an empty state.
    const nextActive = active === pair ? next[Math.min(index, next.length - 1)] ?? "" : active;
    setTabState({ tabs: next, active: nextActive });
  }, []);

  const registerChartHandle = useCallback((pair: string, handle: MarketChartHandle | null) => {
    if (handle) chartHandles.current.set(pair, handle);
    else chartHandles.current.delete(pair);
  }, []);

  const handleChartInfo = useCallback((pair: string, info: ChartLiveInfo) => {
    setChartInfo({ symbol: pair, ...info });
  }, []);

  const handleShotsChanged = useCallback(() => {
    setPatternShotsVersion((version) => version + 1);
    setCandlestickShotsVersion((version) => version + 1);
  }, []);

  // Tabs are restored once, after mount: the dashboard is prerendered without storage, so reading
  // localStorage any earlier would mismatch the server render. The last watched pair seeds the
  // strip when no tab state was ever saved.
  useEffect(() => {
    const saved = readSaved<ChartTabsState | null>(TAB_STORAGE_KEY, null);
    const restored = Array.isArray(saved?.tabs)
      ? saved.tabs.filter((pair) => typeof pair === "string" && /^[A-Z0-9]{1,24}$/.test(pair)).slice(0, MAX_CHART_TABS)
      : [];
    const seed = readSaved("tradechart.symbol", "");
    const fallback = typeof seed === "string" && /^[A-Z0-9]{1,24}$/.test(seed) ? seed : symbol;
    if (restored.length) {
      const active = restored.includes(saved?.active ?? "") ? saved!.active : restored[0];
      setTabState({ tabs: restored, active });
    } else {
      setTabState({ tabs: [fallback], active: fallback });
    }
    setTabsReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every tab change is persisted and mirrored to the dashboard's market symbol, which feeds the
  // alert form defaults and its own storage key. An empty strip is stored too, so a deliberately
  // closed last tab does not come back on reload.
  useEffect(() => {
    if (!tabsReady) return;
    try { localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(tabState)); } catch { /* Storage can be unavailable. */ }
    if (activeTab) onSymbolChange(activeTab);
  }, [tabState, activeTab, onSymbolChange, tabsReady]);

  // A symbol arriving from outside (the dashboard's restored pair) opens or activates a tab.
  useEffect(() => {
    if (!tabsReady || !symbol) return;
    const pair = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!pair || pair === tabStateRef.current.active) return;
    openTab(pair);
  }, [symbol, openTab, tabsReady]);

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
  // Switching tabs leaves nothing armed, because the button is not shown for that pair.
  useEffect(() => { setClearArmed(null); }, [activeTab]);
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
  useEffect(() => { setCandlestickClearArmed(null); }, [activeTab]);
  // A different pair on screen deselects whatever the previous chart had selected.
  useEffect(() => { setSelectedDrawing(null); }, [activeTab]);

  const { removeDrawing, updateDrawing, clearTradeEntry } = drawingActions({
    drawings, setDrawings, selected: selectedDrawing, setSelected: setSelectedDrawing,
    alerts, onUpdateLineAlert, onDeleteLineAlert,
  });

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
      } finally {
        if (active) setWatchlistLoaded(true);
      }
    }
    void loadWatchlist();
    return () => { active = false; };
  }, []);

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
    try { localStorage.setItem("tradechart.drawings", JSON.stringify(drawings)); } catch { /* Storage can be unavailable. */ }
  }, [drawings]);

  /**
   * One batched quote request covers the watchlist and every open tab. A failure keeps the last
   * values on screen but marks them stale, which is more useful than blanking the whole column.
   */
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function updateQuotes() {
      const symbols = [...new Set([...watchlist, ...tabState.tabs])];
      if (!symbols.length) return;
      try {
        const quotes = await fetchQuotes(symbols, exchange);
        if (!active) return;
        setWatchQuotes((current) => ({ ...current, ...quotes }));
        setQuotesStale(false);
      } catch {
        if (active) setQuotesStale(true);
      } finally {
        if (active) timer = window.setTimeout(() => void updateQuotes(), QUOTE_REFRESH_MS);
      }
    }
    void updateQuotes();
    return () => { active = false; window.clearTimeout(timer); };
  }, [watchlist, tabState.tabs, exchange]);

  // A quote from the other exchange describes a different market, so it is dropped on a switch.
  useEffect(() => { setWatchQuotes({}); setQuotesStale(false); }, [exchange]);

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
  useEffect(() => { setWatchScans({}); }, [scanTimeframe, exchange]);

  /**
   * Scans the enabled rows on the visible chart's interval. The exchange includes the candle that
   * is still forming, so the helper reads the one before it; a missing pair must not stop the others.
   */
  useEffect(() => {
    if (!watchEnabled.length || !watchlistLoaded) return;
    let active = true;
    async function scan() {
      await Promise.all(watchEnabled.map(async (pair) => {
        try {
          const [data, openInterest] = await Promise.all([
            fetchCandles(pair, scanTimeframe, WATCH_METRIC_BARS, exchange),
            // A pair without a futures market still gets the candle columns.
            fetchOpenInterest(pair, scanTimeframe, WATCH_OI_POINTS, exchange).catch(() => []),
          ]);
          if (active) setWatchScans((all) => ({ ...all, [pair]: watchMetrics(data, openInterest, scanTimeframe) }));
        } catch {
          if (active) setWatchScans((all) => ({ ...all, [pair]: emptyWatchMetrics }));
        }
      }));
    }
    void scan();
    const timer = window.setInterval(() => void scan(), WATCH_METRIC_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [watchEnabled, scanTimeframe, exchange, watchlistLoaded]);

  async function addWatch(event: FormEvent) {
    event.preventDefault();
    const pair = watchDraft.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!pair) { setWatchNotice("Enter a market symbol, for example ADAUSDT."); return; }
    if (pair.length > 24) { setWatchNotice("Use a symbol of 24 characters or fewer."); return; }
    if (watchlist.includes(pair)) { setWatchNotice(`${pair} is already on the watchlist.`); return; }
    setWatchNotice(`Saving ${pair}…`);
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

  const symbolDrawings = useMemo(
    () => drawings.filter((line) => line.symbol === activeTab),
    [drawings, activeTab],
  );
  /** Newest pictures first, with the current pair's group ahead of the rest of the watchlist.
   The API already answers newest first, so grouping only has to keep that order. */
  const shotsBySymbol = useMemo(() => {
    const groups = new Map<string, PatternShot[]>();
    for (const shot of patternShots) groups.set(shot.symbol, [...groups.get(shot.symbol) ?? [], shot]);
    return groups;
  }, [patternShots]);
  const shotSymbols = useMemo(
    () => [...shotsBySymbol.keys()].sort((left, right) => left === activeTab ? -1 : right === activeTab ? 1 : left.localeCompare(right)),
    [shotsBySymbol, activeTab],
  );
  const candlestickBySymbol = useMemo(() => {
    const groups = new Map<string, PatternShot[]>();
    for (const shot of candlestickShots) groups.set(shot.symbol, [...groups.get(shot.symbol) ?? [], shot]);
    return groups;
  }, [candlestickShots]);
  const candlestickSymbols = useMemo(
    () => [...candlestickBySymbol.keys()].sort((left, right) => left === activeTab ? -1 : right === activeTab ? 1 : left.localeCompare(right)),
    [candlestickBySymbol, activeTab],
  );

  return (
    <div className="workspace-grid">
      <section className="market panel" id="market">
        <ChartTabs
          tabs={tabState.tabs}
          active={activeTab}
          onSelect={openTab}
          onClose={closeTab}
          notice={tabNotice}
        />
        {tabState.tabs.map((pair) => (
          <div className="chart-tab-pane" hidden={pair !== activeTab} key={pair}>
            <MarketChart
              symbol={pair}
              exchange={exchange}
              onExchangeChange={onExchangeChange}
              theme={theme}
              active={pair === activeTab}
              drawings={drawings}
              onDrawingsChange={setDrawings}
              selected={selectedDrawing}
              onSelectedChange={setSelectedDrawing}
              alerts={alerts}
              onCreateLineAlert={onCreateLineAlert}
              onUpdateLineAlert={onUpdateLineAlert}
              onDeleteLineAlert={onDeleteLineAlert}
              onPriceSelect={onPriceSelect}
              dayChange={watchQuotes[pair]?.change ?? null}
              onChartInfo={handleChartInfo}
              onShowAnnotateTab={setAnnotateTab}
              onShotsChanged={handleShotsChanged}
              handleRef={registerChartHandle}
            />
          </div>
        ))}
        {!tabState.tabs.length && (
          <div className="chart-tab-empty">
            <p className="eyebrow">NO CHARTS OPEN</p>
            <p>Select a pair from the watchlist to open its chart.</p>
          </div>
        )}
      </section>
      <aside className="workspace-side">
        <WatchlistPanel
          watchlist={watchlist}
          quotes={watchQuotes}
          metrics={watchScans}
          enabled={watchEnabled}
          timeframe={scanTimeframe}
          current={activeTab ?? ""}
          loaded={watchlistLoaded}
          stale={quotesStale}
          notice={watchNotice}
          draft={watchDraft}
          onSelect={openTab}
          onRemove={(pair) => void removeWatch(pair)}
          onToggleMetrics={toggleWatchMetrics}
          onDraftChange={setWatchDraft}
          onAdd={addWatch}
        />
        <AnnotatePanel
          symbol={activeTab ?? ""}
          timeframe={scanTimeframe}
          tab={annotateTab}
          onTabChange={setAnnotateTab}
          drawings={symbolDrawings}
          alerts={alerts}
          selected={selectedDrawing}
          onSelectDrawing={setSelectedDrawing}
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
            price: activeInfo?.price ?? null,
            ema100: activeInfo?.ema100 ?? null,
            rsi14: activeInfo?.rsi14 ?? null,
            atr14: activeInfo?.atr14 ?? null,
          }}
          hasEntryDrawing={symbolDrawings.some((line) => line.origin === "calculator")}
          onDrawEntry={(request: TradeEntryDrawing) => {
            if (!activeTab) return;
            chartHandles.current.get(activeTab)?.drawEntry({ ...request, symbol: activeTab });
          }}
          onClearEntry={() => { if (activeTab) clearTradeEntry(activeTab); }}
        />
      </aside>
    </div>
  );
}

"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, readableError } from "@/lib/api/client";
import { reportUrlFromMessage, messageWithoutReport } from "@/lib/alerts";
import MarketWorkspace from "@/features/market/market-workspace";
import AppSidebar from "@/components/layout/app-sidebar";
import type { AlertItem, AlertKind, EventItem, ToastItem } from "@/types/alerts";
import type { Drawing, Exchange } from "@/types/market";
import {
  contextTimeframes, defaultRsiSettings, timeframes,
  type ContextTimeframe,
} from "./constants";
import { emaFieldErrors, macdFieldErrors } from "./validation";
import AlertForm, { type AlertFormModel } from "./components/alert-form";
import AlertList from "./components/alert-list";
import ActivityLog from "./components/activity-log";
import DashboardHeader from "./components/dashboard-header";
import ToastStack from "./components/toast-stack";

export default function AlertDashboard() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [kind, setKind] = useState<AlertKind>("price");
  const [marketSymbol, setMarketSymbol] = useState("BTCUSDT");
  const [exchange, setExchange] = useState<Exchange>("binance");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("market");
  const [targetPrice, setTargetPrice] = useState("");
  const [macdTimeframe, setMacdTimeframe] = useState<(typeof timeframes)[number]>("1h");
  const [rsiTimeframe, setRsiTimeframe] = useState<ContextTimeframe>("1h");
  const [trendTimeframe, setTrendTimeframe] = useState<ContextTimeframe>("1h");
  const rsiTimeframeTouched = useRef(false);
  const [macdThreshold5, setMacdThreshold5] = useState(false);
  const [macdThreshold10, setMacdThreshold10] = useState(false);
  const [rsiEnabled, setRsiEnabled] = useState(true);
  const [rsiSettings, setRsiSettings] = useState(defaultRsiSettings);
  const [trendEnabled, setTrendEnabled] = useState(true);
  const [trendPeriod, setTrendPeriod] = useState("100");
  const [emaTimeframe, setEmaTimeframe] = useState<(typeof timeframes)[number]>("1h");
  const [emaPeriod, setEmaPeriod] = useState("100");
  const [emaRsiTimeframe, setEmaRsiTimeframe] = useState<ContextTimeframe>("1h");
  const emaRsiTimeframeTouched = useRef(false);
  const [emaRsiEnabled, setEmaRsiEnabled] = useState(true);
  const [emaRsiSettings, setEmaRsiSettings] = useState(defaultRsiSettings);
  const [emaMacdEnabled, setEmaMacdEnabled] = useState(true);
  const [emaMacdTimeframe, setEmaMacdTimeframe] = useState<ContextTimeframe>("1h");
  const [predictionTimeframe, setPredictionTimeframe] = useState("1h");
  const [predictionStageA, setPredictionStageA] = useState(true);
  const [predictionStageB, setPredictionStageB] = useState(true);
  const [predictionTrendPeriod, setPredictionTrendPeriod] = useState("100");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notificationAvailable, setNotificationAvailable] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [clearedThrough, setClearedThrough] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const seenEvents = useRef<Set<number> | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    setNotificationAvailable("Notification" in window);
    try {
      localStorage.removeItem("tradechart.telegram");
      localStorage.removeItem("cd.tg");
      setClearedThrough(localStorage.getItem("tradechart.log-cleared-through") ?? "");
    } catch { /* Browser storage is optional. */ }
  }, []);

  // Fans the saved theme out into React state on mount; the inline script in the
  // document head has already applied it, so this must not overwrite storage yet.
  const themeMounted = useRef(false);
  useEffect(() => {
    if (!themeMounted.current) {
      themeMounted.current = true;
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
      return;
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem("tradechart.theme", theme); } catch { /* Storage can be unavailable. */ }
  }, [theme]);

  // Keep the pair the user was watching across reloads instead of falling back to BTCUSDT.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("tradechart.symbol");
      if (saved && /^[A-Z0-9]{1,24}$/.test(saved)) setMarketSymbol(saved);
    } catch { /* Storage can be unavailable. */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("tradechart.symbol", marketSymbol); } catch { /* Storage can be unavailable. */ }
  }, [marketSymbol]);

  useEffect(() => {
    try {
      setSidebarCollapsed(localStorage.getItem("marketa.sidebar") === "collapsed");
    } catch { /* Storage can be unavailable. */ }
  }, []);

  useEffect(() => {
    const sections = ["market", "create-alert", "alerts", "activity", "annotate"];
    const elements = sections
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (!elements.length) return;

    // The active link is the last section whose top edge has scrolled past the
    // sticky header, which keeps the rail in sync at the very top of the page too.
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = 120;
      let current = elements[0].id;
      for (const element of elements) {
        if (element.getBoundingClientRect().top <= line) current = element.id;
      }
      setActiveSection(current);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("marketa.sidebar", next ? "collapsed" : "expanded");
      } catch { /* Storage can be unavailable. */ }
      return next;
    });
  }

  function toast(title: string, message: string) {
    const item = { id: Date.now() + Math.random(), title, message };
    setToasts((current) => [...current.slice(-3), item]);
    window.setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== item.id)), 8000);
  }
  function playAlertSound() {
    try {
      const context = audioRef.current ?? new AudioContext(); audioRef.current = context;
      if (context.state === "suspended") void context.resume();
      [0, 0.18, 0.36].forEach((delay, index) => {
        const oscillator = context.createOscillator(); const gain = context.createGain();
        oscillator.frequency.value = index === 2 ? 1175 : 880; oscillator.connect(gain); gain.connect(context.destination);
        const start = context.currentTime + delay; gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
        oscillator.start(start); oscillator.stop(start + 0.16);
      });
    } catch { /* Audio may be disabled by the browser. */ }
  }
  function notifyEvent(item: EventItem) {
    toast(item.title, item.message); playAlertSound();
    if ("Notification" in window && Notification.permission === "granted") {
      const reportUrl = reportUrlFromMessage(item.message);
      const notification = new Notification(item.title, {
        body: messageWithoutReport(item.message),
        tag: `alert-${item.id}`,
      });
      if (reportUrl) {
        notification.onclick = () => {
          window.focus();
          window.open(reportUrl, "_blank", "noopener,noreferrer");
          notification.close();
        };
      }
    }
  }

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [nextAlerts, nextEvents, nextExchange] = await Promise.all([
        api<AlertItem[]>("/alerts/"), api<EventItem[]>("/events/"), api<{ exchange: Exchange }>("/exchange/"),
      ]);
      if (seenEvents.current) nextEvents.filter((item) => !seenEvents.current?.has(item.id)).forEach(notifyEvent);
      seenEvents.current = new Set(nextEvents.map((item) => item.id));
      setAlerts(nextAlerts); setEvents(nextEvents); setExchange(nextExchange.exchange); setError("");
    } catch (reason) {
      setError(readableError(reason, "Could not reach the API."));
    } finally { setRefreshing(false); }
  }, []);

  async function selectExchange(next: Exchange) {
    try {
      const saved = await api<{ exchange: Exchange }>("/exchange/", { method: "POST", body: JSON.stringify({ exchange: next }) });
      setExchange(saved.exchange);
    } catch (reason) {
      setError(readableError(reason, "Could not change the exchange."));
      void refresh();
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  function changeMacdTimeframe(next: (typeof timeframes)[number]) {
    setMacdTimeframe(next);
    // RSI follows the MACD interval until the user picks a different RSI interval.
    if (!rsiTimeframeTouched.current && contextTimeframes.includes(next as ContextTimeframe)) {
      setRsiTimeframe(next as ContextTimeframe);
    }
  }
  function changeRsiTimeframe(next: ContextTimeframe) {
    rsiTimeframeTouched.current = true;
    setRsiTimeframe(next);
  }
  function changeEmaTimeframe(next: (typeof timeframes)[number]) {
    setEmaTimeframe(next);
    // RSI follows the EMA-cross interval until the user picks a different RSI interval.
    if (!emaRsiTimeframeTouched.current && contextTimeframes.includes(next as ContextTimeframe)) {
      setEmaRsiTimeframe(next as ContextTimeframe);
    }
  }
  function changeEmaRsiTimeframe(next: ContextTimeframe) {
    emaRsiTimeframeTouched.current = true;
    setEmaRsiTimeframe(next);
  }

  async function createAlert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setFieldErrors({});
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload: Record<string, string | number | boolean> = {
      symbol: String(form.get("symbol")).trim().toUpperCase(),
      kind, note: String(form.get("note") ?? "").trim(),
      frequency: String(form.get("frequency")),
    };
    if (kind === "price") {
      payload.condition = String(form.get("condition"));
      payload.price = Number(form.get("price"));
    } else if (kind === "macd") {
      payload.timeframe = macdTimeframe;
      payload.rsi_timeframe = rsiTimeframe;
      payload.trend_timeframe = trendTimeframe;
      payload.condition = "cross";
      payload.macd_threshold_5 = macdThreshold5;
      payload.macd_threshold_10 = macdThreshold10;
      payload.rsi_enabled = rsiEnabled;
      if (rsiEnabled) {
        payload.rsi_period = Number(rsiSettings.period);
        payload.rsi_oversold = Number(rsiSettings.oversold);
        payload.rsi_overbought = Number(rsiSettings.overbought);
      }
      payload.trend_enabled = trendEnabled;
      if (trendEnabled) payload.trend_period = Number(trendPeriod);
      const errors = macdFieldErrors({ rsiEnabled, rsi: rsiSettings, trendEnabled, trendPeriod });
      if (Object.keys(errors).length) { setFieldErrors(errors); setBusy(false); return; }
    } else if (kind === "ema") {
      payload.timeframe = emaTimeframe;
      payload.condition = "cross";
      payload.ema_period = Number(emaPeriod);
      payload.rsi_timeframe = emaRsiTimeframe;
      payload.rsi_enabled = emaRsiEnabled;
      if (emaRsiEnabled) {
        payload.rsi_period = Number(emaRsiSettings.period);
        payload.rsi_oversold = Number(emaRsiSettings.oversold);
        payload.rsi_overbought = Number(emaRsiSettings.overbought);
      }
      payload.macd_context_enabled = emaMacdEnabled;
      payload.macd_context_timeframe = emaMacdTimeframe;
      const errors = emaFieldErrors({ rsiEnabled: emaRsiEnabled, rsi: emaRsiSettings });
      if (Object.keys(errors).length) { setFieldErrors(errors); setBusy(false); return; }
    } else {
      payload.timeframe = predictionTimeframe;
      payload.condition = "cross";
      payload.frequency = "every";
      payload.prediction_stage_a = predictionStageA;
      payload.prediction_stage_b = predictionStageB;
      payload.trend_period = Number(predictionTrendPeriod);
      if (!predictionStageA && !predictionStageB) {
        setFieldErrors({ prediction: "Enable stage A, stage B, or both." });
        setBusy(false);
        return;
      }
    }
    try {
      await api<AlertItem>("/alerts/", { method: "POST", body: JSON.stringify(payload) });
      formElement.reset(); resetForm(); await refresh(); requestNotifications();
    } catch (reason) {
      setError(readableError(reason, "Could not create alert."));
    } finally { setBusy(false); }
  }

  function resetForm() {
    setTargetPrice(""); setMacdTimeframe("1h");
    setMacdThreshold5(false); setMacdThreshold10(false);
    rsiTimeframeTouched.current = false;
    setRsiTimeframe("1h"); setTrendTimeframe("1h");
    setRsiEnabled(true); setRsiSettings(defaultRsiSettings);
    setTrendEnabled(true); setTrendPeriod("100");
    setEmaTimeframe("1h"); setEmaPeriod("100");
    emaRsiTimeframeTouched.current = false;
    setEmaRsiTimeframe("1h"); setEmaRsiEnabled(true); setEmaRsiSettings(defaultRsiSettings);
    setEmaMacdEnabled(true); setEmaMacdTimeframe("1h");
    setPredictionTimeframe("1h"); setPredictionStageA(true); setPredictionStageB(true);
    setPredictionTrendPeriod("100"); setFieldErrors({});
  }

  async function toggleAlert(item: AlertItem) {
    try { await api<AlertItem>(`/alerts/${item.id}/`, { method: "PATCH", body: JSON.stringify({ active: !item.active }) }); await refresh(); }
    catch (reason) { setError(readableError(reason, "Could not update alert.")); }
  }
  async function deleteAlert(id: number) {
    try { await api<void>(`/alerts/${id}/`, { method: "DELETE" }); await refresh(); }
    catch (reason) { setError(readableError(reason, "Could not delete alert.")); }
  }

  async function createLineAlert(drawing: Drawing, condition: string, frequency: string) {
    const matching = alerts.find((item) => item.line_type === drawing.type && item.symbol === drawing.symbol && item.line_t1 && Math.abs(new Date(item.line_t1).getTime() / 1000 - drawing.t1) < 2 && Number(item.line_price1) === drawing.p1);
    const geometry = {
      line_type: drawing.type, line_t1: new Date(drawing.t1 * 1000).toISOString(), line_price1: drawing.p1,
      line_t2: drawing.t2 === undefined ? null : new Date(drawing.t2 * 1000).toISOString(),
      line_price2: drawing.p2 ?? null, line_extend: !!drawing.extend,
    };
    try {
      if (matching) await api<AlertItem>(`/alerts/${matching.id}/`, { method: "PATCH", body: JSON.stringify({ ...geometry, condition, frequency, active: true }) });
      else await api<AlertItem>("/alerts/", { method: "POST", body: JSON.stringify({ symbol: drawing.symbol, kind: "price", condition, frequency, note: "", ...geometry }) });
      await refresh();
    } catch (reason) { setError(readableError(reason, "Could not create drawing alert.")); }
  }
  async function updateLineAlert(drawing: Drawing) {
    const matching = alerts.find((item) => item.id === Number(drawing.id));
    if (!matching) return;
    try {
      await api<AlertItem>(`/alerts/${matching.id}/`, { method: "PATCH", body: JSON.stringify({
        line_type: drawing.type, line_t1: new Date(drawing.t1 * 1000).toISOString(), line_price1: drawing.p1,
        line_t2: drawing.t2 === undefined ? null : new Date(drawing.t2 * 1000).toISOString(), line_price2: drawing.p2 ?? null,
        line_extend: !!drawing.extend, frequency: drawing.repeat ? "every" : "once",
      }) });
      await refresh();
    } catch (reason) { setError(readableError(reason, "Could not update drawing alert.")); }
  }
  async function deleteLineAlert(drawing: Drawing) {
    const matching = alerts.find((item) => item.symbol === drawing.symbol && item.line_type === drawing.type && item.line_t1 && Math.abs(new Date(item.line_t1).getTime() / 1000 - drawing.t1) < 2 && Number(item.line_price1) === drawing.p1);
    if (matching) await deleteAlert(matching.id);
  }
  function clearLog() {
    const newest = events[0]?.triggered_at ?? new Date().toISOString();
    setClearedThrough(newest);
    try { localStorage.setItem("tradechart.log-cleared-through", newest); } catch { /* Browser storage is optional. */ }
  }
  function requestNotifications() {
    if ("Notification" in window) void Notification.requestPermission();
  }
  const activeCount = alerts.filter((item) => item.active).length;
  const macdSummary = (() => {
    const warnings = [macdThreshold5 ? "5%" : "", macdThreshold10 ? "10%" : ""].filter(Boolean);
    const parts = [`Notify when the ${marketSymbol || "selected pair"} MACD (${macdTimeframe}) crosses the signal line in either direction.`];
    parts.push(warnings.length
      ? ` Early warning at ${warnings.join(" and ")} of ATR.`
      : " No early warning.");
    parts.push(` RSI context: ${rsiSettings.period || "14"} period on ${rsiTimeframe}, ${rsiSettings.oversold || "30"} oversold / ${rsiSettings.overbought || "70"} overbought.`);
    parts.push(` Trend context: ${trendPeriod || "100"} EMA on ${trendTimeframe}.`);
    return parts.join("");
  })();
  const emaSummary = (() => {
    const parts = [
      `Notify when a ${emaTimeframe} candle closes above or below the ${emaPeriod || "100"} EMA.`,
      ` RSI context: ${emaRsiSettings.period || "14"} period on ${emaRsiTimeframe}, ${emaRsiSettings.oversold || "30"} oversold / ${emaRsiSettings.overbought || "70"} overbought.`,
    ];
    parts.push(emaMacdEnabled
      ? ` MACD trend context: line versus signal on ${emaMacdTimeframe}.`
      : " MACD trend context is off.");
    return parts.join("");
  })();
  const predictionSummary = (() => {
    const timeframe = predictionTimeframe;
    const ema = predictionTrendPeriod || "100";
    if (predictionStageA && predictionStageB) {
      return `Notify on the 1H breakout model with 4H context and optional 15M retest. Stage A covers squeeze early warnings, breakout triggers, high confluence, and failed breakouts. Stage B keeps the separate breakout confirmation with RSI and the ${ema} EMA.`;
    }
    if (predictionStageA) {
      return `Notify on the 1H breakout model: 4H major levels and ${ema} EMA trend, a completed-candle break with volume and ATR buffer, a 0–100 quality score, and failed-breakout detection.`;
    }
    if (predictionStageB) {
      return `Notify when a ${timeframe} breakout confirms with volume, bands, RSI, and the ${ema} EMA.`;
    }
    return `Notify when a ${timeframe} setup triggers.`;
  })();
  const formModel: AlertFormModel = {
    kind,
    onKindChange: setKind,
    marketSymbol,
    onMarketSymbolChange: setMarketSymbol,
    targetPrice,
    onTargetPriceChange: setTargetPrice,
    macdTimeframe,
    onMacdTimeframeChange: changeMacdTimeframe,
    macdThreshold5,
    onMacdThreshold5Change: setMacdThreshold5,
    macdThreshold10,
    onMacdThreshold10Change: setMacdThreshold10,
    rsiEnabled,
    onRsiEnabledChange: setRsiEnabled,
    rsiTimeframe,
    onRsiTimeframeChange: changeRsiTimeframe,
    rsiSettings,
    onRsiSettingsChange: setRsiSettings,
    trendEnabled,
    onTrendEnabledChange: setTrendEnabled,
    trendTimeframe,
    onTrendTimeframeChange: setTrendTimeframe,
    trendPeriod,
    onTrendPeriodChange: setTrendPeriod,
    predictionTimeframe,
    onPredictionTimeframeChange: setPredictionTimeframe,
    predictionStageA,
    onPredictionStageAChange: setPredictionStageA,
    predictionStageB,
    onPredictionStageBChange: setPredictionStageB,
    predictionTrendPeriod,
    onPredictionTrendPeriodChange: setPredictionTrendPeriod,
    predictionSummary,
    fieldErrors,
    busy,
    macdSummary,
    emaTimeframe,
    onEmaTimeframeChange: changeEmaTimeframe,
    emaPeriod,
    onEmaPeriodChange: setEmaPeriod,
    emaRsiEnabled,
    onEmaRsiEnabledChange: setEmaRsiEnabled,
    emaRsiTimeframe,
    onEmaRsiTimeframeChange: changeEmaRsiTimeframe,
    emaRsiSettings,
    onEmaRsiSettingsChange: setEmaRsiSettings,
    emaMacdEnabled,
    onEmaMacdEnabledChange: setEmaMacdEnabled,
    emaMacdTimeframe,
    onEmaMacdTimeframeChange: setEmaMacdTimeframe,
    emaSummary,
  };
  const notificationsGranted =
    notificationAvailable && Notification.permission === "granted";

  return (
    <div className="flex min-h-svh w-full bg-background">
      <AppSidebar
        collapsed={sidebarCollapsed}
        mobileOpen={mobileNavOpen}
        activeSection={activeSection}
        activeAlerts={activeCount}
        triggers={events.length}
        onNavigate={() => setMobileNavOpen(false)}
        onCloseMobile={() => setMobileNavOpen(false)}
        onToggleCollapsed={toggleSidebar}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader
          theme={theme}
          activeAlerts={activeCount}
          triggers={events.length}
          sidebarCollapsed={sidebarCollapsed}
          onToggleTheme={() =>
            setTheme((current) => (current === "dark" ? "light" : "dark"))
          }
          onToggleSidebar={toggleSidebar}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        <main id="main-content" className="flex-1 px-4 py-5 md:px-6 md:py-6">
          <div className="flex w-full flex-col gap-5">
            <MarketWorkspace
              symbol={marketSymbol}
              exchange={exchange}
              onExchangeChange={(value) => void selectExchange(value)}
              theme={theme}
              onSymbolChange={setMarketSymbol}
              onPriceSelect={setTargetPrice}
              alerts={alerts}
              onCreateLineAlert={createLineAlert}
              onUpdateLineAlert={updateLineAlert}
              onDeleteLineAlert={deleteLineAlert}
            />

            {error && (
              <div className="notice" role="alert">
                <b>Connection or validation issue</b>
                <span>{error}</span>
                <button onClick={() => void refresh()}>Retry</button>
              </div>
            )}

            <div className="content-grid dashboard-grid">
              <AlertForm model={formModel} onSubmit={createAlert} />
              <AlertList
                alerts={alerts}
                refreshing={refreshing}
                notificationAvailable={notificationAvailable}
                notificationsGranted={notificationsGranted}
                onRefresh={() => void refresh()}
                onEnableNotifications={requestNotifications}
                onToggle={(item) => void toggleAlert(item)}
                onDelete={(id) => void deleteAlert(id)}
              />
              <ActivityLog
                events={events}
                clearedThrough={clearedThrough}
                onClear={clearLog}
              />
            </div>

            <footer className="flex flex-col gap-2 border-t pt-6 pb-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>Marketa+ © 2026</span>
              <span>
                Prices via {exchange === "binance" ? "Binance" : "Bybit"} public market data ·
                UTC timestamps
              </span>
            </footer>
          </div>
        </main>
      </div>

      <ToastStack
        toasts={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((entry) => entry.id !== id))
        }
      />
    </div>
  );
}
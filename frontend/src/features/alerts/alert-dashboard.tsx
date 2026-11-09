"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, readableError } from "@/lib/api/client";
import { reportUrlFromMessage, messageWithoutReport } from "@/lib/alerts";
import MarketWorkspace from "@/features/market/market-workspace";
import AppSidebar from "@/components/layout/app-sidebar";
import type { AlertItem, AlertKind, EventItem, RecoveryTrigger, ToastItem } from "@/types/alerts";
import type { Drawing, Exchange } from "@/types/market";
import { timeframes } from "./constants";
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
  const [patternTimeframe, setPatternTimeframe] = useState<(typeof timeframes)[number]>("1h");
  const [swingTimeframe, setSwingTimeframe] = useState<(typeof timeframes)[number]>("1h");
  const [recoveryTrigger, setRecoveryTrigger] = useState<RecoveryTrigger>("sma");
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
    // The chart reads either exchange directly from the browser, so the switch takes effect
    // immediately; only persisting the preference needs the API.
    setExchange(next);
    setError("");
    try {
      const saved = await api<{ exchange: Exchange }>("/exchange/", { method: "POST", body: JSON.stringify({ exchange: next }) });
      setExchange(saved.exchange);
    } catch (reason) {
      setError(readableError(reason, "Could not save the exchange preference; the chart is showing the selected market."));
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function createAlert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
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
    } else if (kind === "trend_recovery") {
      payload.timeframe = "1h";
      payload.condition = "cross";
      payload.recovery_trigger = recoveryTrigger;
    } else if (kind === "swing_detection") {
      payload.timeframe = swingTimeframe;
      payload.condition = "cross";
    } else {
      payload.timeframe = patternTimeframe;
    }
    try {
      await api<AlertItem>("/alerts/", { method: "POST", body: JSON.stringify(payload) });
      formElement.reset(); resetForm(); await refresh(); requestNotifications();
    } catch (reason) {
      setError(readableError(reason, "Could not create alert."));
    } finally { setBusy(false); }
  }

  function resetForm() {
    setTargetPrice("");
    setPatternTimeframe("1h"); setSwingTimeframe("1h"); setRecoveryTrigger("sma");
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
  const patternSummary = `Watch the last 50 ${patternTimeframe} candles of ${marketSymbol || "the selected pair"} for a chart pattern. Notify while a shape is forming with the entry, invalidation and target it pins, then again when a completed candle closes through that entry at the same target.`;
  const recoverySummary = `Watch ${marketSymbol || "the selected pair"} on closed 1h candles. When the 1D EMA 19/39 and 4H EMA 12/26 MACDs agree on the trend, warn early as the 1h MACD (${recoveryTrigger === "ema" ? "EMA 12/100" : "SMA 3/10"}) recovers from a 3+ bar pullback through zero, then confirm on the zero-line cross. Bullish recoveries and bearish reversals are tracked as separate cycles.`;
  const swingSummary = `Watch closed ${swingTimeframe} candles of ${marketSymbol || "the selected pair"}. Notify once per candle when its wick touches a current projected Trend Bias diagonal from the 1H, 4H or 1D reading.`;
  const formModel: AlertFormModel = {
    kind,
    onKindChange: setKind,
    marketSymbol,
    onMarketSymbolChange: setMarketSymbol,
    targetPrice,
    onTargetPriceChange: setTargetPrice,
    patternTimeframe,
    onPatternTimeframeChange: setPatternTimeframe,
    swingTimeframe,
    onSwingTimeframeChange: setSwingTimeframe,
    recoveryTrigger,
    onRecoveryTriggerChange: setRecoveryTrigger,
    patternSummary,
    swingSummary,
    recoverySummary,
    busy,
  };
  const notificationsGranted =
    notificationAvailable && Notification.permission === "granted";

  return (
    <div className="flex min-h-svh w-full bg-background">
      <AppSidebar
        collapsed={sidebarCollapsed}
        mobileOpen={mobileNavOpen}
        activeSection={activeSection}
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

        <main id="main-content" className="flex-1 px-0 pt-0 pb-6">
          <div className="flex w-full flex-col gap-0">
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

            <section className="alerts-group" aria-label="Alerts">
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
            </section>

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
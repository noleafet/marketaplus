import type { AlertItem } from "@/types/alerts";
import { conditions, patternLabels, recoveryTriggers } from "../constants";

type Props = {
  alerts: AlertItem[];
  refreshing: boolean;
  notificationAvailable: boolean;
  notificationsGranted: boolean;
  onRefresh: () => void;
  onEnableNotifications: () => void;
  onToggle: (alert: AlertItem) => void;
  onDelete: (id: number) => void;
};

/** What the backend engine has pinned for this alert so far. */
function patternProgress(item: AlertItem) {
  if (!item.pattern_key) return `Watching ${item.timeframe} candles for a shape`;
  const shape = patternLabels[item.pattern_key] ?? item.pattern_key;
  const bias = item.pattern_bias === "bullish" ? "bullish" : item.pattern_bias === "bearish" ? "bearish" : "";
  const status = item.pattern_state === "forming" ? "forming" : "last reported";
  const target = item.pattern_target == null ? "" : ` · target ${Number(item.pattern_target).toLocaleString()}`;
  return `${shape}${bias ? ` · ${bias}` : ""} ${status}${target}`;
}

export default function AlertList({
  alerts,
  refreshing,
  notificationAvailable,
  notificationsGranted,
  onRefresh,
  onEnableNotifications,
  onToggle,
  onDelete,
}: Props) {
  return (
    <section className="panel list-panel" id="alerts">
      <div className="panel-head">
        <div>
          <p className="eyebrow">MONITOR</p>
          <h2>Your alerts</h2>
        </div>
        <div className="panel-actions">
          {notificationAvailable && !notificationsGranted && alerts.length > 0 && (
            <button className="refresh" onClick={onEnableNotifications}>
              Enable notifications
            </button>
          )}
          <button className="refresh" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Syncing…" : "↻ Refresh"}
          </button>
        </div>
      </div>
      {alerts.length ? (
        <div className="alert-list">
          {alerts.map((item) => (
            <article className={`alert-row ${item.active ? "" : "muted"}`} key={item.id}>
              <button
                aria-label={item.active ? "Pause alert" : "Enable alert"}
                className={`status-toggle ${item.active ? "enabled" : ""}`}
                onClick={() => onToggle(item)}
              >
                <span />
              </button>
              <div className="alert-details">
                <div className="alert-title">
                  <b>{item.symbol}</b>
                  <span className="tag">
                    {item.kind === "macd"
                      ? `MACD · ${item.timeframe}${item.rsi_enabled ? ` + RSI ${item.rsi_timeframe || item.timeframe}` : ""}${item.trend_enabled ? ` + Trend ${item.trend_timeframe || "1h"}` : ""}`
                      : item.kind === "swing_detection"
                        ? `SWING · ${item.timeframe}`
                        : item.kind === "pattern"
                        ? `PATTERN · ${item.timeframe}`
                        : item.kind === "trend_recovery"
                          ? `TREND RECOVERY · 1h`
                          : item.line_type
                          ? "DRAWING"
                          : "PRICE"}
                  </span>
                </div>
                <p>
                  {item.kind === "macd"
                    ? `MACD ${conditions[item.condition]} signal${
                        item.macd_threshold_5 || item.macd_threshold_10
                          ? ` (thresholds: ${[
                              item.macd_threshold_5 && "5%",
                              item.macd_threshold_10 && "10%",
                            ]
                              .filter(Boolean)
                              .join(", ")})`
                          : ""
                      } · RSI ${item.rsi_timeframe || item.timeframe} · EMA ${item.trend_period || 100}/${item.trend_timeframe || "1h"}`
                    : item.kind === "swing_detection"
                      ? `Wick touch of a current 1H/4H/1D trend-bias diagonal · one notice per ${item.timeframe} candle`
                      : item.kind === "pattern"
                      ? patternProgress(item)
                      : item.kind === "trend_recovery"
                        ? `1D/4H MACD trend filter · 1h ${recoveryTriggers[item.recovery_trigger ?? "sma"] ?? "SMA 3/10"} trigger · bullish recovery + bearish reversal`
                        : item.line_type
                        ? `${conditions[item.condition]} drawing level`
                        : `${conditions[item.condition]} ${Number(item.price).toLocaleString()}`}
                  {item.note ? <span className="note"> · {item.note}</span> : null}
                </p>
                <small>
                  {item.frequency === "once" ? "ONE SHOT" : "REPEATING"}{" "}
                  · CREATED {new Date(item.created_at).toLocaleString()}
                </small>
              </div>
              <button
                className="delete"
                aria-label={`Delete ${item.symbol} alert`}
                onClick={() => onDelete(item.id)}
              >
                ×
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <span>◷</span>
          <b>No alerts yet</b>
          <p>Your active conditions will appear here.</p>
        </div>
      )}
    </section>
  );
}

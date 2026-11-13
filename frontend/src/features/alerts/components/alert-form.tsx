import type { FormEvent } from "react";
import { PanelHeader } from "@/components/ui/panel-header";
import type { AlertKind, RecoveryTrigger } from "@/types/alerts";
import { conditions, recoveryTriggers, timeframes } from "../constants";

export type AlertFormModel = {
  kind: AlertKind;
  onKindChange: (kind: AlertKind) => void;
  marketSymbol: string;
  onMarketSymbolChange: (symbol: string) => void;
  targetPrice: string;
  onTargetPriceChange: (price: string) => void;
  patternTimeframe: (typeof timeframes)[number];
  onPatternTimeframeChange: (timeframe: (typeof timeframes)[number]) => void;
  swingTimeframe: (typeof timeframes)[number];
  onSwingTimeframeChange: (timeframe: (typeof timeframes)[number]) => void;
  recoveryTrigger: RecoveryTrigger;
  onRecoveryTriggerChange: (trigger: RecoveryTrigger) => void;
  patternSummary: string;
  swingSummary: string;
  recoverySummary: string;
  busy: boolean;
};

type Props = {
  model: AlertFormModel;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export default function AlertForm({ model, onSubmit }: Props) {
  const {
    kind,
    onKindChange,
    marketSymbol,
    onMarketSymbolChange,
    targetPrice,
    onTargetPriceChange,
    patternTimeframe,
    onPatternTimeframeChange,
    swingTimeframe,
    onSwingTimeframeChange,
    recoveryTrigger,
    onRecoveryTriggerChange,
    patternSummary,
    swingSummary,
    recoverySummary,
    busy,
  } = model;

  return (
    <section className="panel create-panel" id="create-alert">
      <PanelHeader
        eyebrow="CONFIGURE"
        title="Create an alert"
        actions={<span className="step">01 / 02</span>}
      />
      <div className="kind-switch">
        <button type="button" className={kind === "price" ? "selected" : ""} aria-pressed={kind === "price"} onClick={() => onKindChange("price")}>
          Price level
        </button>
        <button type="button" className={kind === "trend_recovery" ? "selected" : ""} aria-pressed={kind === "trend_recovery"} onClick={() => onKindChange("trend_recovery")}>
          Trend Recovery
        </button>
        <button type="button" className={kind === "swing_detection" ? "selected" : ""} aria-pressed={kind === "swing_detection"} onClick={() => onKindChange("swing_detection")}>
          Swing detection
        </button>
        <button type="button" className={kind === "pattern" ? "selected" : ""} aria-pressed={kind === "pattern"} onClick={() => onKindChange("pattern")}>
          Pattern forming
        </button>
      </div>
      <form onSubmit={onSubmit} className="alert-form">
        <label>
          Market symbol
          <input
            name="symbol"
            placeholder="BTCUSDT"
            required
            maxLength={24}
            autoComplete="off"
            value={marketSymbol}
            onChange={(event) =>
              onMarketSymbolChange(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
            }
          />
        </label>
        {kind === "price" ? (
          <label>
            Target price
            <input
              name="price"
              type="number"
              step="any"
              min="0"
              placeholder="68000.00"
              required
              value={targetPrice}
              onChange={(event) => onTargetPriceChange(event.target.value)}
            />
          </label>
        ) : null}
        {kind === "price" && (
          <label>
            Condition
            <select name="condition">
              {["cross_up", "cross_down", "cross", "above", "below"].map((condition) => (
                <option key={condition} value={condition}>
                  {conditions[condition]}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "trend_recovery" && (
          <div className="macd-config">
            <div className="config-row">
              <label>
                1H trigger
                <select
                  name="recovery_trigger"
                  value={recoveryTrigger}
                  onChange={(event) =>
                    onRecoveryTriggerChange(event.target.value as RecoveryTrigger)
                  }
                >
                  {Object.entries(recoveryTriggers).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="config-note">
              Fixed filters: 1D MACD (EMA 19/39) and 4H MACD (EMA 12/26) must agree on the
              trend. The 1H MACD needs a pullback of at least 3 closed bars through zero
              before an early warning, then a zero-line cross on a closed candle confirms.
              EMA 12/100 is the slower alternative to SMA 3/10 — pick one, they are never
              combined.
            </p>
            <div className="macd-summary" aria-live="polite">
              <b>This alert will</b>
              <p>{recoverySummary}</p>
            </div>
          </div>
        )}
        {kind === "swing_detection" && (
          <div className="macd-config">
            <div className="config-row">
              <label>
                Candle timeframe
                <select
                  name="swing_timeframe"
                  value={swingTimeframe}
                  onChange={(event) =>
                    onSwingTimeframeChange(event.target.value as (typeof timeframes)[number])
                  }
                >
                  {timeframes.map((timeframe) => (
                    <option key={timeframe} value={timeframe}>
                      {timeframe}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="config-note">
              Watches the current projected Trend Bias diagonals from the 1H, 4H and 1D
              readings. A closed candle alerts when its wick touches one of those lines.
            </p>
            <div className="macd-summary" aria-live="polite">
              <b>This alert will</b>
              <p>{swingSummary}</p>
            </div>
          </div>
        )}
        {kind === "pattern" && (
          <div className="macd-config">
            <div className="config-row">
              <label>
                Timeframe
                <select
                  name="pattern_timeframe"
                  value={patternTimeframe}
                  onChange={(event) =>
                    onPatternTimeframeChange(event.target.value as (typeof timeframes)[number])
                  }
                >
                  {timeframes.map((timeframe) => (
                    <option key={timeframe} value={timeframe}>
                      {timeframe}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="macd-summary" aria-live="polite">
              <b>This alert will</b>
              <p>{patternSummary}</p>
            </div>
          </div>
        )}
        <label>
          Trigger frequency
          <select name="frequency" defaultValue="every">
            <option value="once">Once — disable after trigger</option>
            <option value="every">Repeat — 60s</option>
          </select>
        </label>
        <label className="wide">
          Note <span className="optional">OPTIONAL</span>
          <input
            name="note"
            maxLength={240}
            placeholder="Add a reminder for this alert"
          />
        </label>
        <button type="submit" className="submit wide" disabled={busy}>
          {busy ? "Saving…" : "Save alert"}
          <span>↗</span>
        </button>
      </form>
    </section>
  );
}

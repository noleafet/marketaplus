import type { FormEvent } from "react";
import type {
  AlertKind, RecoveryTrigger, RsiSettings,
} from "@/types/alerts";
import {
  conditions, contextTimeframes, recoveryTriggers, timeframes,
  type ContextTimeframe,
} from "../constants";

export type AlertFormModel = {
  kind: AlertKind;
  onKindChange: (kind: AlertKind) => void;
  marketSymbol: string;
  onMarketSymbolChange: (symbol: string) => void;
  targetPrice: string;
  onTargetPriceChange: (price: string) => void;
  macdTimeframe: (typeof timeframes)[number];
  onMacdTimeframeChange: (timeframe: (typeof timeframes)[number]) => void;
  macdThreshold5: boolean;
  onMacdThreshold5Change: (enabled: boolean) => void;
  macdThreshold10: boolean;
  onMacdThreshold10Change: (enabled: boolean) => void;
  rsiEnabled: boolean;
  onRsiEnabledChange: (enabled: boolean) => void;
  rsiTimeframe: ContextTimeframe;
  onRsiTimeframeChange: (timeframe: ContextTimeframe) => void;
  rsiSettings: RsiSettings;
  onRsiSettingsChange: (settings: RsiSettings) => void;
  trendEnabled: boolean;
  onTrendEnabledChange: (enabled: boolean) => void;
  trendTimeframe: ContextTimeframe;
  onTrendTimeframeChange: (timeframe: ContextTimeframe) => void;
  trendPeriod: string;
  onTrendPeriodChange: (period: string) => void;
  patternTimeframe: (typeof timeframes)[number];
  onPatternTimeframeChange: (timeframe: (typeof timeframes)[number]) => void;
  recoveryTrigger: RecoveryTrigger;
  onRecoveryTriggerChange: (trigger: RecoveryTrigger) => void;
  patternSummary: string;
  recoverySummary: string;
  fieldErrors: Record<string, string>;
  busy: boolean;
  macdSummary: string;
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
    macdTimeframe,
    onMacdTimeframeChange,
    macdThreshold5,
    onMacdThreshold5Change,
    macdThreshold10,
    onMacdThreshold10Change,
    rsiEnabled,
    onRsiEnabledChange,
    rsiTimeframe,
    onRsiTimeframeChange,
    rsiSettings,
    onRsiSettingsChange,
    trendEnabled,
    onTrendEnabledChange,
    trendTimeframe,
    onTrendTimeframeChange,
    trendPeriod,
    onTrendPeriodChange,
    patternTimeframe,
    onPatternTimeframeChange,
    recoveryTrigger,
    onRecoveryTriggerChange,
    patternSummary,
    recoverySummary,
    fieldErrors,
    busy,
    macdSummary,
  } = model;

  return (
    <section className="panel create-panel" id="create-alert">
      <div className="panel-head">
        <div>
          <p className="eyebrow">CONFIGURE</p>
          <h2>Create an alert</h2>
        </div>
        <span className="step">01 / 02</span>
      </div>
      <div className="kind-switch">
        <button className={kind === "price" ? "selected" : ""} onClick={() => onKindChange("price")}>
          Price level
        </button>
        <button className={kind === "macd" ? "selected" : ""} onClick={() => onKindChange("macd")}>
          MACD cross
        </button>
        <button className={kind === "pattern" ? "selected" : ""} onClick={() => onKindChange("pattern")}>
          Pattern forming
        </button>
        <button className={kind === "trend_recovery" ? "selected" : ""} onClick={() => onKindChange("trend_recovery")}>
          Trend Recovery
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
        {kind === "macd" && (
          <div className="macd-config">
            <div className="config-row">
              <label>
                Timeframe
                <select
                  name="timeframe"
                  value={macdTimeframe}
                  onChange={(event) =>
                    onMacdTimeframeChange(event.target.value as (typeof timeframes)[number])
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

            <fieldset className="config-block">
              <legend>Early warning</legend>
              <p className="config-hint">
                Also notify while the MACD line is still approaching the signal line, before
                the cross happens. Distance is measured as a percentage of the 14-period ATR.
              </p>
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    name="macd_threshold_5"
                    checked={macdThreshold5}
                    onChange={(event) => onMacdThreshold5Change(event.target.checked)}
                  />{" "}
                  5% of ATR away
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    name="macd_threshold_10"
                    checked={macdThreshold10}
                    onChange={(event) => onMacdThreshold10Change(event.target.checked)}
                  />{" "}
                  10% of ATR away
                </label>
              </div>
              <p className="config-note">
                Both can be enabled — you get one notice per threshold crossed.
              </p>
            </fieldset>

            <fieldset className="config-block">
              <legend>RSI context</legend>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="rsi_enabled"
                  checked={rsiEnabled}
                  onChange={(event) => onRsiEnabledChange(event.target.checked)}
                />{" "}
                Use a custom RSI period and levels
              </label>
              <div className="config-row">
                <label>
                  RSI timeframe
                  <select
                    name="rsi_timeframe"
                    value={rsiTimeframe}
                    onChange={(event) =>
                      onRsiTimeframeChange(event.target.value as ContextTimeframe)
                    }
                  >
                    {contextTimeframes.map((timeframe) => (
                      <option key={timeframe} value={timeframe}>
                        {timeframe}
                      </option>
                    ))}
                  </select>
                </label>
                {rsiEnabled && (
                  <>
                    <label>
                      Period
                      <input
                        name="rsi_period"
                        type="number"
                        min="2"
                        max="100"
                        value={rsiSettings.period}
                        onChange={(event) =>
                          onRsiSettingsChange({ ...rsiSettings, period: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Oversold
                      <input
                        name="rsi_oversold"
                        type="number"
                        min="0"
                        max="100"
                        value={rsiSettings.oversold}
                        onChange={(event) =>
                          onRsiSettingsChange({ ...rsiSettings, oversold: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Overbought
                      <input
                        name="rsi_overbought"
                        type="number"
                        min="0"
                        max="100"
                        value={rsiSettings.overbought}
                        onChange={(event) =>
                          onRsiSettingsChange({ ...rsiSettings, overbought: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}
              </div>
              {fieldErrors.rsi_period && (
                <p className="field-error">{fieldErrors.rsi_period}</p>
              )}
              {fieldErrors.rsi_oversold && (
                <p className="field-error">{fieldErrors.rsi_oversold}</p>
              )}
              {fieldErrors.rsi_overbought && (
                <p className="field-error">{fieldErrors.rsi_overbought}</p>
              )}
              <p className="config-note">
                Included in every MACD alert. Starts on the MACD timeframe; choose another interval
                here to override it. Labels momentum as bullish / bearish / bullish-balanced /
                bearish-balanced and never blocks the cross.
              </p>
            </fieldset>

            <fieldset className="config-block">
              <legend>Trend context</legend>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="trend_enabled"
                  checked={trendEnabled}
                  onChange={(event) => onTrendEnabledChange(event.target.checked)}
                />{" "}
                Use a custom EMA period
              </label>
              <div className="config-row">
                <label>
                  EMA timeframe
                  <select
                    name="trend_timeframe"
                    value={trendTimeframe}
                    onChange={(event) =>
                      onTrendTimeframeChange(event.target.value as ContextTimeframe)
                    }
                  >
                    {contextTimeframes.map((timeframe) => (
                      <option key={timeframe} value={timeframe}>
                        {timeframe}
                      </option>
                    ))}
                  </select>
                </label>
                {trendEnabled && (
                  <label>
                    EMA period
                    <input
                      name="trend_period"
                      type="number"
                      min="2"
                      max="500"
                      value={trendPeriod}
                      onChange={(event) => onTrendPeriodChange(event.target.value)}
                    />
                  </label>
                )}
              </div>
              {fieldErrors.trend_period && (
                <p className="field-error">{fieldErrors.trend_period}</p>
              )}
              <p className="config-note">
                Included in every MACD alert. Compares the close against the EMA on the selected
                timeframe (1h by default) and never blocks the cross. 100 is the default period;
                use 200 for the longer trend.
              </p>
            </fieldset>

            <div className="macd-summary" aria-live="polite">
              <b>This alert will</b>
              <p>{macdSummary}</p>
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
        <button className="submit wide" disabled={busy}>
          {busy ? "Saving…" : "Save alert"}
          <span>↗</span>
        </button>
      </form>
    </section>
  );
}

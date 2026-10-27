import type { FormEvent } from "react";
import type {
  AlertKind, RsiSettings,
} from "@/types/alerts";
import {
  conditions, contextTimeframes, timeframes,
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
  predictionTimeframe: string;
  onPredictionTimeframeChange: (timeframe: string) => void;
  predictionStageA: boolean;
  onPredictionStageAChange: (enabled: boolean) => void;
  predictionStageB: boolean;
  onPredictionStageBChange: (enabled: boolean) => void;
  predictionTrendPeriod: string;
  onPredictionTrendPeriodChange: (period: string) => void;
  predictionSummary: string;
  fieldErrors: Record<string, string>;
  busy: boolean;
  macdSummary: string;
  emaTimeframe: (typeof timeframes)[number];
  onEmaTimeframeChange: (timeframe: (typeof timeframes)[number]) => void;
  emaPeriod: string;
  onEmaPeriodChange: (period: string) => void;
  emaRsiEnabled: boolean;
  onEmaRsiEnabledChange: (enabled: boolean) => void;
  emaRsiTimeframe: ContextTimeframe;
  onEmaRsiTimeframeChange: (timeframe: ContextTimeframe) => void;
  emaRsiSettings: RsiSettings;
  onEmaRsiSettingsChange: (settings: RsiSettings) => void;
  emaMacdEnabled: boolean;
  onEmaMacdEnabledChange: (enabled: boolean) => void;
  emaMacdTimeframe: ContextTimeframe;
  onEmaMacdTimeframeChange: (timeframe: ContextTimeframe) => void;
  emaSummary: string;
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
    predictionTimeframe,
    onPredictionTimeframeChange,
    predictionStageA,
    onPredictionStageAChange,
    predictionStageB,
    onPredictionStageBChange,
    predictionTrendPeriod,
    onPredictionTrendPeriodChange,
    predictionSummary,
    fieldErrors,
    busy,
    macdSummary,
    emaTimeframe,
    onEmaTimeframeChange,
    emaPeriod,
    onEmaPeriodChange,
    emaRsiEnabled,
    onEmaRsiEnabledChange,
    emaRsiTimeframe,
    onEmaRsiTimeframeChange,
    emaRsiSettings,
    onEmaRsiSettingsChange,
    emaMacdEnabled,
    onEmaMacdEnabledChange,
    emaMacdTimeframe,
    onEmaMacdTimeframeChange,
    emaSummary,
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
        <button className={kind === "ema" ? "selected" : ""} onClick={() => onKindChange("ema")}>
          EMA cross
        </button>
        <button className={kind === "prediction" ? "selected" : ""} onClick={() => onKindChange("prediction")}>
          Prediction
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
        {kind === "ema" && (
          <div className="macd-config">
            <div className="config-row">
              <label>
                Timeframe
                <select
                  name="timeframe"
                  value={emaTimeframe}
                  onChange={(event) =>
                    onEmaTimeframeChange(event.target.value as (typeof timeframes)[number])
                  }
                >
                  {timeframes.map((timeframe) => (
                    <option key={timeframe} value={timeframe}>
                      {timeframe}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                EMA
                <select
                  name="ema_period"
                  value={emaPeriod}
                  onChange={(event) => onEmaPeriodChange(event.target.value)}
                >
                  <option value="100">EMA 100</option>
                  <option value="200">EMA 200</option>
                </select>
              </label>
            </div>
            <p className="config-hint">
              Fires when a completed candle closes on the opposite side of the EMA from the
              previous candle. New alerts arm at the latest close, so they do not replay an old
              cross.
            </p>

            <fieldset className="config-block">
              <legend>RSI context</legend>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="ema_rsi_enabled"
                  checked={emaRsiEnabled}
                  onChange={(event) => onEmaRsiEnabledChange(event.target.checked)}
                />{" "}
                Use a custom RSI period and levels
              </label>
              <div className="config-row">
                <label>
                  RSI timeframe
                  <select
                    name="ema_rsi_timeframe"
                    value={emaRsiTimeframe}
                    onChange={(event) =>
                      onEmaRsiTimeframeChange(event.target.value as ContextTimeframe)
                    }
                  >
                    {contextTimeframes.map((timeframe) => (
                      <option key={timeframe} value={timeframe}>
                        {timeframe}
                      </option>
                    ))}
                  </select>
                </label>
                {emaRsiEnabled && (
                  <>
                    <label>
                      Period
                      <input
                        name="ema_rsi_period"
                        type="number"
                        min="2"
                        max="100"
                        value={emaRsiSettings.period}
                        onChange={(event) =>
                          onEmaRsiSettingsChange({ ...emaRsiSettings, period: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Oversold
                      <input
                        name="ema_rsi_oversold"
                        type="number"
                        min="0"
                        max="100"
                        value={emaRsiSettings.oversold}
                        onChange={(event) =>
                          onEmaRsiSettingsChange({ ...emaRsiSettings, oversold: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Overbought
                      <input
                        name="ema_rsi_overbought"
                        type="number"
                        min="0"
                        max="100"
                        value={emaRsiSettings.overbought}
                        onChange={(event) =>
                          onEmaRsiSettingsChange({ ...emaRsiSettings, overbought: event.target.value })
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
                Included in every EMA alert. Starts on the EMA timeframe; choose another interval
                here to override it. Labels momentum as bullish / bearish / bullish-balanced /
                bearish-balanced.
              </p>
            </fieldset>

            <fieldset className="config-block">
              <legend>MACD trend context</legend>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="macd_context_enabled"
                  checked={emaMacdEnabled}
                  onChange={(event) => onEmaMacdEnabledChange(event.target.checked)}
                />{" "}
                Include MACD trend context
              </label>
              <div className="config-row">
                <label>
                  MACD timeframe
                  <select
                    name="macd_context_timeframe"
                    value={emaMacdTimeframe}
                    onChange={(event) =>
                      onEmaMacdTimeframeChange(event.target.value as ContextTimeframe)
                    }
                    disabled={!emaMacdEnabled}
                  >
                    {contextTimeframes.map((timeframe) => (
                      <option key={timeframe} value={timeframe}>
                        {timeframe}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="config-note">
                Compares the MACD line with its signal line on the selected timeframe and adds
                MACD: Bullish or MACD: Bearish to the alert.
              </p>
            </fieldset>

            <div className="macd-summary" aria-live="polite">
              <b>This alert will</b>
              <p>{emaSummary}</p>
            </div>
          </div>
        )}
        {kind === "prediction" && (
          <div className="macd-config">
            <div className="config-row">
              <label>
                Timeframe
                <select
                  name="prediction_timeframe"
                  value={predictionTimeframe}
                  onChange={(event) => onPredictionTimeframeChange(event.target.value)}
                >
                  {timeframes.map((timeframe) => (
                    <option
                      key={timeframe}
                      value={timeframe}
                      disabled={predictionStageA && timeframe !== "1h"}
                    >
                      {timeframe}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Trend EMA
                <select
                  value={predictionTrendPeriod}
                  onChange={(event) => onPredictionTrendPeriodChange(event.target.value)}
                >
                  <option value="100">EMA 100</option>
                  <option value="200">EMA 200</option>
                </select>
              </label>
            </div>

            <fieldset className="config-block">
              <legend>
                Stage A <span className="legend-note">multi-timeframe breakout</span>
              </legend>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={predictionStageA}
                  onChange={(event) => {
                    onPredictionStageAChange(event.target.checked);
                    if (event.target.checked) onPredictionTimeframeChange("1h");
                  }}
                />{" "}
                Early warning, breakout, and failed breakout
              </label>
              <p className="config-hint">
                4H major levels and 100 EMA context, 1H completed-candle trigger with a
                0.25×ATR buffer and 1.5× relative volume, optional 15M retest. BBW squeeze
                below the 15th percentile of its last 100 candles. A configurable 0–100
                quality score rates confluence; 80+ is high confluence, not a probability.
              </p>
            </fieldset>

            <fieldset className="config-block">
              <legend>
                Stage B <span className="legend-note">breakout confirmed</span>
              </legend>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={predictionStageB}
                  onChange={(event) => onPredictionStageBChange(event.target.checked)}
                />{" "}
                Breakout confirmation
              </label>
              <p className="config-hint">
                A completed candle closes through a level by at least 0.1×ATR, volume exceeds
                1.5× its 20-candle average, Bollinger Band Width expands, and RSI plus the
                selected EMA support the direction.
              </p>
            </fieldset>

            {fieldErrors.prediction && (
              <p className="field-error">{fieldErrors.prediction}</p>
            )}
            <div className="macd-summary" aria-live="polite">
              <b>This alert will</b>
              <p>{predictionSummary}</p>
            </div>
          </div>
        )}
        {kind !== "prediction" && (
          <label>
            Trigger frequency
            <select name="frequency" defaultValue="every">
              <option value="once">Once — disable after trigger</option>
              <option value="every">Repeat — 60s</option>
            </select>
          </label>
        )}
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

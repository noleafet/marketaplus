import { AiTwotonePicture } from "react-icons/ai";
import { FiPause, FiPlay } from "react-icons/fi";
import { TfiHelpAlt } from "react-icons/tfi";
import type { Preferences } from "@/types/market";

const indicatorChips = [
  ["ema", "EMA 100/200"],
  ["vol", "Volume"],
  ["bb", "Bollinger"],
  ["macd", "MACD"],
  ["rsi", "RSI"],
  ["atr", "ATR"],
  ["keyLevel", "Key Level"],
  ["trendBias", "Trend Bias"],
] as const;

const indicatorTitles: Partial<Record<keyof Preferences["indicators"], string>> = {
  keyLevel:
    "Shows up to two closest supports and two closest resistances scoring 40/100 or more. Strength: independent reactions 30, price rejection 25, higher-timeframe confluence 20, volume 15, recency 10",
  trendBias:
    "Draws 1H, 4H and 1D trendline segments through two major swing highs and lows, keeping every candle on the correct side. The current leg extends 24 hours past the current time; the previous leg stops where price broke it. Readings below the chart interval stay in the readout but are not drawn",
};

type IndicatorProps = {
  preferences: Preferences;
  onChange: (update: Partial<Preferences>) => void;
  onToggleIndicator: (key: keyof Preferences["indicators"]) => void;
};

/** Left column, first row: candle style and the indicator switches. */
export function IndicatorControls({
  preferences,
  onChange,
  onToggleIndicator,
}: IndicatorProps) {
  return (
    <div className="control-row indicator-row">
      <div className="mode-switch">
        <button
          aria-pressed={preferences.candleType === "candles"}
          className={preferences.candleType === "candles" ? "chosen" : ""}
          onClick={() => onChange({ candleType: "candles" })}
        >
          Candles
        </button>
        <button
          aria-pressed={preferences.candleType === "ha"}
          className={preferences.candleType === "ha" ? "chosen" : ""}
          onClick={() => onChange({ candleType: "ha" })}
        >
          Heikin Ashi
        </button>
      </div>
      {indicatorChips.map(([key, label]) => (
        <button
          aria-pressed={preferences.indicators[key]}
          className={`indicator-chip ${preferences.indicators[key] ? "active" : ""}`}
          key={key}
          title={indicatorTitles[key]}
          onClick={() => onToggleIndicator(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

type PatternProps = {
  running: boolean;
  busy: boolean;
  note: string;
  onToggle: () => void;
  onExportPicture: () => void;
  onOpenGuide: () => void;
};

/**
 * Right column, first row: the chart-pattern monitor. Like the candlestick monitor it only
 * carries state and commands; the detected pattern name is painted on the chart itself.
 */
export function PatternControls({
  running,
  busy,
  note,
  onToggle,
  onExportPicture,
  onOpenGuide,
}: PatternProps) {
  return (
    <div
      className="pattern-tools pattern-row"
      title={note || "Checks the latest 50 candles every 60 seconds while running."}
    >
      <span className="pattern-title">Pattern analysis</span>
      <button
        type="button"
        className={`monitor-toggle ${running ? "active" : ""}`}
        aria-pressed={running}
        title={running ? "Pause the 60-second pattern checks" : "Start checking the latest 50 candles every 60 seconds"}
        onClick={onToggle}
      >
        {running ? <FiPause aria-hidden="true" /> : <FiPlay aria-hidden="true" />}
        {running ? "Pause" : "Start"}
      </button>
      <button
        type="button"
        className="pattern-shot"
        aria-label="Save a picture of the chart with this pattern"
        title="Save a picture of the chart with this pattern"
        disabled={busy}
        onClick={onExportPicture}
      >
        <AiTwotonePicture className={busy ? "spinning" : ""} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="pattern-guide-button"
        aria-label="What each pattern means and how it is measured"
        title="Pattern readings"
        onClick={onOpenGuide}
      >
        <TfiHelpAlt aria-hidden="true" />
      </button>
    </div>
  );
}

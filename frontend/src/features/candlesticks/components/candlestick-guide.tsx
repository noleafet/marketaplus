"use client";

import { useEffect } from "react";
import {
  CANDLESTICK_LOOKBACK, CANDLESTICK_PATTERNS, CANDLESTICK_RECENT_BARS,
} from "../patterns";
import CandlestickSample from "./candlestick-samples";

/** Reference card for the shapes the candlestick monitor watches, opened from its help button. */
export default function CandlestickGuide({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal-card candle-guide-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="candlestick-guide-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">REFERENCE</p>
            <h2 id="candlestick-guide-title">Candlestick monitor</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="Close the candlestick guide"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="modal-note">
          The monitor reads the last {CANDLESTICK_LOOKBACK} candles for context, then reports the
          newest shape finishing in the latest {CANDLESTICK_RECENT_BARS} candles. When it finds one
          it highlights the candles on the chart. The picture button saves it to the{" "}
          <b>Candlesticks</b> tab. Checks run every 60 seconds while the monitor is started; it is
          paused by default.
        </p>
        <div className="guide-scroll candle-guide-scroll">
          <div className="candle-guide-grid">
            {CANDLESTICK_PATTERNS.map((pattern) => (
              <article className="candle-guide-item" key={pattern.key}>
                <div className="candle-guide-picture">
                  <CandlestickSample pattern={pattern.key} />
                </div>
                <div className="candle-guide-body">
                  <header>
                    <h3>{pattern.label}</h3>
                    <span className={`guide-reading ${pattern.bias}`}>
                      {pattern.bias === "both"
                        ? "Bullish / Bearish"
                        : pattern.bias === "bullish"
                          ? "Bullish"
                          : "Bearish"}
                    </span>
                  </header>
                  <dl>
                    <div>
                      <dt>Historical success / reversal rate</dt>
                      <dd>
                        {pattern.success}%{" "}
                        {pattern.bias === "both" ? "reversal" : `${pattern.bias} reversal`}
                      </dd>
                    </div>
                    <div>
                      <dt>Frequency</dt>
                      <dd>{pattern.frequency}</dd>
                    </div>
                  </dl>
                  <p>{pattern.notes}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
        <p className="modal-foot">
          Success rates and frequencies are the reference figures supplied for this monitor. They
          move with the market, timeframe, and confirmation rules, so treat them as context rather
          than a forecast. The pictures are hand-drawn samples, not live charts.
        </p>
      </div>
    </div>
  );
}

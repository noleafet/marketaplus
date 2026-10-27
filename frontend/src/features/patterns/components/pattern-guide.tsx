"use client";

import { useEffect } from "react";
import { patternChoices } from "../pattern-analysis";
import {
  PATTERN_ACCURACY,
  PATTERN_ACCURACY_SOURCE,
  PATTERN_NOTES,
  accuracyText,
} from "../metadata";
import PatternSample from "./pattern-samples";

/** Reference card for the shapes the detector knows, opened from the help button. */
export default function PatternGuide({ onClose }: { onClose: () => void }) {
  // Escape closes it, the same key the drawing toolbar already listens for.
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
        aria-labelledby="pattern-guide-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">REFERENCE</p>
            <h2 id="pattern-guide-title">Pattern readings</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="Close the pattern guide"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="modal-note">
          Every shape below is checked in the latest 50 candles. Each picture shows the price path,
          the amber <b>Entry</b> line that confirms the pattern, and the measured <b>Target</b> in
          green for bullish setups or red for bearish ones. The chart can also report a shape that is
          still forming, drawn as a projection with the level that confirms it.
        </p>
        <div className="guide-scroll candle-guide-scroll">
          <div className="candle-guide-grid pattern-guide-grid">
            {patternChoices.map((choice) => (
              <article className="candle-guide-item" key={choice.value}>
                <div className="candle-guide-picture">
                  <PatternSample pattern={choice.value} />
                </div>
                <div className="candle-guide-body">
                  <header>
                    <h3>{choice.label}</h3>
                    <span className={`guide-reading ${choice.bias}`}>
                      {choice.bias === "bullish" ? "Bullish" : "Bearish"}
                    </span>
                  </header>
                  <dl>
                    <div>
                      <dt>Historical success rate</dt>
                      <dd>{accuracyText(PATTERN_ACCURACY[choice.value])}</dd>
                    </div>
                  </dl>
                  <p>{PATTERN_NOTES[choice.value]}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
        <p className="modal-foot">
          Historical success rates after the pattern performance statistics in{" "}
          {PATTERN_ACCURACY_SOURCE}. They are estimates rather than a single study result, so
          each keeps its range. They do not say how far the target was reached before a setup
          counted, and results move with the market, timeframe and confirmation rules —
          reference only, not a forecast.
        </p>
      </div>
    </div>
  );
}

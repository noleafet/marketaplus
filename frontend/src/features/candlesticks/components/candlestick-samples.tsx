import { candlestickLabel, type CandlestickPatternKey } from "../patterns";

type SampleCandle = { open: number; high: number; low: number; close: number };

/**
 * Hand-built excerpts for the reference card. They are deliberately small and clean: the point is
 * to show the silhouette of each shape, not to reproduce a real market.
 */
const SAMPLES: Record<CandlestickPatternKey, SampleCandle[]> = {
  morning_star: [
    { open: 12.6, high: 12.85, low: 12.0, close: 12.1 },
    { open: 12.1, high: 12.3, low: 11.35, close: 11.4 },
    { open: 11.15, high: 11.3, low: 11.05, close: 11.25 },
    { open: 11.35, high: 12.0, low: 11.25, close: 11.95 },
    { open: 11.95, high: 12.25, low: 11.85, close: 12.2 },
  ],
  evening_star: [
    { open: 10.2, high: 10.9, low: 10.05, close: 10.8 },
    { open: 10.8, high: 11.65, low: 10.7, close: 11.6 },
    { open: 11.85, high: 12.0, low: 11.75, close: 11.95 },
    { open: 11.75, high: 11.85, low: 10.95, close: 11.0 },
    { open: 11.0, high: 11.15, low: 10.6, close: 10.7 },
  ],
  three_black_crows: [
    { open: 12.6, high: 12.75, low: 11.95, close: 12.0 },
    { open: 12.1, high: 12.25, low: 11.4, close: 11.5 },
    { open: 11.6, high: 11.7, low: 10.9, close: 11.0 },
    { open: 11.1, high: 11.2, low: 10.4, close: 10.5 },
    { open: 10.55, high: 10.65, low: 10.1, close: 10.2 },
  ],
  three_bar_reversal: [
    { open: 12.6, high: 12.75, low: 11.95, close: 12.0 },
    { open: 12.0, high: 12.15, low: 11.35, close: 11.4 },
    { open: 11.4, high: 11.5, low: 10.8, close: 10.9 },
    { open: 11.0, high: 11.25, low: 10.9, close: 11.15 },
    { open: 11.2, high: 11.95, low: 11.1, close: 11.9 },
  ],
  three_outside_up: [
    { open: 12.4, high: 12.55, low: 11.75, close: 11.8 },
    { open: 11.7, high: 11.8, low: 11.05, close: 11.1 },
    { open: 11.05, high: 12.05, low: 10.95, close: 12.0 },
    { open: 12.0, high: 12.55, low: 11.9, close: 12.5 },
    { open: 12.5, high: 12.7, low: 12.35, close: 12.6 },
  ],
  three_outside_down: [
    { open: 10.4, high: 11.05, low: 10.3, close: 11.0 },
    { open: 11.0, high: 11.75, low: 10.9, close: 11.7 },
    { open: 11.75, high: 11.85, low: 10.5, close: 10.6 },
    { open: 10.65, high: 10.75, low: 10.05, close: 10.1 },
    { open: 10.1, high: 10.2, low: 9.85, close: 9.95 },
  ],
  piercing_line: [
    { open: 12.6, high: 12.7, low: 12.1, close: 12.2 },
    { open: 12.2, high: 12.3, low: 11.6, close: 11.7 },
    { open: 11.7, high: 11.8, low: 11.05, close: 11.1 },
    { open: 11.1, high: 11.2, low: 10.2, close: 10.3 },
    { open: 10.15, high: 10.95, low: 10.05, close: 10.85 },
  ],
  dark_cloud_cover: [
    { open: 10.0, high: 10.7, low: 9.95, close: 10.6 },
    { open: 10.6, high: 11.25, low: 10.55, close: 11.2 },
    { open: 11.2, high: 11.7, low: 11.15, close: 11.6 },
    { open: 11.6, high: 12.25, low: 11.5, close: 12.2 },
    { open: 12.25, high: 12.3, low: 11.75, close: 11.85 },
  ],
  hammer: [
    { open: 12.6, high: 12.75, low: 11.95, close: 12.0 },
    { open: 12.0, high: 12.15, low: 11.35, close: 11.4 },
    { open: 11.5, high: 11.7, low: 10.3, close: 11.6 },
    { open: 11.65, high: 12.1, low: 11.55, close: 12.05 },
    { open: 12.05, high: 12.3, low: 11.95, close: 12.2 },
  ],
  shooting_star: [
    { open: 10.0, high: 10.7, low: 9.95, close: 10.6 },
    { open: 10.6, high: 11.25, low: 10.55, close: 11.2 },
    { open: 11.2, high: 11.85, low: 11.15, close: 11.8 },
    { open: 11.8, high: 12.45, low: 11.75, close: 12.4 },
    { open: 12.5, high: 13.1, low: 12.3, close: 12.35 },
  ],
  bearish_engulfing: [
    { open: 10.6, high: 11.25, low: 10.5, close: 11.2 },
    { open: 11.2, high: 11.95, low: 11.1, close: 11.9 },
    { open: 12.0, high: 12.1, low: 10.9, close: 11.0 },
    { open: 11.0, high: 11.1, low: 10.5, close: 10.6 },
    { open: 10.6, high: 10.7, low: 10.3, close: 10.4 },
  ],
  bullish_engulfing: [
    { open: 12.0, high: 12.1, low: 11.35, close: 11.4 },
    { open: 11.4, high: 11.5, low: 10.75, close: 10.8 },
    { open: 10.7, high: 11.75, low: 10.6, close: 11.7 },
    { open: 11.7, high: 12.1, low: 11.6, close: 12.0 },
    { open: 12.0, high: 12.2, low: 11.9, close: 12.1 },
  ],
};

const WIDTH = 168;
const HEIGHT = 96;
const PADDING = 10;

export default function CandlestickSample({ pattern }: { pattern: CandlestickPatternKey }) {
  const candles = SAMPLES[pattern];
  const low = Math.min(...candles.map((bar) => bar.low));
  const high = Math.max(...candles.map((bar) => bar.high));
  const range = Math.max(high - low, Number.EPSILON);
  const slot = (WIDTH - PADDING * 2) / candles.length;
  const bodyWidth = Math.max(6, Math.min(15, slot * 0.52));
  const y = (price: number) => PADDING + ((high - price) / range) * (HEIGHT - PADDING * 2);

  return (
    <svg
      className="candle-sample"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${candlestickLabel(pattern)} candle sample`}
    >
      <line
        x1={PADDING}
        y1={HEIGHT - PADDING}
        x2={WIDTH - PADDING}
        y2={HEIGHT - PADDING}
        className="candle-sample-base"
      />
      {candles.map((bar, index) => {
        const center = PADDING + slot * (index + 0.5);
        const top = y(Math.max(bar.open, bar.close));
        const bottom = y(Math.min(bar.open, bar.close));
        const tone = bar.close >= bar.open ? "bullish" : "bearish";
        return (
          <g key={index} className={`candle-sample-bar ${tone}`}>
            <line x1={center} y1={y(bar.high)} x2={center} y2={y(bar.low)} />
            <rect
              x={center - bodyWidth / 2}
              y={top}
              width={bodyWidth}
              height={Math.max(1.5, bottom - top)}
            />
          </g>
        );
      })}
    </svg>
  );
}

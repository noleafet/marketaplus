import type { Timeframe } from "@/types/market";
import { candleTimeLabel } from "@/lib/format";

export type LegendTone = "bullish" | "bearish";

export type LegendEntry = {
  label: string;
  value: string;
  title?: string;
  /** Green for buying pressure / upward momentum, red for selling pressure. */
  tone?: LegendTone;
};

type Props = {
  ariaLabel: string;
  time: number;
  timeframe: Timeframe;
  entries: LegendEntry[];
  pane?: boolean;
  /** True when the bar under the pointer is still forming, so its values can still change. */
  live?: boolean;
};

/** Shared hover card for the price pane and each indicator pane. */
export default function ChartLegend({ ariaLabel, time, timeframe, entries, pane = false, live = false }: Props) {
  return (
    <div className={`chart-legend ${pane ? "pane-legend" : ""}`.trim()} aria-label={ariaLabel}>
      <time dateTime={new Date(time * 1000).toISOString()}>
        {candleTimeLabel(time, timeframe)}
        {live && <span className="legend-live" title="This candle is still forming; its values can still change.">LIVE</span>}
      </time>
      <dl>
        {entries.map((entry) => (
          <div key={entry.label}>
            <dt title={entry.title}>{entry.label}</dt>
            <dd className={entry.tone ? `tone-${entry.tone}` : undefined}>{entry.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

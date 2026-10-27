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
};

/** Shared hover card for the price pane and each indicator pane. */
export default function ChartLegend({ ariaLabel, time, timeframe, entries, pane = false }: Props) {
  return (
    <div className={`chart-legend ${pane ? "pane-legend" : ""}`.trim()} aria-label={ariaLabel}>
      <time dateTime={new Date(time * 1000).toISOString()}>
        {candleTimeLabel(time, timeframe)}
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

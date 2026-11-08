type Props = {
  tabs: string[];
  active: string | null;
  onSelect: (pair: string) => void;
  onClose: (pair: string) => void;
  notice: string;
};

/**
 * The strip of open charts above the market panel. Each tab is named after its pair; the active
 * one carries the underline, and every tab can be closed with its × button.
 */
export default function ChartTabs({ tabs, active, onSelect, onClose, notice }: Props) {
  if (!tabs.length && !notice) return null;
  return (
    <div className="chart-tabs">
      <div className="chart-tabs-list" role="tablist" aria-label="Open charts">
        {tabs.map((pair) => (
          <div
            className={`chart-tab ${pair === active ? "active" : ""}`.trim()}
            key={pair}
            role="presentation"
          >
            <button
              type="button"
              role="tab"
              aria-selected={pair === active}
              className="chart-tab-name"
              onClick={() => onSelect(pair)}
            >
              {pair}
            </button>
            <button
              type="button"
              className="chart-tab-close"
              aria-label={`Close ${pair} chart`}
              onClick={() => onClose(pair)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {notice && <p className="chart-tab-notice" role="status">{notice}</p>}
    </div>
  );
}

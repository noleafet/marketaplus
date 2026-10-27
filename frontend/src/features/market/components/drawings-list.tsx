import { lineValue } from "@/lib/chart";
import { fmt } from "@/lib/format";
import type { Drawing, LineAlert } from "@/types/market";

const drawingName = (drawing: Drawing) =>
  drawing.label ??
  (drawing.type === "hline"
    ? "Horizontal line"
    : drawing.type === "hray"
      ? "Horizontal ray"
      : drawing.type === "ray"
        ? "Ray"
        : "Trendline");

type Props = {
  drawings: Drawing[];
  alerts: LineAlert[];
  selected: string | null;
  onSelect: (id: string) => void;
  onUpdate: (id: string, update: Partial<Drawing>) => void;
  onRemove: (id: string) => void;
  onCreateAlert: (drawing: Drawing, condition: string, frequency: string) => Promise<void>;
  onDeleteAlert: (drawing: Drawing) => void;
};

export default function DrawingsList({
  drawings,
  alerts,
  selected,
  onSelect,
  onUpdate,
  onRemove,
  onCreateAlert,
  onDeleteAlert,
}: Props) {
  if (!drawings.length) {
    return (
      <p className="empty workspace-empty">
        Choose a drawing tool above, then click the chart to place it.
      </p>
    );
  }
  return (
    <div className="drawing-list">
      {drawings.map((line, index) => {
        const attached = alerts.find(
          (alert) =>
            alert.line_type === line.type &&
            alert.line_t1 &&
            Math.abs(Number(alert.line_price1) - line.p1) < 1e-10 &&
            Math.abs(new Date(alert.line_t1).getTime() / 1000 - line.t1) < 2,
        );
        return (
          <article
            className={`drawing-item ${selected === line.id ? "selected" : ""} ${line.hidden ? "muted" : ""} ${line.tone ? `tone-${line.tone}` : ""}`}
            key={line.id}
            onClick={() => onSelect(line.id)}
          >
            <div className="drawing-item-head">
              <b>
                {drawingName(line)} {index + 1}
              </b>
              <span>{fmt(lineValue(line, Date.now() / 1000))}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onUpdate(line.id, { hidden: !line.hidden });
                }}
              >
                {line.hidden ? "Show" : "Hide"}
              </button>
              <button
                type="button"
                aria-label="Delete drawing"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(line.id);
                }}
              >
                ×
              </button>
            </div>
            <div className="drawing-options">
              <label>
                Width
                <select
                  value={line.width}
                  onChange={(event) => onUpdate(line.id, { width: +event.target.value })}
                >
                  {[1, 2, 3, 4, 5, 6].map((width) => (
                    <option key={width} value={width}>
                      {width}px
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Opacity
                <input
                  type="range"
                  min="10"
                  max="100"
                  step="5"
                  value={Math.round(line.opacity * 100)}
                  onChange={(event) =>
                    onUpdate(line.id, { opacity: +event.target.value / 100 })
                  }
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={!!line.extend}
                  disabled={line.type !== "trend"}
                  onChange={(event) => onUpdate(line.id, { extend: event.target.checked })}
                />{" "}
                Extend
              </label>
            </div>
            <div className="drawing-options">
              <label>
                Alert
                <select
                  value={attached?.condition ?? ""}
                  onChange={(event) => {
                    if (event.target.value) {
                      void onCreateAlert(
                        line,
                        event.target.value,
                        line.repeat ? "every" : "once",
                      );
                    } else {
                      onDeleteAlert(line);
                    }
                  }}
                >
                  <option value="">No alert</option>
                  <option value="cross">On touch</option>
                  <option value="cross_up">Cross above</option>
                  <option value="cross_down">Cross below</option>
                </select>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={!!line.repeat}
                  onChange={(event) => onUpdate(line.id, { repeat: event.target.checked })}
                />{" "}
                Repeat
              </label>
              {attached && (
                <span className={attached.active ? "positive" : "negative"}>
                  {attached.active ? "Armed" : "Triggered"}
                </span>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

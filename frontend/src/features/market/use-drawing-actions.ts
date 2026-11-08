import type { Dispatch, SetStateAction } from "react";
import type { Drawing, LineAlert } from "@/types/market";

type Deps = {
  drawings: Drawing[];
  setDrawings: Dispatch<SetStateAction<Drawing[]>>;
  selected: string | null;
  setSelected: Dispatch<SetStateAction<string | null>>;
  alerts: LineAlert[];
  onUpdateLineAlert: (drawing: Drawing) => void;
  onDeleteLineAlert: (drawing: Drawing) => void;
};

/**
 * Drawing edits shared by the chart canvas and the annotate panel. Both sides mutate the same
 * list, so the alert bookkeeping stays in one place instead of drifting between copies.
 */
export function drawingActions({
  drawings,
  setDrawings,
  selected,
  setSelected,
  alerts,
  onUpdateLineAlert,
  onDeleteLineAlert,
}: Deps) {
  function removeDrawing(id: string) {
    const drawing = drawings.find((line) => line.id === id);
    if (drawing) onDeleteLineAlert(drawing);
    setDrawings((items) => items.filter((line) => line.id !== id));
    if (selected === id) setSelected(null);
  }
  function updateDrawing(id: string, update: Partial<Drawing>) {
    setDrawings((items) => items.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...update };
      const attached = alerts.find((alert) => alert.line_type === next.type && alert.line_t1 && Math.abs(Number(alert.line_price1) - next.p1) < 1e-10 && Math.abs(new Date(alert.line_t1).getTime() / 1000 - next.t1) < 2);
      if (attached && (update.t1 !== undefined || update.p1 !== undefined || update.t2 !== undefined || update.p2 !== undefined || update.extend !== undefined || update.repeat !== undefined)) onUpdateLineAlert({ ...next, id: attached.id.toString() } as Drawing);
      return next;
    }));
  }
  function clearTradeEntry(target: string) {
    const previous = drawings.filter(
      (item) => item.symbol === target && item.origin === "calculator",
    );
    if (!previous.length) return;
    for (const drawing of previous) onDeleteLineAlert(drawing);
    setDrawings((items) => items.filter(
      (item) => !(item.symbol === target && item.origin === "calculator"),
    ));
    setSelected((current) => previous.some((drawing) => drawing.id === current) ? null : current);
  }
  return { removeDrawing, updateDrawing, clearTradeEntry };
}

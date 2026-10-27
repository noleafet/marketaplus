import type { Preferences, Tool } from "@/types/market";
import { lineTools } from "@/types/market";

const toolLabel = (tool: Tool) =>
  tool === "trend"
    ? "╱ Trendline"
    : tool === "ray"
      ? "↗ Ray"
      : tool === "hline"
        ? "— Horizontal"
        : "⊢ Horizontal ray";

const toolKey = (tool: Tool) =>
  tool === "trend" ? "T" : tool === "ray" ? "R" : tool === "hline" ? "H" : "J";

type Props = {
  tool: Tool | null;
  magnet: boolean;
  pendingPoint: boolean;
  preferences: Preferences;
  onChooseTool: (tool: Tool) => void;
  onChange: (update: Partial<Preferences>) => void;
  onMagnetChange: (magnet: boolean) => void;
};

export default function DrawingToolbar({
  tool,
  magnet,
  pendingPoint,
  preferences,
  onChooseTool,
  onChange,
  onMagnetChange,
}: Props) {
  return (
    <div className="drawing-toolbar drawing-row" aria-label="Chart drawing tools">
      {lineTools.map((item) => (
        <button
          key={item}
          aria-pressed={tool === item}
          className={tool === item ? "active" : ""}
          title={`${item} (${toolKey(item)})`}
          onClick={() => onChooseTool(item)}
        >
          {toolLabel(item)}
        </button>
      ))}
      <button
        className={magnet ? "active" : ""}
        aria-pressed={magnet}
        onClick={() => onMagnetChange(!magnet)}
      >
        Magnet
      </button>
      <button
        className={preferences.drawingsVisible ? "" : "active"}
        onClick={() => onChange({ drawingsVisible: !preferences.drawingsVisible })}
      >
        {preferences.drawingsVisible ? "Hide drawings" : "Show drawings"}
      </button>
      <button
        className={preferences.alertsVisible ? "" : "active"}
        onClick={() => onChange({ alertsVisible: !preferences.alertsVisible })}
      >
        {preferences.alertsVisible ? "Hide alert lines" : "Show alert lines"}
      </button>
      {tool && (
        <span className="tool-hint">
          {tool === "hline" || tool === "hray"
            ? "Click a price level"
            : pendingPoint
              ? "Click the second point"
              : "Click the first point"}
          ; Esc cancels
        </span>
      )}
    </div>
  );
}

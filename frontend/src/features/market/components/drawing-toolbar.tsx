import type { Tool } from "@/types/market";

/** Only these two drawing tools are offered; legacy ray/hray drawings still render. */
const drawingTools: readonly Tool[] = ["trend", "hline"];

const toolLabel = (tool: Tool) => (tool === "trend" ? "Trendline" : "Horizontal");

const toolKey = (tool: Tool) => (tool === "trend" ? "T" : "H");

type Props = {
  tool: Tool | null;
  pendingPoint: boolean;
  onChooseTool: (tool: Tool) => void;
};

export default function DrawingToolbar({
  tool,
  pendingPoint,
  onChooseTool,
}: Props) {
  return (
    <div className="drawing-toolbar drawing-row" aria-label="Chart drawing tools">
      {drawingTools.map((item) => (
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
      {tool && (
        <span className="tool-hint">
          {tool === "hline"
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

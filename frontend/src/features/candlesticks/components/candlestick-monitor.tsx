import { AiTwotonePicture } from "react-icons/ai";
import { FiPause, FiPlay } from "react-icons/fi";
import { TfiHelpAlt } from "react-icons/tfi";

type Props = {
  running: boolean;
  busy: boolean;
  note: string;
  onToggle: () => void;
  onCapture: () => void;
  onOpenGuide: () => void;
};

/**
 * The candlestick-monitor row. It only carries state and commands; detection and screenshots live
 * in the workspace, next to the chart they have to measure. The running/paused label is the button
 * itself, so the row stays compact beside the pattern controls.
 */
export default function CandlestickMonitor({
  running,
  busy,
  note,
  onToggle,
  onCapture,
  onOpenGuide,
}: Props) {
  return (
    <div
      className="workspace-controls candle-monitor monitor-row"
      title={note || "Checks the last 25 candles every 60 seconds while running."}
    >
      <span className="pattern-title">Candlestick monitor</span>
      <button
        type="button"
        className={`monitor-toggle ${running ? "active" : ""}`}
        aria-pressed={running}
        title={running ? "Pause the 60-second candlestick checks" : "Start checking the last candles every 60 seconds"}
        onClick={onToggle}
      >
        {running ? <FiPause aria-hidden="true" /> : <FiPlay aria-hidden="true" />}
        {running ? "Pause" : "Start"}
      </button>
      <button
        type="button"
        className="pattern-shot"
        aria-label="Save a picture of the current candlestick pattern"
        title="Save a picture of the current candlestick pattern"
        disabled={busy}
        onClick={onCapture}
      >
        <AiTwotonePicture className={busy ? "spinning" : ""} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="pattern-guide-button"
        aria-label="Candlestick pattern reference and samples"
        title="Candlestick readings"
        onClick={onOpenGuide}
      >
        <TfiHelpAlt aria-hidden="true" />
      </button>
    </div>
  );
}

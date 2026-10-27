import { messageWithoutReport, reportUrlFromMessage } from "@/lib/alerts";
import type { ToastItem } from "@/types/alerts";

type Props = {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
};

export default function ToastStack({ toasts, onDismiss }: Props) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((item) => {
        const reportUrl = reportUrlFromMessage(item.message);
        return (
          <div className="alert-toast" key={item.id}>
            <button
              aria-label="Dismiss notification"
              onClick={() => onDismiss(item.id)}
            >
              ×
            </button>
            <b>{item.title}</b>
            <span>{messageWithoutReport(item.message)}</span>
            {reportUrl && (
              <a className="toast-report" href={reportUrl} target="_blank" rel="noreferrer">
                See full report
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

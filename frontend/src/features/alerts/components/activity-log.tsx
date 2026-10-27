import { messageWithoutReport, reportUrlFromMessage } from "@/lib/alerts";
import type { EventItem } from "@/types/alerts";

type Props = {
  events: EventItem[];
  clearedThrough: string;
  onClear: () => void;
};

export default function ActivityLog({ events, clearedThrough, onClear }: Props) {
  const visible = events
    .filter((event) => !clearedThrough || event.triggered_at > clearedThrough)
    .slice(0, 20);
  return (
    <section className="panel activity-panel" id="activity">
      <div className="panel-head">
        <div>
          <p className="eyebrow">ACTIVITY</p>
          <h2>Triggered</h2>
        </div>
        <div className="panel-actions">
          <span className="count">{events.length} EVENTS</span>
          <button className="refresh" onClick={onClear}>
            Clear log
          </button>
        </div>
      </div>
      {visible.length ? (
        <div className="event-list">
          {visible.map((event) => {
            const reportUrl = reportUrlFromMessage(event.message);
            return (
              <article className="event-row" key={event.id}>
                <span className="event-spark">✳</span>
                <div>
                  <b>{event.title}</b>
                  <p>{messageWithoutReport(event.message)}</p>
                  {reportUrl && (
                    <a
                      className="event-report"
                      href={reportUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      See full report
                    </a>
                  )}
                </div>
                <time>
                  {new Date(event.triggered_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="no-events">Alerts that trigger will appear here.</p>
      )}
    </section>
  );
}

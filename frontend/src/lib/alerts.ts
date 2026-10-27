/**
 * The alert worker appends a machine-facing `Report: <url>` line to MACD, EMA, and prediction
 * events. The dashboard shows the wording but the URL itself has to become a real link.
 */
const REPORT_LINE = /^[ \t]*Report:\s*(https?:\/\/\S+)[ \t]*$/gim;

/** The report URL carried by an alert message, or null when the alert has no report. */
export function reportUrlFromMessage(message: string): string | null {
  REPORT_LINE.lastIndex = 0;
  const match = REPORT_LINE.exec(message);
  return match ? match[1] : null;
}

/** The event text with the machine-facing report URL line removed. */
export function messageWithoutReport(message: string): string {
  return message.replace(REPORT_LINE, "").replace(/\n{2,}/g, "\n").trim();
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FiCalendar, FiExternalLink } from "react-icons/fi";
import type { MarketEvent } from "@/types/market";

const IMPACT_RANK: Record<MarketEvent["impact"], number> = {
  critical: 4,
  high: 3,
  mid: 2,
  low: 1,
  unknown: 0,
};

const IMPACT_LABEL: Record<MarketEvent["impact"], string> = {
  critical: "Critical",
  high: "High",
  mid: "Mid",
  low: "Low",
  unknown: "Unrated",
};

/** The provider's title cut to five words keeps the identity row compact. */
function shortTitle(title: string) {
  const words = title.trim().split(/\s+/).filter(Boolean);
  return {
    text: words.slice(0, 5).join(" "),
    truncated: words.length > 5,
  };
}

function dateValue(event: MarketEvent) {
  const value = new Date(event.date).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function pickTopEvent(events: MarketEvent[]) {
  return events.reduce((best, event) => {
    const rank = IMPACT_RANK[event.impact] ?? 0;
    const bestRank = IMPACT_RANK[best.impact] ?? 0;
    if (rank !== bestRank) return rank > bestRank ? event : best;
    const score = event.impact_score ?? -1;
    const bestScore = best.impact_score ?? -1;
    if (score !== bestScore) return score > bestScore ? event : best;
    return dateValue(event) < dateValue(best) ? event : best;
  }, events[0]);
}

function displayDate(event: MarketEvent) {
  if (event.displayed_date) return event.displayed_date;
  const value = new Date(event.date);
  if (Number.isNaN(value.getTime())) return event.date;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(value);
}

type Props = {
  events: MarketEvent[];
};

/**
 * The strongest event for the current pair, followed by the remaining count. The whole chip opens
 * the full list of upcoming catalysts; past entries are removed on every sync.
 */
export default function MarketEvents({ events }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const top = useMemo(() => (events.length ? pickTopEvent(events) : null), [events]);
  const ordered = useMemo(() => {
    const now = Date.now();
    const upcoming = events
      .filter((event) => dateValue(event) >= now)
      .sort((left, right) => dateValue(left) - dateValue(right));
    const past = events
      .filter((event) => dateValue(event) < now)
      .sort((left, right) => dateValue(right) - dateValue(left));
    return [...upcoming, ...past];
  }, [events]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      triggerRef.current?.focus();
    };
  }, [open]);

  if (!top) return null;

  const title = shortTitle(top.title);
  const more = events.length - 1;

  return (
    <div className="market-events">
      <button
        ref={triggerRef}
        type="button"
        className="market-event-trigger"
        aria-haspopup="dialog"
        aria-label={`Show ${events.length} market event${events.length === 1 ? "" : "s"} for ${top.symbol}`}
        onClick={() => setOpen(true)}
      >
        <span className={`market-event-impact impact-${top.impact}`}>
          {IMPACT_LABEL[top.impact]}
        </span>
        <span className="market-event-title">
          {title.text}
          {more > 0 ? `...+${more} more.` : title.truncated ? "..." : ""}
        </span>
        <FiCalendar className="market-event-icon" aria-hidden="true" />
      </button>

      {open && (
        <div className="modal-backdrop" onPointerDown={() => setOpen(false)}>
          <div
            className="modal-card market-events-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="market-events-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">MARKET EVENTS · {top.symbol}</p>
                <h2 id="market-events-title">Catalysts for this pair</h2>
              </div>
              <button
                ref={closeRef}
                type="button"
                className="modal-close"
                aria-label="Close market events"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="modal-note">
              Upcoming events scraped from CoinMarketCal. Scores of 5.0 and above show as High,
              8.0 and above as Critical; past entries are removed.
            </p>
            <div className="market-events-list">
              {ordered.map((event) => {
                const summary = event.impact_summary || event.description;
                return (
                  <article key={event.id} className={`market-event-item impact-${event.impact}`}>
                    <div className="market-event-item-head">
                      <span className={`market-event-impact impact-${event.impact}`}>
                        {IMPACT_LABEL[event.impact]}
                      </span>
                      <time dateTime={event.date}>{displayDate(event)}</time>
                      {event.is_estimated && (
                        <span className="market-event-estimated">estimated</span>
                      )}
                    </div>
                    <h3>{event.title}</h3>
                    {summary && <p>{summary}</p>}
                    {(event.categories.length > 0 || event.source_url) && (
                      <div className="market-event-item-foot">
                        {event.categories.length > 0 && (
                          <span>{event.categories.join(" · ")}</span>
                        )}
                        {event.source_url && (
                          <a href={event.source_url} target="_blank" rel="noreferrer">
                            Source <FiExternalLink aria-hidden="true" />
                          </a>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            <p className="modal-foot">
              Event dates and impact scores are supplied by CoinMarketCal. Treat them as
              scheduled catalysts, not forecasts.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

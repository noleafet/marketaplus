import type { RefObject } from "react";
import { proxied } from "@/lib/api/client";
import { KEPT_PER_SYMBOL } from "@/lib/market/constants";
import type { PatternShot } from "@/types/market";
import { patternChoices } from "../pattern-analysis";

type Props = {
  groups: Map<string, PatternShot[]>;
  order: string[];
  notice: string;
  current: string;
  onDelete: (id: number) => void;
  onClear: (symbol: string) => void;
  clearing: string | null;
  armed: string | null;
  armRef: RefObject<HTMLButtonElement | null>;
};

/** The pattern tab: the pictures the server kept, newest first, for the pairs on the watchlist. */
export default function PatternPictures({
  groups,
  order,
  notice,
  current,
  onDelete,
  onClear,
  clearing,
  armed,
  armRef,
}: Props) {
  const label = (key: string) =>
    patternChoices.find((choice) => choice.value === key)?.label ?? key;
  return (
    <div className="pattern-shots">
      {notice && (
        <p className="watch-notice" role="status">
          {notice}
        </p>
      )}
      {!order.length && !notice && (
        <p className="empty workspace-empty">
          No pictures yet. Use the picture button in the pattern monitor; the server keeps the
          newest {KEPT_PER_SYMBOL} for every pair on the watchlist.
        </p>
      )}
      {order.map((pair) => (
        <section className="pattern-group" key={pair}>
          <h3 className="pattern-group-title">
            <b>{pair}</b>
            <span>
              {groups.get(pair)!.length}/{KEPT_PER_SYMBOL}
            </span>
            {pair === current && (
              <button
                type="button"
                ref={armed === pair ? armRef : undefined}
                className={`pattern-clear ${armed === pair ? "armed" : ""}`}
                disabled={clearing === pair}
                title={`Delete every saved picture for ${pair}`}
                onClick={() => onClear(pair)}
              >
                {clearing === pair
                  ? "Clearing…"
                  : armed === pair
                    ? `Clear ${groups.get(pair)!.length}?`
                    : "Clear all"}
              </button>
            )}
          </h3>
          <div className="pattern-shot-list">
            {groups.get(pair)!.map((shot) => (
              <article className="pattern-shot-row" key={shot.id}>
                <a
                  className="pattern-shot-thumb"
                  href={proxied(shot.image_url)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the full picture"
                >
                  <img
                    src={proxied(shot.image_url)}
                    alt={`${shot.symbol} ${label(shot.pattern)}`}
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.visibility = "hidden";
                    }}
                  />
                </a>
                <div className="pattern-shot-meta">
                  <b>{label(shot.pattern)}</b>
                  <span>
                    {shot.timeframe ? shot.timeframe.toUpperCase() : "—"} ·{" "}
                    {new Date(shot.created_at).toLocaleString()} ·{" "}
                    {Math.max(1, Math.round(shot.size / 1024))} KB
                  </span>
                  <span className="pattern-shot-summary" title={shot.summary}>
                    {shot.summary || "—"}
                  </span>
                </div>
                <div className="pattern-shot-actions">
                  <a
                    href={proxied(shot.image_url)}
                    download={`${shot.symbol.toLowerCase()}-${shot.timeframe || "chart"}-${shot.pattern}.png`}
                    title="Save this picture"
                  >
                    ↓
                  </a>
                  <button
                    type="button"
                    aria-label={`Delete ${shot.symbol} ${label(shot.pattern)} picture`}
                    onClick={() => onDelete(shot.id)}
                  >
                    ×
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

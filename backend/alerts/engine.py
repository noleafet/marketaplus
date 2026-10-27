"""Manual triggers for the recurring jobs the alert scheduler runs.

``run_alerts`` owns the schedule; this registry exposes the same units of work to the
HTTP API so a job can be run on demand from the Swagger UI without waiting for the next
tick. Each job captures the text a management command would have written to stdout.
"""

import io
from dataclasses import dataclass
from typing import Callable

from .events import sync_market_events
from .services import check_alerts, check_prediction_alerts


@dataclass(frozen=True)
class EngineJob:
    key: str
    title: str
    description: str
    run: Callable[[dict, io.StringIO], dict]


def _run_alerts(_options, output):
    events = check_alerts(stdout=output)
    return {"triggered": len(events)}


def _run_predictions(_options, output):
    events = check_prediction_alerts(stdout=output)
    return {"triggered": len(events)}


def _run_events(options, output):
    summary = sync_market_events(
        symbols=options.get("symbols"),
        stdout=output,
    )
    return {"triggered": 0, "summary": summary}


JOBS = {
    job.key: job
    for job in (
        EngineJob(
            key="alerts",
            title="Check active alerts",
            description=(
                "Fetch current prices, MACD, EMA and RSI once and fire every active price, "
                "MACD, EMA or line alert that matches. Equivalent to one scheduler poll."
            ),
            run=_run_alerts,
        ),
        EngineJob(
            key="predictions",
            title="Check prediction stages",
            description=(
                "Advance prediction stage A and stage B alerts by one poll, the same step the "
                "scheduler runs every 60 seconds."
            ),
            run=_run_predictions,
        ),
        EngineJob(
            key="events",
            title="Sync market events",
            description=(
                "Scrape each watchlist pair's CoinMarketCal coin page for upcoming events. "
                "Set symbols to limit the run."
            ),
            run=_run_events,
        ),
    )
}


def run_engine_job(key, options=None):
    """Run one registered job and return ``(job, payload, captured_output)``.

    Returns ``None`` when ``key`` is not a known job.
    """
    job = JOBS.get(key)
    if job is None:
        return None
    output = io.StringIO()
    payload = job.run(options or {}, output)
    return job, payload, output.getvalue()

import logging
from datetime import timedelta, timezone as dt_timezone

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from alerts.events import sync_market_events
from alerts.models import AppConfiguration
from alerts.services import check_alerts, check_prediction_alerts

logger = logging.getLogger(__name__)
PREDICTION_POLL_SECONDS = 60


class Command(BaseCommand):
    help = "Schedule recurring checks for active alerts using the configured poll interval."

    def add_arguments(self, parser):
        parser.add_argument("--interval", type=int, default=None,
                            help="Override the poll interval stored in Alert configuration.")

    def handle(self, *args, **options):
        override = options["interval"]
        configuration = AppConfiguration.load()
        interval = override if override is not None else configuration.alert_poll_seconds
        if interval < 1:
            raise CommandError("The configured polling interval must be at least 1 second.")
        interval_state = {"seconds": interval}

        scheduler = BlockingScheduler(timezone=timezone.get_current_timezone())

        def poll_alerts():
            try:
                self.stdout.write(f"Checking active alerts (poll interval: {interval_state['seconds']}s).")
                check_alerts(stdout=self.stdout)
            except Exception:
                logger.exception("Scheduled alert check failed")
                self.stderr.write(self.style.ERROR("Alert check failed; it will be retried on the next scheduled run."))

            if override is None:
                current_interval = AppConfiguration.load().alert_poll_seconds
                if current_interval < 1:
                    logger.error("Ignoring invalid configured alert poll interval: %s", current_interval)
                    return
                job = scheduler.get_job("check-configured-alerts")
                scheduled_interval = job.trigger.interval.total_seconds() if job else current_interval
                if current_interval != scheduled_interval:
                    scheduler.reschedule_job(
                        "check-configured-alerts",
                        trigger=IntervalTrigger(seconds=current_interval, timezone=timezone.get_current_timezone()),
                        next_run_time=timezone.now() + timedelta(seconds=current_interval),
                    )
                    interval_state["seconds"] = current_interval
                    logger.info("Alert polling interval updated to %s seconds", current_interval)

        def poll_predictions():
            try:
                self.stdout.write(
                    f"Checking prediction alerts (poll interval: {PREDICTION_POLL_SECONDS}s)."
                )
                check_prediction_alerts(stdout=self.stdout)
            except Exception:
                logger.exception("Scheduled prediction check failed")
                self.stderr.write(self.style.ERROR(
                    "Prediction check failed; it will be retried on the next scheduled run."
                ))

        def sync_events():
            try:
                self.stdout.write("Scraping CoinMarketCal events for the watchlist.")
                sync_market_events(stdout=self.stdout)
            except Exception:
                logger.exception("Scheduled market event sync failed")
                self.stderr.write(self.style.ERROR(
                    "Market event sync failed; it will be retried at the next midnight UTC run."
                ))

        def report_job(event):
            if event.exception:
                logger.error("Scheduler job failed: %s", event.exception)
            else:
                logger.debug("Scheduler completed alert check job")

        scheduler.add_listener(report_job, EVENT_JOB_EXECUTED | EVENT_JOB_ERROR)
        scheduler.add_job(
            poll_alerts,
            trigger=IntervalTrigger(seconds=interval, timezone=timezone.get_current_timezone()),
            id="check-configured-alerts",
            next_run_time=timezone.now(),
            max_instances=1,
            coalesce=True,
        )
        scheduler.add_job(
            poll_predictions,
            trigger=IntervalTrigger(
                seconds=PREDICTION_POLL_SECONDS, timezone=timezone.get_current_timezone(),
            ),
            id="check-prediction-alerts",
            next_run_time=timezone.now(),
            max_instances=1,
            coalesce=True,
        )
        scheduler.add_job(
            sync_events,
            trigger=CronTrigger(hour=0, minute=0, timezone=dt_timezone.utc),
            id="sync-market-events",
            # Populate the dashboard right after deploy; the cron trigger then runs at 00:00 UTC.
            next_run_time=timezone.now(),
            max_instances=1,
            coalesce=True,
        )
        self.stdout.write(self.style.SUCCESS(
            f"Alert scheduler started; checking immediately, then every {interval}s. "
            f"Prediction stages run every {PREDICTION_POLL_SECONDS}s. "
            f"Market events sync at 00:00 UTC. Ctrl+C stops it."
        ))
        try:
            scheduler.start()
        except KeyboardInterrupt:
            scheduler.shutdown(wait=False)
            self.stdout.write("\nAlert scheduler stopped.")

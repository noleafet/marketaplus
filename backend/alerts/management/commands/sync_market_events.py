from django.core.management.base import BaseCommand, CommandError

from alerts.events import sync_market_events


class Command(BaseCommand):
    help = "Scrape CoinMarketCal upcoming events for the watchlist."

    def add_arguments(self, parser):
        parser.add_argument(
            "--symbol", action="append", default=None,
            help="Limit the scrape to one symbol; repeat for several symbols.",
        )

    def handle(self, *args, **options):
        summary = sync_market_events(
            symbols=options["symbol"],
            stdout=self.stdout,
        )
        if summary["status"] == "no-symbols":
            raise CommandError("The watchlist is empty; add a symbol before syncing events.")

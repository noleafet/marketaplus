from django.core.management.base import BaseCommand

from alerts.services import check_alerts


class Command(BaseCommand):
    help = "Check active alerts once against current market data."

    def handle(self, *args, **options):
        events = check_alerts(stdout=self.stdout)
        if not events:
            self.stdout.write("No alerts triggered.")

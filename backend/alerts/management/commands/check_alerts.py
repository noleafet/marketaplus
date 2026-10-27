from django.core.management.base import BaseCommand

from alerts.services import check_alerts, check_prediction_alerts


class Command(BaseCommand):
    help = "Check active alerts and prediction stages once against current market data."

    def handle(self, *args, **options):
        events = check_alerts(stdout=self.stdout)
        events += check_prediction_alerts(stdout=self.stdout)
        if not events:
            self.stdout.write("No alerts triggered.")

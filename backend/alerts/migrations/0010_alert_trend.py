from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("alerts", "0009_macd_thresholds_rsi_cascading")]

    operations = [
        migrations.AddField(
            model_name="alert",
            name="trend_enabled",
            field=models.BooleanField(default=False, help_text="Enable trend filter (SMA) check after MACD trigger"),
        ),
        migrations.AddField(
            model_name="alert",
            name="trend_period",
            field=models.PositiveSmallIntegerField(default=200, help_text="SMA period for the trend filter (defaults to the 200 SMA)", null=True, blank=True),
        ),
    ]

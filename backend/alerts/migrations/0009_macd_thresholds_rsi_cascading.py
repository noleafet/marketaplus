from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("alerts", "0008_alert_rsi")]

    operations = [
        migrations.AddField(
            model_name="alert",
            name="macd_threshold_5",
            field=models.BooleanField(default=False, help_text="Enable 5% MACD cross approach threshold"),
        ),
        migrations.AddField(
            model_name="alert",
            name="macd_threshold_10",
            field=models.BooleanField(default=False, help_text="Enable 10% MACD cross approach threshold"),
        ),
        migrations.AddField(
            model_name="alert",
            name="rsi_enabled",
            field=models.BooleanField(default=False, help_text="Enable RSI check after MACD trigger"),
        ),
        migrations.AddField(
            model_name="alert",
            name="macd_triggered",
            field=models.BooleanField(default=False, help_text="Track if MACD has triggered for cascading RSI alert"),
        ),
    ]

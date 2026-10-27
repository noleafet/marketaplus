from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("alerts", "0006_rename_telegram_enabled_to_notification_enabled")]

    operations = [
        migrations.AddField(
            model_name="alert",
            name="last_macd_diff",
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="alert",
            name="last_macd_gap_percent",
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="alert",
            name="last_macd_warning_threshold",
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
    ]

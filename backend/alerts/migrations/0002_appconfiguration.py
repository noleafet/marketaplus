import django.core.validators
from django.db import migrations, models


def create_default_configuration(apps, schema_editor):
    AppConfiguration = apps.get_model("alerts", "AppConfiguration")
    AppConfiguration.objects.get_or_create(
        pk=1,
        defaults={
            "exchange_url": "https://data-api.binance.vision/api/v3",
            "exchange_timeout": 10,
            "alert_poll_seconds": 5,
            "telegram_bot_token": "",
            "telegram_chat_id": "",
        },
    )


class Migration(migrations.Migration):
    dependencies = [("alerts", "0001_initial")]

    operations = [
        migrations.CreateModel(
            name="AppConfiguration",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("exchange_url", models.URLField(default="https://data-api.binance.vision/api/v3", help_text="Base REST API URL for market data (without a trailing slash).")),
                ("exchange_timeout", models.PositiveIntegerField(default=10, help_text="Timeout in seconds for exchange and Telegram HTTP requests.", validators=[django.core.validators.MinValueValidator(1)])),
                ("alert_poll_seconds", models.PositiveIntegerField(default=5, help_text="Seconds between alert evaluation cycles.", validators=[django.core.validators.MinValueValidator(1)])),
                ("telegram_bot_token", models.CharField(blank=True, default="", max_length=255)),
                ("telegram_chat_id", models.CharField(blank=True, default="", max_length=128)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "Alert configuration",
                "verbose_name_plural": "Alert configuration",
            },
        ),
        migrations.RunPython(create_default_configuration, migrations.RunPython.noop),
    ]

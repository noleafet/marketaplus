from django.db import migrations, models
import django.core.validators


def move_configuration_values(apps, schema_editor):
    AppConfiguration = apps.get_model("alerts", "AppConfiguration")
    Notification = apps.get_model("alerts", "Notification")
    Exchange = apps.get_model("alerts", "Exchange")
    database = schema_editor.connection.alias
    configuration = AppConfiguration.objects.using(database).filter(pk=1).first()
    if configuration is None:
        return
    Notification.objects.using(database).update_or_create(
        pk=1,
        defaults={
            "telegram_bot_token": configuration.telegram_bot_token,
            "telegram_chat_id": configuration.telegram_chat_id,
        },
    )
    Exchange.objects.using(database).update_or_create(
        pk=1,
        defaults={
            "exchange": configuration.exchange,
            "exchange_url": configuration.exchange_url,
            "exchange_timeout": configuration.exchange_timeout,
        },
    )


def restore_configuration_values(apps, schema_editor):
    AppConfiguration = apps.get_model("alerts", "AppConfiguration")
    Notification = apps.get_model("alerts", "Notification")
    Exchange = apps.get_model("alerts", "Exchange")
    database = schema_editor.connection.alias
    notification = Notification.objects.using(database).filter(pk=1).first()
    exchange = Exchange.objects.using(database).filter(pk=1).first()
    if notification is None or exchange is None:
        return
    AppConfiguration.objects.using(database).update_or_create(
        pk=1,
        defaults={
            "telegram_bot_token": notification.telegram_bot_token,
            "telegram_chat_id": notification.telegram_chat_id,
            "exchange": exchange.exchange,
            "exchange_url": exchange.exchange_url,
            "exchange_timeout": exchange.exchange_timeout,
        },
    )


class Migration(migrations.Migration):
    dependencies = [("alerts", "0004_exchange_watchlist")]

    operations = [
        migrations.CreateModel(
            name="Notification",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("telegram_bot_token", models.CharField(blank=True, default="", max_length=255)),
                ("telegram_chat_id", models.CharField(blank=True, default="", max_length=128)),
            ],
        ),
        migrations.CreateModel(
            name="Exchange",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("exchange", models.CharField(choices=[("binance", "Binance"), ("bybit", "Bybit")], default="binance", max_length=12)),
                ("exchange_url", models.URLField(default="https://data-api.binance.vision/api/v3", help_text="Base REST API URL for market data (without a trailing slash).")),
                ("exchange_timeout", models.PositiveIntegerField(default=10, help_text="Timeout in seconds for exchange and Telegram HTTP requests.", validators=[django.core.validators.MinValueValidator(1)])),
            ],
        ),
        migrations.RunPython(move_configuration_values, restore_configuration_values),
        migrations.RemoveField(model_name="appconfiguration", name="telegram_bot_token"),
        migrations.RemoveField(model_name="appconfiguration", name="telegram_chat_id"),
        migrations.RemoveField(model_name="appconfiguration", name="exchange"),
        migrations.RemoveField(model_name="appconfiguration", name="exchange_url"),
        migrations.RemoveField(model_name="appconfiguration", name="exchange_timeout"),
    ]

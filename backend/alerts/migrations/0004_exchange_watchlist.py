from django.db import migrations, models


def seed_watchlist(apps, schema_editor):
    WatchlistSymbol = apps.get_model("alerts", "WatchlistSymbol")
    database = schema_editor.connection.alias
    for position, symbol in enumerate(("BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT")):
        WatchlistSymbol.objects.using(database).get_or_create(
            symbol=symbol,
            defaults={"position": position},
        )


class Migration(migrations.Migration):
    dependencies = [("alerts", "0003_appconfiguration_telegram_enabled")]

    operations = [
        migrations.AddField(
            model_name="appconfiguration",
            name="exchange",
            field=models.CharField(
                choices=[("binance", "Binance"), ("bybit", "Bybit")],
                default="binance",
                max_length=12,
            ),
        ),
        migrations.CreateModel(
            name="WatchlistSymbol",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("symbol", models.CharField(max_length=24, unique=True)),
                ("position", models.PositiveIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"ordering": ["position", "id"]},
        ),
        migrations.RunPython(seed_watchlist, migrations.RunPython.noop),
    ]
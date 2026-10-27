from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("alerts", "0007_alert_macd_approach_state")]

    operations = [
        migrations.AlterField(
            model_name="alert",
            name="kind",
            field=models.CharField(
                choices=[("price", "Price"), ("macd", "MACD cross"), ("rsi", "RSI")],
                default="price",
                max_length=8,
            ),
        ),
        migrations.AddField(
            model_name="alert",
            name="rsi_overbought",
            field=models.FloatField(blank=True, default=70, null=True),
        ),
        migrations.AddField(
            model_name="alert",
            name="rsi_oversold",
            field=models.FloatField(blank=True, default=30, null=True),
        ),
        migrations.AddField(
            model_name="alert",
            name="rsi_period",
            field=models.PositiveSmallIntegerField(blank=True, default=14, null=True),
        ),
        migrations.AddField(
            model_name="alert",
            name="last_rsi_value",
            field=models.FloatField(blank=True, null=True),
        ),
    ]

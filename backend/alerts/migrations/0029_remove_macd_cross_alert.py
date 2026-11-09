# Generated for the MACD-cross alert removal.

from django.db import migrations, models


def delete_macd_alerts(apps, schema_editor):
    Alert = apps.get_model("alerts", "Alert")

    # TriggerEvent keeps its row with a null alert, so fired history survives the cleanup.
    Alert.objects.filter(kind="macd").delete()


class Migration(migrations.Migration):

    dependencies = [
        ('alerts', '0028_alter_alert_kind'),
    ]

    operations = [
        migrations.RunPython(
            delete_macd_alerts,
            reverse_code=migrations.RunPython.noop,
        ),
        migrations.RemoveField(
            model_name='alert',
            name='last_macd_diff',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='last_macd_gap_percent',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='last_macd_warning_threshold',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='macd_threshold_5',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='macd_threshold_10',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='rsi_enabled',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='rsi_timeframe',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='trend_enabled',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='trend_period',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='trend_timeframe',
        ),
        migrations.AlterField(
            model_name='alert',
            name='kind',
            field=models.CharField(choices=[('price', 'Price'), ('rsi', 'RSI'), ('pattern', 'Chart pattern'), ('trend_recovery', 'Trend recovery'), ('swing_detection', 'Swing detection')], default='price', max_length=16),
        ),
    ]

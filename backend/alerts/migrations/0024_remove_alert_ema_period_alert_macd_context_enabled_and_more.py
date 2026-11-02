# Generated for the EMA-cross and two-stage prediction removal.

from django.db import migrations, models


def delete_ema_and_prediction_alerts(apps, schema_editor):
    Alert = apps.get_model("alerts", "Alert")

    # TriggerEvent keeps its row with a null alert, so fired history survives the cleanup.
    Alert.objects.filter(kind__in=["ema", "prediction"]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('alerts', '0023_alert_pattern_bias_alert_pattern_end_time_and_more'),
    ]

    operations = [
        migrations.RunPython(
            delete_ema_and_prediction_alerts,
            reverse_code=migrations.RunPython.noop,
        ),
        migrations.RemoveField(
            model_name='alert',
            name='ema_period',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='macd_context_enabled',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='macd_context_timeframe',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='prediction_a_direction',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='prediction_a_high_confluence',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='prediction_a_last_bar_time',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='prediction_a_level',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='prediction_a_score',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='prediction_a_state',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='prediction_stage_a',
        ),
        migrations.RemoveField(
            model_name='alert',
            name='prediction_stage_b',
        ),
        migrations.AlterField(
            model_name='alert',
            name='kind',
            field=models.CharField(choices=[('price', 'Price'), ('macd', 'MACD cross'), ('rsi', 'RSI'), ('pattern', 'Chart pattern')], default='price', max_length=16),
        ),
    ]

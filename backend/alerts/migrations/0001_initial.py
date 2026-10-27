import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [
        migrations.CreateModel(
            name="Alert",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("symbol", models.CharField(db_index=True, max_length=24)),
                ("kind", models.CharField(choices=[("price", "Price"), ("macd", "MACD cross")], default="price", max_length=8)),
                ("condition", models.CharField(choices=[("cross_up", "Crosses above"), ("cross_down", "Crosses below"), ("cross", "Crosses either way"), ("above", "Is above"), ("below", "Is below")], max_length=12)),
                ("price", models.DecimalField(blank=True, decimal_places=12, max_digits=30, null=True)),
                ("timeframe", models.CharField(blank=True, default="", max_length=3)),
                ("note", models.CharField(blank=True, default="", max_length=240)),
                ("frequency", models.CharField(choices=[("once", "Once"), ("every", "Every time")], default="once", max_length=8)),
                ("active", models.BooleanField(db_index=True, default=True)),
                ("last_triggered_at", models.DateTimeField(blank=True, null=True)),
                ("last_observed_value", models.FloatField(blank=True, null=True)),
                ("last_bar_open_time", models.DateTimeField(blank=True, null=True)),
                ("cooldown_seconds", models.PositiveIntegerField(default=60)),
                ("line_type", models.CharField(blank=True, choices=[("trend", "Trendline"), ("ray", "Ray"), ("hline", "Horizontal line"), ("hray", "Horizontal ray")], default="", max_length=8)),
                ("line_t1", models.DateTimeField(blank=True, null=True)),
                ("line_price1", models.DecimalField(blank=True, decimal_places=12, max_digits=30, null=True)),
                ("line_t2", models.DateTimeField(blank=True, null=True)),
                ("line_price2", models.DecimalField(blank=True, decimal_places=12, max_digits=30, null=True)),
                ("line_extend", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="TriggerEvent",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("symbol", models.CharField(db_index=True, max_length=24)),
                ("title", models.CharField(max_length=180)),
                ("message", models.TextField()),
                ("observed_value", models.FloatField(blank=True, null=True)),
                ("triggered_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("alert", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="events", to="alerts.alert")),
            ],
            options={"ordering": ["-triggered_at"]},
        ),
    ]

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("alerts", "0002_appconfiguration")]

    operations = [
        migrations.AddField(
            model_name="appconfiguration",
            name="telegram_enabled",
            field=models.BooleanField(default=False),
        ),
    ]
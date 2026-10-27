from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("alerts", "0005_split_configuration_models")]

    operations = [
        migrations.RenameField(
            model_name="appconfiguration",
            old_name="telegram_enabled",
            new_name="notification_enabled",
        ),
    ]

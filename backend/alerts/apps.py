from django.apps import AppConfig


class AlertsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "alerts"

    def ready(self):
        # Registers the OpenAPI authentication scheme for the CSRF-protected Telegram helpers.
        from . import schema  # noqa: F401

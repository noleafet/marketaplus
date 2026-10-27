import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    """Create the configured initial administrator once, without resetting credentials."""

    help = "Create the configured Django superuser if it does not already exist."

    def handle(self, *args, **options):
        username = os.getenv("DJANGO_SUPERUSER_USERNAME", "").strip()
        password = os.getenv("DJANGO_SUPERUSER_PASSWORD", "")
        email = os.getenv("DJANGO_SUPERUSER_EMAIL", "").strip()

        if not username or not password:
            self.stdout.write(
                self.style.WARNING(
                    "Initial superuser not created; set DJANGO_SUPERUSER_USERNAME "
                    "and DJANGO_SUPERUSER_PASSWORD to enable bootstrap."
                )
            )
            return

        user_model = get_user_model()
        lookup = {user_model.USERNAME_FIELD: username}
        if user_model._default_manager.filter(**lookup).exists():
            self.stdout.write("Configured superuser already exists; leaving it unchanged.")
            return

        user_fields = {**lookup, "password": password}
        if any(field.name == "email" for field in user_model._meta.fields):
            user_fields["email"] = email
        user_model._default_manager.db_manager().create_superuser(**user_fields)
        self.stdout.write(self.style.SUCCESS(f"Created initial superuser '{username}'."))

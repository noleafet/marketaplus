"""OpenAPI helpers that document the app's non-standard authentication.

The Telegram helper views use ``CsrfProtectedSessionAuthentication``: a Django session
cookie plus a CSRF header. drf-spectacular cannot infer that, so it is described here.
The module is imported from ``AlertsConfig.ready`` so the extension registers itself.
"""

from drf_spectacular.extensions import OpenApiAuthenticationExtension


class CsrfSessionAuthenticationScheme(OpenApiAuthenticationExtension):
    target_class = "alerts.views.CsrfProtectedSessionAuthentication"
    name = "csrfSession"

    def get_security_definition(self, auto_schema):
        return {
            "type": "apiKey",
            "in": "header",
            "name": "X-CSRFToken",
            "description": (
                "Send the token from the csrftoken cookie (GET /api/telegram/csrf/) as the "
                "X-CSRFToken header, alongside the session cookie when one is present."
            ),
        }

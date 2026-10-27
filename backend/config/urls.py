from django.contrib import admin
from django.urls import include, path
from django.views.generic.base import RedirectView
from drf_spectacular.views import SpectacularAPIView, SpectacularRedocView, SpectacularSwaggerView

urlpatterns = [
    # Dynamic redirect that resolves the actual admin URL configuration
    path('', RedirectView.as_view(pattern_name='admin:index', permanent=False), name='root-redirect'),
    
    # Your actual admin path
    path('admin/', admin.site.urls),
    path("api/", include("alerts.urls")),
    # OpenAPI 3 schema plus the Swagger UI / ReDoc front ends.
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("api/redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
]
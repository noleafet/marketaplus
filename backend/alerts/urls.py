from django.urls import path

from .views import (
    AlertDetailView, AlertEventsView, AlertListCreateView, EngineJobListView, EngineRunView,
    ExchangeSelectionView, HealthView, MarketCandlesView, MarketEventListView, MarketQuoteView,
    PatternShotDetailView, PatternShotImageView, PatternShotListView, TelegramCsrfView,
    TelegramFindChatView, TelegramStatusView, TelegramTestView, WatchlistDetailView,
    WatchlistSlugView, WatchlistView,
)

urlpatterns = [
    path("health/", HealthView.as_view(), name="health"),
    path("exchange/", ExchangeSelectionView.as_view(), name="exchange-selection"),
    path("watchlist/", WatchlistView.as_view(), name="watchlist"),
    path("watchlist/<str:symbol>/", WatchlistDetailView.as_view(), name="watchlist-detail"),
    path("watchlist/<str:symbol>/slug/", WatchlistSlugView.as_view(), name="watchlist-slug"),
    path("market/quote/", MarketQuoteView.as_view(), name="market-quote"),
    path("market/candles/", MarketCandlesView.as_view(), name="market-candles"),
    path("market/events/", MarketEventListView.as_view(), name="market-events"),
    path("telegram/status/", TelegramStatusView.as_view(), name="telegram-status"),
    path("telegram/csrf/", TelegramCsrfView.as_view(), name="telegram-csrf"),
    path("telegram/find-chat/", TelegramFindChatView.as_view(), name="telegram-find-chat"),
    path("telegram/test/", TelegramTestView.as_view(), name="telegram-test"),
    path("engine/jobs/", EngineJobListView.as_view(), name="engine-jobs"),
    path("engine/run/", EngineRunView.as_view(), name="engine-run"),
    path("alerts/", AlertListCreateView.as_view(), name="alert-list"),
    path("alerts/<int:pk>/", AlertDetailView.as_view(), name="alert-detail"),
    path("events/", AlertEventsView.as_view(), name="event-list"),
    path("pattern-shots/", PatternShotListView.as_view(), name="pattern-shot-list"),
    path("pattern-shots/<int:pk>/", PatternShotDetailView.as_view(), name="pattern-shot-detail"),
    path("pattern-shots/<int:pk>/image/", PatternShotImageView.as_view(), name="pattern-shot-image"),
]

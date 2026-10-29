import logging

import requests
from django.db.models import Max
from django.http import HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.authentication import SessionAuthentication
from rest_framework import generics, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .engine import JOBS, run_engine_job
from .events import MarketEventError, resolve_watchlist_slug, sync_symbol_events
from .models import (
    Alert, AppConfiguration, Exchange, MarketEvent, Notification, PatternShot,
    TriggerEvent, WatchlistSymbol,
)
from .serializers import (
    AlertSerializer, CsrfSerializer, DetailSerializer, EngineJobSerializer,
    EngineRunRequestSerializer, EngineRunResponseSerializer, ExchangeSelectionResponseSerializer,
    ExchangeSelectionSerializer, HealthSerializer, MarketCandleSerializer, MarketEventSerializer,
    MarketQuoteSerializer, PatternShotSerializer, TelegramFindChatResponseSerializer,
    TelegramFindChatSerializer, TelegramStatusSerializer, TelegramTestSerializer,
    TriggerEventSerializer, WatchlistSlugSerializer, WatchlistSymbolSerializer,
)
from .services import (
    find_telegram_chat, get_market_candles, get_market_quote, send_telegram_test,
)

logger = logging.getLogger(__name__)


class CsrfProtectedSessionAuthentication(SessionAuthentication):
    def authenticate(self, request):
        self.enforce_csrf(request)
        return super().authenticate(request)


class AlertListCreateView(generics.ListCreateAPIView):
    queryset = Alert.objects.all()
    serializer_class = AlertSerializer

    def get_queryset(self):
        queryset = super().get_queryset()
        active = self.request.query_params.get("active")
        if active in {"true", "false"}:
            queryset = queryset.filter(active=(active == "true"))
        return queryset


class AlertDetailView(generics.RetrieveUpdateDestroyAPIView):
    queryset = Alert.objects.all()
    serializer_class = AlertSerializer


class AlertEventsView(generics.ListAPIView):
    serializer_class = TriggerEventSerializer
    queryset = TriggerEvent.objects.select_related("alert").all()[:200]


class ExchangeSelectionView(APIView):
    @extend_schema(
        summary="Read the configured exchange",
        responses={200: ExchangeSelectionResponseSerializer},
        tags=["market"],
    )
    def get(self, request):
        exchange = Exchange.load()
        return Response({"exchange": exchange.exchange, "options": ["binance", "bybit"]})

    @extend_schema(
        summary="Switch the exchange",
        request=ExchangeSelectionSerializer,
        responses={200: ExchangeSelectionResponseSerializer, 400: DetailSerializer},
        tags=["market"],
    )
    def post(self, request):
        serializer = ExchangeSelectionSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        exchange = Exchange.load()
        exchange.exchange = serializer.validated_data["exchange"]
        exchange.save(update_fields=["exchange"])
        return self.get(request)


class WatchlistView(APIView):
    @extend_schema(
        summary="List watchlist symbols",
        responses={200: WatchlistSymbolSerializer(many=True)},
        tags=["watchlist"],
    )
    def get(self, request):
        symbols = WatchlistSymbol.objects.all()
        return Response(WatchlistSymbolSerializer(symbols, many=True).data)

    @extend_schema(
        summary="Add a watchlist symbol",
        description="Adding a symbol also fetches its market events immediately.",
        request=WatchlistSymbolSerializer,
        responses={200: WatchlistSymbolSerializer, 400: DetailSerializer},
        tags=["watchlist"],
    )
    def post(self, request):
        serializer = WatchlistSymbolSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        symbol = serializer.validated_data["symbol"]
        next_position = (WatchlistSymbol.objects.aggregate(value=Max("position"))["value"] or 0) + 1
        entry, created = WatchlistSymbol.objects.get_or_create(
            symbol=symbol, defaults={"position": next_position},
        )
        # Resolve the coin slug up front: the calendar page URL wants slugs, not tickers.
        try:
            resolve_watchlist_slug(entry)
        except MarketEventError as exc:
            logger.warning("Coin slug lookup failed for %s: %s", symbol, exc)
        # A new pair needs its events now; the four-hourly sync only covers the existing list.
        if created or not MarketEvent.objects.filter(symbol=symbol).exists():
            try:
                sync_symbol_events(symbol)
            except Exception:
                logger.exception("Market event sync failed for newly added symbol %s", symbol)
        return Response(WatchlistSymbolSerializer(entry).data, status=status.HTTP_200_OK)


class WatchlistDetailView(APIView):
    @extend_schema(
        summary="Remove a watchlist symbol",
        parameters=[OpenApiParameter("symbol", str, OpenApiParameter.PATH)],
        responses={204: None, 404: None},
        tags=["watchlist"],
    )
    def delete(self, request, symbol):
        deleted, _details = WatchlistSymbol.objects.filter(symbol=symbol.upper()).delete()
        return Response(status=status.HTTP_204_NO_CONTENT if deleted else status.HTTP_404_NOT_FOUND)


class WatchlistSlugView(APIView):
    @extend_schema(
        summary="Resolve a watchlist pair's coin slug",
        description=(
            "Looks up the canonical coin slug (a CoinGecko id such as `bitcoin`) for a "
            "watchlist pair and stores it on the watchlist row. The CoinMarketCal coin page "
            "URL wants that slug rather than a ticker, because tickers collide across projects."
        ),
        parameters=[OpenApiParameter("symbol", str, OpenApiParameter.PATH)],
        request=None,
        responses={
            200: WatchlistSlugSerializer,
            404: DetailSerializer,
            502: DetailSerializer,
        },
        tags=["watchlist"],
    )
    def post(self, request, symbol):
        entry = WatchlistSymbol.objects.filter(symbol=symbol.strip().upper()).first()
        if entry is None:
            return Response(
                {"detail": "Add the pair to the watchlist before resolving its slug."},
                status=status.HTTP_404_NOT_FOUND,
            )
        try:
            slug = resolve_watchlist_slug(entry, refresh=True)
        except MarketEventError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        if not slug:
            return Response(
                {"detail": f"No coin matched {entry.symbol}."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response({"symbol": entry.symbol, "slug": slug})


class MarketQuoteView(APIView):
    @extend_schema(
        summary="Latest price quote",
        parameters=[OpenApiParameter(
            "symbol", str, required=True, description="Market symbol, e.g. BTCUSDT.",
        )],
        responses={200: MarketQuoteSerializer, 400: DetailSerializer, 502: DetailSerializer},
        tags=["market"],
    )
    def get(self, request):
        symbol = request.query_params.get("symbol", "").strip().upper()
        if not symbol.isalnum() or len(symbol) > 24:
            return Response({"detail": "A valid market symbol is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            return Response(get_market_quote(symbol, Exchange.load()))
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except requests.RequestException:
            return Response({"detail": "The selected exchange could not be reached."}, status=status.HTTP_502_BAD_GATEWAY)


class MarketCandlesView(APIView):
    @extend_schema(
        summary="OHLCV candles",
        parameters=[
            OpenApiParameter("symbol", str, required=True, description="Market symbol."),
            OpenApiParameter("interval", str, description="One of 1m, 5m, 15m, 1h, 4h, 1d, 1w."),
            OpenApiParameter("limit", int, description="Candles to return, 2 to 1000."),
        ],
        responses={200: MarketCandleSerializer(many=True), 400: DetailSerializer, 502: DetailSerializer},
        tags=["market"],
    )
    def get(self, request):
        symbol = request.query_params.get("symbol", "").strip().upper()
        timeframe = request.query_params.get("interval", "1h")
        if not symbol.isalnum() or len(symbol) > 24:
            return Response({"detail": "A valid market symbol is required."}, status=status.HTTP_400_BAD_REQUEST)
        if timeframe not in {"1m", "5m", "15m", "1h", "4h", "1d", "1w"}:
            return Response({"detail": "Unsupported market timeframe."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            limit = max(2, min(int(request.query_params.get("limit", "500")), 1000))
        except ValueError:
            return Response({"detail": "Limit must be an integer."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            candles = get_market_candles(symbol, timeframe, Exchange.load(), limit)
            return Response(candles)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except requests.RequestException:
            return Response({"detail": "The selected exchange could not be reached."}, status=status.HTTP_502_BAD_GATEWAY)


class MarketEventListView(generics.ListAPIView):
    """Upcoming events stored for one watchlist symbol, soonest first."""

    serializer_class = MarketEventSerializer

    @extend_schema(
        summary="Market events for a symbol",
        parameters=[OpenApiParameter("symbol", str, required=True, description="Watchlist symbol.")],
        tags=["market"],
    )
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)

    def get_queryset(self):
        symbol = self.request.query_params.get("symbol", "").strip().upper()
        if not symbol:
            return MarketEvent.objects.none()
        return MarketEvent.objects.filter(symbol=symbol).order_by("date", "-impact_score", "id")


class PatternShotListView(generics.ListCreateAPIView):
    serializer_class = PatternShotSerializer
    queryset = PatternShot.objects.all()

    def get_queryset(self):
        queryset = super().get_queryset()
        # Defaults to chart patterns so the original tab keeps working against the shared table.
        category = self.request.query_params.get("category", PatternShot.Category.CHART).strip().lower()
        if category not in PatternShot.Category.values:
            category = PatternShot.Category.CHART
        queryset = queryset.filter(category=category)
        symbol = self.request.query_params.get("symbol", "").strip().upper()
        if symbol:
            queryset = queryset.filter(symbol=symbol)
        try:
            limit = int(self.request.query_params.get("limit", PatternShot.KEEP_PER_SYMBOL))
        except ValueError:
            limit = PatternShot.KEEP_PER_SYMBOL
        limit = max(1, min(limit, PatternShot.KEEP_PER_SYMBOL))
        # The model already keeps only the newest ten per symbol; this is a hard ceiling on top.
        kept: dict[str, int] = {}
        shots = []
        for shot in queryset:
            taken = kept.get(shot.symbol, 0)
            if taken >= limit:
                continue
            kept[shot.symbol] = taken + 1
            shots.append(shot)
        return shots

    @extend_schema(
        operation_id="pattern_shots_clear",
        summary="Clear a symbol's pictures",
        parameters=[
            OpenApiParameter("symbol", str, required=True, description="Symbol to clear."),
            OpenApiParameter("category", str, description="chart or candlestick."),
        ],
        responses={200: None, 400: DetailSerializer},
        tags=["pattern-shots"],
    )
    def delete(self, request, *args, **kwargs):
        # Clearing in bulk stays deliberately narrow. One symbol at a time is what the dashboard
        # offers, and a call with no symbol would wipe every picture on the server.
        symbol = request.query_params.get("symbol", "").strip().upper()
        if not symbol:
            return Response({"detail": "Name one symbol to clear."}, status=status.HTTP_400_BAD_REQUEST)
        # Clear only the tab the user is looking at; the other category keeps its pictures.
        category = request.query_params.get("category", PatternShot.Category.CHART).strip().lower()
        if category not in PatternShot.Category.values:
            category = PatternShot.Category.CHART
        deleted = PatternShot.objects.filter(symbol=symbol, category=category).delete()[0]
        return Response({"symbol": symbol, "category": category, "deleted": deleted})


class PatternShotDetailView(generics.RetrieveDestroyAPIView):
    serializer_class = PatternShotSerializer
    queryset = PatternShot.objects.all()


class PatternShotImageView(APIView):
    @extend_schema(
        summary="Picture bytes",
        responses={200: OpenApiResponse(description="PNG bytes."), 404: None},
        tags=["pattern-shots"],
    )
    def get(self, request, pk):
        shot = get_object_or_404(PatternShot, pk=pk)
        return HttpResponse(
            bytes(shot.image),
            content_type="image/png",
            headers={"Cache-Control": "private, max-age=86400"},
        )


class HealthView(APIView):
    authentication_classes = []
    permission_classes = []

    @extend_schema(
        summary="Liveness probe",
        responses={200: HealthSerializer},
        tags=["system"],
    )
    def get(self, request):
        return Response({"status": "ok"}, status=status.HTTP_200_OK)


class TelegramStatusView(APIView):
    @extend_schema(
        summary="Telegram notification status",
        responses={200: TelegramStatusSerializer},
        tags=["telegram"],
    )
    def get(self, request):
        configuration = AppConfiguration.load()
        notifications = Notification.objects.order_by("id").exclude(telegram_bot_token="").exclude(telegram_chat_id="")
        chat_hints = [f"...{chat_id[-4:]}" for chat_id in notifications.values_list("telegram_chat_id", flat=True)]
        configured = bool(chat_hints)
        return Response({
            "configured": configured,
            "enabled": configured and configuration.notification_enabled,
            "chat_hint": ", ".join(chat_hints),
        })


class TelegramCsrfView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(
        summary="Fetch a CSRF token for the Telegram helpers",
        description="Sets the csrftoken cookie and returns the same token in the body.",
        responses={200: CsrfSerializer},
        tags=["telegram"],
    )
    @method_decorator(ensure_csrf_cookie)
    def get(self, request):
        return Response({"csrf_token": get_token(request)})


class TelegramTestView(APIView):
    authentication_classes = [CsrfProtectedSessionAuthentication]
    permission_classes = [AllowAny]

    @extend_schema(
        summary="Send a Telegram test message",
        request=TelegramTestSerializer,
        responses={
            200: DetailSerializer,
            400: OpenApiResponse(DetailSerializer, description="Telegram rejected the request or token."),
            502: OpenApiResponse(DetailSerializer, description="Telegram could not be reached."),
        },
        tags=["telegram"],
    )
    def post(self, request):
        serializer = TelegramTestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            send_telegram_test(
                Notification(),
                token=serializer.validated_data["bot_token"],
                chat_id=serializer.validated_data["chat_id"],
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except requests.RequestException:
            return Response({"detail": "Telegram could not be reached. Check backend logs and try again."}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({"detail": "Test message sent."}, status=status.HTTP_200_OK)


class TelegramFindChatView(APIView):
    authentication_classes = [CsrfProtectedSessionAuthentication]
    permission_classes = [AllowAny]

    @extend_schema(
        summary="Find the Telegram chat id",
        description=(
            "Calls Telegram getUpdates with the supplied bot token and returns the chat id of "
            "the most recent message so it can be stored on a notification."
        ),
        request=TelegramFindChatSerializer,
        responses={
            200: TelegramFindChatResponseSerializer,
            400: OpenApiResponse(DetailSerializer, description="Telegram rejected the token."),
            502: OpenApiResponse(DetailSerializer, description="Telegram could not be reached."),
        },
        tags=["telegram"],
    )
    def post(self, request):
        serializer = TelegramFindChatSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            chat = find_telegram_chat(Notification(), token=serializer.validated_data["bot_token"])
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except requests.RequestException:
            return Response({"detail": "Telegram could not be reached. Check the token and try again."}, status=status.HTTP_502_BAD_GATEWAY)
        name = chat.get("title") or " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")])) or chat.get("username") or "Telegram chat"
        return Response({"chat_id": str(chat["id"]), "chat_name": name}, status=status.HTTP_200_OK)


class EngineJobListView(APIView):
    """The recurring polling jobs the scheduler owns, exposed so they can be run on demand."""

    @extend_schema(
        summary="List engine jobs",
        description="Keys accepted by POST /api/engine/run/.",
        responses={200: EngineJobSerializer(many=True)},
        tags=["engine"],
    )
    def get(self, request):
        return Response([
            {"key": job.key, "title": job.title, "description": job.description}
            for job in JOBS.values()
        ])


class EngineRunView(APIView):
    """Run one scheduler job synchronously and return its captured output.

    The jobs are the same units the alert worker runs, so a manual run can fetch market data
    and send Telegram notifications. Runs are not queued: the request blocks until the job
    finishes.
    """

    @extend_schema(
        summary="Run an engine job now",
        description=(
            "Runs one scheduler polling job immediately and returns the text it would have "
            "written to stdout. Price, MACD, EMA and event checks call the exchange and "
            "CoinMarketCal coin pages, so the request can take a while."
        ),
        request=EngineRunRequestSerializer,
        responses={
            200: EngineRunResponseSerializer,
            400: OpenApiResponse(DetailSerializer, description="Unknown job or invalid options."),
        },
        tags=["engine"],
    )
    def post(self, request):
        serializer = EngineRunRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        result = run_engine_job(serializer.validated_data["job"], serializer.validated_data)
        if result is None:
            return Response({"detail": "Unknown engine job."}, status=status.HTTP_400_BAD_REQUEST)
        job, payload, output = result
        return Response({
            "job": job.key,
            "title": job.title,
            "output": output,
            **payload,
        }, status=status.HTTP_200_OK)

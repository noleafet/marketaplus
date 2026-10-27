import base64
import binascii

from django.urls import reverse
from rest_framework import serializers

from .engine import JOBS
from .models import Alert, MarketEvent, PatternShot, TriggerEvent, WatchlistSymbol

TIMEFRAMES = {"1m", "5m", "15m", "1h", "4h", "1d", "1w"}
PRICE_CONDITIONS = {"cross_up", "cross_down", "cross", "above", "below"}
MACD_CONDITIONS = {"cross_up", "cross_down", "cross"}
RSI_CONDITIONS = {"cross_up", "cross_down", "cross", "above", "below"}
# Mirrors the pattern keys offered by the chart's pattern analysis.
PATTERN_KEYS = {
    "head_and_shoulders", "inverse_head_and_shoulders", "double_top", "double_bottom",
    "bull_flag", "bear_flag", "ascending_triangle", "descending_triangle",
    "symmetrical_triangle", "rising_wedge", "falling_wedge",
}
# Mirrors the candlestick-monitor detections on the chart.
CANDLESTICK_PATTERN_KEYS = {
    "morning_star", "evening_star", "three_black_crows", "three_bar_reversal",
    "three_outside_up", "three_outside_down", "piercing_line", "dark_cloud_cover",
    "hammer", "shooting_star", "bearish_engulfing", "bullish_engulfing",
}
PATTERN_CATEGORIES = {PatternShot.Category.CHART, PatternShot.Category.CANDLESTICK}
MAX_PATTERN_IMAGE_BYTES = 6 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class AlertSerializer(serializers.ModelSerializer):
    class Meta:
        model = Alert
        fields = [
            "id", "symbol", "kind", "condition", "price", "timeframe", "rsi_timeframe",
            "trend_timeframe", "note", "frequency", "active", "cooldown_seconds",
            "line_type", "line_t1", "line_price1", "line_t2", "line_price2",
            "line_extend", "created_at", "updated_at", "last_triggered_at", "rsi_period",
            "rsi_oversold", "rsi_overbought", "last_rsi_value", "macd_threshold_5",
            "macd_threshold_10", "rsi_enabled", "macd_triggered", "trend_enabled",
            "trend_period", "ema_period", "macd_context_enabled", "macd_context_timeframe",
            "prediction_stage_a", "prediction_stage_b", "prediction_a_state",
            "prediction_a_last_bar_time", "prediction_a_direction", "prediction_a_level",
            "prediction_a_score", "prediction_a_high_confluence",
        ]
        read_only_fields = [
            "id", "created_at", "updated_at", "last_triggered_at", "last_rsi_value",
            "macd_triggered", "prediction_a_state", "prediction_a_last_bar_time",
            "prediction_a_direction", "prediction_a_level", "prediction_a_score",
            "prediction_a_high_confluence",
        ]

    def validate_symbol(self, value):
        value = value.strip().upper()
        if not value.isalnum() or len(value) > 24:
            raise serializers.ValidationError("Use a valid alphanumeric market symbol, e.g. BTCUSDT.")
        return value

    def validate_price(self, value):
        if value is not None and value <= 0:
            raise serializers.ValidationError("Price must be greater than zero.")
        return value

    def _validate_rsi_context(self, attrs):
        if not attrs.get("rsi_enabled", getattr(self.instance, "rsi_enabled", True)):
            return
        rsi_period = attrs.get("rsi_period", getattr(self.instance, "rsi_period", 14))
        if rsi_period is not None and (rsi_period < 2 or rsi_period > 100):
            raise serializers.ValidationError({"rsi_period": "RSI period must be between 2 and 100."})
        rsi_oversold = attrs.get("rsi_oversold", getattr(self.instance, "rsi_oversold", 30))
        if rsi_oversold is not None and (rsi_oversold < 0 or rsi_oversold > 100):
            raise serializers.ValidationError({"rsi_oversold": "RSI oversold must be between 0 and 100."})
        rsi_overbought = attrs.get("rsi_overbought", getattr(self.instance, "rsi_overbought", 70))
        if rsi_overbought is not None and (rsi_overbought < 0 or rsi_overbought > 100):
            raise serializers.ValidationError({"rsi_overbought": "RSI overbought must be between 0 and 100."})
        if rsi_oversold is not None and rsi_overbought is not None and rsi_oversold >= rsi_overbought:
            raise serializers.ValidationError({"rsi_oversold": "RSI oversold must be less than overbought."})

    def _apply_rsi_timeframe_default(self, attrs, timeframe):
        """RSI follows the alert timeframe until an explicit interval is stored."""
        if self.instance is None:
            if not attrs.get("rsi_timeframe"):
                attrs["rsi_timeframe"] = timeframe
            return
        if "timeframe" not in attrs or "rsi_timeframe" in attrs:
            return
        previous_timeframe = getattr(self.instance, "timeframe", "")
        previous_rsi_timeframe = getattr(self.instance, "rsi_timeframe", "")
        if not previous_rsi_timeframe or previous_rsi_timeframe == previous_timeframe:
            attrs["rsi_timeframe"] = timeframe

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", Alert.Kind.PRICE))
        condition = attrs.get("condition", getattr(self.instance, "condition", ""))
        if kind == Alert.Kind.PRICE:
            if condition not in PRICE_CONDITIONS:
                raise serializers.ValidationError({"condition": "Unsupported price condition."})
            if attrs.get("price", getattr(self.instance, "price", None)) is None and not attrs.get("line_type", getattr(self.instance, "line_type", "")):
                raise serializers.ValidationError({"price": "A price or line geometry is required."})
            line_type = attrs.get("line_type", getattr(self.instance, "line_type", ""))
            if line_type:
                if condition not in MACD_CONDITIONS:
                    raise serializers.ValidationError({"condition": "Line alerts support cross_up, cross_down, or cross."})
                t1 = attrs.get("line_t1", getattr(self.instance, "line_t1", None))
                p1 = attrs.get("line_price1", getattr(self.instance, "line_price1", None))
                if t1 is None or p1 is None:
                    raise serializers.ValidationError({"line_t1": "Line alerts require the first time and price point."})
                if line_type in {Alert.LineType.TREND, Alert.LineType.RAY}:
                    t2 = attrs.get("line_t2", getattr(self.instance, "line_t2", None))
                    p2 = attrs.get("line_price2", getattr(self.instance, "line_price2", None))
                    if t2 is None or p2 is None or t1 == t2:
                        raise serializers.ValidationError({"line_t2": "Trendlines and rays require two distinct time/price points."})
        elif kind == Alert.Kind.MACD:
            if condition not in MACD_CONDITIONS:
                raise serializers.ValidationError({"condition": "MACD supports cross_up, cross_down, or cross."})
            timeframe = attrs.get("timeframe", getattr(self.instance, "timeframe", ""))
            if timeframe not in TIMEFRAMES:
                raise serializers.ValidationError({"timeframe": f"Choose one of {', '.join(sorted(TIMEFRAMES))}."})
            rsi_timeframe = attrs.get(
                "rsi_timeframe", getattr(self.instance, "rsi_timeframe", ""),
            )
            if rsi_timeframe and rsi_timeframe not in TIMEFRAMES:
                raise serializers.ValidationError({
                    "rsi_timeframe": f"Choose one of {', '.join(sorted(TIMEFRAMES))}.",
                })
            trend_timeframe = attrs.get(
                "trend_timeframe", getattr(self.instance, "trend_timeframe", "1h"),
            )
            if not trend_timeframe:
                trend_timeframe = "1h"
                attrs["trend_timeframe"] = "1h"
            if trend_timeframe not in TIMEFRAMES:
                raise serializers.ValidationError({
                    "trend_timeframe": f"Choose one of {', '.join(sorted(TIMEFRAMES))}.",
                })
            # RSI follows the MACD timeframe by default, including when only the MACD
            # timeframe is changed later. An explicit RSI timeframe stays put.
            self._apply_rsi_timeframe_default(attrs, timeframe)
            if attrs.get("line_type", ""):
                raise serializers.ValidationError({"line_type": "Line alerts are only available for price alerts."})
            self._validate_rsi_context(attrs)
            # Validate trend filter fields if the trend filter is enabled for MACD alert
            if attrs.get("trend_enabled", getattr(self.instance, "trend_enabled", True)):
                trend_period = attrs.get("trend_period", getattr(self.instance, "trend_period", 100))
                if trend_period is not None and (trend_period < 2 or trend_period > 500):
                    raise serializers.ValidationError({"trend_period": "Trend EMA period must be between 2 and 500."})
        elif kind == Alert.Kind.EMA:
            if condition not in MACD_CONDITIONS:
                raise serializers.ValidationError({"condition": "EMA cross supports cross_up, cross_down, or cross."})
            timeframe = attrs.get("timeframe", getattr(self.instance, "timeframe", ""))
            if timeframe not in TIMEFRAMES:
                raise serializers.ValidationError({"timeframe": f"Choose one of {', '.join(sorted(TIMEFRAMES))}."})
            ema_period = attrs.get("ema_period", getattr(self.instance, "ema_period", 100))
            if ema_period not in {100, 200}:
                raise serializers.ValidationError({"ema_period": "Choose the 100 or 200 EMA."})
            rsi_timeframe = attrs.get(
                "rsi_timeframe", getattr(self.instance, "rsi_timeframe", ""),
            )
            if rsi_timeframe and rsi_timeframe not in TIMEFRAMES:
                raise serializers.ValidationError({
                    "rsi_timeframe": f"Choose one of {', '.join(sorted(TIMEFRAMES))}.",
                })
            macd_context_timeframe = attrs.get(
                "macd_context_timeframe",
                getattr(self.instance, "macd_context_timeframe", "1h"),
            )
            if not macd_context_timeframe:
                macd_context_timeframe = "1h"
                attrs["macd_context_timeframe"] = "1h"
            if macd_context_timeframe not in TIMEFRAMES:
                raise serializers.ValidationError({
                    "macd_context_timeframe": f"Choose one of {', '.join(sorted(TIMEFRAMES))}.",
                })
            self._apply_rsi_timeframe_default(attrs, timeframe)
            if attrs.get("line_type", ""):
                raise serializers.ValidationError({"line_type": "Line alerts are only available for price alerts."})
            self._validate_rsi_context(attrs)
        elif kind == Alert.Kind.PREDICTION:
            timeframe = attrs.get("timeframe", getattr(self.instance, "timeframe", ""))
            if timeframe not in TIMEFRAMES:
                raise serializers.ValidationError({"timeframe": f"Choose one of {', '.join(sorted(TIMEFRAMES))}."})
            stage_a = attrs.get(
                "prediction_stage_a", getattr(self.instance, "prediction_stage_a", True),
            )
            stage_b = attrs.get(
                "prediction_stage_b", getattr(self.instance, "prediction_stage_b", True),
            )
            if not stage_a and not stage_b:
                raise serializers.ValidationError({
                    "prediction_stage_a": "Enable stage A, stage B, or both.",
                })
            # Stage A is a fixed multi-timeframe model: 4H context, 1H trigger and
            # optional 15M retest. Stage B may still use any supported timeframe.
            if stage_a and timeframe != "1h":
                raise serializers.ValidationError({
                    "timeframe": "Stage A uses the 1H breakout timeframe. Choose 1h or disable Stage A.",
                })
            trend_period = attrs.get(
                "trend_period", getattr(self.instance, "trend_period", 100),
            )
            if trend_period is not None and (trend_period < 2 or trend_period > 500):
                raise serializers.ValidationError({
                    "trend_period": "Trend EMA period must be between 2 and 500.",
                })
            if attrs.get("line_type", ""):
                raise serializers.ValidationError({
                    "line_type": "Line alerts are only available for price alerts.",
                })
        elif kind == Alert.Kind.RSI:
            raise serializers.ValidationError({"kind": "RSI alerts are only available as a confirmation option for MACD or EMA alerts. Create a MACD or EMA alert and enable its RSI context."})
        return attrs


class TriggerEventSerializer(serializers.ModelSerializer):
    alert_id = serializers.IntegerField(read_only=True)

    class Meta:
        model = TriggerEvent
        fields = ["id", "alert_id", "symbol", "title", "message", "observed_value", "triggered_at"]


class MarketEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = MarketEvent
        fields = [
            "id", "external_id", "symbol", "coin_symbol", "title", "description", "date",
            "date_end", "displayed_date", "impact", "impact_score", "impact_summary",
            "source_url", "categories", "is_estimated", "updated_at",
        ]
        read_only_fields = fields


class TelegramFindChatSerializer(serializers.Serializer):
    bot_token = serializers.CharField(max_length=255, trim_whitespace=True)


class DetailSerializer(serializers.Serializer):
    """Shared shape for the ``{"detail": "..."}`` error responses."""

    detail = serializers.CharField()


class HealthSerializer(serializers.Serializer):
    status = serializers.CharField()


class CsrfSerializer(serializers.Serializer):
    csrf_token = serializers.CharField()


class MarketQuoteSerializer(serializers.Serializer):
    price = serializers.FloatField()
    change = serializers.FloatField(help_text="24h change, in percent.")


class MarketCandleSerializer(serializers.Serializer):
    time = serializers.IntegerField(help_text="Candle open time, UTC seconds.")
    open = serializers.FloatField()
    high = serializers.FloatField()
    low = serializers.FloatField()
    close = serializers.FloatField()
    volume = serializers.FloatField()


class ExchangeSelectionResponseSerializer(serializers.Serializer):
    exchange = serializers.CharField()
    options = serializers.ListField(child=serializers.CharField())


class TelegramFindChatResponseSerializer(serializers.Serializer):
    chat_id = serializers.CharField()
    chat_name = serializers.CharField()


class TelegramStatusSerializer(serializers.Serializer):
    configured = serializers.BooleanField()
    enabled = serializers.BooleanField()
    chat_hint = serializers.CharField(help_text="Comma-separated masked chat ids.")


class EngineJobSerializer(serializers.Serializer):
    key = serializers.CharField()
    title = serializers.CharField()
    description = serializers.CharField()


class EngineRunRequestSerializer(serializers.Serializer):
    job = serializers.ChoiceField(
        choices=sorted(JOBS),
        help_text="Which polling job to run now.",
    )
    symbols = serializers.ListField(
        child=serializers.CharField(),
        required=False,
        allow_empty=False,
        help_text="Events job only: limit the sync to these watchlist symbols.",
    )


class EngineRunResponseSerializer(serializers.Serializer):
    job = serializers.CharField()
    title = serializers.CharField()
    output = serializers.CharField(help_text="Stdout captured from the job while it ran.")
    triggered = serializers.IntegerField(
        required=False,
        help_text="Alert or prediction events fired. Always 0 for the events job.",
    )
    summary = serializers.DictField(
        required=False,
        help_text="Market event scrape summary, returned by the events job.",
    )


class TelegramTestSerializer(serializers.Serializer):
    bot_token = serializers.CharField(max_length=255, trim_whitespace=True)
    chat_id = serializers.CharField(max_length=128, trim_whitespace=True)


class ExchangeSelectionSerializer(serializers.Serializer):
    exchange = serializers.ChoiceField(choices=[("binance", "Binance"), ("bybit", "Bybit")])


class WatchlistSymbolSerializer(serializers.ModelSerializer):
    class Meta:
        model = WatchlistSymbol
        fields = ["symbol", "position", "slug"]
        read_only_fields = ["position", "slug"]

    def validate_symbol(self, value):
        value = value.strip().upper()
        if not value.isalnum() or len(value) > 24:
            raise serializers.ValidationError("Use a valid alphanumeric market symbol, e.g. BTCUSDT.")
        return value


class WatchlistSlugSerializer(serializers.Serializer):
    """The canonical coin slug (a CoinGecko id) resolved for one watchlist pair."""

    symbol = serializers.CharField()
    slug = serializers.CharField()


class PatternShotSerializer(serializers.ModelSerializer):
    """Base64 PNG in, picture metadata plus its API URL out; the bytes never leave the server."""

    image_url = serializers.SerializerMethodField()
    size = serializers.SerializerMethodField()
    # Base64 keeps the upload a plain JSON body, so no multipart parser or Pillow is needed.
    image = serializers.CharField(write_only=True, trim_whitespace=False)

    class Meta:
        model = PatternShot
        fields = [
            "id", "symbol", "category", "pattern", "timeframe", "summary", "created_at",
            "image_url", "size", "image",
        ]
        read_only_fields = ["id", "created_at"]

    def validate_symbol(self, value):
        value = value.strip().upper()
        if not value.isalnum() or len(value) > 24:
            raise serializers.ValidationError("Use a valid alphanumeric market symbol, e.g. BTCUSDT.")
        return value

    def validate_category(self, value):
        value = value.strip().lower()
        if value not in PATTERN_CATEGORIES:
            raise serializers.ValidationError("Unsupported picture category.")
        return value

    def validate_pattern(self, value):
        return value.strip().lower()

    def validate(self, attrs):
        category = attrs.get("category", getattr(self.instance, "category", PatternShot.Category.CHART))
        pattern = attrs.get("pattern", getattr(self.instance, "pattern", ""))
        keys = CANDLESTICK_PATTERN_KEYS if category == PatternShot.Category.CANDLESTICK else PATTERN_KEYS
        if pattern not in keys:
            raise serializers.ValidationError({"pattern": "Unsupported pattern for this category."})
        return attrs

    def validate_timeframe(self, value):
        value = value.strip().lower()
        if value and value not in TIMEFRAMES:
            raise serializers.ValidationError(f"Choose one of {', '.join(sorted(TIMEFRAMES))}.")
        return value

    def validate_image(self, value):
        # Canvas data URLs arrive as "data:image/png;base64,...", so accept both spellings.
        if "," in value[:64]:
            value = value.split(",", 1)[1]
        try:
            image = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError):
            raise serializers.ValidationError("The picture must be base64 encoded.")
        if not image.startswith(PNG_SIGNATURE):
            raise serializers.ValidationError("Only PNG pictures are supported.")
        if len(image) > MAX_PATTERN_IMAGE_BYTES:
            raise serializers.ValidationError("Keep pictures under 6 MB.")
        return image

    def get_image_url(self, instance) -> str:
        return reverse("pattern-shot-image", args=[instance.pk])

    def get_size(self, instance) -> int:
        return len(bytes(instance.image))

    def create(self, validated_data):
        return PatternShot.store(**validated_data)

from django.db import models
from django.core.validators import MinValueValidator


class AppConfiguration(models.Model):
    """Singleton site configuration editable by trusted Django staff users."""

    alert_poll_seconds = models.PositiveIntegerField(
        default=5,
        validators=[MinValueValidator(1)],
        help_text="Seconds between alert evaluation cycles.",
    )
    notification_enabled = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Alert configuration"
        verbose_name_plural = "Alert configuration"

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return "Alert configuration"

    @classmethod
    def load(cls):
        configuration, _created = cls.objects.get_or_create(pk=1)
        return configuration


class Notification(models.Model):
    telegram_bot_token = models.CharField(max_length=255, blank=True, default="")
    telegram_chat_id = models.CharField(max_length=128, blank=True, default="")

    def __str__(self):
        return self.telegram_chat_id or "Telegram notification"


class Exchange(models.Model):
    class Name(models.TextChoices):
        BINANCE = "binance", "Binance"
        BYBIT = "bybit", "Bybit"

    exchange = models.CharField(max_length=12, choices=Name.choices, default=Name.BINANCE)
    exchange_url = models.URLField(
        default="https://data-api.binance.vision/api/v3",
        help_text="Base REST API URL for market data (without a trailing slash).",
    )
    exchange_timeout = models.PositiveIntegerField(
        default=10,
        validators=[MinValueValidator(1)],
        help_text="Timeout in seconds for exchange and Telegram HTTP requests.",
    )

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return self.get_exchange_display()

    @classmethod
    def load(cls):
        exchange, _created = cls.objects.get_or_create(pk=1)
        return exchange


class WatchlistSymbol(models.Model):
    symbol = models.CharField(max_length=24, unique=True)
    position = models.PositiveIntegerField(default=0)
    # Canonical coin id (a CoinGecko slug such as "bitcoin"). The calendar page URL wants that
    # slug, not a ticker, because tickers collide across projects, so it is resolved on demand
    # and cached.
    slug = models.CharField(max_length=80, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self):
        return self.symbol


class MarketEvent(models.Model):
    """An upcoming CoinMarketCal event scraped for one watchlist symbol.

    One event can mention several coins, so the same external id is stored once per watchlist
    symbol. Only upcoming rows are kept; the recurring scrape deletes rows whose date has passed.
    """

    class Impact(models.TextChoices):
        LOW = "low", "Low"
        MID = "mid", "Mid"
        HIGH = "high", "High"
        CRITICAL = "critical", "Critical"
        UNKNOWN = "unknown", "Unknown"

    external_id = models.CharField(max_length=64)
    symbol = models.CharField(max_length=24, db_index=True)
    coin_symbol = models.CharField(max_length=24, blank=True, default="")
    title = models.CharField(max_length=240)
    description = models.TextField(blank=True, default="")
    date = models.DateTimeField(db_index=True)
    date_end = models.DateTimeField(null=True, blank=True)
    displayed_date = models.CharField(max_length=80, blank=True, default="")
    impact = models.CharField(max_length=12, choices=Impact.choices, default=Impact.UNKNOWN)
    impact_score = models.FloatField(null=True, blank=True)
    impact_summary = models.CharField(max_length=500, blank=True, default="")
    source_url = models.URLField(max_length=500, blank=True, default="")
    categories = models.JSONField(default=list, blank=True)
    is_estimated = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["date", "-impact_score", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["external_id", "symbol"], name="unique_market_event_per_symbol",
            ),
        ]
        indexes = [models.Index(fields=["symbol", "date"], name="market_event_symbol_date")]
        verbose_name = "Market event"
        verbose_name_plural = "Market events"

    def __str__(self):
        return f"{self.symbol}: {self.title}"


class Alert(models.Model):
    class Kind(models.TextChoices):
        PRICE = "price", "Price"
        MACD = "macd", "MACD cross"
        EMA = "ema", "EMA cross"
        RSI = "rsi", "RSI"
        PREDICTION = "prediction", "Two-stage prediction"

    class Condition(models.TextChoices):
        CROSS_UP = "cross_up", "Crosses above"
        CROSS_DOWN = "cross_down", "Crosses below"
        CROSS = "cross", "Crosses either way"
        ABOVE = "above", "Is above"
        BELOW = "below", "Is below"

    class Frequency(models.TextChoices):
        ONCE = "once", "Once"
        EVERY = "every", "Every time"

    class LineType(models.TextChoices):
        TREND = "trend", "Trendline"
        RAY = "ray", "Ray"
        HLINE = "hline", "Horizontal line"
        HRAY = "hray", "Horizontal ray"

    symbol = models.CharField(max_length=24, db_index=True)
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.PRICE)
    condition = models.CharField(max_length=12, choices=Condition.choices)
    price = models.DecimalField(max_digits=30, decimal_places=12, null=True, blank=True)
    timeframe = models.CharField(max_length=3, blank=True, default="")
    rsi_timeframe = models.CharField(
        max_length=3, blank=True, default="",
        help_text="Timeframe for the RSI context; blank follows the MACD timeframe",
    )
    trend_timeframe = models.CharField(
        max_length=3, blank=True, default="1h",
        help_text="Timeframe for the EMA trend context (defaults to 1h)",
    )
    note = models.CharField(max_length=240, blank=True, default="")
    frequency = models.CharField(max_length=8, choices=Frequency.choices, default=Frequency.ONCE)
    active = models.BooleanField(default=True, db_index=True)
    last_triggered_at = models.DateTimeField(null=True, blank=True)
    last_observed_value = models.FloatField(null=True, blank=True)
    last_bar_open_time = models.DateTimeField(null=True, blank=True)
    last_macd_diff = models.FloatField(null=True, blank=True)
    last_macd_gap_percent = models.FloatField(null=True, blank=True)
    last_macd_warning_threshold = models.PositiveSmallIntegerField(null=True, blank=True)
    cooldown_seconds = models.PositiveIntegerField(default=60)
    rsi_period = models.PositiveSmallIntegerField(default=14, null=True, blank=True)
    rsi_oversold = models.FloatField(default=30, null=True, blank=True)
    rsi_overbought = models.FloatField(default=70, null=True, blank=True)
    last_rsi_value = models.FloatField(null=True, blank=True)
    macd_threshold_5 = models.BooleanField(default=False, help_text="Enable 5% MACD cross approach threshold")
    macd_threshold_10 = models.BooleanField(default=False, help_text="Enable 10% MACD cross approach threshold")
    rsi_enabled = models.BooleanField(default=True, help_text="Enable RSI context by default")
    macd_triggered = models.BooleanField(default=False, help_text="Track if MACD has triggered for cascading RSI alert")
    trend_enabled = models.BooleanField(default=True, help_text="Enable EMA trend context by default")
    trend_period = models.PositiveSmallIntegerField(default=100, null=True, blank=True, help_text="EMA period for the trend filter (defaults to the 100 EMA)")

    # EMA-cross alert. The main timeframe decides the price/EMA crossing; RSI reuses the
    # context fields above, while MACD has its own optional timeframe.
    ema_period = models.PositiveSmallIntegerField(
        default=100, help_text="EMA period for EMA cross alerts (100 or 200)",
    )
    macd_context_enabled = models.BooleanField(
        default=True, help_text="Include MACD trend context in EMA cross alerts",
    )
    macd_context_timeframe = models.CharField(
        max_length=3, blank=True, default="1h",
        help_text="Timeframe for the MACD trend context (defaults to 1h)",
    )

    # Stage A is a multi-timeframe breakout detector. Its persisted state prevents a
    # squeeze episode, breakout or failed breakout from being reported twice. Stage B
    # remains the original single-timeframe confirmation rule.
    class PredictionAState(models.TextChoices):
        IDLE = "idle", "Idle"
        EARLY = "early", "Early warning"
        BREAKOUT = "breakout", "Breakout"

    prediction_stage_a = models.BooleanField(default=True, help_text="Enable the multi-timeframe breakout warning")
    prediction_stage_b = models.BooleanField(default=True, help_text="Enable the confirmed-breakout alert")
    prediction_a_state = models.CharField(
        max_length=12, choices=PredictionAState.choices, default=PredictionAState.IDLE,
        help_text="Internal state: idle, early warning sent, or breakout awaiting failure",
    )
    prediction_a_last_bar_time = models.DateTimeField(
        null=True, blank=True,
        help_text="Internal state: last completed 1H bar evaluated by Stage A",
    )
    prediction_a_direction = models.CharField(max_length=8, blank=True, default="")
    prediction_a_level = models.JSONField(
        default=dict, blank=True,
        help_text="Internal state: the 4H level active in the Stage A state machine",
    )
    prediction_a_score = models.PositiveSmallIntegerField(null=True, blank=True)
    prediction_a_high_confluence = models.BooleanField(default=False)

    # Optional line-based price alert, preserving the drawing alert semantics of TradeChartAlert.
    line_type = models.CharField(max_length=8, choices=LineType.choices, blank=True, default="")
    line_t1 = models.DateTimeField(null=True, blank=True)
    line_price1 = models.DecimalField(max_digits=30, decimal_places=12, null=True, blank=True)
    line_t2 = models.DateTimeField(null=True, blank=True)
    line_price2 = models.DecimalField(max_digits=30, decimal_places=12, null=True, blank=True)
    line_extend = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    @property
    def effective_rsi_timeframe(self):
        """RSI follows the MACD timeframe unless the alert stores its own interval."""
        return self.rsi_timeframe or self.timeframe

    @property
    def effective_trend_timeframe(self):
        return self.trend_timeframe or "1h"

    @property
    def effective_macd_context_timeframe(self):
        """MACD context follows 1h unless the EMA-cross alert stores its own interval."""
        return self.macd_context_timeframe or "1h"

    def __str__(self):
        if self.kind == self.Kind.MACD:
            target = f"MACD {self.timeframe}"
        elif self.kind == self.Kind.EMA:
            target = f"EMA {self.ema_period or 100} {self.timeframe}"
        elif self.kind == self.Kind.RSI:
            target = f"RSI {self.timeframe}"
        elif self.kind == self.Kind.PREDICTION:
            stages = "".join(
                stage for stage, enabled in (
                    ("A", self.prediction_stage_a),
                    ("B", self.prediction_stage_b),
                ) if enabled
            ) or "no stages"
            target = f"prediction {stages} {self.timeframe}"
        else:
            target = str(self.price or "line")
        return f"{self.symbol} {self.condition} {target}"


class PatternShot(models.Model):
    """A saved pattern picture, kept for the newest ten per market symbol and category."""

    KEEP_PER_SYMBOL = 10

    class Category(models.TextChoices):
        CHART = "chart", "Chart pattern"
        CANDLESTICK = "candlestick", "Candlestick pattern"

    symbol = models.CharField(max_length=24, db_index=True)
    category = models.CharField(
        max_length=16, choices=Category.choices, default=Category.CHART, db_index=True,
    )
    pattern = models.CharField(max_length=40)
    timeframe = models.CharField(max_length=3, blank=True, default="")
    summary = models.CharField(max_length=240, blank=True, default="")
    image = models.BinaryField()
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return f"{self.symbol} {self.pattern}"

    @classmethod
    def store(cls, *, symbol, pattern, timeframe, image, summary="", category=Category.CHART):
        """Saves a picture and drops everything older than the newest ten for that symbol and category.

        Chart patterns and candlestick-monitor captures share this table, but each keeps its own
        ten so a busy monitor cannot push the user's chart-pattern pictures out of the list.
        """
        shot = cls.objects.create(
            symbol=symbol, category=category, pattern=pattern, timeframe=timeframe,
            summary=summary[:240], image=image,
        )
        stale = list(
            cls.objects.filter(symbol=symbol, category=category)
            .order_by("-created_at", "-id")
            .values_list("id", flat=True)[cls.KEEP_PER_SYMBOL:]
        )
        if stale:
            cls.objects.filter(id__in=stale).delete()
        return shot


class TriggerEvent(models.Model):
    alert = models.ForeignKey(Alert, related_name="events", on_delete=models.SET_NULL, null=True, blank=True)
    symbol = models.CharField(max_length=24, db_index=True)
    title = models.CharField(max_length=180)
    message = models.TextField()
    observed_value = models.FloatField(null=True, blank=True)
    triggered_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-triggered_at"]

    def __str__(self):
        return f"{self.symbol}: {self.title}"

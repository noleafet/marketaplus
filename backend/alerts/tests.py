import base64
import json
from datetime import datetime as utc_datetime, timedelta, timezone as dt_timezone
from unittest.mock import ANY, patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .models import (
    Alert, AppConfiguration, Exchange, MarketEvent, Notification, PatternShot,
    TriggerEvent, WatchlistSymbol,
)
from .events import (
    CoinGeckoError, MarketEventError, base_coin_symbol, clear_coin_catalog_cache,
    coin_candidates, fetch_coin_events, normalize_impact, purge_market_events,
    resolve_coin_slug, store_events, sync_market_events,
)
from .patterns import (
    DETECTED_PATTERN_KEYS, best_pattern, detect_patterns, first_close_past, pattern_evaluate,
)
from .recovery import detect_events, macd_series, trend_signs
from .services import (
    _closed_bars, _ema, _macd_approach_thresholds, _notify,
    _trend_signal, _volume_percent, check_alerts, check_pattern_alerts,
    check_recovery_alerts, get_market_candles, get_market_quote,
)


class AlertApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_create_price_alert_normalizes_symbol(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "btcusdt", "kind": "price", "condition": "cross_up",
            "price": "65000", "frequency": "once",
        }, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["symbol"], "BTCUSDT")
        self.assertEqual(Alert.objects.count(), 1)


    def test_macd_requires_supported_timeframe_and_cross_condition(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "ETHUSDT", "kind": "macd", "condition": "above", "timeframe": "2h",
        }, format="json")
        self.assertEqual(response.status_code, 400)

    def test_alert_can_be_paused_and_deleted(self):
        alert = Alert.objects.create(symbol="BTCUSDT", kind="price", condition="above", price="1")
        response = self.client.patch(f"/api/alerts/{alert.id}/", {"active": False}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["active"])
        response = self.client.delete(f"/api/alerts/{alert.id}/")
        self.assertEqual(response.status_code, 204)

    def test_telegram_status_never_returns_credentials(self):
        configuration = AppConfiguration.load()
        notification = Notification.objects.create()
        notification.telegram_bot_token = "secret-token"
        notification.telegram_chat_id = "123456789"
        configuration.notification_enabled = True
        configuration.save()
        notification.save()

        response = self.client.get("/api/telegram/status/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"configured": True, "enabled": True, "chat_hint": "...6789"})
        self.assertNotIn("secret-token", str(response.data))

    @patch("alerts.services.telegram_request")
    def test_alert_delivery_requires_backend_telegram_enablement(self, send_message):
        configuration = AppConfiguration.load()
        notification = Notification.objects.create()
        notification.telegram_bot_token = "secret-token"
        notification.telegram_chat_id = "123456789"
        event = TriggerEvent(symbol="BTCUSDT", title="BTC alert", message="Target crossed")

        notification.save()
        _notify(event, configuration)
        send_message.assert_not_called()

        configuration.notification_enabled = True
        _notify(event, configuration)
        send_message.assert_called_once()

    @patch("alerts.services.telegram_request")
    def test_alert_delivery_sends_to_every_configured_destination(self, send_message):
        configuration = AppConfiguration.load()
        configuration.notification_enabled = True
        configuration.save()
        Notification.objects.create(telegram_bot_token="token-one", telegram_chat_id="111")
        Notification.objects.create(telegram_bot_token="token-two", telegram_chat_id="222")
        event = TriggerEvent(symbol="BTCUSDT", title="BTC alert", message="Target crossed")

        _notify(event, configuration)

        self.assertEqual(send_message.call_count, 2)
        self.assertEqual(
            {call.args[2]["chat_id"] for call in send_message.call_args_list},
            {"111", "222"},
        )

    @patch("alerts.services.telegram_request")
    def test_alert_delivery_formats_telegram_html(self, send_message):
        configuration = AppConfiguration.load()
        configuration.notification_enabled = True
        configuration.save()
        Notification.objects.create(telegram_bot_token="secret-token", telegram_chat_id="123")
        event = TriggerEvent(
            symbol="BTCUSDT",
            title="BTCUSDT(1h) MACD Crossed",
            message=(
                "Status: Bullish\nVolume: 150%\n"
                "Report: http://localhost:3000/report/?token=BTCUSDT&interval=1h"
            ),
        )

        _notify(event, configuration)

        payload = send_message.call_args.args[2]
        self.assertEqual(payload["parse_mode"], "HTML")
        self.assertIn("🔔 <b>BTCUSDT(1h) MACD Crossed</b>", payload["text"])
        self.assertIn("• <b>Status:</b> Bullish", payload["text"])
        self.assertIn("• <b>Volume:</b> 150%", payload["text"])
        self.assertIn(
            'See <a href="http://localhost:3000/report/?token=BTCUSDT&amp;interval=1h">'
            "full report</a>",
            payload["text"],
        )
        self.assertNotIn("Report:", payload["text"])
        self.assertNotIn("• See", payload["text"])

    @patch("alerts.services.telegram_request")
    def test_alert_delivery_escapes_html_in_dynamic_text(self, send_message):
        configuration = AppConfiguration.load()
        configuration.notification_enabled = True
        configuration.save()
        Notification.objects.create(telegram_bot_token="secret-token", telegram_chat_id="123")
        event = TriggerEvent(symbol="BTCUSDT", title="<b>Alert</b>", message="Note: 5 < 6 & 7 > 4")

        _notify(event, configuration)

        text = send_message.call_args.args[2]["text"]
        self.assertIn("<b>&lt;b&gt;Alert&lt;/b&gt;</b>", text)
        self.assertIn("• <b>Note:</b> 5 &lt; 6 &amp; 7 &gt; 4", text)

    def test_telegram_status_reports_multiple_configured_destinations(self):
        configuration = AppConfiguration.load()
        configuration.notification_enabled = True
        configuration.save()
        Notification.objects.create(telegram_bot_token="token-one", telegram_chat_id="1111")
        Notification.objects.create(telegram_bot_token="token-two", telegram_chat_id="2222")

        response = self.client.get("/api/telegram/status/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {
            "configured": True,
            "enabled": True,
            "chat_hint": "...1111, ...2222",
        })


class VolumePercentTests(SimpleTestCase):
    def test_volume_percent_compares_with_previous_twenty_candles(self):
        closed = [[0, 0, 0, 0, 1, 1, 0] for _ in range(20)]
        closed.append([0, 0, 0, 0, 1, 1.5, 0])

        self.assertEqual(_volume_percent(closed), 150)
        self.assertIsNone(_volume_percent(closed[:20]))


@override_settings(FRONTEND_URL="http://localhost:3000")
class MacdApproachTests(TestCase):
    def test_thresholds_are_reported_separately_and_only_once_per_approach(self):
        self.assertEqual(
            _macd_approach_thresholds(-0.2, -0.09, 20, 9, Alert.Condition.CROSS_UP, None),
            ([10], 10),
        )
        self.assertEqual(
            _macd_approach_thresholds(-0.09, -0.04, 9, 4, Alert.Condition.CROSS_UP, 10),
            ([5], 5),
        )
        # A wobble that widens the gap keeps the bands already reported...
        self.assertEqual(
            _macd_approach_thresholds(-0.04, -0.06, 4, 6, Alert.Condition.CROSS_UP, 5),
            ([], 5),
        )
        self.assertEqual(
            _macd_approach_thresholds(-0.06, -0.045, 6, 4.5, Alert.Condition.CROSS_UP, 5),
            ([], 5),
        )
        # ...until the lines drift well clear of every band, which re-arms them.
        self.assertEqual(
            _macd_approach_thresholds(-0.06, -0.2, 6, 20, Alert.Condition.CROSS_UP, 5),
            ([], None),
        )
        # A cross always starts the next approach fresh.
        self.assertEqual(
            _macd_approach_thresholds(-0.04, 0.02, 4, 2, Alert.Condition.CROSS_UP, 5),
            ([], None),
        )

    def test_approach_thresholds_follow_cross_direction(self):
        self.assertEqual(
            _macd_approach_thresholds(-0.2, -0.05, 20, 5, Alert.Condition.CROSS_DOWN, None),
            ([], None),
        )
        self.assertEqual(
            _macd_approach_thresholds(0.2, 0.05, 20, 5, Alert.Condition.CROSS_DOWN, None),
            ([10, 5], 5),
        )

    @patch("alerts.services._trend_signal", return_value=None)
    @patch("alerts.services._rsi_signal", return_value=None)
    @patch("alerts.services._macd_signal")
    def test_checker_creates_distinct_events_for_10_and_5_percent(self, macd_signal, _rsi_signal, _trend_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY,
            macd_threshold_5=True, macd_threshold_10=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
            last_macd_gap_percent=20,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": -0.09,
            "close": 100, "macd": 1, "signal": 1.09, "atr": 1,
        }

        check_alerts()

        warning = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(warning.title, "BTCUSDT(1m) MACD 10% Approach")
        self.assertIn("Status: Bullish", warning.message)
        self.assertIn("Distance: 9.00%", warning.message)
        self.assertIn("Current Price: $100.000", warning.message)
        self.assertIn("RSI (1m): –", warning.message)
        self.assertIn("EMA 100 (1h): –", warning.message)
        self.assertIn("Report: http://localhost:3000/report/?token=BTCUSDT&interval=1m&time=", warning.message)
        self.assertIn("subject=BTCUSDT%281m%29%20MACD%2010%25%20Approach", warning.message)
        alert.refresh_from_db()
        self.assertEqual(alert.last_macd_warning_threshold, 10)
        self.assertTrue(alert.active)

        macd_signal.return_value = {
            "bar_time": bar_time + timedelta(minutes=1), "previous_diff": -0.09,
            "current_diff": -0.04, "close": 100, "macd": 1, "signal": 1.04, "atr": 1,
        }
        check_alerts()

        warnings = list(TriggerEvent.objects.filter(alert=alert).order_by("id"))
        self.assertEqual(len(warnings), 2)
        self.assertEqual(warnings[1].title, "BTCUSDT(1m) MACD 5% Approach")
        self.assertIn("Distance: 4.00%", warnings[1].message)
        alert.refresh_from_db()
        self.assertEqual(alert.last_macd_warning_threshold, 5)
        self.assertTrue(alert.active)

    @patch("alerts.services._trend_signal")
    @patch("alerts.services._rsi_signal")
    @patch("alerts.services._macd_signal")
    def test_crossed_alert_uses_report_format(self, macd_signal, rsi_signal, trend_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="15m", frequency=Alert.Frequency.EVERY,
            last_bar_open_time=timezone.now() - timedelta(minutes=30),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=15)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 81567.344, "macd": 1, "signal": 0.9, "atr": 1,
            "volume_percent": 120.0,
        }
        rsi_signal.return_value = {"bar_time": bar_time, "rsi": 75, "close": 81567.344}
        trend_signal.return_value = {"bar_time": bar_time, "ema": 82645.64, "close": 81242.938, "trend": "downtrend"}

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(event.title, "BTCUSDT(15m) MACD Crossed")
        self.assertIn("Status: Bullish", event.message)
        self.assertNotIn("Distance:", event.message)
        self.assertIn("Current Price: $81,567.344", event.message)
        self.assertIn("RSI (15m): 75 Bullish", event.message)
        self.assertIn("EMA 100 (1h): 82,645.64 Bearish", event.message)
        self.assertIn("Volume: 120%", event.message)
        self.assertLess(event.message.index("Volume: 120%"), event.message.index("Report:"))
        self.assertIn("Report: http://localhost:3000/report/?token=BTCUSDT&interval=15m&time=", event.message)
        self.assertIn("subject=BTCUSDT%2815m%29%20MACD%20Crossed", event.message)


class TrendSignalTests(TestCase):
    def test_ema_is_seeded_with_sma_then_smoothed(self):
        # Seed = SMA(1, 2, 3) = 2; multiplier = 2 / (3 + 1) = 0.5.
        self.assertEqual(_ema([1, 2, 3, 4, 5], 3), 4)

    @patch("alerts.services._candles_for")
    def test_trend_signal_uses_ema(self, candles_for):
        closed_at = int(timezone.now().timestamp() * 1000) - 60_000
        candles_for.return_value = [
            [index, 0, 0, 0, close, 0, closed_at - (2 - index) * 60_000]
            for index, close in enumerate((10, 20, 30))
        ]

        trend = _trend_signal("BTCUSDT", "1m", ANY, 2)

        # Seed = SMA(10, 20) = 15; then 30 with multiplier 2/3 = 25.
        self.assertEqual(trend["ema"], 25)
        self.assertEqual(trend["trend"], "uptrend")


class TrendFilterTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_macd_alert_defaults_trend_period_to_100_ema(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "macd", "condition": "cross_up", "timeframe": "1h",
            "trend_enabled": True,
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["trend_enabled"])
        self.assertEqual(response.data["trend_period"], 100)

    def test_macd_alert_accepts_200_ema_option(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "macd", "condition": "cross_up", "timeframe": "1h",
            "trend_enabled": True, "trend_period": 200,
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["trend_period"], 200)

    def test_macd_alert_rejects_out_of_range_trend_period(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "macd", "condition": "cross_up", "timeframe": "1h",
            "trend_enabled": True, "trend_period": 1000,
        }, format="json")

        self.assertEqual(response.status_code, 400)
        self.assertIn("trend_period", response.data)

    def test_macd_alert_defaults_rsi_to_macd_timeframe_and_ema_to_one_hour(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "macd", "condition": "cross_up", "timeframe": "15m",
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["rsi_enabled"])
        self.assertTrue(response.data["trend_enabled"])
        self.assertEqual(response.data["rsi_timeframe"], "15m")
        self.assertEqual(response.data["trend_timeframe"], "1h")

    def test_macd_alert_accepts_custom_rsi_and_ema_timeframes(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "macd", "condition": "cross_up", "timeframe": "1h",
            "rsi_timeframe": "5m", "trend_timeframe": "4h",
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["rsi_timeframe"], "5m")
        self.assertEqual(response.data["trend_timeframe"], "4h")

    def test_macd_alert_rejects_unsupported_context_timeframes(self):
        for field in ("rsi_timeframe", "trend_timeframe"):
            with self.subTest(field=field):
                payload = {
                    "symbol": "BTCUSDT", "kind": "macd", "condition": "cross_up",
                    "timeframe": "1h",
                }
                payload[field] = "2h"
                response = self.client.post("/api/alerts/", payload, format="json")

                self.assertEqual(response.status_code, 400)
                self.assertIn(field, response.data)

    def test_changing_macd_timeframe_moves_default_rsi_but_not_custom_rsi(self):
        client = APIClient()
        response = client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "macd", "condition": "cross_up", "timeframe": "1h",
        }, format="json")
        alert_id = response.data["id"]

        response = client.patch(
            f"/api/alerts/{alert_id}/", {"timeframe": "4h"}, format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["rsi_timeframe"], "4h")

        response = client.post("/api/alerts/", {
            "symbol": "ETHUSDT", "kind": "macd", "condition": "cross_up", "timeframe": "1h",
            "rsi_timeframe": "5m", "trend_timeframe": "4h",
        }, format="json")
        alert_id = response.data["id"]

        response = client.patch(
            f"/api/alerts/{alert_id}/", {"timeframe": "15m"}, format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["rsi_timeframe"], "5m")
        self.assertEqual(response.data["trend_timeframe"], "4h")

    @patch("alerts.services._rsi_signal", return_value=None)
    @patch("alerts.services._trend_signal")
    @patch("alerts.services._macd_signal")
    def test_trend_info_is_included_in_macd_cross(self, macd_signal, trend_signal, _rsi_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, trend_enabled=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        self.assertEqual(alert.trend_period, 100)
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 100, "macd": 1, "signal": 0.9, "atr": 1,
        }
        trend_signal.return_value = {
            "bar_time": bar_time, "ema": 95, "close": 100, "trend": "uptrend",
        }

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(event.title, "BTCUSDT(1m) MACD Crossed")
        self.assertIn("EMA 100 (1h): 95.00 Bullish", event.message)
        trend_signal.assert_called_once_with("BTCUSDT", "1h", ANY, 100)

    @patch("alerts.services._rsi_signal")
    @patch("alerts.services._trend_signal")
    @patch("alerts.services._macd_signal")
    def test_macd_context_uses_configured_timeframes(self, macd_signal, trend_signal, rsi_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="15m", rsi_timeframe="5m", trend_timeframe="4h",
            frequency=Alert.Frequency.EVERY,
            last_bar_open_time=timezone.now() - timedelta(minutes=30),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=15)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 100, "macd": 1, "signal": 0.9, "atr": 1,
        }
        rsi_signal.return_value = {"bar_time": bar_time, "rsi": 75, "close": 100}
        trend_signal.return_value = {
            "bar_time": bar_time, "ema": 95, "close": 100, "trend": "uptrend",
        }

        check_alerts()

        rsi_signal.assert_called_once_with("BTCUSDT", "5m", ANY, 14)
        trend_signal.assert_called_once_with("BTCUSDT", "4h", ANY, 100)
        event = TriggerEvent.objects.get(alert=alert)
        self.assertIn("RSI (5m): 75 Bullish", event.message)
        self.assertIn("EMA 100 (4h): 95.00 Bullish", event.message)

    @patch("alerts.services._rsi_signal", return_value=None)
    @patch("alerts.services._trend_signal")
    @patch("alerts.services._macd_signal")
    def test_trend_info_fires_even_when_price_below_ema(self, macd_signal, trend_signal, _rsi_signal):
        """The trend value only adds info — it must never suppress the MACD alert."""
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, trend_enabled=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 100, "macd": 1, "signal": 0.9, "atr": 1,
        }
        trend_signal.return_value = {
            "bar_time": bar_time, "ema": 105, "close": 100, "trend": "downtrend",
        }

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(event.title, "BTCUSDT(1m) MACD Crossed")
        self.assertIn("EMA 100 (1h): 105.00 Bearish", event.message)

    @patch("alerts.services._rsi_signal", return_value=None)
    @patch("alerts.services._trend_signal")
    @patch("alerts.services._macd_signal")
    def test_trend_classified_balanced_within_ema_tolerance(self, macd_signal, trend_signal, _rsi_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, trend_enabled=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 100, "macd": 1, "signal": 0.9, "atr": 1,
        }
        trend_signal.return_value = {
            "bar_time": bar_time, "ema": 100.05, "close": 100, "trend": "downtrend",
        }

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(event.title, "BTCUSDT(1m) MACD Crossed")
        self.assertIn("EMA 100 (1h): 100.05 Bearish-Balanced", event.message)

    @patch("alerts.services._rsi_signal", return_value=None)
    @patch("alerts.services._trend_signal")
    @patch("alerts.services._macd_signal")
    def test_trend_failure_does_not_stop_macd_alert(self, macd_signal, trend_signal, _rsi_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, trend_enabled=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 100, "macd": 1, "signal": 0.9, "atr": 1,
        }
        trend_signal.return_value = None

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(event.title, "BTCUSDT(1m) MACD Crossed")
        self.assertIn("EMA 100 (1h): –", event.message)


class RsiFilterInfoTests(TestCase):
    def _cross_setup(self, rsi_value):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, rsi_enabled=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        return alert, bar_time

    def _macd_return(self, bar_time):
        return {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 100, "macd": 1, "signal": 0.9, "atr": 1,
        }

    @patch("alerts.services._trend_signal", return_value=None)
    @patch("alerts.services._rsi_signal")
    @patch("alerts.services._macd_signal")
    def test_rsi_info_classified_bullish_bearish_balanced(self, macd_signal, rsi_signal, _trend_signal):
        for rsi_value, expected_state in (
            (78, "Bullish"),
            (22, "Bearish"),
            (55, "Bullish-Balanced"),
            (45, "Bearish-Balanced"),
        ):
            with self.subTest(rsi_value=rsi_value):
                TriggerEvent.objects.all().delete()
                Alert.objects.all().delete()
                alert, bar_time = self._cross_setup(rsi_value)
                macd_signal.return_value = self._macd_return(bar_time)
                rsi_signal.return_value = {
                    "bar_time": bar_time, "rsi": rsi_value, "close": 100,
                }

                check_alerts()

                event = TriggerEvent.objects.get(alert=alert)
                self.assertEqual(event.title, "BTCUSDT(1m) MACD Crossed")
                self.assertIn(f"RSI (1m): {rsi_value} {expected_state}", event.message)

    @patch("alerts.services._trend_signal", return_value=None)
    @patch("alerts.services._rsi_signal")
    @patch("alerts.services._macd_signal")
    def test_rsi_info_respects_custom_levels(self, macd_signal, rsi_signal, _trend_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, rsi_enabled=True,
            rsi_period=14, rsi_oversold=45, rsi_overbought=55,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = self._macd_return(bar_time)
        rsi_signal.return_value = {"bar_time": bar_time, "rsi": 50, "close": 100}

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(event.title, "BTCUSDT(1m) MACD Crossed")
        self.assertIn("RSI (1m): 50 Bullish-Balanced", event.message)

    @patch("alerts.services._trend_signal", return_value=None)
    @patch("alerts.services._rsi_signal")
    @patch("alerts.services._macd_signal")
    def test_rsi_failure_does_not_stop_macd_alert(self, macd_signal, rsi_signal, _trend_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, rsi_enabled=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = self._macd_return(bar_time)
        rsi_signal.return_value = None

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(event.title, "BTCUSDT(1m) MACD Crossed")
        self.assertIn("RSI (1m): –", event.message)


class TelegramAdminTests(TestCase):
    def setUp(self):
        self.notification = Notification.objects.create()
        self.user = get_user_model().objects.create_superuser("admin", "admin@example.test", "password")
        self.client.force_login(self.user)

    @override_settings(STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    })
    def test_configuration_form_exposes_backend_telegram_actions(self):
        response = self.client.get(f"/admin/alerts/notification/{self.notification.pk}/change/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Find my Telegram chat ID")
        self.assertContains(response, "Send test Telegram message")

    @patch("alerts.admin.find_telegram_chat")
    def test_admin_chat_lookup_saves_chat_id(self, find_chat):
        find_chat.return_value = {"id": 512345678, "first_name": "Trader"}

        response = self.client.post(f"/admin/alerts/notification/{self.notification.pk}/find-chat/")

        self.notification.refresh_from_db()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.notification.telegram_chat_id, "512345678")

    @patch("alerts.admin.find_telegram_chat")
    def test_admin_chat_lookup_uses_entered_token(self, find_chat):
        find_chat.return_value = {"id": 512345678, "first_name": "Trader"}

        response = self.client.post(f"/admin/alerts/notification/{self.notification.pk}/change/", {
            "telegram_bot_token": "new-token",
            "telegram_chat_id": "",
            "_find_chat": "1",
        })

        self.notification.refresh_from_db()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.notification.telegram_bot_token, "new-token")
        self.assertEqual(self.notification.telegram_chat_id, "512345678")
        find_chat.assert_called_once()
        self.assertEqual(find_chat.call_args.args[0].telegram_bot_token, "new-token")

    def test_non_staff_cannot_use_telegram_admin_actions(self):
        self.client.logout()

        response = self.client.post(f"/admin/alerts/notification/{self.notification.pk}/test-message/")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin/login/", response.url)

    @patch("alerts.admin.send_telegram_test")
    def test_admin_test_message_uses_backend_service(self, send_test):
        response = self.client.post(f"/admin/alerts/notification/{self.notification.pk}/test-message/")

        self.assertEqual(response.status_code, 302)
        send_test.assert_called_once_with(self.notification)


class TelegramTestApiTests(TestCase):
    def setUp(self):
        self.notification = Notification.objects.create()
        self.notification.telegram_bot_token = "server-only-token"
        self.notification.telegram_chat_id = "512345678"
        self.notification.save()
        self.client = APIClient(enforce_csrf_checks=True)

    @override_settings(DEBUG=False, CSRF_TRUSTED_ORIGINS=["https://tca.noleafet.blitz.cloud"])
    @patch("alerts.views.send_telegram_test")
    def test_any_user_can_send_test_message_with_csrf(self, send_test):
        csrf = self.client.get("/api/telegram/csrf/")
        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "adhoc-token", "chat_id": "987654321"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"], HTTP_ORIGIN="https://tca.noleafet.blitz.cloud",
        )

        self.assertEqual(csrf.status_code, 200)
        self.assertEqual(response.status_code, 200)
        send_test.assert_called_once()
        self.assertIsInstance(send_test.call_args.args[0], Notification)
        self.assertIsNone(send_test.call_args.args[0].pk)
        self.assertEqual(send_test.call_args.kwargs, {"token": "adhoc-token", "chat_id": "987654321"})
        self.notification.refresh_from_db()
        self.assertEqual(self.notification.telegram_bot_token, "server-only-token")
        self.assertEqual(self.notification.telegram_chat_id, "512345678")

    @override_settings(DEBUG=False)
    @patch("alerts.services.requests.post")
    def test_test_message_reports_telegram_rejection(self, post):
        post.return_value.json.return_value = {"ok": False, "description": "Unauthorized"}
        csrf = self.client.get("/api/telegram/csrf/")

        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "invalid-token", "chat_id": "987654321"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"],
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {"detail": "Unauthorized"})

    def test_test_message_requires_csrf_without_a_session(self):
        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "adhoc-token", "chat_id": "987654321"}, format="json",
        )

        self.assertEqual(response.status_code, 403)

    @override_settings(DEBUG=False, CSRF_TRUSTED_ORIGINS=["https://tca.noleafet.blitz.cloud"])
    @patch("alerts.views.find_telegram_chat")
    def test_any_user_can_find_chat_without_admin_session(self, find_chat):
        find_chat.return_value = {"id": 987654321, "first_name": "Ad hoc"}
        csrf = self.client.get("/api/telegram/csrf/")

        response = self.client.post(
            "/api/telegram/find-chat/", {"bot_token": "adhoc-token"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"], HTTP_ORIGIN="https://tca.noleafet.blitz.cloud",
        )

        self.assertEqual(csrf.status_code, 200)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"chat_id": "987654321", "chat_name": "Ad hoc"})
        find_chat.assert_called_once()
        self.assertIsInstance(find_chat.call_args.args[0], Notification)
        self.assertIsNone(find_chat.call_args.args[0].pk)
        self.assertEqual(find_chat.call_args.kwargs, {"token": "adhoc-token"})

    @patch("alerts.views.send_telegram_test")
    def test_staff_can_send_test_message_with_csrf(self, send_test):
        user = get_user_model().objects.create_superuser("api-admin", "api-admin@example.test", "password")
        self.client.force_login(user)
        csrf = self.client.get("/api/telegram/csrf/")

        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "adhoc-token", "chat_id": "987654321"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"],
        )

        self.assertEqual(csrf.status_code, 200)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"detail": "Test message sent."})
        send_test.assert_called_once()
        self.assertIsInstance(send_test.call_args.args[0], Notification)
        self.assertIsNone(send_test.call_args.args[0].pk)
        self.assertEqual(send_test.call_args.kwargs, {"token": "adhoc-token", "chat_id": "987654321"})
        self.notification.refresh_from_db()
        self.assertEqual(self.notification.telegram_bot_token, "server-only-token")
        self.assertEqual(self.notification.telegram_chat_id, "512345678")

    @patch("alerts.views.find_telegram_chat")
    def test_staff_can_find_chat_with_unsaved_token(self, find_chat):
        user = get_user_model().objects.create_superuser("chat-admin", "chat-admin@example.test", "password")
        self.client.force_login(user)
        csrf = self.client.get("/api/telegram/csrf/")
        find_chat.return_value = {"id": 987654321, "first_name": "Ad hoc"}

        response = self.client.post(
            "/api/telegram/find-chat/", {"bot_token": "adhoc-token"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"chat_id": "987654321", "chat_name": "Ad hoc"})
        find_chat.assert_called_once()
        self.assertIsInstance(find_chat.call_args.args[0], Notification)
        self.assertIsNone(find_chat.call_args.args[0].pk)
        self.assertEqual(find_chat.call_args.kwargs, {"token": "adhoc-token"})
        self.notification.refresh_from_db()
        self.assertEqual(self.notification.telegram_bot_token, "server-only-token")


class AppConfigurationTests(TestCase):
    def test_load_uses_database_configuration(self):
        configuration = AppConfiguration.load()
        self.assertEqual(configuration.pk, 1)
        self.assertEqual(configuration.alert_poll_seconds, 5)

        exchange = Exchange.load()
        self.assertEqual(exchange.exchange_url, "https://data-api.binance.vision/api/v3")
        self.assertEqual(exchange.exchange_timeout, 10)
        exchange.exchange_url = "https://example.test/api"
        exchange.exchange_timeout = 4
        configuration.alert_poll_seconds = 2
        exchange.save()
        configuration.save()
        reloaded = AppConfiguration.load()
        reloaded_exchange = Exchange.load()
        self.assertEqual(reloaded_exchange.exchange_url, "https://example.test/api")
        self.assertEqual(reloaded_exchange.exchange_timeout, 4)
        self.assertEqual(reloaded.alert_poll_seconds, 2)


class ExchangeSelectionApiTests(TestCase):
    def test_binance_is_the_default_and_exchange_selection_persists(self):
        response = APIClient().get("/api/exchange/")
        self.assertEqual(response.data, {"exchange": "binance", "options": ["binance", "bybit"]})

        response = APIClient().post("/api/exchange/", {"exchange": "bybit"}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["exchange"], "bybit")
        self.assertEqual(Exchange.load().exchange, "bybit")


class WatchlistApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        clear_coin_catalog_cache()
        # Never reach CoinGecko from tests: lookups see an empty catalog and no ranking
        # unless a test supplies its own with its own patch.
        for name, value in (
            ("_fetch_coin_catalog", {}),
            ("_fetch_market_cap_ranks", {}),
        ):
            patcher = patch(f"alerts.events.{name}", return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(clear_coin_catalog_cache)

    def test_migration_seeds_current_watchlist_symbols(self):
        response = self.client.get("/api/watchlist/")
        self.assertEqual([item["symbol"] for item in response.data], [
            "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
        ])

    def test_watchlist_symbols_can_be_added_and_removed(self):
        response = self.client.post("/api/watchlist/", {"symbol": "adausdt"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["symbol"], "ADAUSDT")

        response = self.client.delete("/api/watchlist/ADAUSDT/")
        self.assertEqual(response.status_code, 204)
        self.assertFalse(WatchlistSymbol.objects.filter(symbol="ADAUSDT").exists())

    def test_admin_session_does_not_require_a_csrf_token_to_save(self):
        # An admin session cookie used to trigger DRF's session CSRF check on every write,
        # failing the dashboard with "CSRF Failed: CSRF token missing."
        user = get_user_model().objects.create_user("admin", password="secret", is_staff=True)
        self.client.force_login(user)

        response = self.client.post("/api/watchlist/", {"symbol": "LINKUSDT"}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(WatchlistSymbol.objects.filter(symbol="LINKUSDT").exists())

    def test_watchlist_lists_the_cached_slug(self):
        WatchlistSymbol.objects.filter(symbol="BTCUSDT").update(slug="bitcoin")

        response = self.client.get("/api/watchlist/")

        self.assertEqual(response.status_code, 200)
        btc = next(item for item in response.data if item["symbol"] == "BTCUSDT")
        self.assertEqual(btc["slug"], "bitcoin")

    @patch("alerts.events._fetch_coin_catalog")
    def test_slug_endpoint_resolves_and_saves(self, coin_catalog):
        coin_catalog.return_value = {"btc": ["bitcoin"]}

        response = self.client.post("/api/watchlist/BTCUSDT/slug/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"symbol": "BTCUSDT", "slug": "bitcoin"})
        self.assertEqual(WatchlistSymbol.objects.get(symbol="BTCUSDT").slug, "bitcoin")

    def test_slug_endpoint_needs_no_provider_credentials(self):
        with patch("alerts.events._fetch_coin_catalog", return_value={"btc": ["bitcoin"]}):
            response = self.client.post("/api/watchlist/BTCUSDT/slug/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["slug"], "bitcoin")

    def test_slug_endpoint_rejects_unknown_pairs(self):
        response = self.client.post("/api/watchlist/DOGEUSDT/slug/")

        self.assertEqual(response.status_code, 404)

    @patch("alerts.events._fetch_coin_catalog")
    def test_slug_endpoint_reports_pairs_without_a_match(self, coin_catalog):
        coin_catalog.return_value = {}

        response = self.client.post("/api/watchlist/BTCUSDT/slug/")

        self.assertEqual(response.status_code, 404)

    @patch("alerts.events._fetch_coin_catalog")
    def test_slug_endpoint_reports_provider_errors(self, coin_catalog):
        coin_catalog.side_effect = CoinGeckoError("CoinGecko request failed")

        response = self.client.post("/api/watchlist/BTCUSDT/slug/")

        self.assertEqual(response.status_code, 502)

    @patch("alerts.events.resolve_coin_slug")
    @patch("alerts.events.fetch_coin_events")
    def test_adding_a_watchlist_symbol_resolves_its_slug(self, scrape_events, resolve_slug):
        resolve_slug.side_effect = (
            lambda symbol, **kwargs: "cardano" if symbol == "ADAUSDT" else ""
        )
        scrape_events.return_value = []

        response = self.client.post("/api/watchlist/", {"symbol": "adausdt"}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["slug"], "cardano")
        self.assertEqual(WatchlistSymbol.objects.get(symbol="ADAUSDT").slug, "cardano")


class PatternShotApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        # Smallest valid PNG: a 1x1 transparent pixel.
        self.png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
        )

    def upload(self, **overrides):
        payload = {
            "symbol": "btcusdt", "pattern": "head_and_shoulders", "timeframe": "1h",
            "summary": "Head and Shoulders over 48 bars.", "image": base64.b64encode(self.png).decode(),
        }
        payload.update(overrides)
        return self.client.post("/api/pattern-shots/", payload, format="json")

    def test_upload_stores_a_picture_and_returns_its_url(self):
        response = self.upload()

        self.assertEqual(response.status_code, 201)
        shot = PatternShot.objects.get()
        self.assertEqual(shot.symbol, "BTCUSDT")
        self.assertEqual(shot.pattern, "head_and_shoulders")
        self.assertEqual(response.data["image_url"], f"/api/pattern-shots/{shot.pk}/image/")
        self.assertEqual(response.data["size"], len(self.png))
        # The bytes themselves must never travel back to the browser.
        self.assertNotIn("image", response.data)

    def test_upload_accepts_a_canvas_data_url(self):
        response = self.upload(image=f"data:image/png;base64,{base64.b64encode(self.png).decode()}")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(PatternShot.objects.get().image, self.png)

    def test_upload_rejects_unknown_patterns_and_non_png_data(self):
        self.assertEqual(self.upload(pattern="cup_and_handle").status_code, 400)
        self.assertEqual(self.upload(timeframe="2h").status_code, 400)
        self.assertEqual(self.upload(image=base64.b64encode(b"not-a-png").decode()).status_code, 400)

    def test_only_the_newest_ten_pictures_per_symbol_are_kept(self):
        for index in range(12):
            self.assertEqual(self.upload(summary=f"picture {index}").status_code, 201)

        self.assertEqual(PatternShot.objects.filter(symbol="BTCUSDT").count(), 10)
        self.assertEqual(PatternShot.objects.filter(symbol="BTCUSDT").first().summary, "picture 11")

    def test_clear_removes_every_picture_for_one_symbol_only(self):
        self.upload(symbol="btcusdt")
        self.upload(symbol="BTCUSDT")
        self.upload(symbol="ethusdt")

        response = self.client.delete("/api/pattern-shots/?symbol=btcusdt")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["symbol"], "BTCUSDT")
        self.assertEqual(response.data["deleted"], 2)
        # Other pairs on the watchlist keep their pictures.
        self.assertEqual(PatternShot.objects.filter(symbol="ETHUSDT").count(), 1)
        self.assertEqual(self.client.get("/api/pattern-shots/?symbol=BTCUSDT").data, [])

    def test_clear_requires_a_symbol_so_nothing_is_wiped_by_accident(self):
        self.upload(symbol="btcusdt")

        self.assertEqual(self.client.delete("/api/pattern-shots/").status_code, 400)
        self.assertEqual(PatternShot.objects.count(), 1)
        self.assertFalse(PatternShot.objects.filter(summary="picture 0").exists())

    def test_retention_is_per_symbol(self):
        self.upload()
        for _ in range(11):
            self.upload(symbol="ETHUSDT", pattern="bull_flag")

        self.assertEqual(PatternShot.objects.filter(symbol="BTCUSDT").count(), 1)
        self.assertEqual(PatternShot.objects.filter(symbol="ETHUSDT").count(), 10)

    def test_list_can_be_filtered_by_symbol(self):
        self.upload(pattern="bull_flag")
        self.upload(symbol="ETHUSDT", pattern="bear_flag")

        response = self.client.get("/api/pattern-shots/?symbol=ETHUSDT")

        self.assertEqual(response.status_code, 200)
        self.assertEqual([shot["symbol"] for shot in response.data], ["ETHUSDT"])

    def test_candlestick_pictures_use_their_own_category(self):
        response = self.upload(category="candlestick", pattern="hammer", summary="Hammer")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["category"], "candlestick")
        self.assertEqual(PatternShot.objects.get().category, "candlestick")

    def test_candlestick_pictures_accept_the_reversal_patterns(self):
        for pattern in ("three_bar_reversal", "piercing_line", "dark_cloud_cover", "shooting_star"):
            with self.subTest(pattern=pattern):
                response = self.upload(category="candlestick", pattern=pattern)
                self.assertEqual(response.status_code, 201)
                self.assertEqual(response.data["pattern"], pattern)

    def test_each_category_only_accepts_its_own_patterns(self):
        self.assertEqual(self.upload(category="candlestick", pattern="head_and_shoulders").status_code, 400)
        self.assertEqual(self.upload(category="chart", pattern="hammer").status_code, 400)
        self.assertEqual(self.upload(category="other", pattern="hammer").status_code, 400)

    def test_list_and_clear_are_scoped_to_one_category(self):
        self.upload(symbol="btcusdt", pattern="bull_flag")
        self.upload(symbol="btcusdt", pattern="hammer", category="candlestick")

        response = self.client.get("/api/pattern-shots/?symbol=BTCUSDT&category=candlestick")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([shot["pattern"] for shot in response.data], ["hammer"])
        # A plain list still means the chart-pattern tab.
        response = self.client.get("/api/pattern-shots/?symbol=BTCUSDT")
        self.assertEqual([shot["pattern"] for shot in response.data], ["bull_flag"])

        response = self.client.delete("/api/pattern-shots/?symbol=BTCUSDT&category=candlestick")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["deleted"], 1)
        self.assertEqual(PatternShot.objects.filter(category="chart").count(), 1)
        self.assertFalse(PatternShot.objects.filter(category="candlestick").exists())

    def test_retention_is_per_symbol_and_category(self):
        for index in range(11):
            self.upload(symbol="BTCUSDT", pattern="bull_flag", summary=f"chart {index}")
        for index in range(3):
            self.upload(
                symbol="BTCUSDT", category="candlestick", pattern="hammer",
                summary=f"candle {index}",
            )

        self.assertEqual(PatternShot.objects.filter(category="chart").count(), 10)
        self.assertEqual(PatternShot.objects.filter(category="candlestick").count(), 3)

    def test_picture_bytes_are_streamed_from_the_api(self):
        shot = PatternShot.store(
            symbol="BTCUSDT", pattern="bull_flag", timeframe="1h", image=self.png, summary="Pole",
        )

        response = self.client.get(f"/api/pattern-shots/{shot.pk}/image/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")
        self.assertEqual(response.content, self.png)

    def test_picture_can_be_deleted(self):
        shot = PatternShot.objects.create(
            symbol="BTCUSDT", pattern="bull_flag", timeframe="1h", image=self.png,
        )

        response = self.client.delete(f"/api/pattern-shots/{shot.pk}/")

        self.assertEqual(response.status_code, 204)
        self.assertFalse(PatternShot.objects.exists())


class MarketAdapterTests(TestCase):
    def setUp(self):
        self.exchange = Exchange.load()

    @patch("alerts.services.requests.get")
    def test_bybit_quote_is_normalized(self, get):
        self.exchange.exchange = Exchange.Name.BYBIT
        get.return_value.json.return_value = {
            "retCode": 0,
            "result": {"list": [{"lastPrice": "100.5", "price24hPcnt": "0.025"}]},
        }

        quote = get_market_quote("BTCUSDT", self.exchange)

        self.assertEqual(quote, {"price": 100.5, "change": 2.5})

    @patch("alerts.services.requests.get")
    def test_bybit_candles_are_normalized_in_chronological_order(self, get):
        self.exchange.exchange = Exchange.Name.BYBIT
        get.return_value.json.return_value = {
            "retCode": 0,
            "result": {"list": [
                ["2000", "2", "3", "1", "2.5", "20", "5"],
                ["1000", "1", "2", "0.5", "1.5", "10", "3"],
            ]},
        }

        candles = get_market_candles("BTCUSDT", "1m", self.exchange, 2)

        self.assertEqual([candle["time"] for candle in candles], [1, 2])
        self.assertEqual(candles[0]["close"], 1.5)


class MarketEventTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        clear_coin_catalog_cache()
        for name, value in (
            ("_fetch_coin_catalog", {}),
            ("_fetch_market_cap_ranks", {}),
        ):
            patcher = patch(f"alerts.events.{name}", return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(clear_coin_catalog_cache)

    def test_coin_candidates_strip_quote_and_size_prefix(self):
        self.assertEqual(base_coin_symbol("btcusdt"), "BTC")
        self.assertEqual(base_coin_symbol("1000SHIBUSDT"), "1000SHIB")
        self.assertIn("btc", coin_candidates("BTCUSDT"))
        self.assertIn("shib", coin_candidates("1000SHIBUSDT"))
        self.assertIn("babydoge", coin_candidates("1MBABYDOGEUSDT"))

    def _scraped_event(self, **overrides):
        days = overrides.pop("days", 2)
        moment = timezone.now() + timedelta(days=days)
        event = {
            "id": 1001,
            "title": "Bitcoin upgrade",
            "description": "Node operators upgrade before the fork.",
            "impactScore": 8,
            "impactSummary": "A network upgrade moves the whole market.",
            "link": "https://x.com/bitcoin/status/1",
            "slug": "bitcoin-upgrade-1001",
            "dateEvent": "$D" + moment.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "dateEventTo": None,
            "dateEventDisplayed": "27 Oct 2026",
            "dateType": False,
            "dateTypeSelected": "date",
            "coins": [{"id": "bitcoin", "symbol": "btc"}],
            "categories": [{"id": 1, "name": "Release"}, {"id": 7, "name": "Other"}],
        }
        event.update(overrides)
        return event

    def _page_with_payload(self, *payloads):
        chunks = "".join(
            f"<script>self.__next_f.push([1,{json.dumps(payload)}])</script>"
            for payload in payloads
        )
        return f"<html><body>{chunks}</body></html>"

    def test_impact_score_thresholds(self):
        self.assertEqual(normalize_impact(8.0), (MarketEvent.Impact.CRITICAL, 8.0))
        self.assertEqual(normalize_impact(7.9), (MarketEvent.Impact.HIGH, 7.9))
        self.assertEqual(normalize_impact(5), (MarketEvent.Impact.HIGH, 5.0))
        self.assertEqual(normalize_impact(4.9), (MarketEvent.Impact.LOW, 4.9))
        self.assertEqual(normalize_impact(None), (MarketEvent.Impact.UNKNOWN, None))
        self.assertEqual(normalize_impact("n/a"), (MarketEvent.Impact.UNKNOWN, None))

    def test_fetch_coin_events_keeps_only_upcoming_events(self):
        upcoming = [self._scraped_event()]
        past = [self._scraped_event(id=2002, days=-3)]
        html = self._page_with_payload(
            "0:" + json.dumps({"events": upcoming}),
            "1:" + json.dumps({"events": past}),
        )

        with patch("alerts.events._fetch_coin_page", return_value=html):
            events = fetch_coin_events("bitcoin")

        self.assertEqual([event["id"] for event in events], [1001])

    def test_fetch_coin_events_accepts_an_empty_calendar(self):
        html = self._page_with_payload('0:{"events":[]}')

        with patch("alerts.events._fetch_coin_page", return_value=html):
            self.assertEqual(fetch_coin_events("bitcoin"), [])

    def test_fetch_coin_events_rejects_a_page_without_event_data(self):
        with patch("alerts.events._fetch_coin_page", return_value="<html></html>"):
            with self.assertRaises(MarketEventError):
                fetch_coin_events("bitcoin")

    def test_store_events_writes_the_scraped_fields(self):
        self.assertEqual(store_events("BTCUSDT", "bitcoin", [self._scraped_event()]), 1)

        row = MarketEvent.objects.get()
        self.assertEqual(row.external_id, "1001")
        self.assertEqual(row.coin_symbol, "btc")
        self.assertEqual(row.title, "Bitcoin upgrade")
        self.assertEqual(row.impact, MarketEvent.Impact.CRITICAL)
        self.assertEqual(row.impact_score, 8.0)
        self.assertEqual(row.impact_summary, "A network upgrade moves the whole market.")
        self.assertEqual(row.categories, ["Release", "Other"])
        self.assertEqual(row.source_url, "https://x.com/bitcoin/status/1")
        self.assertEqual(row.displayed_date, "27 Oct 2026")
        self.assertFalse(row.is_estimated)

    def test_store_events_marks_inexact_dates_as_estimated(self):
        store_events("BTCUSDT", "bitcoin", [
            self._scraped_event(id=3003, dateType=True, dateTypeSelected="quarter"),
        ])

        self.assertTrue(MarketEvent.objects.get().is_estimated)

    def test_store_events_skips_past_and_incomplete_rows(self):
        self.assertEqual(store_events("BTCUSDT", "bitcoin", [
            self._scraped_event(id=2002, days=-3),
            self._scraped_event(id=2003, title=""),
            self._scraped_event(id=2004, dateEvent=None),
        ]), 0)
        self.assertEqual(MarketEvent.objects.count(), 0)

    def test_purge_removes_past_rows(self):
        symbol = "BTCUSDT"
        past = MarketEvent.objects.create(
            external_id="past", symbol=symbol, title="Past",
            date=timezone.now() - timedelta(days=2), impact=MarketEvent.Impact.HIGH,
        )
        future = MarketEvent.objects.create(
            external_id="future", symbol=symbol, title="Future",
            date=timezone.now() + timedelta(days=2), impact=MarketEvent.Impact.LOW,
        )

        purged = purge_market_events(symbols=[symbol])

        self.assertEqual(purged["past"], 1)
        self.assertEqual(purged["removed_unknown_symbols"], 0)
        self.assertFalse(MarketEvent.objects.filter(pk=past.pk).exists())
        self.assertTrue(MarketEvent.objects.filter(pk=future.pk).exists())

    def test_purge_removes_rows_for_symbols_no_longer_watched(self):
        MarketEvent.objects.create(
            external_id="gone", symbol="GONEUSDT", title="Gone",
            date=timezone.now() + timedelta(days=2), impact=MarketEvent.Impact.HIGH,
        )

        purged = purge_market_events()

        self.assertEqual(purged["removed_unknown_symbols"], 1)
        self.assertFalse(MarketEvent.objects.filter(symbol="GONEUSDT").exists())

    def test_events_endpoint_filters_by_symbol(self):
        now = timezone.now()
        MarketEvent.objects.create(
            external_id="btc-event", symbol="BTCUSDT", title="Bitcoin upgrade",
            date=now, impact=MarketEvent.Impact.HIGH,
        )
        MarketEvent.objects.create(
            external_id="eth-event", symbol="ETHUSDT", title="Ethereum upgrade",
            date=now, impact=MarketEvent.Impact.HIGH,
        )

        response = self.client.get("/api/market/events/?symbol=btcusdt")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["title"], "Bitcoin upgrade")

    @patch("alerts.views.resolve_watchlist_slug", return_value="bitcoin")
    @patch("alerts.views.sync_symbol_events")
    def test_adding_a_watchlist_symbol_triggers_an_event_sync(self, sync_events, _resolve):
        response = self.client.post("/api/watchlist/", {"symbol": "btcusdt"}, format="json")

        self.assertEqual(response.status_code, 200)
        sync_events.assert_called_once_with("BTCUSDT")

    @patch("alerts.events.resolve_coin_slug")
    @patch("alerts.events.fetch_coin_events")
    def test_sync_scrapes_upcoming_events_for_each_slugged_pair(
        self, scrape_events, resolve_slug,
    ):
        resolve_slug.side_effect = (
            lambda symbol: "bitcoin" if symbol == "BTCUSDT" else ""
        )
        # Migration 0004 seeds a few default pairs, including BTCUSDT.
        watch, _created = WatchlistSymbol.objects.get_or_create(symbol="BTCUSDT")
        scrape_events.return_value = [self._scraped_event()]

        summary = sync_market_events()

        self.assertEqual(summary["status"], "ok")
        self.assertEqual(summary["upcoming"], 1)
        self.assertEqual(summary["synced"], 1)
        self.assertEqual(summary["failed"], [])
        scrape_events.assert_called_once_with("bitcoin")
        self.assertEqual(MarketEvent.objects.get(symbol="BTCUSDT").title, "Bitcoin upgrade")
        watch.refresh_from_db()
        self.assertEqual(watch.slug, "bitcoin")

    @patch("alerts.events.resolve_coin_slug")
    @patch("alerts.events.fetch_coin_events")
    def test_sync_reports_scrape_failures(self, scrape_events, resolve_slug):
        resolve_slug.side_effect = (
            lambda symbol: "bitcoin" if symbol == "BTCUSDT" else ""
        )
        WatchlistSymbol.objects.get_or_create(symbol="BTCUSDT")
        scrape_events.side_effect = MarketEventError("CoinMarketCal request failed")

        summary = sync_market_events()

        self.assertEqual(summary["status"], "failed")
        self.assertEqual(summary["synced"], 0)
        self.assertEqual(summary["failed"], ["BTCUSDT"])

    @patch("alerts.events.resolve_coin_slug", return_value="")
    def test_sync_skips_pairs_without_a_coin_slug(self, _resolve_slug):
        summary = sync_market_events(symbols=["BTCUSDT"])

        self.assertEqual(summary["status"], "ok")
        self.assertEqual(summary["synced"], 0)
        self.assertEqual(summary["failed"], [])
        self.assertEqual(summary["skipped"], ["BTCUSDT"])

    @patch("alerts.events._fetch_market_cap_ranks")
    @patch("alerts.events._fetch_coin_catalog")
    def test_resolve_coin_slug_picks_the_largest_coin_for_a_shared_ticker(
        self, coin_catalog, top_coins,
    ):
        coin_catalog.return_value = {
            "uni": ["uniswap", "uni", "universe"],
            "nuni": ["not-uni"],
        }
        top_coins.return_value = {"uniswap": 20, "uni": 6300, "universe": 900}

        self.assertEqual(resolve_coin_slug("UNIUSDT"), "uniswap")

    @patch("alerts.events._fetch_coin_catalog")
    def test_resolve_coin_slug_falls_back_to_the_plain_ticker(self, coin_catalog):
        coin_catalog.return_value = {"shib": ["shiba-inu"]}

        self.assertEqual(resolve_coin_slug("1000SHIBUSDT"), "shiba-inu")

    @patch("alerts.events._fetch_market_cap_ranks")
    @patch("alerts.events._fetch_coin_catalog")
    def test_resolve_coin_slug_maps_size_prefixed_pairs_to_the_underlying_coin(
        self, coin_catalog, top_coins,
    ):
        coin_catalog.return_value = {"1000shib": ["1000shib"], "shib": ["shiba-inu"]}
        top_coins.return_value = {"shiba-inu": 20}

        self.assertEqual(resolve_coin_slug("1000SHIBUSDT"), "shiba-inu")

    @patch("alerts.events._fetch_market_cap_ranks")
    @patch("alerts.events._fetch_coin_catalog")
    def test_resolve_coin_slug_keeps_a_size_prefixed_ticker_that_is_the_bigger_market(
        self, coin_catalog, top_coins,
    ):
        coin_catalog.return_value = {"1000sats": ["1000sats"], "sats": ["sats"]}
        top_coins.return_value = {"1000sats": 210, "sats": 1400}

        self.assertEqual(resolve_coin_slug("1000SATSUSDT"), "1000sats")

    @patch("alerts.events._fetch_coin_catalog")
    def test_resolve_coin_slug_returns_empty_when_nothing_matches(self, coin_catalog):
        coin_catalog.return_value = {"btc": ["bitcoin"]}

        self.assertEqual(resolve_coin_slug("NOPECOINUSDT"), "")

    @patch("alerts.events._fetch_coin_catalog")
    def test_resolve_coin_slug_propagates_catalog_errors(self, coin_catalog):
        coin_catalog.side_effect = CoinGeckoError("CoinGecko request failed")

        with self.assertRaises(CoinGeckoError):
            resolve_coin_slug("BTCUSDT")

    @patch("alerts.events._fetch_market_cap_ranks")
    @patch("alerts.events._fetch_coin_catalog")
    def test_resolve_coin_slug_survives_a_failed_ranking(self, coin_catalog, top_coins):
        coin_catalog.return_value = {"btc": ["bitcoin", "bitcoin-base"]}
        top_coins.side_effect = CoinGeckoError("CoinGecko rate limit reached.")

        self.assertEqual(resolve_coin_slug("BTCUSDT"), "bitcoin")

    @patch("alerts.events._fetch_market_cap_ranks")
    @patch("alerts.events._fetch_coin_catalog")
    def test_market_cap_ranks_are_reused_between_lookups(self, coin_catalog, top_coins):
        coin_catalog.return_value = {"uni": ["uni", "uniswap"], "ada": ["ada", "cardano"]}
        top_coins.return_value = {"uniswap": 20, "cardano": 10}

        self.assertEqual(resolve_coin_slug("UNIUSDT"), "uniswap")
        self.assertEqual(resolve_coin_slug("ADAUSDT"), "cardano")

        top_coins.assert_called_once()

    @patch("alerts.events._fetch_coin_catalog")
    def test_coin_catalog_is_reused_between_lookups(self, coin_catalog):
        coin_catalog.return_value = {"btc": ["bitcoin"]}

        resolve_coin_slug("BTCUSDT")
        resolve_coin_slug("BTCUSDT")

        coin_catalog.assert_called_once()

    @patch("alerts.events.resolve_coin_slug")
    @patch("alerts.events.fetch_coin_events")
    def test_event_sync_uses_resolved_slugs(self, scrape_events, resolve_slug):
        watch, _created = WatchlistSymbol.objects.get_or_create(symbol="BTCUSDT")
        resolve_slug.side_effect = (
            lambda symbol, **kwargs: "bitcoin" if symbol == "BTCUSDT" else ""
        )
        scrape_events.return_value = []

        sync_market_events()

        scrape_events.assert_called_once_with("bitcoin")
        watch.refresh_from_db()
        self.assertEqual(watch.slug, "bitcoin")


class EngineApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_jobs_endpoint_lists_the_polling_jobs(self):
        response = self.client.get("/api/engine/jobs/")

        self.assertEqual(response.status_code, 200)
        keys = {job["key"] for job in response.data}
        self.assertEqual(keys, {"alerts", "patterns", "recovery", "events"})

    @patch("alerts.engine.check_alerts", return_value=[])
    def test_running_the_alerts_job_returns_captured_output(self, check):
        response = self.client.post("/api/engine/run/", {"job": "alerts"}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["job"], "alerts")
        self.assertEqual(response.data["triggered"], 0)
        self.assertIn("output", response.data)
        check.assert_called_once()

    @patch("alerts.engine.check_pattern_alerts", return_value=[])
    def test_running_the_patterns_job(self, check):
        response = self.client.post("/api/engine/run/", {"job": "patterns"}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["job"], "patterns")
        self.assertEqual(response.data["triggered"], 0)
        check.assert_called_once()

    @patch("alerts.engine.sync_market_events", return_value={"status": "ok", "upcoming": 2})
    def test_running_the_events_job_forwards_options(self, sync):
        response = self.client.post(
            "/api/engine/run/",
            {"job": "events", "symbols": ["BTCUSDT"]},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["summary"]["status"], "ok")
        _args, kwargs = sync.call_args
        self.assertEqual(kwargs["symbols"], ["BTCUSDT"])

    def test_unknown_job_is_rejected(self):
        response = self.client.post("/api/engine/run/", {"job": "nope"}, format="json")

        self.assertEqual(response.status_code, 400)


class OpenApiSchemaTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_schema_endpoint_serves_the_api_description(self):
        response = self.client.get("/api/schema/")

        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        self.assertIn("Marketa+ API", body)
        self.assertIn("/api/engine/run/", body)
        self.assertIn("/api/telegram/find-chat/", body)


PATTERN_START = 1_700_000_000
PATTERN_HOUR = 3600


def pattern_bar(index, price):
    """One candle of the reference fixtures: a body exactly at the given price."""
    return {
        "time": PATTERN_START + index * PATTERN_HOUR,
        "open": price, "high": price + 0.5, "low": price - 0.5, "close": price,
    }


def pattern_anchors(points, length):
    """Straight-legged series through turning points, wick plus or minus a quarter.

    Same builder as the chart detector spec, so the expected levels below are the reference
    engine's own numbers rather than a second reading of the rules.
    """
    prices = [float("nan")] * length
    for (from_index, from_price), (to_index, to_price) in zip(points, points[1:]):
        span = max(1, to_index - from_index)
        for index in range(from_index, to_index + 1):
            prices[index] = from_price + (to_price - from_price) * (index - from_index) / span
    return [{
        "time": PATTERN_START + index * PATTERN_HOUR,
        "open": price, "high": price + 0.25, "low": price - 0.25, "close": price,
    } for index, price in enumerate(prices)]


def pattern_time(index):
    return PATTERN_START + index * PATTERN_HOUR


def double_top_prices():
    return (
        [100 + index for index in range(11)]
        + [110 - (index - 10) for index in range(11, 21)]
        + [100 + (index - 20) for index in range(21, 31)]
        + [110 - (index - 30) * 0.375 for index in range(31, 70)]
    )


def only_pattern(keys, bars):
    matches = detect_patterns(keys, bars)
    assert len(matches) == 1, matches
    return matches[0]


def pattern_level(match, side):
    levels = [level for level in match["levels"] if level["side"] == side]
    assert len(levels) == 1, match["levels"]
    return levels[0]


class PatternEngineParityTests(SimpleTestCase):
    """The backend engine has to agree with the chart engine, level for level."""

    def test_head_and_shoulders_confirms_after_a_neckline_break(self):
        bars = pattern_anchors(
            [[0, 98], [8, 105], [14, 100], [20, 112], [26, 100], [32, 105], [45, 96], [49, 96]], 50,
        )
        match = only_pattern(["head_and_shoulders"], bars)

        self.assertEqual(match["key"], "head_and_shoulders")
        self.assertEqual(match["bias"], "bearish")
        self.assertFalse(match["forming"])
        self.assertEqual(match["span_bars"], 24)
        self.assertEqual(match["end_time"], pattern_time(32))
        self.assertEqual(match["break_time"], pattern_time(40))
        level = pattern_level(match, "down")
        self.assertAlmostEqual(level["price"], 99.75, places=10)
        self.assertAlmostEqual(level["slope"], 0.0, places=10)
        self.assertAlmostEqual(level["target"], 87.25, places=10)
        self.assertEqual(match["invalidation"]["side"], "above")
        self.assertAlmostEqual(match["invalidation"]["price"], 112.25, places=10)

    def test_head_and_shoulders_forms_while_the_right_shoulder_is_missing(self):
        bars = pattern_anchors([[0, 102], [8, 105], [14, 100], [20, 112], [30, 100], [34, 104]], 35)
        match = only_pattern(["head_and_shoulders"], bars)

        self.assertTrue(match["forming"])
        self.assertIsNone(match["break_time"])
        self.assertEqual(match["end_time"], pattern_time(30))
        self.assertEqual(match["span_bars"], 22)
        level = pattern_level(match, "down")
        self.assertAlmostEqual(level["price"], 99.75, places=10)
        self.assertAlmostEqual(level["target"], 87.25, places=10)

    def test_a_sloped_neckline_is_quoted_on_the_newest_bar_and_drifts_per_bar(self):
        bars = pattern_anchors(
            [[0, 102], [8, 105], [14, 100], [20, 112], [30, 101], [34, 104]], 35,
        )
        match = only_pattern(["head_and_shoulders"], bars)
        level = pattern_level(match, "down")

        self.assertTrue(match["forming"])
        self.assertAlmostEqual(level["price"], 101.0, places=10)
        self.assertAlmostEqual(level["slope"], 0.0625, places=10)
        # Height 112.25 - 100.125 (neckline at the head), measured from the quoted 101.
        self.assertAlmostEqual(level["target"], 88.875, places=10)

    def test_a_broken_sloped_neckline_names_the_break_bar_level(self):
        bars = pattern_anchors(
            [[0, 98], [8, 105], [14, 100], [20, 112], [26, 101], [32, 105], [45, 97], [49, 97]], 50,
        )
        match = only_pattern(["head_and_shoulders"], bars)
        level = pattern_level(match, "down")

        self.assertFalse(match["forming"])
        self.assertEqual(match["break_time"], pattern_time(38))
        self.assertAlmostEqual(level["price"], 101.75, places=10)
        self.assertAlmostEqual(level["slope"], 1 / 12, places=10)
        # Height 112.25 - 100.25, measured from the break-bar neckline, not the drawing edge.
        self.assertAlmostEqual(level["target"], 89.75, places=6)

    def test_inverse_head_and_shoulders_breaks_above_the_neckline(self):
        bars = pattern_anchors(
            [[0, 112], [8, 105], [14, 110], [20, 96], [26, 110], [32, 105], [45, 114], [49, 114]], 50,
        )
        match = only_pattern(["inverse_head_and_shoulders"], bars)

        self.assertFalse(match["forming"])
        self.assertEqual(match["bias"], "bullish")
        level = pattern_level(match, "up")
        self.assertAlmostEqual(level["price"], 110.25, places=10)
        self.assertAlmostEqual(level["target"], 124.75, places=10)
        self.assertEqual(match["invalidation"]["side"], "below")
        self.assertAlmostEqual(match["invalidation"]["price"], 95.75, places=10)

    def test_inverse_head_and_shoulders_forms_from_two_swings(self):
        bars = pattern_anchors([[0, 108], [8, 105], [14, 110], [20, 98], [30, 110], [34, 106]], 35)
        match = only_pattern(["inverse_head_and_shoulders"], bars)

        self.assertTrue(match["forming"])
        level = pattern_level(match, "up")
        self.assertAlmostEqual(level["price"], 110.25, places=10)
        self.assertAlmostEqual(level["target"], 122.75, places=10)

    def test_double_bottom_breaks_the_reaction_high(self):
        bars = pattern_anchors([[0, 100], [8, 90], [14, 100], [20, 90], [45, 110], [49, 110]], 50)
        match = only_pattern(["double_bottom"], bars)

        self.assertFalse(match["forming"])
        self.assertEqual(match["bias"], "bullish")
        self.assertEqual(match["span_bars"], 12)
        self.assertEqual(match["break_time"], pattern_time(33))
        level = pattern_level(match, "up")
        self.assertAlmostEqual(level["price"], 100.25, places=10)
        self.assertAlmostEqual(level["slope"], 0.0, places=10)
        self.assertAlmostEqual(level["target"], 110.75, places=10)
        self.assertEqual(match["invalidation"]["side"], "below")
        self.assertAlmostEqual(match["invalidation"]["price"], 89.75, places=10)

    def test_double_bottom_forms_while_the_second_bottom_is_missing(self):
        bars = pattern_anchors([[0, 100], [10, 90], [22, 100], [29, 94]], 30)
        match = only_pattern(["double_bottom"], bars)

        self.assertTrue(match["forming"])
        self.assertEqual(match["end_time"], pattern_time(22))
        self.assertEqual(match["span_bars"], 12)
        level = pattern_level(match, "up")
        self.assertAlmostEqual(level["price"], 100.25, places=10)
        self.assertAlmostEqual(level["target"], 110.75, places=10)

    def test_double_top_breaks_the_reaction_low(self):
        bars = [pattern_bar(index, price) for index, price in enumerate(double_top_prices())]
        match = only_pattern(["double_top"], bars)

        self.assertFalse(match["forming"])
        self.assertEqual(match["bias"], "bearish")
        self.assertEqual(match["span_bars"], 20)
        self.assertEqual(match["end_time"], pattern_time(30))
        level = pattern_level(match, "down")
        self.assertAlmostEqual(level["price"], 99.5, places=10)
        self.assertAlmostEqual(level["target"], 88.5, places=10)
        self.assertEqual(match["invalidation"]["side"], "above")
        self.assertAlmostEqual(match["invalidation"]["price"], 110.5, places=10)

    def test_double_top_forms_while_the_second_top_is_missing(self):
        prices = (
            [100 + index for index in range(11)]
            + [110 - ((index - 10) * 10) / 20 for index in range(11, 31)]
            + [100 + ((index - 30) * 5) / 9 for index in range(31, 40)]
        )
        bars = [pattern_bar(index, price) for index, price in enumerate(prices)]
        match = only_pattern(["double_top"], bars)

        self.assertTrue(match["forming"])
        self.assertIsNone(match["break_time"])
        level = pattern_level(match, "down")
        self.assertAlmostEqual(level["price"], 99.5, places=10)
        self.assertAlmostEqual(level["target"], 88.5, places=10)

    def test_ascending_triangle_keeps_the_flat_resistance_as_the_entry(self):
        bars = pattern_anchors(
            [[0, 101], [5, 99], [10, 110], [15, 102], [20, 110], [25, 105],
             [30, 110], [35, 109], [39, 109]], 40,
        )
        match = only_pattern(["ascending_triangle"], bars)

        self.assertTrue(match["forming"])
        self.assertEqual(match["bias"], "bullish")
        level = pattern_level(match, "up")
        self.assertAlmostEqual(level["price"], 110.25, places=10)
        self.assertAlmostEqual(level["slope"], 0.0, places=10)
        # Opening width at the first touch (bar 5): 110.25 - 98.75 = 11.5.
        self.assertAlmostEqual(level["target"], 121.75, places=10)
        self.assertEqual(match["invalidation"]["side"], "below")
        self.assertAlmostEqual(match["invalidation"]["price"], 108.95, places=10)
        self.assertAlmostEqual(match["invalidation"]["slope"], 0.3, places=10)

    def test_descending_triangle_keeps_the_flat_support_as_the_entry(self):
        bars = pattern_anchors(
            [[0, 110], [5, 100], [10, 110], [15, 100], [20, 107], [25, 100],
             [30, 104], [35, 101], [39, 101]], 40,
        )
        match = only_pattern(["descending_triangle"], bars)

        self.assertTrue(match["forming"])
        self.assertEqual(match["bias"], "bearish")
        level = pattern_level(match, "down")
        self.assertAlmostEqual(level["price"], 99.75, places=10)
        # Opening width at the first touch (bar 5): 111.75 - 99.75 = 12.
        self.assertAlmostEqual(level["target"], 87.75, places=10)
        self.assertEqual(match["invalidation"]["side"], "above")
        self.assertAlmostEqual(match["invalidation"]["price"], 101.55, places=10)
        self.assertAlmostEqual(match["invalidation"]["slope"], -0.3, places=10)

    def test_symmetrical_triangle_offers_both_sides_and_no_invalidation(self):
        bars = pattern_anchors(
            [[0, 105], [5, 100], [10, 110], [15, 101], [20, 109], [25, 102],
             [30, 108], [35, 105], [39, 105]], 40,
        )
        match = only_pattern(["symmetrical_triangle"], bars)

        self.assertTrue(match["forming"])
        self.assertIsNone(match["invalidation"])
        self.assertEqual([level["side"] for level in match["levels"]], ["up", "down"])
        up, down = match["levels"]
        self.assertAlmostEqual(up["price"], 107.35, places=10)
        self.assertAlmostEqual(up["slope"], -0.1, places=10)
        # Opening width at the first touch (bar 5): 110.75 - 99.75 = 11.
        self.assertAlmostEqual(up["target"], 118.35, places=10)
        self.assertEqual(up["bias"], "bullish")
        self.assertAlmostEqual(down["price"], 103.15, places=10)
        self.assertAlmostEqual(down["slope"], 0.1, places=10)
        self.assertAlmostEqual(down["target"], 92.15, places=10)
        self.assertEqual(down["bias"], "bearish")

    def test_rising_wedge_resolves_downward(self):
        bars = pattern_anchors(
            [[0, 98], [5, 100], [10, 104], [15, 103], [20, 106], [25, 105.6],
             [30, 108], [34, 105]], 35,
        )
        match = only_pattern(["rising_wedge"], bars)

        self.assertFalse(match["forming"])
        self.assertEqual(match["bias"], "bearish")
        self.assertEqual(match["break_time"], pattern_time(32))
        level = pattern_level(match, "down")
        # Support through 102.75@15 and 105.35@25, read on the break bar.
        self.assertAlmostEqual(level["price"], 107.17, places=10)
        # Opening width at the first touch (bar 10): 104.25 - 101.45 = 2.8.
        self.assertAlmostEqual(level["target"], 104.37, places=6)
        self.assertEqual(match["invalidation"]["side"], "above")
        self.assertAlmostEqual(match["invalidation"]["price"], 109.05, places=10)

    def test_falling_wedge_resolves_upward(self):
        bars = pattern_anchors(
            [[0, 111], [5, 100], [10, 110], [15, 99], [20, 107], [25, 98],
             [30, 104], [34, 106]], 35,
        )
        match = only_pattern(["falling_wedge"], bars)

        self.assertFalse(match["forming"])
        self.assertEqual(match["bias"], "bullish")
        self.assertEqual(match["break_time"], pattern_time(32))
        level = pattern_level(match, "up")
        self.assertAlmostEqual(level["price"], 103.65, places=10)
        self.assertAlmostEqual(level["target"], 115.65, places=10)
        self.assertEqual(match["invalidation"]["side"], "below")
        self.assertAlmostEqual(match["invalidation"]["price"], 96.85, places=10)

    def test_flags_are_out_of_scope_for_the_backend_engine(self):
        bars = pattern_anchors(
            [[0, 100], [9, 110], [11, 110.25], [13, 108.65], [15, 109.35], [17, 107.75],
             [19, 108.45], [21, 106.85], [23, 107.55], [29, 105.5]], 30,
        )

        self.assertEqual(detect_patterns(["bull_flag", "bear_flag"], bars), [])

    def test_the_engine_covers_nine_level_based_patterns(self):
        self.assertEqual(len(DETECTED_PATTERN_KEYS), 9)
        self.assertNotIn("bull_flag", DETECTED_PATTERN_KEYS)
        self.assertNotIn("bear_flag", DETECTED_PATTERN_KEYS)

    def test_a_short_window_reports_nothing(self):
        bars = [pattern_bar(index, price) for index, price in enumerate(double_top_prices())]

        self.assertEqual(detect_patterns(["double_top"], bars[:20]), [])

    def test_matches_come_back_in_the_order_the_keys_were_asked(self):
        bars = [pattern_bar(index, price) for index, price in enumerate(double_top_prices())]

        matches = detect_patterns(["double_top", "double_bottom"], bars)

        self.assertEqual([match["key"] for match in matches], ["double_top"])

    def test_best_pattern_prefers_a_confirmed_shape_then_the_wider_one(self):
        bars = [pattern_bar(index, price) for index, price in enumerate(double_top_prices())]
        matches = detect_patterns(list(DETECTED_PATTERN_KEYS), bars)

        self.assertEqual(best_pattern(matches)["key"], "double_top")
        self.assertIsNone(best_pattern([]))

    def test_best_pattern_chooses_the_widest_when_several_are_forming(self):
        narrow = {"forming": True, "span_bars": 20}
        wider = {"forming": True, "span_bars": 37, "key": "wider"}
        narrow["key"] = "narrow"

        self.assertEqual(best_pattern([narrow, wider])["key"], "wider")
        self.assertEqual(best_pattern([wider, narrow])["key"], "wider")


class PatternStateMachineTests(SimpleTestCase):
    """The alert's own transitions, tested apart from the database and the exchange."""

    def forming_case(self):
        # Fully drawn: the right shoulder printed at bar 34, only the neckline break is missing.
        bars = pattern_anchors(
            [[0, 102], [8, 105], [14, 100], [20, 112], [30, 100], [34, 104], [38, 102]], 39,
        )
        return bars, only_pattern(["head_and_shoulders"], bars)

    def evaluate(self, bars, match, state=None):
        return pattern_evaluate(
            bars, match, state or {}, symbol="BTCUSDT", timeframe="1h",
            first_poll=state is None,
        )

    def test_a_forming_shape_is_reported_and_its_numbers_are_pinned(self):
        bars, match = self.forming_case()
        signals, state = self.evaluate(bars, match)

        self.assertEqual([signal["event"] for signal in signals], ["forming"])
        self.assertEqual(state["state"], "forming")
        self.assertEqual(state["key"], "head_and_shoulders")
        self.assertAlmostEqual(state["entry"]["price"], 99.75, places=10)
        self.assertEqual(state["entry"]["side"], "down")
        self.assertEqual(state["entry"]["anchor_time"], pattern_time(38))
        self.assertAlmostEqual(state["invalidation"]["price"], 112.25, places=10)
        # The engine calls the head an "above" level; the alert stores it as the same kind of
        # crossing test as the entry, so one helper decides both.
        self.assertEqual(state["invalidation"]["side"], "up")
        self.assertAlmostEqual(state["target"], 87.25, places=10)

    def test_the_same_formation_is_never_reported_twice(self):
        bars, match = self.forming_case()
        _, pinned = self.evaluate(bars, match)

        signals, state = self.evaluate(bars, match, pinned)

        self.assertEqual(signals, [])
        self.assertEqual(state["state"], "forming")

    def test_a_shape_still_missing_its_right_shoulder_does_not_warn(self):
        bars = pattern_anchors(
            [[0, 102], [8, 105], [14, 100], [20, 112], [30, 100], [34, 104]], 35,
        )
        match = only_pattern(["head_and_shoulders"], bars)
        self.assertEqual(match["stage"], "missing_swing")

        signals, state = self.evaluate(bars, match)

        self.assertEqual(signals, [])
        self.assertEqual(state["state"], "idle")
        # Nothing is remembered, so the completed shape can still warn later.
        self.assertFalse(state["signature"])

    def test_a_two_sided_shape_waits_for_the_side_that_actually_breaks(self):
        bars = pattern_anchors(
            [[0, 105], [5, 100], [10, 110], [15, 101], [20, 109], [25, 102],
             [30, 108], [35, 105], [39, 105]], 40,
        )
        match = only_pattern(["symmetrical_triangle"], bars)

        signals, state = self.evaluate(bars, match)

        self.assertEqual(signals, [])
        self.assertEqual(state["state"], "idle")

    def test_first_close_past_prices_a_sloped_level_for_every_newer_bar(self):
        bars = [pattern_bar(index, 100) for index in range(10)]

        # The line sinks one per bar, so flat closes only clear it once it has come down to them.
        hit = first_close_past(
            bars, anchor_time=pattern_time(0), price=107.0, slope=-1.0, side="up",
        )
        self.assertIsNotNone(hit)
        self.assertEqual(hit["time"], pattern_time(8))
        # A line that only ever climbs is never crossed from below by those same closes.
        self.assertIsNone(first_close_past(
            bars, anchor_time=pattern_time(0), price=100.0, slope=1.0, side="up",
        ))

    def test_first_close_past_ignores_a_break_that_happened_while_the_job_was_down(self):
        bars = [pattern_bar(index, 100) for index in range(10)]

        self.assertIsNone(first_close_past(
            bars, anchor_time=pattern_time(0), price=107.0, slope=-1.0, side="up",
            max_drift_bars=2,
        ))

    def test_a_forming_convergence_alert_honours_the_detectors_noise_band(self):
        # The detector only calls a channel break once the close clears the edge by
        # 5% of the window's span; the pinned alert has to wait for the same margin.
        points = [
            [0, 101], [5, 99], [10, 110], [15, 102], [20, 110], [25, 105],
            [30, 110], [35, 109], [39, 109],
        ]
        bars = pattern_anchors(points, 40)
        match = only_pattern(["ascending_triangle"], bars)
        signals, pinned = pattern_evaluate(
            bars, match, None, symbol="BTCUSDT", timeframe="1h",
        )
        self.assertEqual([signal["event"] for signal in signals], ["forming"])
        self.assertGreater(pinned["entry"]["slack"], 0)

        # 110.6 clears the 110.25 resistance but stays inside the band: no breakout.
        inside = pattern_anchors(points + [[40, 110.6]], 41)
        signals, state = pattern_evaluate(
            inside, None, pinned, symbol="BTCUSDT", timeframe="1h",
        )
        self.assertEqual(signals, [])
        self.assertEqual(state["state"], "forming")

        # 111.5 clears the band: the breakout the warning promised.
        outside = pattern_anchors(points + [[40, 111.5]], 41)
        signals, state = pattern_evaluate(
            outside, None, state, symbol="BTCUSDT", timeframe="1h",
        )
        self.assertEqual([signal["event"] for signal in signals], ["breakout"])


class PatternAlertTests(TestCase):
    """One alert, followed through the polls the scheduler would hand it."""

    # Fully drawn head and shoulders: right shoulder at bar 34, neckline (99.75) not yet broken.
    FORMING = [[0, 102], [8, 105], [14, 100], [20, 112], [30, 100], [34, 104], [38, 102]]

    def setUp(self):
        self.alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PATTERN, condition=Alert.Condition.CROSS,
            timeframe="1h", frequency=Alert.Frequency.EVERY,
        )
        self.forming = pattern_anchors(self.FORMING, 39)

    def extend(self, price, length):
        return pattern_anchors(self.FORMING + [[length - 1, price]], length)

    def poll(self, bars):
        with patch("alerts.services._closed_bars", return_value=bars):
            return check_pattern_alerts()

    def reload(self):
        self.alert.refresh_from_db()
        return self.alert

    def test_a_forming_shape_warns_once_and_records_its_numbers(self):
        events = self.poll(self.forming)

        self.assertEqual(len(events), 1)
        self.assertIn("Pattern - Forming - Head and Shoulders - Bearish", events[0].title)
        self.assertIn("Entry: close below $99.750", events[0].message)
        self.assertIn("Invalidation: close above $112.250", events[0].message)
        self.assertIn("Target: $87.250", events[0].message)
        self.assertIn("Report:", events[0].message)

        alert = self.reload()
        self.assertEqual(alert.pattern_state, Alert.PatternState.FORMING)
        self.assertEqual(alert.pattern_key, "head_and_shoulders")
        self.assertAlmostEqual(alert.pattern_entry["price"], 99.75, places=10)
        self.assertAlmostEqual(alert.pattern_target, 87.25, places=10)
        self.assertEqual(
            alert.pattern_last_bar_time,
            utc_datetime.fromtimestamp(pattern_time(38), tz=dt_timezone.utc),
        )

    def test_the_same_closed_bar_cannot_fire_again_on_the_next_poll(self):
        self.poll(self.forming)

        self.assertEqual(self.poll(self.forming), [])
        self.assertEqual(TriggerEvent.objects.count(), 1)

    def test_the_entry_event_carries_the_target_the_warning_promised(self):
        warning = self.poll(self.forming)
        entered = self.poll(self.extend(98, 40))

        self.assertEqual(len(entered), 1)
        self.assertIn("Pattern - Breakout - Head and Shoulders - Bearish", entered[0].title)
        self.assertIn("Breakout: $99.750", entered[0].message)
        # The pair reads as one trade plan, so the number cannot drift between the two notices.
        self.assertEqual(
            entered[0].message.split("Target: ")[1].splitlines()[0],
            warning[0].message.split("Target: ")[1].splitlines()[0],
        )
        alert = self.reload()
        self.assertEqual(alert.pattern_state, Alert.PatternState.IDLE)
        self.assertEqual(alert.pattern_entry, {})
        self.assertTrue(alert.pattern_signature)

    def test_a_close_through_the_head_resets_the_alert_without_a_third_notice(self):
        self.poll(self.forming)

        self.assertEqual(self.poll(self.extend(113, 40)), [])
        alert = self.reload()
        self.assertEqual(alert.pattern_state, Alert.PatternState.IDLE)
        self.assertIsNone(alert.pattern_target)
        self.assertEqual(TriggerEvent.objects.count(), 1)

    def test_a_shape_that_never_breaks_is_dropped_once_it_ages_out(self):
        self.poll(self.forming)

        # Pinned at bar 38; the forming window is 30 bars.
        self.assertEqual(self.poll(self.extend(105, 70)), [])
        self.assertEqual(self.reload().pattern_state, Alert.PatternState.IDLE)

    def test_a_break_that_predates_the_alert_is_never_reported(self):
        confirmed = pattern_anchors(
            [[0, 98], [8, 105], [14, 100], [20, 112], [26, 100], [32, 105], [45, 96], [49, 96]], 50,
        )

        self.assertEqual(self.poll(confirmed), [])
        alert = self.reload()
        self.assertEqual(alert.pattern_state, Alert.PatternState.IDLE)
        self.assertEqual(TriggerEvent.objects.count(), 0)
        # Arming remembers the shape, so its own warning cannot arrive late.
        self.assertTrue(alert.pattern_signature)

    def test_a_break_on_the_newest_closed_bar_is_reported_without_a_warning(self):
        # A straight ramp holds no shape, so this only makes the alert no longer new.
        self.poll([pattern_bar(index, 100 + index) for index in range(30)])
        breaking = pattern_anchors(
            [[0, 98], [8, 105], [14, 100], [20, 112], [26, 100], [32, 105], [38, 99]], 39,
        )

        events = self.poll(breaking)

        # Several readings fit these candles and the widest one wins; what matters is that the
        # break itself is reported, because it is the newest closed bar rather than history.
        self.assertEqual(len(events), 1)
        self.assertIn("Pattern - Breakout", events[0].title)
        self.assertIn("Breakout: $", events[0].message)
        self.assertEqual(self.reload().pattern_state, Alert.PatternState.IDLE)

    def test_a_once_alert_stops_watching_after_the_pair(self):
        self.alert.frequency = Alert.Frequency.ONCE
        self.alert.save(update_fields=["frequency"])

        self.poll(self.forming)
        self.assertTrue(self.reload().active)

        self.poll(self.extend(98, 40))

        self.assertFalse(self.reload().active)

    def test_an_every_alert_stays_live_after_the_pair(self):
        self.poll(self.forming)

        self.poll(self.extend(98, 40))

        alert = self.reload()
        self.assertTrue(alert.active)
        self.assertEqual(alert.pattern_state, Alert.PatternState.IDLE)

    def test_a_market_with_too_few_candles_is_left_alone(self):
        self.assertEqual(self.poll(self.forming[:20]), [])
        self.assertEqual(self.reload().pattern_state, Alert.PatternState.IDLE)


class PatternAlertApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_a_pattern_alert_needs_only_a_symbol_and_a_timeframe(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "pattern", "timeframe": "1h",
            "frequency": "every", "note": "watch the neckline",
        }, format="json")

        self.assertEqual(response.status_code, 201, response.data)
        alert = Alert.objects.get(pk=response.data["id"])
        self.assertEqual(alert.kind, Alert.Kind.PATTERN)
        self.assertEqual(alert.condition, Alert.Condition.CROSS)
        self.assertEqual(alert.pattern_state, Alert.PatternState.IDLE)
        self.assertEqual(alert.pattern_key, "")

    def test_a_pattern_alert_rejects_a_price_it_would_not_use(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "pattern", "timeframe": "1h", "price": "65000",
        }, format="json")

        self.assertEqual(response.status_code, 400)
        self.assertIn("price", response.data)

    def test_a_pattern_alert_needs_a_supported_timeframe(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "pattern", "timeframe": "2h",
        }, format="json")

        self.assertEqual(response.status_code, 400)
        self.assertIn("timeframe", response.data)

    def test_the_alert_list_exposes_the_engine_state(self):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PATTERN, condition=Alert.Condition.CROSS,
            timeframe="1h", pattern_key="head_and_shoulders", pattern_bias="bearish",
            pattern_state=Alert.PatternState.FORMING, pattern_target=87.25,
        )

        response = self.client.get("/api/alerts/")

        self.assertEqual(response.status_code, 200)
        row = next(item for item in response.data if item["id"] == alert.id)
        self.assertEqual(row["pattern_state"], "forming")
        self.assertEqual(row["pattern_key"], "head_and_shoulders")
        self.assertEqual(row["pattern_bias"], "bearish")
        self.assertAlmostEqual(row["pattern_target"], 87.25)


class ReviewRegressionTests(TestCase):
    """Accuracy fixes from the November 2026 logic review."""

    @patch("alerts.services._trend_signal", return_value=None)
    @patch("alerts.services._rsi_signal")
    @patch("alerts.services._macd_signal", return_value=None)
    def test_rsi_cross_alert_fires_without_a_single_level(self, _macd, rsi_signal, _trend):
        # Admin-created RSI "cross" alerts used to crash the whole poll building their title.
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.RSI, condition=Alert.Condition.CROSS,
            timeframe="1h", frequency=Alert.Frequency.EVERY, last_rsi_value=25,
        )
        later = Alert.objects.create(
            symbol="ETHUSDT", kind=Alert.Kind.RSI, condition=Alert.Condition.ABOVE,
            timeframe="1h", frequency=Alert.Frequency.EVERY,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        rsi_signal.side_effect = lambda symbol, *_args: {
            "bar_time": bar_time, "rsi": 35 if symbol == "BTCUSDT" else 80, "close": 100,
        }

        check_alerts()

        self.assertEqual(TriggerEvent.objects.get(alert=alert).title, "BTCUSDT RSI 1h crosses either way 30/70")
        self.assertTrue(TriggerEvent.objects.filter(alert=later).exists())

    def test_rsi_level_of_zero_is_honoured(self):
        alert = Alert(rsi_oversold=0, rsi_overbought=100)
        from .services import _rsi_classification
        self.assertEqual(_rsi_classification(alert, {"rsi": 25}), "bearish-balanced")

    def test_resuming_an_alert_clears_stale_cross_state(self):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS,
            timeframe="1h", active=False, last_macd_diff=-5,
            last_bar_open_time=timezone.now() - timedelta(days=30),
        )
        user = get_user_model().objects.create_user("reviewer", password="x")
        client = APIClient()
        client.force_authenticate(user)

        response = client.patch(f"/api/alerts/{alert.id}/", {"active": True}, format="json")

        self.assertEqual(response.status_code, 200)
        alert.refresh_from_db()
        self.assertIsNone(alert.last_macd_diff)
        self.assertIsNone(alert.last_bar_open_time)

    def test_events_still_running_are_kept(self):
        now = timezone.now()
        event = {
            "id": 7, "title": "Week-long conference",
            "dateEvent": (now - timedelta(days=2)).strftime("%Y-%m-%dT00:00:00Z"),
            "dateEventTo": (now + timedelta(days=3)).strftime("%Y-%m-%dT00:00:00Z"),
            "coins": 5, "categories": "bad",  # Malformed lists are ignored, not fatal.
        }
        self.assertEqual(store_events("BTCUSDT", "bitcoin", [event]), 1)
        purge_market_events(symbols=["BTCUSDT"])
        self.assertTrue(MarketEvent.objects.filter(symbol="BTCUSDT", external_id="7").exists())

    @patch("alerts.events.resolve_coin_slug", return_value="bitcoin")
    @patch("alerts.events.fetch_coin_events")
    def test_sync_drops_upcoming_events_the_source_no_longer_lists(self, scrape_events, _resolve):
        WatchlistSymbol.objects.get_or_create(symbol="BTCUSDT")
        future = (timezone.now() + timedelta(days=10)).strftime("%Y-%m-%dT00:00:00Z")
        scrape_events.return_value = [{"id": 1, "title": "Old", "dateEvent": future}]
        sync_market_events(symbols=["BTCUSDT"])
        scrape_events.return_value = [{"id": 2, "title": "Reissued", "dateEvent": future}]

        sync_market_events(symbols=["BTCUSDT"])

        ids = set(MarketEvent.objects.filter(symbol="BTCUSDT").values_list("external_id", flat=True))
        self.assertEqual(ids, {"2"})


class PatternGeometryReviewTests(SimpleTestCase):
    """Measured moves and swing rules from the November 2026 logic review; the chart spec pins
    the same numbers."""

    def test_double_top_is_measured_from_its_higher_top(self):
        bars = pattern_anchors([[0, 98], [10, 110], [16, 100], [22, 111], [32, 95], [39, 95]], 40)
        match = only_pattern(["double_top"], bars)
        # 111.25 - 99.75 = 11.5 below the neckline, not a line extrapolated through both tops.
        self.assertAlmostEqual(pattern_level(match, "down")["target"], 88.25, places=10)

    def test_equal_neighbouring_lows_still_make_one_swing(self):
        bars = pattern_anchors([[0, 98], [10, 110], [16, 100], [22, 110], [30, 96], [34, 96]], 35)
        bars[17] = {**bars[17], "low": bars[16]["low"]}
        match = only_pattern(["double_top"], bars)
        self.assertAlmostEqual(pattern_level(match, "down")["target"], 89.25, places=10)

    def test_an_unresolved_symmetrical_triangle_is_neutral(self):
        bars = pattern_anchors(
            [[0, 105], [5, 100], [10, 110], [15, 101], [20, 109], [25, 102],
             [30, 108], [35, 105], [39, 105]], 40,
        )
        match = only_pattern(["symmetrical_triangle"], bars)
        self.assertTrue(match["forming"])
        self.assertEqual(match["bias"], "neutral")

    def test_a_half_formed_double_top_never_warns_or_breaks_out(self):
        forming_bars = pattern_anchors([[0, 92], [12, 96], [20, 100], [28, 90], [32, 95]], 33)
        match = only_pattern(["double_top"], forming_bars)
        self.assertEqual(match["stage"], "missing_swing")
        signals, state = pattern_evaluate(
            forming_bars, match, None, symbol="BTCUSDT", timeframe="1h",
        )
        self.assertEqual(signals, [])
        self.assertEqual(state["state"], "idle")

    def test_an_alert_pinned_before_the_second_top_fails_quietly_on_a_neckline_close(self):
        # Alerts already forming from a half-drawn shape (pinned before this rule) must not
        # report the neckline close as a breakout either.
        from .patterns import _pin
        forming_bars = pattern_anchors([[0, 92], [12, 96], [20, 100], [28, 90], [32, 95]], 33)
        match = only_pattern(["double_top"], forming_bars)
        state = {"state": "forming", "key": "", "bias": "", "signature": "", "entry": {},
                 "target": None, "invalidation": {}, "end_time": None}
        _pin(state, match, symbol="BTCUSDT", timeframe="1h", last_time=forming_bars[-1]["time"])
        self.assertIs(state["entry"]["needs_swing"], True)

        slid = pattern_anchors([[0, 92], [12, 96], [20, 100], [28, 90], [32, 95], [40, 84]], 41)
        signals, state = pattern_evaluate(
            slid, best_pattern(detect_patterns(list(DETECTED_PATTERN_KEYS), slid)), state,
            symbol="BTCUSDT", timeframe="1h",
        )
        self.assertEqual(signals, [])
        self.assertEqual(state["state"], "idle")
        self.assertIsNone(state["target"])

class PatternAlertMissingSwingTests(TestCase):
    """The half-formed-shape rule, followed through the scheduler job and the database."""

    def setUp(self):
        self.alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PATTERN, condition=Alert.Condition.CROSS,
            timeframe="1h", frequency=Alert.Frequency.EVERY,
        )

    def poll(self, bars):
        with patch("alerts.services._closed_bars", return_value=bars):
            return check_pattern_alerts()

    def test_a_half_formed_double_top_sends_nothing_even_when_it_slides(self):
        self.assertEqual(self.poll(pattern_anchors(
            [[0, 92], [12, 96], [20, 100], [28, 90], [32, 95]], 33,
        )), [])
        self.assertEqual(self.poll(pattern_anchors(
            [[0, 92], [12, 96], [20, 100], [28, 90], [32, 95], [40, 84]], 41,
        )), [])
        self.alert.refresh_from_db()
        self.assertEqual(self.alert.pattern_state, Alert.PatternState.IDLE)
        self.assertEqual(TriggerEvent.objects.filter(alert=self.alert).count(), 0)

    def test_the_completed_shape_warns_and_then_reports_its_breakout(self):
        # Half drawn: nothing yet.
        self.assertEqual(self.poll(pattern_anchors(
            [[0, 92], [12, 96], [20, 100], [28, 90], [32, 95]], 33,
        )), [])
        # The second top prints at 100 on bar 36 and price turns down: now it warns.
        forming = self.poll(pattern_anchors(
            [[0, 92], [12, 96], [20, 100], [28, 90], [36, 100], [40, 96]], 41,
        ))
        self.assertEqual(len(forming), 1)
        self.assertIn("Pattern - Forming - Double Top", forming[0].title)
        self.alert.refresh_from_db()
        self.assertIs(self.alert.pattern_entry["needs_swing"], False)

        broke = self.poll(pattern_anchors(
            [[0, 92], [12, 96], [20, 100], [28, 90], [36, 100], [40, 96], [44, 88]], 45,
        ))

        self.assertEqual(len(broke), 1)
        self.assertIn("Pattern - Breakout - Double Top", broke[0].title)
        self.alert.refresh_from_db()
        self.assertEqual(self.alert.pattern_state, Alert.PatternState.IDLE)

class PatternBreakoutTargetTests(SimpleTestCase):
    def test_a_sloped_neckline_breakout_measures_its_target_from_the_break(self):
        # Found replaying live ETHUSDT 1d candles: an inverse head and shoulders pinned its target
        # at 4231 while forming, the rising neckline then broke at 4673, and the breakout quoted
        # a "bullish" target below its own entry.
        bars = pattern_anchors([[0, 100], [20, 100], [21, 160]], 22)
        state = {
            "state": "forming", "key": "inverse_head_and_shoulders", "bias": "bullish",
            "signature": "s", "end_time": bars[0]["time"], "target": 105.0, "invalidation": {},
            "entry": {"side": "up", "price": 100.0, "slope": 2.0, "anchor_time": bars[0]["time"],
                      "needs_swing": False, "height": 5.0},
        }

        signals, state = pattern_evaluate(bars, None, state, symbol="ETHUSDT", timeframe="1d")

        self.assertEqual([signal["event"] for signal in signals], ["breakout"])
        self.assertAlmostEqual(signals[0]["level"], 142.0, places=10)
        self.assertAlmostEqual(state["target"], 147.0, places=10)


def _recovery_hour_bars(closes, start=0, step=3600):
    return [
        {"time": start + index * step, "close": close, "high": close, "low": close}
        for index, close in enumerate(closes)
    ]


def _recovery_trend_bars(count, direction, step):
    """Steadily rising (``direction=1``) or falling closes give a signed MACD."""
    return [
        {"time": (index - count) * step, "close": 100 + direction * index}
        for index in range(count)
    ]


def _recovery_signs(direction):
    daily = trend_signs(_recovery_trend_bars(200, direction, 86400), 86400, "1d")
    four_hour = trend_signs(_recovery_trend_bars(200, direction, 14400), 14400, "4h")
    return daily, four_hour


BULLISH_HOUR_CLOSES = (
    [100.0] * 12 + [98, 96, 94, 92, 90, 88]
    + [89, 91, 93, 96, 100, 105, 111, 118, 126]
)
BEARISH_HOUR_CLOSES = (
    [100.0] * 12 + [102, 104, 106, 108, 110, 112]
    + [111, 109, 107, 104, 100, 95, 89, 82, 74]
)


class TrendRecoveryDetectionTests(SimpleTestCase):
    def test_bullish_pullback_warns_then_confirms_on_zero_cross(self):
        daily, four_hour = _recovery_signs(1)
        events = detect_events(
            _recovery_hour_bars(BULLISH_HOUR_CLOSES), "sma", daily, four_hour,
        )

        self.assertEqual(
            [(event["direction"], event["stage"]) for event in events],
            [("bullish", "early"), ("bullish", "confirmed")],
        )
        early, confirmed = events
        self.assertLess(early["bar_time"], confirmed["bar_time"])
        self.assertLess(early["macd"], 0)
        self.assertGreaterEqual(confirmed["macd"], 0)
        self.assertGreaterEqual(confirmed["pullback_bars"], 3)
        self.assertGreater(confirmed["daily_macd"], 0)
        self.assertGreater(confirmed["h4_macd"], 0)

    def test_bearish_bounce_warns_then_confirms_on_zero_cross(self):
        daily, four_hour = _recovery_signs(-1)
        events = detect_events(
            _recovery_hour_bars(BEARISH_HOUR_CLOSES), "sma", daily, four_hour,
        )

        self.assertEqual(
            [(event["direction"], event["stage"]) for event in events],
            [("bearish", "early"), ("bearish", "confirmed")],
        )
        confirmed = events[-1]
        self.assertLessEqual(confirmed["macd"], 0)
        self.assertLess(confirmed["daily_macd"], 0)
        self.assertLess(confirmed["h4_macd"], 0)

    def test_oscillation_around_zero_never_confirms_a_pullback(self):
        daily, four_hour = _recovery_signs(1)
        closes = [100 + (1 if index % 2 else -1) for index in range(60)]

        events = detect_events(_recovery_hour_bars(closes), "sma", daily, four_hour)

        self.assertEqual(events, [])

    def test_losing_trend_alignment_cancels_the_setup(self):
        daily, four_hour = _recovery_signs(1)
        # Flip the daily filter bearish halfway through: no bullish recovery may fire.
        flipped = daily[:20] + [(when, -value) for when, value in daily[20:]]
        events = detect_events(
            _recovery_hour_bars(BULLISH_HOUR_CLOSES), "sma", flipped, four_hour,
        )

        self.assertEqual([event for event in events if event["direction"] == "bullish"], [])

    def test_ema_trigger_confirms_on_a_longer_series(self):
        daily, four_hour = _recovery_signs(1)
        closes = [100.0] * 110 + BULLISH_HOUR_CLOSES[12:]
        events = detect_events(_recovery_hour_bars(closes), "ema", daily, four_hour)

        stages = [(event["direction"], event["stage"]) for event in events]
        self.assertIn(("bullish", "confirmed"), stages)

    def test_macd_series_needs_warmup_bars(self):
        macd = macd_series([100.0] * 9, *(("sma", 3), ("sma", 10)))
        self.assertTrue(all(value is None for value in macd))
        macd = macd_series([100.0] * 10, *(("sma", 3), ("sma", 10)))
        self.assertEqual(macd[-1], 0)


class TrendRecoveryApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_trend_recovery_alert_is_created_with_defaults(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "trend_recovery", "timeframe": "1h",
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["kind"], "trend_recovery")
        self.assertEqual(response.data["condition"], "cross")
        self.assertEqual(response.data["recovery_trigger"], "sma")
        self.assertIsNone(response.data["recovery_last_bar_time"])

    def test_trend_recovery_accepts_ema_trigger(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "trend_recovery", "timeframe": "1h",
            "recovery_trigger": "ema",
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["recovery_trigger"], "ema")

    def test_trend_recovery_rejects_other_timeframes_and_triggers(self):
        for payload in (
            {"timeframe": "4h"},
            {"timeframe": "1h", "recovery_trigger": "wma"},
        ):
            with self.subTest(payload=payload):
                response = self.client.post("/api/alerts/", {
                    "symbol": "BTCUSDT", "kind": "trend_recovery", **payload,
                }, format="json")
                self.assertEqual(response.status_code, 400)


class TrendRecoveryCheckerTests(TestCase):
    HOUR_START = 1_700_000_000

    def _hour_bars(self, count):
        return [
            {"time": self.HOUR_START + index * 3600, "close": 100 + index}
            for index in range(count)
        ]

    def _recovery_event(self, bar_time, stage="confirmed", direction="bullish"):
        return {
            "bar_time": bar_time, "direction": direction, "stage": stage,
            "macd": 0.5, "close": 105.0, "daily_macd": 1.0, "h4_macd": 0.5,
            "pullback_bars": 5,
        }

    @patch("alerts.recovery.detect_events")
    @patch("alerts.recovery.trend_signs", return_value=[(0, 1.0)])
    def test_checker_arms_then_fires_each_cycle_once(self, _signs, detect_events):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.TREND_RECOVERY,
            condition=Alert.Condition.CROSS, timeframe="1h",
            frequency=Alert.Frequency.EVERY,
        )
        candles = {
            "1h": self._hour_bars(3),
            "4h": [{"time": 0, "close": 1}],
            "1d": [{"time": 0, "close": 1}],
        }

        with patch("alerts.services._closed_bars",
                   side_effect=lambda s, t, e, l: candles[t]):
            detect_events.return_value = []
            check_recovery_alerts()
            alert.refresh_from_db()
            self.assertIsNotNone(alert.recovery_last_bar_time)
            self.assertEqual(TriggerEvent.objects.count(), 0)

            # Two new closed bars arrive carrying an early warning and a confirmation.
            candles["1h"] = self._hour_bars(5)
            new_close = candles["1h"][-1]["time"] + 3600
            detect_events.return_value = [
                self._recovery_event(new_close - 3600, stage="early"),
                self._recovery_event(new_close, stage="confirmed"),
            ]
            check_recovery_alerts()

            titles = list(TriggerEvent.objects.order_by("id").values_list("title", flat=True))
            self.assertEqual(titles, [
                "BTCUSDT Trend Recovery - Bullish Early Warning",
                "BTCUSDT Trend Recovery - Bullish Pullback Recovery",
            ])
            event = TriggerEvent.objects.get(title=titles[1])
            self.assertIn("Status: Confirmed - Bullish pullback recovery", event.message)
            self.assertIn("Trigger: SMA 3/10 (1h)", event.message)
            self.assertIn("MACD 1d (EMA 19/39): 1.00", event.message)
            alert.refresh_from_db()
            self.assertIsNotNone(alert.last_triggered_at)
            self.assertTrue(alert.active)

            # The same bars evaluated again must not duplicate the cycle's events.
            check_recovery_alerts()
            self.assertEqual(TriggerEvent.objects.count(), 2)

    @patch("alerts.recovery.detect_events")
    @patch("alerts.recovery.trend_signs", return_value=[(0, 1.0)])
    def test_once_alert_deactivates_on_confirmed_recovery(self, _signs, detect_events):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.TREND_RECOVERY,
            condition=Alert.Condition.CROSS, timeframe="1h",
            frequency=Alert.Frequency.ONCE,
        )
        candles = {
            "1h": self._hour_bars(3),
            "4h": [{"time": 0, "close": 1}],
            "1d": [{"time": 0, "close": 1}],
        }

        with patch("alerts.services._closed_bars",
                   side_effect=lambda s, t, e, l: candles[t]):
            detect_events.return_value = []
            check_recovery_alerts()
            candles["1h"] = self._hour_bars(4)
            new_close = candles["1h"][-1]["time"] + 3600
            detect_events.return_value = [self._recovery_event(new_close)]
            check_recovery_alerts()

        alert.refresh_from_db()
        self.assertFalse(alert.active)

    def test_check_alerts_skips_trend_recovery_kind(self):
        Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.TREND_RECOVERY,
            condition=Alert.Condition.CROSS, timeframe="1h",
        )
        with patch("alerts.services._closed_bars") as closed_bars:
            check_alerts()
        closed_bars.assert_not_called()



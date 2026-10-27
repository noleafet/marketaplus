import base64
import json
from datetime import timedelta
from unittest.mock import ANY, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
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
from .prediction import (
    STAGE_A_SCORE_WEIGHTS, stage_a_breakout, stage_a_evaluate, stage_a_setup,
    stage_a_snapshot, stage_b_signal,
)
from .services import (
    _closed_bars, _ema, _ema_crossed, _ema_signal, _macd_approach_thresholds, _notify,
    _trend_signal, _volume_percent, check_alerts, check_prediction_alerts,
    get_market_candles, get_market_quote,
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


class EmaCrossApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_ema_cross_defaults(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "btcusdt", "kind": "ema", "condition": "cross", "timeframe": "15m",
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["symbol"], "BTCUSDT")
        self.assertEqual(response.data["ema_period"], 100)
        self.assertTrue(response.data["rsi_enabled"])
        self.assertTrue(response.data["macd_context_enabled"])
        self.assertEqual(response.data["macd_context_timeframe"], "1h")
        self.assertEqual(response.data["rsi_timeframe"], "15m")

    def test_ema_cross_accepts_its_options(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "ema", "condition": "cross", "timeframe": "1h",
            "ema_period": 200, "rsi_timeframe": "5m", "macd_context_enabled": False,
            "macd_context_timeframe": "4h",
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["ema_period"], 200)
        self.assertEqual(response.data["rsi_timeframe"], "5m")
        self.assertFalse(response.data["macd_context_enabled"])
        self.assertEqual(response.data["macd_context_timeframe"], "4h")

    def test_ema_cross_rejects_unsupported_period_and_contexts(self):
        cases = (
            ("ema_period", {"ema_period": 50}),
            ("timeframe", {"timeframe": "2h"}),
            ("rsi_timeframe", {"rsi_timeframe": "2h"}),
            ("macd_context_timeframe", {"macd_context_timeframe": "2h"}),
        )
        for field, values in cases:
            with self.subTest(field=field):
                payload = {
                    "symbol": "BTCUSDT", "kind": "ema", "condition": "cross",
                    "timeframe": "1h", **values,
                }
                response = self.client.post("/api/alerts/", payload, format="json")

                self.assertEqual(response.status_code, 400)
                self.assertIn(field, response.data)

    def test_changing_ema_timeframe_moves_default_rsi(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "ema", "condition": "cross", "timeframe": "1h",
        }, format="json")
        alert_id = response.data["id"]

        response = self.client.patch(
            f"/api/alerts/{alert_id}/", {"timeframe": "4h"}, format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["rsi_timeframe"], "4h")


@override_settings(FRONTEND_URL="http://localhost:3000")
class EmaCrossEvaluationTests(TestCase):
    @patch("alerts.services._macd_signal")
    @patch("alerts.services._rsi_signal")
    @patch("alerts.services._ema_signal")
    def test_ema_cross_uses_requested_message_format(self, ema_signal, rsi_signal, macd_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.EMA, condition=Alert.Condition.CROSS,
            timeframe="1h", frequency=Alert.Frequency.EVERY,
            last_bar_open_time=timezone.now() - timedelta(hours=2),
        )
        bar_time = timezone.now() - timedelta(hours=1)
        ema_signal.return_value = {
            "bar_time": bar_time, "close": 82567.344, "ema": 82000,
            "previous_close": 81000, "previous_ema": 82100,
            "volume_percent": 150.0,
        }
        rsi_signal.return_value = {"bar_time": bar_time, "rsi": 75, "close": 82567.344}
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": 0.2, "current_diff": -0.3,
            "close": 82567.344, "macd": 1, "signal": 1.3, "atr": 1,
        }

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(event.title, "BTCUSDT(1h) EMA Crossed - Bullish")
        self.assertIn("Status: Bullish", event.message)
        self.assertIn("Current Price: $82,567.344", event.message)
        self.assertIn("RSI: 75 Bullish", event.message)
        self.assertIn("MACD: Bearish", event.message)
        self.assertIn("Volume: 150%", event.message)
        self.assertLess(event.message.index("Volume: 150%"), event.message.index("Report:"))
        self.assertIn(
            "Report: http://localhost:3000/report/?token=BTCUSDT&interval=1h&time=",
            event.message,
        )
        ema_signal.assert_called_once_with("BTCUSDT", "1h", ANY, 100)
        rsi_signal.assert_called_once_with("BTCUSDT", "1h", ANY, 14)
        macd_signal.assert_called_once_with("BTCUSDT", "1h", ANY)

    @patch("alerts.services._macd_signal", return_value=None)
    @patch("alerts.services._rsi_signal", return_value=None)
    @patch("alerts.services._ema_signal")
    def test_bearish_cross_is_reported(self, ema_signal, _rsi_signal, _macd_signal):
        alert = Alert.objects.create(
            symbol="ETHUSDT", kind=Alert.Kind.EMA, condition=Alert.Condition.CROSS,
            timeframe="4h", frequency=Alert.Frequency.EVERY, ema_period=200,
            last_bar_open_time=timezone.now() - timedelta(hours=8),
        )
        bar_time = timezone.now() - timedelta(hours=4)
        ema_signal.return_value = {
            "bar_time": bar_time, "close": 2000, "ema": 2100,
            "previous_close": 2200, "previous_ema": 2150,
        }

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertEqual(event.title, "ETHUSDT(4h) EMA Crossed - Bearish")
        self.assertIn("RSI: –", event.message)
        self.assertIn("MACD: –", event.message)
        self.assertIn("interval=4h", event.message)
        ema_signal.assert_called_once_with("ETHUSDT", "4h", ANY, 200)

    @patch("alerts.services._macd_signal")
    @patch("alerts.services._rsi_signal", return_value=None)
    @patch("alerts.services._ema_signal")
    def test_no_side_change_does_not_alert(self, ema_signal, _rsi_signal, macd_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.EMA, condition=Alert.Condition.CROSS,
            timeframe="1h", frequency=Alert.Frequency.EVERY, macd_context_enabled=False,
            last_bar_open_time=timezone.now() - timedelta(hours=2),
        )
        bar_time = timezone.now() - timedelta(hours=1)
        ema_signal.return_value = {
            "bar_time": bar_time, "close": 83000, "ema": 82000,
            "previous_close": 82500, "previous_ema": 82100,
        }

        check_alerts()

        self.assertFalse(TriggerEvent.objects.exists())
        macd_signal.assert_not_called()

    @patch("alerts.services._macd_signal")
    @patch("alerts.services._rsi_signal", return_value=None)
    @patch("alerts.services._ema_signal")
    def test_first_observation_arms_without_replaying(self, ema_signal, _rsi_signal, macd_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.EMA, condition=Alert.Condition.CROSS,
            timeframe="1h", frequency=Alert.Frequency.EVERY, macd_context_enabled=False,
        )
        bar_time = timezone.now() - timedelta(hours=1)
        ema_signal.return_value = {
            "bar_time": bar_time, "close": 83000, "ema": 82000,
            "previous_close": 81000, "previous_ema": 82100,
        }

        check_alerts()

        self.assertFalse(TriggerEvent.objects.exists())
        alert.refresh_from_db()
        self.assertEqual(alert.last_bar_open_time, bar_time)
        macd_signal.assert_not_called()

    @patch("alerts.services._macd_signal")
    @patch("alerts.services._rsi_signal", return_value=None)
    @patch("alerts.services._ema_signal")
    def test_macd_context_can_be_disabled(self, ema_signal, _rsi_signal, macd_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.EMA, condition=Alert.Condition.CROSS,
            timeframe="1h", frequency=Alert.Frequency.EVERY, macd_context_enabled=False,
            last_bar_open_time=timezone.now() - timedelta(hours=2),
        )
        bar_time = timezone.now() - timedelta(hours=1)
        ema_signal.return_value = {
            "bar_time": bar_time, "close": 82567.344, "ema": 82000,
            "previous_close": 81000, "previous_ema": 82100,
        }

        check_alerts()

        event = TriggerEvent.objects.get(alert=alert)
        self.assertNotIn("MACD:", event.message)
        macd_signal.assert_not_called()

    def test_ema_cross_helper_requires_opposite_sides(self):
        self.assertEqual(_ema_crossed(10, 15, 30, 25), (True, 1))
        self.assertEqual(_ema_crossed(30, 25, 10, 15), (True, -1))
        self.assertEqual(_ema_crossed(30, 25, 35, 27), (False, 1))
        self.assertEqual(_ema_crossed(20, 20, 30, 25), (False, 1))

    @patch("alerts.services._candles_for")
    def test_ema_signal_returns_previous_and_current_closes(self, candles_for):
        closed_at = int(timezone.now().timestamp() * 1000) - 60_000
        candles_for.return_value = [
            [index, 0, 0, 0, close, 0, closed_at - (2 - index) * 60_000]
            for index, close in enumerate((20, 10, 30))
        ]

        signal = _ema_signal("BTCUSDT", "1m", ANY, 2)

        self.assertEqual(signal["previous_close"], 10)
        self.assertEqual(signal["previous_ema"], 15)
        self.assertEqual(signal["close"], 30)
        self.assertEqual(signal["ema"], 25)

    def test_volume_percent_compares_with_previous_twenty_candles(self):
        closed = [[0, 0, 0, 0, 1, 1, 0] for _ in range(20)]
        closed.append([0, 0, 0, 0, 1, 1.5, 0])

        self.assertEqual(_volume_percent(closed), 150)
        self.assertIsNone(_volume_percent(closed[:20]))

    @patch("alerts.services._candles_for")
    def test_ema_signal_includes_volume_percent(self, candles_for):
        closed_at = int(timezone.now().timestamp() * 1000) - 60_000
        volumes = [1] * 20 + [1.5]
        candles_for.return_value = [
            [index, 0, 0, 0, 1, volume, closed_at - (len(volumes) - 1 - index) * 60_000]
            for index, volume in enumerate(volumes)
        ]

        signal = _ema_signal("BTCUSDT", "1m", ANY, 2)

        self.assertEqual(signal["volume_percent"], 150)

    @patch("alerts.services._candles_for")
    def test_ema_signal_ignores_the_forming_candle_for_volume(self, candles_for):
        now_ms = int(timezone.now().timestamp() * 1000)
        volumes = [1] * 20 + [1.5, 9]
        candles_for.return_value = [
            [
                index, 0, 0, 0, 1, volume,
                now_ms + 60_000 if index == len(volumes) - 1
                else now_ms - (len(volumes) - 1 - index) * 60_000,
            ]
            for index, volume in enumerate(volumes)
        ]

        signal = _ema_signal("BTCUSDT", "1m", ANY, 2)

        # The still-forming candle (volume 9) must not affect either side of the ratio.
        self.assertEqual(signal["volume_percent"], 150)


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
        self.assertEqual(
            _macd_approach_thresholds(-0.04, -0.06, 4, 6, Alert.Condition.CROSS_UP, 5),
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
class PredictionRuleTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def _snapshot(self, **overrides):
        support = {
            "kind": "support", "price": 100.0, "low": 99.5, "high": 100.5,
            "strength": 82, "reactions": 3, "factors": {},
        }
        broken_resistance = {
            "kind": "resistance", "price": 100.0, "low": 99.5, "high": 100.5,
            "strength": 82, "reactions": 3, "factors": {},
        }
        resistance = {
            "kind": "resistance", "price": 101.0, "low": 100.5, "high": 101.5,
            "strength": 82, "reactions": 3, "factors": {},
        }
        snapshot = {
            "bar_time": timezone.now(),
            "close": 100.5,
            "previous_close": 99.0,
            "atr": 2.0,
            "bb_width": 0.01,
            "bb_width_previous": 0.009,
            "bb_percentile": 0.10,
            "bb_expanding": True,
            "volume_ratio": 2.0,
            "rsi": 60.0,
            "ema": 95.0,
            "ema_period": 100,
            "levels": {
                "supports": [support],
                "resistances": [resistance],
                "all": [support, broken_resistance, resistance],
            },
        }
        snapshot.update(overrides)
        return snapshot

    def _level(self, kind, price, strength=82):
        return {
            "kind": kind, "price": price, "low": price - 0.5, "high": price + 0.5,
            "strength": strength, "reactions": 3, "factors": {},
        }

    def _stage_a_snapshot(self, **overrides):
        support = self._level("support", 100.0)
        resistance = self._level("resistance", 101.0)
        next_resistance = self._level("resistance", 106.0)
        main = {
            "close": 100.5, "ema": 95.0, "ema_period": 100, "rsi": 60.0,
        }
        context = {
            "close": 110.0, "ema": 100.0, "ema_period": 100, "rsi": 55.0,
        }
        recent = [{
            "time": 1, "open": 100.4, "high": 100.7, "low": 100.2, "close": 100.5,
            "volume": 100.0,
        }]
        snapshot = {
            "timeframe": "1h",
            "context_timeframe": "4h",
            "refinement_timeframe": "15m",
            "bar_time": timezone.now(),
            "close": 100.5,
            "previous_close": 99.0,
            "atr": 2.0,
            "atr_previous": 1.8,
            "atr_expanding": True,
            "bb_width": 0.01,
            "bb_width_previous": 0.009,
            "bb_percentile": 0.10,
            "bb_squeeze": True,
            "bb_expanding": True,
            "volume_ratio": 2.0,
            "rsi": 60.0,
            "ema": 95.0,
            "ema_period": 100,
            "levels": {
                "supports": [support],
                "resistances": [resistance, next_resistance],
                "all": [support, resistance, next_resistance],
            },
            "main": main,
            "context": context,
            "refinement": {
                "bar_time": timezone.now(), "close": 100.5, "high": 100.7,
                "low": 100.2, "recent": recent,
            },
        }
        snapshot.update(overrides)
        return snapshot

    def _bars(self, count, start, seconds, base=100.0, step=0.05):
        bars = []
        for index in range(count):
            close = base + index * step
            bars.append({
                "time": start + index * seconds,
                "open": close - 0.02,
                "high": close + 0.10,
                "low": close - 0.10,
                "close": close,
                "volume": 100.0,
            })
        return bars

    def test_stage_a_early_warning_requires_squeeze_and_proximity(self):
        signal = stage_a_setup(self._stage_a_snapshot())
        self.assertIsNotNone(signal)
        self.assertEqual(signal["event"], "early")
        self.assertEqual(signal["direction"], "long")
        self.assertAlmostEqual(signal["distance_atr"], 0.25)
        self.assertFalse(signal["high_confluence"])

        self.assertIsNone(stage_a_setup(self._stage_a_snapshot(bb_squeeze=False)))
        weak = self._level("support", 100.0, strength=50)
        self.assertIsNone(stage_a_setup(self._stage_a_snapshot(
            levels={"supports": [weak], "resistances": [], "all": [weak]},
        )))
        far = self._level("support", 97.0)
        self.assertIsNone(stage_a_setup(self._stage_a_snapshot(
            levels={"supports": [far], "resistances": [], "all": [far]},
        )))

    def test_stage_a_direction_follows_the_level_side(self):
        self.assertEqual(stage_a_setup(self._stage_a_snapshot())["direction"], "long")

        resistance = self._level("resistance", 100.0)
        short = stage_a_setup(self._stage_a_snapshot(
            close=99.5, previous_close=100.0, rsi=40.0, ema=105.0,
            main={"close": 99.5, "ema": 105.0, "ema_period": 100, "rsi": 40.0},
            context={"close": 90.0, "ema": 95.0, "ema_period": 100, "rsi": 40.0},
            levels={"supports": [], "resistances": [resistance], "all": [resistance]},
        ))
        self.assertEqual(short["direction"], "short")

    def test_stage_a_breakout_requires_buffer_crossing_and_volume(self):
        # Resistance 101 + 0.25 × ATR (2.0) = 101.5, so a 101.8 close triggers.
        breakout = stage_a_breakout(self._stage_a_snapshot(
            close=101.8, previous_close=101.0,
        ))
        self.assertIsNotNone(breakout)
        self.assertEqual(breakout["event"], "breakout")
        self.assertEqual(breakout["direction"], "long")
        self.assertAlmostEqual(breakout["breakout_atr"], 0.4)
        self.assertTrue(breakout["high_confluence"])
        self.assertGreaterEqual(breakout["score"], 80)

        # No fresh crossing: the prior completed candle is already above the buffer.
        self.assertIsNone(stage_a_breakout(self._stage_a_snapshot(
            close=101.8, previous_close=101.6,
        )))
        # A close exactly at the level does not clear the 0.25 × ATR buffer.
        self.assertIsNone(stage_a_breakout(self._stage_a_snapshot(
            close=101.0, previous_close=100.0,
        )))
        # Volume below 1.5× average blocks the trigger even with a strong score.
        self.assertIsNone(stage_a_breakout(self._stage_a_snapshot(
            close=101.8, previous_close=101.0, volume_ratio=1.4,
        )))

    def test_stage_a_breakout_can_be_short(self):
        support = self._level("support", 100.0)
        short = stage_a_breakout(self._stage_a_snapshot(
            close=99.2, previous_close=100.0,
            main={"close": 99.2, "ema": 105.0, "ema_period": 100, "rsi": 40.0},
            context={"close": 90.0, "ema": 95.0, "ema_period": 100, "rsi": 40.0},
            levels={"supports": [support], "resistances": [], "all": [support]},
        ))
        self.assertIsNotNone(short)
        self.assertEqual(short["direction"], "short")
        self.assertAlmostEqual(short["breakout_atr"], 0.4)

    def test_stage_a_score_is_configurable_and_breakout_cannot_be_bypassed(self):
        default = stage_a_breakout(self._stage_a_snapshot(
            close=101.8, previous_close=101.0,
        ))
        penalized = stage_a_breakout(self._stage_a_snapshot(
            close=101.8, previous_close=101.0,
        ), weights={"squeeze": 0, "volume": 0})
        self.assertGreater(default["score"], penalized["score"])
        self.assertEqual(set(STAGE_A_SCORE_WEIGHTS), set(default["score_breakdown"]))

        # Even with weights inflated to 100 each, an early setup stays an early setup.
        inflated = {name: 100 for name in STAGE_A_SCORE_WEIGHTS}
        event, state = stage_a_evaluate(
            self._stage_a_snapshot(), None, weights=inflated,
        )
        self.assertEqual(event["event"], "early")
        self.assertGreaterEqual(event["score"], 80)
        self.assertFalse(event["high_confluence"])
        self.assertEqual(state["state"], "early")

    def test_stage_a_high_confluence_needs_trend_rsi_atr_and_room(self):
        # Strong trigger and score, but the 4H trend opposes the long direction.
        signal = stage_a_breakout(self._stage_a_snapshot(
            close=101.8, previous_close=101.0,
            context={"close": 90.0, "ema": 110.0, "ema_period": 100, "rsi": 45.0},
        ))
        self.assertIsNotNone(signal)
        self.assertGreaterEqual(signal["score"], 80)
        self.assertFalse(signal["high_confluence"])

        # Ample room to the next opposing level is part of high confluence.
        close_room = self._level("resistance", 102.0)
        support = self._level("support", 100.0)
        broken = self._level("resistance", 101.0)
        no_room = stage_a_breakout(self._stage_a_snapshot(
            close=101.8, previous_close=101.0,
            levels={
                "supports": [support],
                "resistances": [broken, close_room],
                "all": [support, broken, close_room],
            },
        ))
        self.assertFalse(no_room["high_confluence"])

    def test_closed_bars_drops_the_still_forming_candle(self):
        candles = [
            [1000, "1", "2", "0.5", "1.5", "10", 1999],
            [2000, "1.5", "2.5", "1", "2", "11", 2999],
        ]
        with patch("alerts.services._candles_for", return_value=candles), patch(
            "alerts.services.time.time", return_value=2.5,
        ):
            bars = _closed_bars("BTCUSDT", "1m", Exchange.load(), 2)

        self.assertEqual([bar["time"] for bar in bars], [1])

    def test_stage_a_snapshot_clips_newer_context_and_refinement_candles(self):
        main_bars = self._bars(130, 0, 3600)
        main_close = main_bars[-1]["time"] + 3600
        context_bars = self._bars(130, main_close - 130 * 14400, 14400)
        refinement_bars = self._bars(20, main_close - 20 * 900, 900)
        future_context = dict(refinement_bars[-1], time=main_close, high=999.0)
        future_refinement = dict(refinement_bars[-1], time=main_close, high=999.0)
        context_bars.append(future_context)
        refinement_bars.append(future_refinement)

        snapshot = stage_a_snapshot(
            context_bars, main_bars, refinement_bars, ema_period=100,
        )
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["refinement"]["recent"][-1]["time"], main_close - 900)
        self.assertLessEqual(
            snapshot["context"]["bar_time"].timestamp(),
            main_bars[-1]["time"],
        )

    def test_stage_a_fetches_the_three_timeframes(self):
        Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PREDICTION, condition=Alert.Condition.CROSS,
            timeframe="1h", prediction_stage_a=True, prediction_stage_b=False,
        )
        with patch("alerts.services._closed_bars", return_value=[{}]) as bars, patch(
            "alerts.services.stage_a_snapshot", return_value=self._stage_a_snapshot(),
        ):
            check_prediction_alerts()

        timeframes = [call.args[1] for call in bars.call_args_list]
        self.assertEqual(set(timeframes), {"4h", "1h", "15m"})

    def test_stage_a_state_machine_prevents_duplicate_early_warnings(self):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PREDICTION, condition=Alert.Condition.CROSS,
            timeframe="1h", prediction_stage_a=True, prediction_stage_b=False,
        )
        bar_time = timezone.now()
        early = self._stage_a_snapshot(bar_time=bar_time)
        with patch("alerts.services._closed_bars", return_value=[{}]), patch(
            "alerts.services.stage_a_snapshot", return_value=early,
        ) as snapshot:
            first = check_prediction_alerts()
            self.assertEqual(len(first), 1)
            self.assertEqual(
                first[0].title, "BTCUSDT(1h) Prediction A - Early Warning - Bullish",
            )
            self.assertEqual(check_prediction_alerts(), [])

            snapshot.return_value = self._stage_a_snapshot(
                bar_time=bar_time + timedelta(hours=1),
            )
            self.assertEqual(check_prediction_alerts(), [])

            # The squeeze clears; the next episode may warn again.
            snapshot.return_value = self._stage_a_snapshot(
                bar_time=bar_time + timedelta(hours=2), bb_squeeze=False,
                bb_percentile=0.5,
            )
            self.assertEqual(check_prediction_alerts(), [])
            alert.refresh_from_db()
            self.assertEqual(alert.prediction_a_state, "idle")

            snapshot.return_value = self._stage_a_snapshot(
                bar_time=bar_time + timedelta(hours=3),
            )
            self.assertEqual(len(check_prediction_alerts()), 1)

    def test_stage_a_breakout_then_failed_breakout_reports_once(self):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PREDICTION, condition=Alert.Condition.CROSS,
            timeframe="1h", prediction_stage_a=True, prediction_stage_b=False,
        )
        bar_time = timezone.now()
        breakout = self._stage_a_snapshot(
            bar_time=bar_time, close=101.8, previous_close=101.0,
        )
        with patch("alerts.services._closed_bars", return_value=[{}]), patch(
            "alerts.services.stage_a_snapshot", return_value=breakout,
        ) as snapshot:
            first = check_prediction_alerts()
            self.assertEqual(
                first[0].title,
                "BTCUSDT(1h) Prediction A - Breakout · High Confluence - Bullish",
            )
            alert.refresh_from_db()
            self.assertEqual(alert.prediction_a_state, "breakout")

            # The same completed bar must not repeat the breakout on another poll.
            self.assertEqual(check_prediction_alerts(), [])

            snapshot.return_value = self._stage_a_snapshot(
                bar_time=bar_time + timedelta(hours=1),
                close=101.2, previous_close=101.8,
            )
            failed = check_prediction_alerts()
            self.assertEqual(
                failed[0].title, "BTCUSDT(1h) Prediction A - Failed Breakout - Bullish",
            )
            alert.refresh_from_db()
            self.assertEqual(alert.prediction_a_state, "idle")

            # A repeat poll of the failure bar stays quiet.
            self.assertEqual(check_prediction_alerts(), [])

    def test_stage_a_breakout_state_ignores_the_same_level_but_allows_a_new_one(self):
        state = {
            "state": "breakout", "direction": "long",
            "level": self._level("resistance", 99.0), "score": 90,
            "high_confluence": True,
        }
        snapshot = self._stage_a_snapshot(close=101.8, previous_close=101.0)
        event, state = stage_a_evaluate(snapshot, state)
        self.assertEqual(event["event"], "breakout")
        self.assertAlmostEqual(state["level"]["price"], 101.0)

        repeat, state = stage_a_evaluate(snapshot, state)
        self.assertIsNone(repeat)
        self.assertAlmostEqual(state["level"]["price"], 101.0)

    def test_stage_a_breakout_suppresses_duplicate_stage_b_event(self):
        Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PREDICTION, condition=Alert.Condition.CROSS,
            timeframe="1h", prediction_stage_a=True, prediction_stage_b=True,
        )
        bar_time = timezone.now()
        with patch("alerts.services._closed_bars", return_value=[{}]), patch(
            "alerts.services.stage_a_snapshot",
            return_value=self._stage_a_snapshot(
                bar_time=bar_time, close=101.8, previous_close=101.0,
            ),
        ), patch(
            "alerts.services.prediction_snapshot",
            return_value=self._snapshot(bar_time=bar_time),
        ):
            events = check_prediction_alerts()

        self.assertEqual(len(events), 1)
        self.assertIn("Prediction A - Breakout", events[0].title)

    def test_stage_b_confirms_long_and_short_breakouts(self):
        long_signal = stage_b_signal(self._snapshot())
        self.assertEqual(long_signal["direction"], "long")

        support = {
            "kind": "support", "price": 100.0, "low": 99.5, "high": 100.5,
            "strength": 80, "reactions": 3, "factors": {},
        }
        short_signal = stage_b_signal(self._snapshot(
            close=99.5, previous_close=101.0, rsi=40.0, ema=105.0,
            levels={"supports": [support], "resistances": [], "all": [support]},
        ))
        self.assertEqual(short_signal["direction"], "short")

    def test_stage_b_needs_volume_expansion_and_directional_confirmation(self):
        self.assertIsNone(stage_b_signal(self._snapshot(volume_ratio=1.4)))
        self.assertIsNone(stage_b_signal(self._snapshot(bb_expanding=False)))
        self.assertIsNone(stage_b_signal(self._snapshot(rsi=45.0)))
        self.assertIsNone(stage_b_signal(self._snapshot(ema=105.0)))

    def test_stage_b_checks_each_completed_bar_once(self):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PREDICTION, condition=Alert.Condition.CROSS,
            timeframe="1h", prediction_stage_a=False, prediction_stage_b=True,
        )
        bar_time = timezone.now()
        snapshot = self._snapshot(bar_time=bar_time)
        with patch("alerts.services._closed_bars", return_value=[{}]), patch(
            "alerts.services.prediction_snapshot", return_value=snapshot,
        ) as prediction:
            first = check_prediction_alerts()
            second = check_prediction_alerts()
            self.assertEqual(len(first), 1)
            self.assertEqual(second, [])

            prediction.return_value = self._snapshot(
                bar_time=bar_time + timedelta(hours=1), previous_close=100.5, close=100.7,
            )
            self.assertEqual(check_prediction_alerts(), [])

            prediction.return_value = self._snapshot(
                bar_time=bar_time + timedelta(hours=2), previous_close=99.9, close=100.5,
            )
            third = check_prediction_alerts()
            self.assertEqual(len(third), 1)
            alert.refresh_from_db()
            self.assertEqual(alert.last_bar_open_time, bar_time + timedelta(hours=2))

    def test_stage_b_fires_without_stage_a_ever_triggering(self):
        """Stage 2 stands alone: a confirmed breakout fires even if stage 1 never did.

        Both stages are evaluated independently on every poll, so an alert that watches for
        both must not hold stage B back while stage A waits for a compression setup it never
        gets.
        """
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PREDICTION, condition=Alert.Condition.CROSS,
            timeframe="1h", prediction_stage_a=True, prediction_stage_b=True,
        )
        bar_time = timezone.now()
        # bb_percentile above the 0.20 cutoff keeps stage A silent the whole time; the first
        # bar has no fresh breakout either, so the alert starts clean.
        no_setup = self._stage_a_snapshot(
            bar_time=bar_time, bb_squeeze=False, bb_percentile=0.5,
            previous_close=100.4, close=100.5,
        )
        with patch("alerts.services._closed_bars", return_value=[{}]), patch(
            "alerts.services.prediction_snapshot", return_value=no_setup,
        ) as prediction, patch(
            "alerts.services.stage_a_snapshot", return_value=no_setup,
        ) as stage_a:
            self.assertEqual(check_prediction_alerts(), [])
            alert.refresh_from_db()
            self.assertEqual(alert.prediction_a_state, "idle")
            self.assertEqual(alert.prediction_a_last_bar_time, bar_time)
            self.assertEqual(alert.last_bar_open_time, bar_time)

            # A later completed candle breaks the level while stage A is still silent.
            prediction.return_value = self._snapshot(
                bar_time=bar_time + timedelta(hours=1), bb_percentile=0.5,
            )
            stage_a.return_value = self._stage_a_snapshot(
                bar_time=bar_time + timedelta(hours=1), bb_squeeze=False,
                bb_percentile=0.5, previous_close=100.4, close=100.5,
            )
            second = check_prediction_alerts()

        self.assertEqual(
            [event.title for event in second], ["BTCUSDT(1h) Prediction B - Bullish"],
        )
        self.assertFalse(
            TriggerEvent.objects.filter(alert=alert, title__contains="Prediction A").exists()
        )

    def test_stage_a_message_uses_alert_format_and_report(self):
        Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PREDICTION, condition=Alert.Condition.CROSS,
            timeframe="1h", prediction_stage_a=True, prediction_stage_b=False,
        )
        with patch("alerts.services._closed_bars", return_value=[{}]), patch(
            "alerts.services.stage_a_snapshot", return_value=self._stage_a_snapshot(),
        ):
            events = check_prediction_alerts()

        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(
            event.title, "BTCUSDT(1h) Prediction A - Early Warning - Bullish",
        )
        self.assertIn("Status: Early warning - Bullish", event.message)
        self.assertIn("Current Price: $100.500", event.message)
        self.assertIn("RSI (1h): 60 Bullish-Balanced", event.message)
        self.assertIn("EMA 100 (1h): 95.00 Bullish", event.message)
        self.assertIn("EMA 100 (4h): 100.00 Bullish", event.message)
        self.assertIn("Volume: 200%", event.message)
        self.assertIn(
            "Level: Support $100.000 (82/100), 0.25×ATR away", event.message,
        )
        self.assertIn("Score: 68/100", event.message)
        self.assertIn(
            "Report: http://localhost:3000/report/?token=BTCUSDT&interval=1h&time=",
            event.message,
        )

    def test_stage_a_high_confluence_message_is_not_a_probability(self):
        Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PREDICTION, condition=Alert.Condition.CROSS,
            timeframe="1h", prediction_stage_a=True, prediction_stage_b=False,
        )
        breakout = self._stage_a_snapshot(close=101.8, previous_close=101.0)
        breakout["refinement"]["recent"] = [{
            "time": 2, "open": 101.6, "high": 101.9, "low": 101.3, "close": 101.8,
            "volume": 100.0,
        }]
        with patch("alerts.services._closed_bars", return_value=[{}]), patch(
            "alerts.services.stage_a_snapshot", return_value=breakout,
        ):
            events = check_prediction_alerts()

        self.assertEqual(len(events), 1)
        message = events[0].message
        self.assertIn("Status: Breakout - Bullish", message)
        self.assertIn("Breakout: Resistance $101.000, 0.40×ATR", message)
        self.assertIn("Score: 97/100 - High confluence", message)
        self.assertIn("Quality: High confluence (not a success probability)", message)
        self.assertIn("Room: 2.10×ATR to next resistance at $106.000", message)
        self.assertIn("15m: Retest held", message)

    def test_stage_b_message_uses_alert_format_and_report(self):
        Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.PREDICTION, condition=Alert.Condition.CROSS,
            timeframe="1h", prediction_stage_a=False, prediction_stage_b=True,
        )
        with patch("alerts.services._closed_bars", return_value=[{}]), patch(
            "alerts.services.prediction_snapshot", return_value=self._snapshot(),
        ):
            events = check_prediction_alerts()

        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event.title, "BTCUSDT(1h) Prediction B - Bullish")
        self.assertIn("Status: Bullish", event.message)
        self.assertIn("Breakout: Resistance $100.000, 0.25×ATR", event.message)
        self.assertIn(
            "Report: http://localhost:3000/report/?token=BTCUSDT&interval=1h&time=",
            event.message,
        )

    def test_prediction_requires_a_timeframe_and_at_least_one_stage(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "btcusdt", "kind": "prediction", "condition": "cross",
            "timeframe": "1h", "prediction_stage_a": True, "prediction_stage_b": False,
            "trend_period": 200, "frequency": "every",
        }, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["symbol"], "BTCUSDT")
        self.assertEqual(response.data["kind"], "prediction")

        response = self.client.post("/api/alerts/", {
            "symbol": "ETHUSDT", "kind": "prediction", "condition": "cross",
            "timeframe": "1h", "prediction_stage_a": False, "prediction_stage_b": False,
        }, format="json")
        self.assertEqual(response.status_code, 400)

        response = self.client.post("/api/alerts/", {
            "symbol": "ETHUSDT", "kind": "prediction", "condition": "cross",
            "timeframe": "2h", "prediction_stage_a": True,
        }, format="json")
        self.assertEqual(response.status_code, 400)

        response = self.client.post("/api/alerts/", {
            "symbol": "ETHUSDT", "kind": "prediction", "condition": "cross",
            "timeframe": "4h", "prediction_stage_a": True, "prediction_stage_b": False,
        }, format="json")
        self.assertEqual(response.status_code, 400)

        # Stage B may still run on a non-1H timeframe when Stage A is disabled.
        response = self.client.post("/api/alerts/", {
            "symbol": "ETHUSDT", "kind": "prediction", "condition": "cross",
            "timeframe": "4h", "prediction_stage_a": False, "prediction_stage_b": True,
        }, format="json")
        self.assertEqual(response.status_code, 201)

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
        self.assertEqual(keys, {"alerts", "predictions", "events"})

    @patch("alerts.engine.check_alerts", return_value=[])
    def test_running_the_alerts_job_returns_captured_output(self, check):
        response = self.client.post("/api/engine/run/", {"job": "alerts"}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["job"], "alerts")
        self.assertEqual(response.data["triggered"], 0)
        self.assertIn("output", response.data)
        check.assert_called_once()

    @patch("alerts.engine.check_prediction_alerts", return_value=[])
    def test_running_the_predictions_job(self, check):
        response = self.client.post("/api/engine/run/", {"job": "predictions"}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["job"], "predictions")
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
        self.assertIn("TradeChartAlerts API", body)
        self.assertIn("/api/engine/run/", body)
        self.assertIn("/api/telegram/find-chat/", body)

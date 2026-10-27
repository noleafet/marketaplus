from datetime import datetime, timezone as dt_timezone
from decimal import Decimal
import html
import logging
import math
import re
import time
from urllib.parse import quote

import requests
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import Alert, AppConfiguration, Exchange, Notification, TriggerEvent
from .prediction import (
    STAGE_A_CONTEXT_TIMEFRAME, STAGE_A_HIGH_CONFLUENCE_SCORE, STAGE_A_MAIN_TIMEFRAME,
    STAGE_A_REFINEMENT_TIMEFRAME, prediction_snapshot, stage_a_evaluate, stage_a_event,
    stage_a_snapshot, stage_b_event, stage_b_signal,
)

logger = logging.getLogger(__name__)
TIMEFRAME_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}
BYBIT_INTERVALS = {"1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "1w": "W"}
VOLUME_AVERAGE_BARS = 20


def _market_request(path, params, exchange):
    if exchange.exchange == Exchange.Name.BYBIT:
        url = f"https://api.bybit.com/v5/market/{path}"
    else:
        url = f"{exchange.exchange_url.rstrip('/')}/{path}"
    response = requests.get(
        url,
        params=params,
        timeout=exchange.exchange_timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if exchange.exchange == Exchange.Name.BYBIT:
        if payload.get("retCode") != 0:
            raise ValueError(payload.get("retMsg") or "Bybit market data request failed.")
        return payload.get("result", {})
    if isinstance(payload, dict) and "code" in payload and "msg" in payload:
        raise ValueError(payload["msg"])
    return payload


def get_market_quote(symbol, exchange):
    if exchange.exchange == Exchange.Name.BYBIT:
        result = _market_request("tickers", {"category": "spot", "symbol": symbol}, exchange)
        item = next(iter(result.get("list", [])), None)
        if item is None:
            raise ValueError(f"{symbol} is not a supported Bybit spot pair.")
        return {"price": float(item["lastPrice"]), "change": float(item["price24hPcnt"]) * 100}
    item = _market_request("ticker/24hr", {"type": "MINI", "symbol": symbol}, exchange)
    price, opening = float(item["lastPrice"]), float(item["openPrice"])
    return {"price": price, "change": (price - opening) / opening * 100 if opening else 0.0}


def _price_for(symbol, exchange):
    return get_market_quote(symbol, exchange)["price"]


def _candles_for(symbol, timeframe, exchange, limit):
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError("Unsupported market timeframe.")
    if exchange.exchange == Exchange.Name.BYBIT:
        result = _market_request("kline", {
            "category": "spot", "symbol": symbol,
            "interval": BYBIT_INTERVALS[timeframe], "limit": str(limit),
        }, exchange)
        duration_ms = TIMEFRAME_SECONDS[timeframe] * 1000
        return [
            [int(candle[0]), candle[1], candle[2], candle[3], candle[4], candle[5], int(candle[0]) + duration_ms - 1]
            for candle in reversed(result.get("list", []))
        ]
    return _market_request("klines", {
        "symbol": symbol, "interval": timeframe, "limit": limit,
    }, exchange)


def get_market_candles(symbol, timeframe, exchange, limit=500):
    candles = _candles_for(symbol, timeframe, exchange, limit)
    return [{
        "time": int(candle[0]) // 1000,
        "open": float(candle[1]),
        "high": float(candle[2]),
        "low": float(candle[3]),
        "close": float(candle[4]),
        "volume": float(candle[5]),
    } for candle in candles]


def _closed_bars(symbol, timeframe, exchange, limit=500):
    """Normalized bars with the still-forming candle removed.

    Prediction rules act on completed candles, so the exchange's newest kline is
    discarded until its close time has passed.
    """
    candles = _candles_for(symbol, timeframe, exchange, limit)
    now_ms = int(time.time() * 1000)
    return [{
        "time": int(candle[0]) // 1000,
        "open": float(candle[1]),
        "high": float(candle[2]),
        "low": float(candle[3]),
        "close": float(candle[4]),
        "volume": float(candle[5]),
    } for candle in candles if int(candle[6]) < now_ms]


def _volume_percent(closed):
    """Latest closed candle's volume as a percentage of the previous 20 candles."""
    if len(closed) < VOLUME_AVERAGE_BARS + 1:
        return None
    baseline = [float(candle[5]) for candle in closed[-VOLUME_AVERAGE_BARS - 1:-1]]
    average = sum(baseline) / len(baseline)
    if average <= 0:
        return None
    return float(closed[-1][5]) / average * 100


def _ema_series(values, length):
    result = [None] * len(values)
    seed = []
    start = None
    alpha = 2 / (length + 1)
    for index, value in enumerate(values):
        if value is None:
            continue
        if start is None:
            start = index
        offset = index - start
        if offset < length:
            seed.append(value)
            if offset == length - 1:
                result[index] = sum(seed) / length
        else:
            result[index] = value * alpha + result[index - 1] * (1 - alpha)
    return result


def _macd_signal(symbol, timeframe, exchange):
    candles = _candles_for(symbol, timeframe, exchange, 300)
    now_ms = int(time.time() * 1000)
    closed = [candle for candle in candles if int(candle[6]) < now_ms]
    if len(closed) < 37:
        return None
    closes = [float(candle[4]) for candle in closed]
    fast, slow = _ema_series(closes, 12), _ema_series(closes, 26)
    macd_line = [f - s if f is not None and s is not None else None for f, s in zip(fast, slow)]
    signal = _ema_series(macd_line, 9)
    index = len(closed) - 1
    if any(value is None for value in (macd_line[index - 1], signal[index - 1], macd_line[index], signal[index])):
        return None
    true_ranges = []
    for candle_index in range(len(closed)):
        candle = closed[candle_index]
        high, low = float(candle[2]), float(candle[3])
        previous_close = float(closed[candle_index - 1][4]) if candle_index else closes[candle_index]
        true_ranges.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
    atr = sum(true_ranges[:14]) / 14
    for true_range in true_ranges[14:]:
        atr = (atr * 13 + true_range) / 14
    return {
        "bar_time": datetime.fromtimestamp(int(closed[index][0]) / 1000, tz=dt_timezone.utc),
        "previous_diff": macd_line[index - 1] - signal[index - 1],
        "current_diff": macd_line[index] - signal[index],
        "close": closes[index],
        "macd": macd_line[index],
        "signal": signal[index],
        "atr": atr,
        "volume_percent": _volume_percent(closed),
    }


def _rsi_signal(symbol, timeframe, exchange, period=14):
    candles = _candles_for(symbol, timeframe, exchange, 500)
    now_ms = int(time.time() * 1000)
    closed = [candle for candle in candles if int(candle[6]) < now_ms]
    if len(closed) < period + 1:
        return None
    closes = [float(candle[4]) for candle in closed]

    gains = []
    losses = []
    for i in range(1, len(closes)):
        change = closes[i] - closes[i - 1]
        gains.append(change if change > 0 else 0)
        losses.append(-change if change < 0 else 0)

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        rsi = 100
    else:
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))

    index = len(closed) - 1
    return {
        "bar_time": datetime.fromtimestamp(int(closed[index][0]) / 1000, tz=dt_timezone.utc),
        "rsi": rsi,
        "close": closes[index],
    }


def _ema(values, period):
    """Exponential moving average seeded with the SMA of the first `period` values."""
    ema = sum(values[:period]) / period
    multiplier = 2 / (period + 1)
    for value in values[period:]:
        ema = (value - ema) * multiplier + ema
    return ema


def _trend_signal(symbol, timeframe, exchange, period=100):
    candles = _candles_for(symbol, timeframe, exchange, max(period + 100, 500))
    now_ms = int(time.time() * 1000)
    closed = [candle for candle in candles if int(candle[6]) < now_ms]
    if len(closed) < period:
        return None
    closes = [float(candle[4]) for candle in closed]
    ema = _ema(closes, period)
    index = len(closed) - 1
    return {
        "bar_time": datetime.fromtimestamp(int(closed[index][0]) / 1000, tz=dt_timezone.utc),
        "ema": ema,
        "close": closes[index],
        "trend": "uptrend" if closes[index] >= ema else "downtrend",
    }


def _ema_signal(symbol, timeframe, exchange, period=100):
    """Return the latest two closed closes and their EMA values for a crossing check."""
    candles = _candles_for(symbol, timeframe, exchange, max(period + 100, 500))
    now_ms = int(time.time() * 1000)
    closed = [candle for candle in candles if int(candle[6]) < now_ms]
    if len(closed) < period + 1:
        return None
    closes = [float(candle[4]) for candle in closed]
    series = _ema_series(closes, period)
    index = len(closed) - 1
    if series[index - 1] is None or series[index] is None:
        return None
    return {
        "bar_time": datetime.fromtimestamp(int(closed[index][0]) / 1000, tz=dt_timezone.utc),
        "close": closes[index],
        "ema": series[index],
        "previous_close": closes[index - 1],
        "previous_ema": series[index - 1],
        "volume_percent": _volume_percent(closed),
    }


def _price_side(close, ema):
    if close > ema:
        return 1
    if close < ema:
        return -1
    return 0


def _ema_crossed(previous_close, previous_ema, close, ema):
    """A cross needs two completed candles on opposite sides of their EMA values."""
    previous_side = _price_side(previous_close, previous_ema)
    current_side = _price_side(close, ema)
    return (
        previous_side != 0 and current_side != 0 and previous_side != current_side,
        current_side,
    )


def _rsi_classification(alert, rsi):
    """Classify RSI momentum as bullish or bearish, adding a balanced qualifier near the middle. Informational only."""
    value = rsi["rsi"]
    if value >= (alert.rsi_overbought or 70):
        return "bullish"
    if value <= (alert.rsi_oversold or 30):
        return "bearish"
    return "bullish-balanced" if value >= 50 else "bearish-balanced"


def _trend_classification(alert, trend):
    """Classify price relative to the EMA as bullish or bearish, adding a balanced qualifier near the EMA. Informational only — never blocks a MACD alert."""
    close, ema = trend["close"], trend["ema"]
    tolerance = ema * 0.001  # within 0.1% of the EMA counts as balanced
    if close > ema + tolerance:
        return "bullish"
    if close < ema - tolerance:
        return "bearish"
    return "bullish-balanced" if close >= ema else "bearish-balanced"


def _format_number(value, decimals=2):
    if value is None or not math.isfinite(value):
        return "–"
    return f"{value:,.{decimals}f}"


def _format_price(value):
    """Current prices are shown with a dollar sign and enough decimals for the pair."""
    if value is None or not math.isfinite(value):
        return "–"
    magnitude = abs(value)
    decimals = 3 if magnitude >= 1 else 5 if magnitude >= 0.01 else 8
    return f"${_format_number(value, decimals)}"


def _format_indicator(value):
    if value is None or not math.isfinite(value):
        return "–"
    magnitude = abs(value)
    decimals = 2 if magnitude >= 1 else 5 if magnitude >= 0.01 else 8
    return _format_number(value, decimals)


def _report_url(alert, bar_time, *, subject=None):
    interval = alert.timeframe
    stamp = bar_time.strftime("%m/%d/%YT%H:%M")
    url = (
        f"{settings.FRONTEND_URL}/report/?token={alert.symbol}"
        f"&interval={interval}&time={stamp}"
    )
    if subject:
        url += f"&subject={quote(subject)}"
    return url


def _rsi_line(alert, rsi):
    timeframe = alert.effective_rsi_timeframe
    if not rsi:
        return f"RSI ({timeframe}): –"
    state = _rsi_classification(alert, rsi).title()
    return f"RSI ({timeframe}): {rsi['rsi']:.0f} {state}"


def _trend_line(alert, trend):
    period = alert.trend_period or 100
    timeframe = alert.effective_trend_timeframe
    if not trend:
        return f"EMA {period} ({timeframe}): –"
    state = _trend_classification(alert, trend).title()
    return f"EMA {period} ({timeframe}): {_format_indicator(trend['ema'])} {state}"


def _volume_line(volume_percent):
    if volume_percent is None or not math.isfinite(volume_percent):
        return "Volume: –"
    return f"Volume: {volume_percent:.0f}%"


def _macd_alert_message(alert, macd, *, status, rsi, trend, distance=None, subject=None):
    lines = [f"Status: {status.capitalize()}"]
    if distance is not None:
        lines.append(f"Distance: {distance:.2f}%")
    lines.extend([
        f"Current Price: {_format_price(macd['close'])}",
        _rsi_line(alert, rsi),
        _trend_line(alert, trend),
        _volume_line(macd.get("volume_percent")),
        f"Report: {_report_url(alert, macd['bar_time'], subject=subject)}",
    ])
    return "\n".join(lines)


def _macd_classification(macd):
    """Classify the MACD line against its signal line for EMA-cross context."""
    if not macd:
        return None
    difference = macd.get("current_diff")
    if difference is None:
        return None
    if difference > 0:
        return "bullish"
    if difference < 0:
        return "bearish"
    return "bullish-balanced"


def _ema_alert_message(alert, ema, *, status, rsi, macd):
    rsi_state = (
        f"{rsi['rsi']:.0f} {_rsi_classification(alert, rsi).title()}"
        if rsi else "–"
    )
    lines = [
        f"Status: {status.capitalize()}",
        f"Current Price: {_format_price(ema['close'])}",
        f"RSI: {rsi_state}",
    ]
    if alert.macd_context_enabled:
        macd_state = _macd_classification(macd)
        lines.append(f"MACD: {macd_state.title() if macd_state else '–'}")
    lines.append(_volume_line(ema.get("volume_percent")))
    lines.append(f"Report: {_report_url(alert, ema['bar_time'])}")
    return "\n".join(lines)


def _prediction_alert_message(alert, snapshot, signal):
    """Format a Stage B prediction event like the MACD and EMA alert messages."""
    status = "Bullish" if signal["direction"] == "long" else "Bearish"
    volume_ratio = snapshot.get("volume_ratio")
    level = signal["level"]
    side = level["kind"].capitalize()
    lines = [
        f"Status: {status}",
        f"Current Price: {_format_price(snapshot['close'])}",
        (
            f"RSI ({alert.timeframe}): {snapshot['rsi']:.0f} "
            f"{_rsi_classification(alert, snapshot).title()}"
        ),
        (
            f"EMA {snapshot['ema_period']} ({alert.timeframe}): "
            f"{_format_indicator(snapshot['ema'])} "
            f"{_trend_classification(alert, snapshot).title()}"
        ),
        _volume_line(volume_ratio * 100 if volume_ratio is not None else None),
        (
            f"Breakout: {side} {_format_price(level['price'])}, "
            f"{signal['breakout_atr']:.2f}×ATR"
        ),
    ]
    if alert.note:
        lines.append(f"Note: {alert.note}")
    lines.append(f"Report: {_report_url(alert, snapshot['bar_time'])}")
    return "\n".join(lines)


def _stage_a_alert_message(alert, snapshot, signal):
    """Format a Stage A event with its multi-timeframe context and quality score."""
    bias = "Bullish" if signal["direction"] == "long" else "Bearish"
    event = signal.get("event")
    status = {
        "early": f"Early warning - {bias}",
        "breakout": f"Breakout - {bias}",
        "failed": f"Failed breakout - {bias}",
    }.get(event, bias)

    timeframe = snapshot.get("timeframe", alert.timeframe)
    context_timeframe = snapshot.get("context_timeframe", STAGE_A_CONTEXT_TIMEFRAME)
    context = snapshot.get("context") or {}
    volume_ratio = snapshot.get("volume_ratio")
    level = signal["level"]
    side = level["kind"].capitalize()

    lines = [
        f"Status: {status}",
        f"Current Price: {_format_price(snapshot['close'])}",
        (
            f"RSI ({timeframe}): {snapshot['rsi']:.0f} "
            f"{_rsi_classification(alert, snapshot).title()}"
        ),
        (
            f"EMA {snapshot['ema_period']} ({timeframe}): "
            f"{_format_indicator(snapshot['ema'])} "
            f"{_trend_classification(alert, snapshot).title()}"
        ),
    ]
    if context.get("ema") is not None:
        lines.append(
            f"EMA {context.get('ema_period', snapshot['ema_period'])} ({context_timeframe}): "
            f"{_format_indicator(context['ema'])} "
            f"{_trend_classification(alert, context).title()}"
        )
    lines.append(_volume_line(volume_ratio * 100 if volume_ratio is not None else None))

    if event == "early":
        lines.append(
            f"Level: {side} {_format_price(level['price'])} "
            f"({level['strength']}/100), {signal['distance_atr']:.2f}×ATR away"
        )
    elif event == "breakout":
        lines.append(
            f"Breakout: {side} {_format_price(level['price'])}, "
            f"{signal['breakout_atr']:.2f}×ATR"
        )
    else:
        failed_atr = signal.get("failed_atr")
        detail = f", {failed_atr:.2f}×ATR back inside" if failed_atr is not None else ""
        lines.append(
            f"Failed: {side} {_format_price(level['price'])}{detail}"
        )

    score = signal.get("score")
    if score is not None:
        label = " - High confluence" if signal.get("high_confluence") else ""
        lines.append(f"Score: {score}/100{label}")

    if event != "failed" and signal.get("next_level") is not None:
        next_level = signal["next_level"]
        room = signal.get("room_atr")
        if room is not None:
            lines.append(
                f"Room: {room:.2f}×ATR to next {next_level['kind']} "
                f"at {_format_price(next_level['price'])}"
            )
    elif event == "breakout":
        lines.append("Room: open-ended")

    retest = signal.get("retest")
    if retest is not None:
        lines.append(f"{STAGE_A_REFINEMENT_TIMEFRAME}: {'Retest held' if retest else 'No retest yet'}")

    if event == "breakout" and signal.get("high_confluence"):
        # A score is a setup-quality label, not a probability of success.
        lines.append("Quality: High confluence (not a success probability)")

    if alert.note:
        lines.append(f"Note: {alert.note}")
    lines.append(f"Report: {_report_url(alert, snapshot['bar_time'])}")
    return "\n".join(lines)


def _line_level(alert, at):
    if not alert.line_type or alert.line_price1 is None:
        return float(alert.price) if alert.price is not None else None
    t1 = alert.line_t1.timestamp() if alert.line_t1 else at
    p1 = float(alert.line_price1)
    if alert.line_type in {Alert.LineType.HLINE, Alert.LineType.HRAY}:
        if alert.line_type == Alert.LineType.HRAY and at < t1:
            return None
        return p1
    if not alert.line_t2 or alert.line_price2 is None or at < t1:
        return None
    t2, p2 = alert.line_t2.timestamp(), float(alert.line_price2)
    if t2 == t1:
        return None
    if alert.line_type == Alert.LineType.TREND and not alert.line_extend and at > t2:
        return None
    return p1 + (p2 - p1) * (at - t1) / (t2 - t1)


def _crossed(condition, previous, current):
    if previous is None:
        return False
    up = previous < 0 <= current
    down = previous > 0 >= current
    if condition == Alert.Condition.CROSS_UP:
        return up
    if condition == Alert.Condition.CROSS_DOWN:
        return down
    return up or down


def _macd_approach_thresholds(previous, current, previous_gap_percent, current_gap_percent, condition, previous_threshold):
    """Return newly reached proximity bands and the current approach state."""
    if previous is None or current == 0 or previous_gap_percent is None or current_gap_percent is None:
        return [], None
    if previous * current <= 0 or current_gap_percent >= previous_gap_percent:
        return [], None
    if (current < 0 and condition == Alert.Condition.CROSS_DOWN) or (
        current > 0 and condition == Alert.Condition.CROSS_UP
    ):
        return [], None

    reached = [
        threshold for threshold in (10, 5)
        if current_gap_percent <= threshold and (previous_threshold is None or threshold < previous_threshold)
    ]
    current_threshold = min(reached) if reached else previous_threshold
    return reached, current_threshold


def _may_fire(alert, now):
    if alert.frequency == Alert.Frequency.ONCE:
        return True
    if alert.last_triggered_at is None:
        return True
    return (now - alert.last_triggered_at).total_seconds() >= alert.cooldown_seconds


def telegram_request(notification, method, data=None, *, token=None):
    token = token or notification.telegram_bot_token
    if not token:
        raise ValueError("Configure the Telegram bot token in Django admin first.")
    response = requests.post(
        f"https://api.telegram.org/bot{token}/{method}",
        data=data or {},
        timeout=Exchange.load().exchange_timeout,
    )
    try:
        payload = response.json()
    except ValueError:
        response.raise_for_status()
        raise ValueError("Telegram returned an invalid response.")
    if not payload.get("ok"):
        raise ValueError(payload.get("description") or "Telegram request failed.")
    response.raise_for_status()
    return payload.get("result")


def find_telegram_chat(notification, *, token=None):
    updates = telegram_request(notification, "getUpdates", {"limit": "100"}, token=token)
    for update in reversed(updates or []):
        message = (
            update.get("message") or update.get("edited_message")
            or update.get("channel_post") or update.get("my_chat_member")
        )
        if message and message.get("chat"):
            return message["chat"]
    raise ValueError("No Telegram messages found. Open your bot and press Start, then try again.")


def send_telegram_test(notification, *, token=None, chat_id=None):
    token = token or notification.telegram_bot_token
    chat_id = chat_id or notification.telegram_chat_id
    if not token:
        raise ValueError("Enter a Telegram bot token.")
    if not chat_id:
        raise ValueError("Enter a Telegram chat ID.")
    return telegram_request(notification, "sendMessage", {
        "chat_id": chat_id,
        "text": "Marketa+ is connected. Your alerts will arrive here.",
    }, token=token)


_TELEGRAM_LABEL = re.compile(r"^([A-Za-z][A-Za-z0-9 ()/.%×_+\-]{0,30}):\s*(.+)$")


def _telegram_text(title, message):
    """Format a stored event for Telegram without changing its wording.

    Labels are bolded, each line becomes a bullet, and every dynamic value is escaped so a
    symbol or note can never break Telegram's HTML mode. The report URL is replaced with a
    closing "See full report" link instead of showing the raw address.
    """
    lines = [f"🔔 <b>{html.escape(title)}</b>"]
    for raw in message.splitlines():
        line = raw.strip()
        if not line:
            continue
        match = _TELEGRAM_LABEL.match(line)
        if match is None:
            lines.append(f"• {html.escape(line)}")
            continue
        label, value = match.groups()
        if label.lower() == "report" and value.startswith(("http://", "https://")):
            href = html.escape(value, quote=True)
            lines.append(f'See <a href="{href}">full report</a>')
            continue
        escaped = html.escape(value)
        if value.startswith(("http://", "https://")):
            escaped = f'<a href="{html.escape(value, quote=True)}">{escaped}</a>'
        lines.append(f"• <b>{html.escape(label)}:</b> {escaped}")
    return "\n".join(lines)


def _notify(event, configuration):
    logger.info("ALERT %s | %s", event.title, event.message)
    if not configuration.notification_enabled:
        return

    for notification in Notification.objects.order_by("id").iterator():
        token = notification.telegram_bot_token
        chat_id = notification.telegram_chat_id

        if not token or not chat_id:
            continue

        try:
            telegram_request(
                notification,
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": _telegram_text(event.title, event.message),
                    "parse_mode": "HTML",
                },
            )
        except (requests.RequestException, ValueError):
            logger.exception("Telegram alert delivery failed for chat_id: %s", chat_id)

def check_alerts(*, stdout=None):
    """Fetch current market values, persist alert state/events, and notify on hits."""
    configuration = AppConfiguration.load()
    exchange = Exchange.load()
    alerts = list(
        Alert.objects.filter(active=True).exclude(kind=Alert.Kind.PREDICTION).order_by("id")
    )
    price_symbols = {a.symbol for a in alerts if a.kind == Alert.Kind.PRICE}
    macd_keys = {(a.symbol, a.timeframe) for a in alerts if a.kind == Alert.Kind.MACD}
    # An EMA-cross alert can also request MACD trend context on its own interval.
    macd_keys.update(
        (a.symbol, a.effective_macd_context_timeframe)
        for a in alerts if a.kind == Alert.Kind.EMA and a.macd_context_enabled
    )
    ema_keys = {
        (a.symbol, a.timeframe, a.ema_period or 100)
        for a in alerts if a.kind == Alert.Kind.EMA
    }
    # MACD alerts always report RSI and the EMA trend in their message, even when the
    # separate confirmation toggles are off. EMA-cross alerts also carry RSI context.
    rsi_keys = {
        (a.symbol, a.effective_rsi_timeframe, a.rsi_period or 14)
        for a in alerts if a.kind in {Alert.Kind.RSI, Alert.Kind.MACD, Alert.Kind.EMA}
    }
    trend_keys = {
        (a.symbol, a.effective_trend_timeframe, a.trend_period or 100)
        for a in alerts if a.kind == Alert.Kind.MACD
    }
    prices, macd_values, ema_values, rsi_values, trend_values = {}, {}, {}, {}, {}
    for symbol in sorted(price_symbols):
        try:
            prices[symbol] = _price_for(symbol, exchange)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s price: %s", symbol, exc)
    for symbol, timeframe in sorted(macd_keys):
        try:
            macd_values[(symbol, timeframe)] = _macd_signal(symbol, timeframe, exchange)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s %s MACD: %s", symbol, timeframe, exc)
    for symbol, timeframe, period in sorted(ema_keys):
        try:
            ema_values[(symbol, timeframe, period)] = _ema_signal(symbol, timeframe, exchange, period)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s %s EMA: %s", symbol, timeframe, exc)
    for symbol, timeframe, period in sorted(rsi_keys):
        try:
            rsi_values[(symbol, timeframe, period)] = _rsi_signal(symbol, timeframe, exchange, period)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s %s RSI: %s", symbol, timeframe, exc)
    for symbol, timeframe, period in sorted(trend_keys):
        try:
            trend_values[(symbol, timeframe, period)] = _trend_signal(symbol, timeframe, exchange, period)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s %s trend: %s", symbol, timeframe, exc)

    fired = []
    now = timezone.now()
    for snapshot in alerts:
        value = prices.get(snapshot.symbol) if snapshot.kind == Alert.Kind.PRICE else None
        macd = macd_values.get((snapshot.symbol, snapshot.timeframe)) if snapshot.kind == Alert.Kind.MACD else None
        ema = ema_values.get((
            snapshot.symbol, snapshot.timeframe, snapshot.ema_period or 100,
        )) if snapshot.kind == Alert.Kind.EMA else None
        macd_context = macd_values.get((
            snapshot.symbol, snapshot.effective_macd_context_timeframe,
        )) if snapshot.kind == Alert.Kind.EMA and snapshot.macd_context_enabled else None
        rsi = rsi_values.get((
            snapshot.symbol, snapshot.effective_rsi_timeframe, snapshot.rsi_period or 14,
        )) if snapshot.kind in {Alert.Kind.RSI, Alert.Kind.MACD, Alert.Kind.EMA} else None
        trend = trend_values.get((
            snapshot.symbol, snapshot.effective_trend_timeframe, snapshot.trend_period or 100,
        )) if snapshot.kind == Alert.Kind.MACD else None
        if snapshot.kind == Alert.Kind.PRICE and value is None:
            continue
        if snapshot.kind == Alert.Kind.RSI and rsi is None:
            continue
        if snapshot.kind == Alert.Kind.MACD and macd is None:
            continue
        if snapshot.kind == Alert.Kind.EMA and ema is None:
            continue
        with transaction.atomic():
            alert = Alert.objects.select_for_update().filter(pk=snapshot.pk, active=True).first()
            if alert is None:
                continue
            event = None
            if alert.kind == Alert.Kind.PRICE:
                level = _line_level(alert, now.timestamp())
                if level is None:
                    continue
                previous_diff = None if alert.last_observed_value is None else alert.last_observed_value - level
                current_diff = value - level
                hit = (
                    value >= level if alert.condition == Alert.Condition.ABOVE else
                    value <= level if alert.condition == Alert.Condition.BELOW else
                    _crossed(alert.condition, previous_diff, current_diff)
                )
                alert.last_observed_value = value
                if hit and _may_fire(alert, now):
                    direction = alert.get_condition_display().lower()
                    event = TriggerEvent.objects.create(
                        alert=alert,
                        symbol=alert.symbol,
                        title=f"{alert.symbol} {direction} {level:g}",
                        message=f"Last price {value:g}; target {level:g}" + (f" — {alert.note}" if alert.note else ""),
                        observed_value=value,
                    )
            elif alert.kind == Alert.Kind.MACD:
                bar_time = macd["bar_time"]
                if alert.last_bar_open_time is None:
                    # Arm at the latest closed candle; never report an old cross on first startup.
                    alert.last_bar_open_time = bar_time
                    alert.last_macd_diff = macd["current_diff"]
                    atr = macd.get("atr")
                    alert.last_macd_gap_percent = abs(macd["current_diff"]) / atr * 100 if atr and atr > 0 else None
                elif bar_time > alert.last_bar_open_time:
                    previous_diff = alert.last_macd_diff
                    if previous_diff is None:
                        previous_diff = macd["previous_diff"]
                    current_diff = macd["current_diff"]
                    atr = macd.get("atr")
                    current_gap_percent = abs(current_diff) / atr * 100 if atr and atr > 0 else None
                    previous_gap_percent = alert.last_macd_gap_percent
                    if previous_gap_percent is None and previous_diff is not None and atr and atr > 0:
                        previous_gap_percent = abs(previous_diff) / atr * 100
                    hit = _crossed(alert.condition, previous_diff, current_diff)
                    alert.last_bar_open_time = bar_time
                    alert.last_observed_value = macd["close"]
                    thresholds, warning_state = _macd_approach_thresholds(
                        previous_diff, current_diff, previous_gap_percent, current_gap_percent, alert.condition,
                        alert.last_macd_warning_threshold,
                    )
                    alert.last_macd_warning_threshold = warning_state
                    alert.last_macd_diff = current_diff
                    alert.last_macd_gap_percent = current_gap_percent
                    # Filter thresholds based on enabled flags
                    enabled_thresholds = []
                    if alert.macd_threshold_5 and 5 in thresholds:
                        enabled_thresholds.append(5)
                    if alert.macd_threshold_10 and 10 in thresholds:
                        enabled_thresholds.append(10)
                    for threshold in enabled_thresholds:
                        status = "bullish" if current_diff < 0 else "bearish"
                        title = f"{alert.symbol}({alert.timeframe}) MACD {threshold}% Approach"
                        fired.append(TriggerEvent.objects.create(
                            alert=alert,
                            symbol=alert.symbol,
                            title=title,
                            message=_macd_alert_message(
                                alert, macd, status=status, rsi=rsi, trend=trend,
                                distance=current_gap_percent, subject=title,
                            ),
                            observed_value=macd["close"],
                        ))
                    if hit and _may_fire(alert, now):
                        status = "bullish" if macd["current_diff"] > 0 else "bearish"
                        title = f"{alert.symbol}({alert.timeframe}) MACD Crossed"
                        event = TriggerEvent.objects.create(
                            alert=alert,
                            symbol=alert.symbol,
                            title=title,
                            message=_macd_alert_message(
                                alert, macd, status=status, rsi=rsi, trend=trend, subject=title,
                            ),
                            observed_value=macd["close"],
                        )
                        alert.macd_triggered = True
            elif alert.kind == Alert.Kind.EMA:
                bar_time = ema["bar_time"]
                if alert.last_bar_open_time is None:
                    # Arm at the latest closed candle; never report an old cross on first startup.
                    alert.last_bar_open_time = bar_time
                    alert.last_observed_value = ema["close"]
                elif bar_time > alert.last_bar_open_time:
                    hit, current_side = _ema_crossed(
                        ema["previous_close"], ema["previous_ema"], ema["close"], ema["ema"],
                    )
                    if alert.condition == Alert.Condition.CROSS_UP:
                        hit = hit and current_side > 0
                    elif alert.condition == Alert.Condition.CROSS_DOWN:
                        hit = hit and current_side < 0
                    alert.last_bar_open_time = bar_time
                    alert.last_observed_value = ema["close"]
                    if hit and _may_fire(alert, now):
                        status = "bullish" if current_side > 0 else "bearish"
                        event = TriggerEvent.objects.create(
                            alert=alert,
                            symbol=alert.symbol,
                            title=(
                                f"{alert.symbol}({alert.timeframe}) EMA Crossed"
                                f" - {status.capitalize()}"
                            ),
                            message=_ema_alert_message(
                                alert, ema, status=status, rsi=rsi, macd=macd_context,
                            ),
                            observed_value=ema["close"],
                        )
            elif alert.kind == Alert.Kind.RSI:
                bar_time = rsi["bar_time"]
                rsi_value = rsi["rsi"]
                rsi_oversold = alert.rsi_oversold or 30
                rsi_overbought = alert.rsi_overbought or 70
                previous_rsi = alert.last_rsi_value
                hit = False
                level = None

                if alert.condition == Alert.Condition.ABOVE:
                    level = rsi_overbought
                    hit = rsi_value >= level
                elif alert.condition == Alert.Condition.BELOW:
                    level = rsi_oversold
                    hit = rsi_value <= level
                elif alert.condition == Alert.Condition.CROSS_UP:
                    level = rsi_overbought
                    hit = previous_rsi is not None and previous_rsi < level <= rsi_value
                elif alert.condition == Alert.Condition.CROSS_DOWN:
                    level = rsi_oversold
                    hit = previous_rsi is not None and previous_rsi > level >= rsi_value
                elif alert.condition == Alert.Condition.CROSS:
                    if previous_rsi is not None:
                        hit = (previous_rsi < rsi_oversold <= rsi_value) or (previous_rsi > rsi_overbought >= rsi_value)

                alert.last_rsi_value = rsi_value
                alert.last_observed_value = rsi["close"]

                if hit and _may_fire(alert, now):
                    direction = alert.get_condition_display().lower()
                    event = TriggerEvent.objects.create(
                        alert=alert,
                        symbol=alert.symbol,
                        title=f"{alert.symbol} RSI {alert.timeframe} {direction} {level:g}",
                        message=f"RSI {rsi_value:.2f}, close {rsi['close']:g}" + (f" — {alert.note}" if alert.note else ""),
                        observed_value=rsi["close"],
                    )
            if event is not None:
                alert.last_triggered_at = now
                if alert.frequency == Alert.Frequency.ONCE:
                    alert.active = False
                fired.append(event)
            alert.save(update_fields=[
                "active", "last_triggered_at", "last_observed_value", "last_bar_open_time",
                "last_macd_diff", "last_macd_gap_percent", "last_macd_warning_threshold",
                "last_rsi_value", "macd_triggered", "updated_at"
            ])

    for event in fired:
        _notify(event, configuration)
        if stdout is not None:
            stdout.write(f"Triggered: {event.title} — {event.message}")
    return fired


def check_prediction_alerts(*, stdout=None):
    """Evaluate enabled two-stage prediction alerts on closed candles.

    The scheduler calls this on its own 60-second job. Snapshots are shared by
    symbol/timeframe/EMA-period so several prediction rules on one market do not
    each fetch the same candles.
    """
    configuration = AppConfiguration.load()
    exchange = Exchange.load()
    alerts = list(
        Alert.objects.filter(active=True, kind=Alert.Kind.PREDICTION).order_by("id")
    )
    if not alerts:
        return []

    stage_b_keys = {
        (alert.symbol, alert.timeframe, alert.trend_period or 100)
        for alert in alerts
        if alert.prediction_stage_b
    }
    stage_a_keys = {
        (alert.symbol, alert.trend_period or 100)
        for alert in alerts
        if alert.prediction_stage_a
    }

    bars_cache = {}

    def closed_bars(symbol, timeframe):
        """Fetch each symbol/timeframe once and remember failures for this poll."""
        key = (symbol, timeframe)
        if key not in bars_cache:
            try:
                # 600 1H bars leave roughly 150 4H bars after Stage A clips the context
                # feed to the trigger's close, comfortably above the 120-bar indicator
                # warm-up even when an exchange omits a candle.
                bars_cache[key] = _closed_bars(symbol, timeframe, exchange, 600)
            except (requests.RequestException, KeyError, IndexError, ValueError) as exc:
                logger.warning(
                    "Could not fetch %s %s prediction data: %s", symbol, timeframe, exc,
                )
                bars_cache[key] = None
        return bars_cache[key]

    stage_b_snapshots = {}
    for symbol, timeframe, ema_period in sorted(stage_b_keys):
        bars = closed_bars(symbol, timeframe)
        if bars is None:
            continue
        try:
            stage_b_snapshots[(symbol, timeframe, ema_period)] = prediction_snapshot(
                bars, ema_period=ema_period,
            )
        except (KeyError, IndexError, ValueError) as exc:
            logger.warning(
                "Could not build %s %s prediction snapshot: %s", symbol, timeframe, exc,
            )

    stage_a_snapshots = {}
    for symbol, ema_period in sorted(stage_a_keys):
        context_bars = closed_bars(symbol, STAGE_A_CONTEXT_TIMEFRAME)
        main_bars = closed_bars(symbol, STAGE_A_MAIN_TIMEFRAME)
        if context_bars is None or main_bars is None:
            continue
        # The 15M feed is an optional refinement. A failure there must not block the
        # 1H breakout that has already been confirmed by the 4H context.
        refinement_bars = closed_bars(symbol, STAGE_A_REFINEMENT_TIMEFRAME)
        try:
            stage_a_snapshots[(symbol, ema_period)] = stage_a_snapshot(
                context_bars, main_bars, refinement_bars, ema_period=ema_period,
            )
        except (KeyError, IndexError, ValueError) as exc:
            logger.warning(
                "Could not build %s Stage A snapshot: %s", symbol, exc,
            )

    stage_a_weights = getattr(settings, "PREDICTION_STAGE_A_SCORE_WEIGHTS", None)
    stage_a_threshold = getattr(
        settings, "PREDICTION_STAGE_A_HIGH_CONFLUENCE_SCORE",
        STAGE_A_HIGH_CONFLUENCE_SCORE,
    )

    fired = []
    now = timezone.now()
    for snapshot in alerts:
        with transaction.atomic():
            alert = Alert.objects.select_for_update().filter(
                pk=snapshot.pk, active=True, kind=Alert.Kind.PREDICTION,
            ).first()
            if alert is None:
                continue
            market_b = stage_b_snapshots.get(
                (alert.symbol, alert.timeframe, alert.trend_period or 100)
            )
            market_a = stage_a_snapshots.get((alert.symbol, alert.trend_period or 100))
            if market_a is None and market_b is None:
                continue

            events = []
            stage_a_signal = None
            if alert.prediction_stage_a and market_a is not None:
                # A Stage A decision only advances on a new completed 1H bar. The same
                # bar cannot create another warning or breakout on a later poll.
                if (
                    alert.prediction_a_last_bar_time is None
                    or market_a["bar_time"] > alert.prediction_a_last_bar_time
                ):
                    state = {
                        "state": alert.prediction_a_state,
                        "direction": alert.prediction_a_direction,
                        "level": alert.prediction_a_level or {},
                        "score": alert.prediction_a_score,
                        "high_confluence": alert.prediction_a_high_confluence,
                    }
                    stage_a_signal, state = stage_a_evaluate(
                        market_a, state, weights=stage_a_weights,
                        high_confluence_threshold=stage_a_threshold,
                    )
                    if stage_a_signal is not None:
                        payload = stage_a_event(alert, market_a, stage_a_signal)
                        payload["message"] = _stage_a_alert_message(
                            alert, market_a, stage_a_signal,
                        )
                        events.append(TriggerEvent.objects.create(
                            alert=alert, symbol=alert.symbol, **payload,
                        ))
                    alert.prediction_a_state = state.get("state") or "idle"
                    alert.prediction_a_direction = state.get("direction") or ""
                    alert.prediction_a_level = state.get("level") or {}
                    alert.prediction_a_score = state.get("score")
                    alert.prediction_a_high_confluence = bool(
                        state.get("high_confluence")
                    )
                    alert.prediction_a_last_bar_time = market_a["bar_time"]

            if alert.prediction_stage_b and market_b is not None:
                # Only inspect a new completed candle. A breakout is a crossing event,
                # so the same bar must not create one event per 60-second poll.
                if (
                    alert.last_bar_open_time is None
                    or market_b["bar_time"] > alert.last_bar_open_time
                ):
                    # When Stage A already reported this exact breakout, Stage B on the
                    # same bar would be a duplicate alert for the same market event.
                    stage_a_reported_breakout = (
                        stage_a_signal is not None
                        and stage_a_signal.get("event") == "breakout"
                    )
                    if not stage_a_reported_breakout:
                        signal = stage_b_signal(market_b)
                        if signal is not None:
                            payload = stage_b_event(alert, market_b, signal)
                            payload["message"] = _prediction_alert_message(
                                alert, market_b, signal,
                            )
                            events.append(TriggerEvent.objects.create(
                                alert=alert, symbol=alert.symbol, **payload,
                            ))
                    alert.last_bar_open_time = market_b["bar_time"]

            observed = market_b or market_a
            if observed is not None:
                alert.last_observed_value = observed["close"]
                alert.last_rsi_value = observed["rsi"]
            if events:
                alert.last_triggered_at = now
                fired.extend(events)
            alert.save(update_fields=[
                "last_triggered_at", "last_observed_value", "last_rsi_value",
                "last_bar_open_time", "prediction_a_state", "prediction_a_last_bar_time",
                "prediction_a_direction", "prediction_a_level", "prediction_a_score",
                "prediction_a_high_confluence", "updated_at",
            ])

    for event in fired:
        _notify(event, configuration)
        if stdout is not None:
            stdout.write(f"Triggered: {event.title} — {event.message}")
    return fired

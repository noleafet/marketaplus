# Marketa+ - Market Analysis & Alerts

[![VS Code](https://img.shields.io/badge/VS%20Code-Editor-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/) 
[![GitHub Copilot](https://img.shields.io/badge/GitHub%20Copilot-AI%20Coding%20Assistant-000000?logo=githubcopilot&logoColor=white)](https://github.com/features/copilot) 
[![OpenCode](https://img.shields.io/badge/OpenCode-AI%20Coding%20Agent-000000?logo=opencode&logoColor=white)](https://opencode.ai/) 
[![AI Engineering](https://img.shields.io/badge/AI-Engineering-8A2BE2?logo=artificialintelligence&logoColor=white)](https://en.wikipedia.org/wiki/Artificial_intelligence)

> Experimental project for market analysis, alerts, and learning.

## Overview

Marketa+ combines a **Next.js dashboard**, **Django REST API**, and **PostgreSQL** to analyze public exchange market data and generate alerts. Binance is the default exchange. The app does not use exchange credentials or execute trades.

## Features

- **Charts:** Candlesticks, volume, Heikin Ashi, EMA, Bollinger Bands, MACD, RSI, ATR, key levels, and 1H/4H/1D trend-bias channels.
- **Watchlist:** Database-backed symbols, exchange selection, and optional scan columns for volume versus the previous 20-candle average, RSI-14, EMA-100, MACD line-minus-signal difference, and open interest (from the futures market).
- **Key levels:** Nearby support/resistance zones scored from 0–100 using swing reactions, rejection, higher-timeframe confluence, volume, and recency. Only levels scoring at least 40 are displayed.
- **Alerts:** Price, MACD cross, EMA cross, drawing-line, and two-stage breakout/prediction alerts. Browser notifications, sound, and optional Telegram delivery are supported.
- **Pattern monitor:** Checks the latest 50 candles every 60 seconds; identifies patterns that are forming or confirmed, projects triggers and measured targets, and saves chart snapshots.
- **Market events:** CoinMarketCal event scraping for watchlist coins every 4 hours from 02:00 UTC, using CoinGecko coin IDs/slugs without a provider API key.
- **Persistence:** Django stores alerts, trigger history, watchlist symbols, exchange settings, and pattern snapshots. Chart preferences and drawings remain browser-local.

## Prediction rules

Prediction checks use completed candles and run every 60 seconds.

### Stage A — Multi-timeframe breakout

- **Context:** 4H levels and EMA-100 trend; 1H breakout trigger; optional 15M retest refinement.
- **Early warning:** Bollinger Band Width is in the lowest 15% of its last 100 candles, and price is within `0.75 × ATR` of a key level scoring at least 60/100.
- **Breakout:** A completed 1H candle closes at least `0.25 × ATR` beyond the level, with volume at least `1.5×` its 20-candle average.
- **High confluence:** Breakout plus 4H/1H trend alignment, directional RSI above/below 50, ATR expansion, at least `1.5 × ATR` of room to the next opposing level, and a score of 80+.
- **Failed breakout:** Fires once when a later completed candle closes back inside the broken range.

The score weights squeeze (15), key level (15), breakout confirmation (25), volume (20), trend (10), RSI (5), ATR expansion (5), and room (5). **A score of 80 is not an 80% success probability and cannot replace the breakout trigger.**

### Stage B — Single-timeframe confirmation

Requires a completed candle to cross at least `0.1 × ATR` beyond a key level, volume above `1.5×` its 20-candle average, expanding Bollinger Band Width, and RSI plus the selected EMA-100/EMA-200 agreeing with the direction.

When both stages are enabled, Stage B is suppressed for a bar where Stage A reports a breakout to prevent duplicate alerts.

### EMA-cross alerts

Triggers when a completed candle closes on the opposite side of the selected EMA-100 or EMA-200 from the previous candle. RSI and optional MACD context are informational; they do not block the alert.

## Architecture

- `frontend/` — Next.js App Router, TypeScript, Tailwind CSS.
  - `src/app/` — route entry points.
  - `src/features/` — alerts, market workspace, patterns, and trade calculator.
  - `src/lib/` — API client, market data adapters, indicators, chart helpers, formatting, and storage.
  - `src/types/`, `src/styles/` — shared types and styling.
- `backend/` — Django REST Framework API and alert evaluator.
  - `backend/alerts/prediction.py` — pure key-level and prediction-rule calculations.
- **Database:** PostgreSQL; SQLite is used when `DATABASE_URL` is not set.
- **Scheduler:** `run_alerts` runs regular alert checks, prediction checks every 60 seconds, and market-event sync every 4 hours from 02:00 UTC (02, 06, 10, 14, 18, 22). Run only one scheduler per app instance.
- **Configuration:** Exchange URL/timeout, polling interval, and Telegram settings are stored in the Django admin configuration.

## Requirements

- Python 3.11+
- Node.js 20+
- Docker and Docker Compose, or PostgreSQL 14+

## Quick start (Docker Compose)

```sh
cp .env.example .env
```

Set `DJANGO_SECRET_KEY`, `POSTGRES_PASSWORD`, `FRONTEND_URL`, and `BACKEND_URL` in `.env`, then run:

```sh
docker compose up --build -d
```

Open:

- Dashboard: http://localhost:3000
- API: http://localhost:8000/api/
- Health: http://localhost:8000/api/health/
- Django admin: http://localhost:8000/admin/
- Swagger UI: http://localhost:8000/api/docs/
- ReDoc: http://localhost:8000/api/redoc/

Set `DJANGO_SUPERUSER_USERNAME`, `DJANGO_SUPERUSER_EMAIL`, and `DJANGO_SUPERUSER_PASSWORD` before startup to create the initial admin account. Configure exchange and Telegram settings under **Alert configuration** in Django admin.

Useful commands:

```sh
docker compose logs -f backend frontend
docker compose exec backend python manage.py check_alerts
docker compose down
```

PostgreSQL data is stored in the `postgres_data` named volume. **`docker compose down -v` deletes that volume and its data.**

## Native development

### 1. Start PostgreSQL

From the repository root:

```sh
docker compose up -d db
```

The local database defaults are `tradechartalert` / `tradechartalert_dev` on port `5432`. Do not reuse these development credentials outside local development. If an existing `postgres_data` volume contains data, retain its existing database settings or migrate deliberately before changing them.

### 2. Start Django

```sh
cp .env.example .env
cd backend
python -m venv .venv
# Activate the environment for your shell
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

API: http://localhost:8000/api/

In a second terminal, start the scheduler:

```sh
python manage.py run_alerts
```

Run only one scheduler process per app instance.

### 3. Start Next.js

In another terminal:

```sh
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

Dashboard: http://localhost:3000

Set `BACKEND_URL` in `frontend/.env.local` if the backend is not at `http://localhost:8000`.

### 4. Run checks

```sh
# Backend (with virtual environment active)
python manage.py test
python manage.py check
python manage.py makemigrations --check --dry-run

# Frontend
npm run build
```

## Alert worker commands

Run from `backend/` with the environment and database configured:

```sh
# Check regular and prediction alerts once
python manage.py check_alerts

# Sync upcoming market events
python manage.py sync_market_events

# Sync selected pairs
python manage.py sync_market_events --symbol BTCUSDT --symbol ETHUSDT

# Start recurring jobs
python manage.py run_alerts

# Optional fixed interval override (seconds; does not follow admin changes)
python manage.py run_alerts --interval 10
```

The scheduler reads active rules, fetches exchange data, records fired notifications as `TriggerEvent`, and sends enabled Telegram messages. One-shot alerts deactivate after firing; repeating price alerts use a 60-second cooldown. EMA/MACD crosses and prediction rules use completed candles and avoid replaying old crosses on startup. Network/API errors are logged and retried on the next run.

## API overview

| Endpoint | Purpose |
|---|---|
| `GET/POST /api/alerts/` | List or create alert rules |
| `GET/PATCH/DELETE /api/alerts/{id}/` | Read, update, pause/resume, or delete an alert |
| `GET/POST /api/pattern-shots/` | List or save PNG pattern snapshots; newest 10 per symbol are retained |
| `DELETE /api/pattern-shots/?symbol=BTCUSDT` | Delete all snapshots for one symbol |
| `GET/DELETE /api/pattern-shots/{id}/` | Read metadata or delete a snapshot |
| `GET /api/pattern-shots/{id}/image/` | Retrieve snapshot PNG |
| `GET /api/events/` | Recent alert trigger history |
| `GET /api/market/events/?symbol=BTCUSDT` | Upcoming market events for a watchlist pair |
| `POST /api/watchlist/{symbol}/slug/` | Resolve and cache the CoinGecko coin slug |
| `GET /api/telegram/status/` | Check Telegram delivery configuration |
| `POST /api/telegram/find-chat/` | Find the latest Telegram chat using a bot token |
| `POST /api/telegram/test/` | Send a one-off test message without saving submitted credentials |
| `GET /api/engine/jobs/` | List runnable scheduler jobs |
| `POST /api/engine/run/` | Run an alert, prediction, or event-sync job on demand |
| `GET /api/health/` | Health check |

Telegram POST helpers use Django CSRF protection. Fetch a token from `GET /api/telegram/csrf/` first; Swagger UI reuses the `csrftoken` cookie automatically.

Full schema: http://localhost:8000/api/schema/

### Alert rule examples

**Price alert**

```json
{
  "symbol": "BTCUSDT",
  "kind": "price",
  "condition": "cross_up",
  "price": "68000",
  "frequency": "once",
  "note": "breakout"
}
```

**MACD cross**

```json
{
  "symbol": "ETHUSDT",
  "kind": "macd",
  "condition": "cross_down",
  "timeframe": "1h",
  "frequency": "every"
}
```

**EMA cross**

```json
{
  "symbol": "BTCUSDT",
  "kind": "ema",
  "condition": "cross",
  "timeframe": "1h",
  "frequency": "every",
  "ema_period": 100,
  "rsi_timeframe": "1h",
  "macd_context_enabled": true,
  "macd_context_timeframe": "1h"
}
```

Supported intervals: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, `1w`. EMA-cross `ema_period` accepts `100` or `200` and defaults to `100`. MACD uses EMA periods 12/26/9 seeded with an SMA.

**Prediction alert**

```json
{
  "symbol": "BTCUSDT",
  "kind": "prediction",
  "condition": "cross",
  "timeframe": "1h",
  "frequency": "every",
  "prediction_stage_a": true,
  "prediction_stage_b": true,
  "trend_period": 100
}
```

At least one prediction stage must be enabled. Stage A requires the `1h` alert timeframe; Stage B can use any supported interval. `trend_period` accepts 2–500 and defaults to 100. Stage A weights and the high-confluence threshold can be overridden with `PREDICTION_STAGE_A_SCORE_WEIGHTS` and `PREDICTION_STAGE_A_HIGH_CONFLUENCE_SCORE`.

## Configuration and security

- See `.env.example` and `frontend/.env.local.example` for environment settings.
- The frontend proxies API calls through `/api/proxy`; `BACKEND_URL` is supplied at build time for the frontend image.
- CoinMarketCal events are scraped from `https://coinmarketcal.com/coin/<slug>` and coin slugs are resolved through CoinGecko's public coin list. Both require outbound HTTPS; no provider API key is required.
- Telegram credentials are stored in Django configuration and are not sent to the browser. Ad-hoc test credentials are not persisted.
- The API is intended for **local, single-user development** and is unauthenticated. **Do not expose it publicly as-is.** Before deployment, add authentication/authorization and throttling, disable Django debug mode, set a strong secret key, configure trusted hosts/CORS, and use secure database credentials.
- Never commit real `.env` files, database passwords, or Telegram tokens. Exchange data availability, rate limits, outages, and provider terms apply.

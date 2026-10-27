# Marketa+ - Market Analysis & Alerts

[![VS Code](https://img.shields.io/badge/VS%20Code-Editor-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/) 
[![GitHub Copilot](https://img.shields.io/badge/GitHub%20Copilot-AI%20Coding%20Assistant-000000?logo=githubcopilot&logoColor=white)](https://github.com/features/copilot) 
[![OpenCode](https://img.shields.io/badge/OpenCode-AI%20Coding%20Agent-000000?logo=opencode&logoColor=white)](https://opencode.ai/) 
[![AI Engineering](https://img.shields.io/badge/AI-Engineering-8A2BE2?logo=artificialintelligence&logoColor=white)](https://en.wikipedia.org/wiki/Artificial_intelligence)

> Unpolished codes, for testing, and learnings


This project implements persistent Django + PostgreSQL backend, a Next.js dashboard with a live candlestick/volume chart, and Django management commands that check public market data independently of an open browser. The dashboard features exchange data pull (from Binance as default), a database-backed watchlist, dark mode, EMA/Bollinger/MACD/RSI/ATR overlays, scored support/resistance key-level zones, Heikin Ashi, editable drawing tools and line alerts, browser notifications/sound, persistent price, MACD, EMA-cross, and two-stage prediction alerts, and pattern analysis. The chart takes two thirds of the workspace and the watchlist and annotate panels stack in the remaining third. A **#** button beside each watchlist pair switches on its scan columns: volume as a percentage of the previous 20-candle average, RSI-14, EMA-100, and the MACD crossover difference (MACD line minus signal). Readings come from the last fully closed candle of the selected interval and refresh every minute; the switch state is remembered per browser. A **Start/Pause** control runs the pattern monitor, which reads only the latest 50 candles and refreshes every 60 seconds. It draws the detected shape on its own layer above the user's drawings and paints the pattern's name on the chart itself; the **Picture** button still exports a PNG and keeps it. The monitor tries every pattern. Partial shapes count as matches: a head and shoulders still waiting for its right shoulder, a double top that has only printed its first top, a triangle or flag still inside its channel are all reported as **forming**, with the missing swing drawn as a projection, the level that confirms the shape drawn as the trigger, and the measured target for each. A symmetrical triangle projects both measured moves. Every match is stored as a picture and the annotate panel switches to the **Pattern** tab to show them, where each saved picture lists its summary, break level, and target, and the current pair's group carries a **Clear all** button that removes every picture saved for that pair after a second confirming click. A help button next to the monitor controls opens a reference card listing every pattern with a sample picture marking its entry and target, its bullish or bearish reading, its historical success rate after Thomas N. Bulkowski's *Encyclopedia of Chart Patterns*, and how the shape is confirmed and measured. The chart's annotate panel is tabbed: drawings live on the **Drawings** tab, and the **Pattern** tab lists the newest ten saved pictures per watchlist pair, served back through the API with per-picture open, save, and delete actions. Chart preferences and drawings remain browser-local; alerts, trigger history, selected exchange, watchlist symbols, and pattern pictures are stored by Django.

**Key Level** draws the two closest support bands below the latest price and the two closest resistance bands above it, but only levels scoring at least 40/100 qualify. Each band gets a 0–100 strength score from independent swing reactions (30), strength of price rejection (25), higher-timeframe confluence (20), volume confirmation (15), and recency (10). Band height is kept compact and consistent as the chart is zoomed.

The **Prediction** tab in **Create an alert** adds two independently switchable stages. The backend checks both on a separate 60-second scheduler job, using completed candles only. **Stage A** is a multi-timeframe breakout model: the 4H chart supplies major support/resistance levels and the 100 EMA trend, the 1H chart is the trigger, and the 15M chart is an optional retest refinement. A squeeze is Bollinger Band Width in the lowest 15% of its last 100 candles. An **early warning** needs that squeeze plus price within 0.75 × ATR of a major level scoring at least 60/100. A **breakout** needs a completed 1H candle to close at least 0.25 × ATR beyond the level on relative volume of at least 1.5× its 20-candle average. **High confluence** is the same breakout with both 4H and 1H trend support, RSI above/below 50 in the trade direction, ATR expansion, at least 1.5 × ATR of room to the next opposing level, and a quality score of 80 or more. The 0–100 score weights squeeze (15), key level (15), breakout confirmation (25), volume (20), trend alignment (10), RSI (5), ATR expansion (5), and room (5); 80+ means high confluence, not an 80% success probability, and the score can never replace a missing breakout trigger. A **failed breakout** fires once if a later completed candle closes back inside the broken level's range. Stage A stores its state per alert, so one squeeze episode, breakout, or failure is not reported again on every 60-second poll. **Stage B** remains the original single-timeframe confirmation: a completed candle must cross at least 0.1 × ATR beyond a key level, volume must exceed 1.5× its 20-candle average, Bollinger Band Width must be expanding, and RSI plus the selected 100 or 200 EMA must agree with the direction. When both stages are enabled and Stage A reports a breakout, Stage B is suppressed for that bar to avoid a duplicate alert.

The **EMA cross** tab fires when a completed candle closes on the opposite side of the selected 100 or 200 EMA from the previous candle. The alert title adds the direction, for example **BTCUSDT(1h) EMA Crossed - Bullish**, and the message reports the status, current price, RSI context, and optional MACD trend context with a report link. RSI follows the EMA timeframe until a different interval is chosen. MACD trend context is enabled by default and has its own timeframe; it compares the MACD line with its signal line and reports `MACD: Bullish` or `MACD: Bearish`. Both context readings are informational and never suppress the EMA cross.

## Architecture

- `frontend/`: Next.js App Router + TypeScript + Tailwind CSS dashboard.
  - `frontend/src/app/`: route entry points only (`layout.tsx`, `page.tsx`).
  - `frontend/src/features/`: feature packages for alerts, market workspace, patterns, and the trade calculator, each with its own components.
  - `frontend/src/lib/`: API client, market data adapters, indicator math, chart helpers, formatting, and storage.
  - `frontend/src/types/`: shared domain types.
  - `frontend/src/styles/`: global, chart, responsive, and Tailwind styles.
- `backend/`: Django REST Framework API and alert evaluator; `backend/alerts/prediction.py` holds the pure key-level and two-stage rule calculations.
- PostgreSQL stores `Alert` rules, `TriggerEvent` history, the selected exchange, and `WatchlistSymbol` entries. SQLite is used automatically only when `DATABASE_URL` is absent (convenient for tests/local experimentation).
- Exchange public REST endpoints provide price quotes and candles. No exchange credentials or trading permissions are used.
- `check_alerts` evaluates active alerts once; `run_alerts` schedules recurring checks alongside the API process inside the backend container using APScheduler. Regular alerts use the configured interval and prediction stages use a separate 60-second job. `run_alerts` also scrapes CoinMarketCal market events for the watchlist every day at 00:00 UTC, one coin page per pair, and keeps only upcoming events; rows whose date has passed are deleted. Scraped impact scores run 0-10: 5.0 and above is high impact and 8.0 and above is critical. Coin slugs come from CoinGecko's public coin list, so no CoinMarketCal API key is needed.
- Exchange selection, exchange URL, request timeout, polling interval, and Telegram credentials are stored in the `AppConfiguration` database table. Telegram credentials are managed by staff in Django admin and are never sent to the browser.

## Requirements

- Python 3.11+
- Node.js 20+
- Docker and Docker Compose (or a separately managed PostgreSQL 14+ instance)

## Docker Compose setup (recommended)

Docker Compose starts PostgreSQL, the Django API with its alert scheduler, and the Next.js frontend. The backend applies database migrations before Supervisor starts both the API and APScheduler process. The scheduler checks immediately, then polls regular alerts according to `alert_poll_seconds` from Django admin. It reloads the setting after each check and reschedules automatically if it changes. Two-stage prediction alerts run on a separate 60-second job so they stay on completed candles instead of following the faster regular poll. Supervisor restarts either process if it exits.

```sh
cp .env.example .env
docker compose up --build -d
```

Open the dashboard at `http://localhost:3000`, the API at `http://localhost:8000/api/`, and health at `http://localhost:8000/api/health/`. Follow logs with `docker compose logs -f backend frontend`; both API and alert worker logs appear under `backend`. Stop the stack with `docker compose down`. Database data is kept in the `postgres_data` named volume; `docker compose down -v` also deletes that data.

The backend container runs `python manage.py run_alerts` under Supervisor as the recurring scheduler. Each run queries active alert rules, gets exchange data, processes conditions, writes triggered events to PostgreSQL, and sends enabled Telegram notifications from Django. The prediction job does the same for stage A and stage B on closed candles every 60 seconds. To run an additional one-off check of both regular and prediction alerts, use `docker compose exec backend python manage.py check_alerts`. Set `DJANGO_SUPERUSER_USERNAME`, `DJANGO_SUPERUSER_EMAIL`, and a strong `DJANGO_SUPERUSER_PASSWORD` in `.env` before starting the stack to create the initial admin account automatically; startup will not reset an existing account. Without a configured username and password, account creation is skipped. Then visit `http://localhost:8000/admin/`. Open **Alert configuration** (direct URL: `http://localhost:8000/admin/alerts/appconfiguration/`) to edit exchange URL, exchange timeout, alert poll seconds, Telegram bot token/chat ID, and the Telegram delivery switch. Use the protected **Find my Telegram chat ID** action there. The dashboard provides blank ad-hoc bot-token and chat-ID fields, **Find my chat ID**, and **Test Telegram** actions through Django’s CSRF-protected API. These actions do not require an admin session and never persist the submitted test credentials. The admin form also has a protected **Send test Telegram message** action. The configured bot token is shown as a password field; leaving it blank preserves the saved token. The browser only displays backend delivery status and never handles configured alert-delivery credentials.

Compose reads root `.env` automatically. Set `DJANGO_SECRET_KEY`, `POSTGRES_PASSWORD`, `FRONTEND_URL`, and `BACKEND_URL` there for your environment. Django derives its CORS and CSRF trusted origins from the frontend and backend URLs. The frontend calls the API through a same-origin `/api/proxy` rewrite, so browser requests do not need cross-origin CORS access. For native development, `frontend/.env.local` sets `BACKEND_URL=http://localhost:8000`. The Next.js rewrite is generated at build time, so provide the backend URL as the `BACKEND_URL` Docker build argument when building the frontend image.

To override published ports, set `FRONTEND_PORT` and/or `BACKEND_PORT` in `.env`. To run only PostgreSQL for native development, use `docker compose up -d db`.

## Native local setup

### 1. Start PostgreSQL

From the repository root:

```sh
docker compose up -d db
```

The development container creates database `tradechartalert` with user/password `tradechartalert` / `tradechartalert_dev` on port 5432. Do not reuse these credentials outside local development. Existing installations with a populated `postgres_data` volume are not renamed by changing defaults; keep the existing database environment values or migrate the database deliberately before switching names.

### 2. Configure Django

```sh
cp .env.example .env
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

The API is available at `http://localhost:8000/api/`. Check `http://localhost:8000/api/health/` for the health response. Admin is at `http://localhost:8000/admin/`. To bootstrap an admin automatically in native development, export `DJANGO_SUPERUSER_USERNAME`, `DJANGO_SUPERUSER_EMAIL`, and `DJANGO_SUPERUSER_PASSWORD` before running the backend startup flow, or run `python manage.py create_initial_superuser` after setting those values. The command is idempotent and leaves an existing account unchanged. You can also use Django's interactive `python manage.py createsuperuser` command.

Set the exchange and Telegram values in Django admin at `/admin/alerts/appconfiguration/`. In a second terminal, start the scheduled processor with `python manage.py run_alerts`; it uses the saved polling interval for regular alerts, checks immediately, runs prediction stages on a 60-second job, and scrapes market events every 00:00 UTC. Run only one scheduler process for this app instance.

### 3. Start Next.js

In another terminal, from the repository root:

```sh
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`. The frontend proxies `/api/proxy` requests to `${BACKEND_URL}/api`; set `BACKEND_URL` in `frontend/.env.local` to change the backend target. The example points to `http://localhost:8000`.

### Run checks

```sh
# From backend, with the virtual environment active
python manage.py test
python manage.py check
python manage.py makemigrations --check --dry-run

# From frontend
npm run build
```

## Alert worker commands

Commands run in `backend/`, with the virtual environment active and database/environment configured:

```sh
# Evaluate all active regular and prediction alerts exactly once
python manage.py check_alerts

# Scrape upcoming CoinMarketCal events for the whole watchlist once
python manage.py sync_market_events

# Limit the scrape to specific pairs
python manage.py sync_market_events --symbol BTCUSDT --symbol ETHUSDT

# Run the APScheduler process until Ctrl+C
# (regular interval comes from Alert configuration; predictions use a 60-second job;
#  market events sync at 00:00 UTC)
python manage.py run_alerts

# Optional fixed interval override (seconds; does not follow admin interval changes)
python manage.py run_alerts --interval 10
```

Run exactly one recurring scheduler for this app instance. Each scheduled run reads active rules from PostgreSQL, fetches current values from the configured exchange, locks and updates each alert transactionally, and saves every fired notification to `TriggerEvent`. A one-shot alert is deactivated when it fires. Repeating price alerts use a 60-second cooldown; MACD-cross and EMA-cross alerts are checked on closed candles and are armed at the latest closed candle on first observation, so they do not replay an old cross at startup. Prediction alerts share one snapshot per symbol/timeframe/EMA period per 60-second check, inspect only completed candles, and keep stage A armed state so a persistent compression warning is not repeated every minute. Network/API errors are logged and retried on the next scheduled run. The backend needs outbound HTTPS access to the configured exchange; Telegram also needs outbound HTTPS access to Telegram.

## API overview

- `GET/POST /api/alerts/` — list or create alert rules.
- `GET/PATCH/DELETE /api/alerts/{id}/` — retrieve, update (including pause/resume), or delete an alert.
- `GET/POST /api/pattern-shots/` — list saved pattern pictures (optional `?symbol=`, `?limit=` per pair, newest first) or upload one as base64 PNG JSON (`symbol`, `pattern`, `timeframe`, `summary`, `image`). Only the newest ten per symbol are kept.
- `DELETE /api/pattern-shots/?symbol=BTCUSDT` — delete every saved picture for one symbol, returning `{"symbol": ..., "deleted": n}`. The symbol is required, so a call without one is rejected rather than clearing every picture.
- `GET/DELETE /api/pattern-shots/{id}/` — retrieve a picture's metadata or delete it.
- `GET /api/pattern-shots/{id}/image/` — the PNG bytes, with a `Content-Type` of `image/png`.
- `GET /api/events/` — recent trigger history.
- `GET /api/market/events/?symbol=BTCUSDT` — stored upcoming CoinMarketCal events for one watchlist pair, soonest first. The dashboard shows the highest-impact title after the market identity and opens the full list from the calendar icon.
- `POST /api/watchlist/{symbol}/slug/` — resolve the canonical coin slug (a CoinGecko id such as `bitcoin`) for one watchlist pair and cache it on the watchlist row, returning `{"symbol", "slug"}`. The lookup uses CoinGecko's public coin list and needs no provider key; returns `404` when the pair is unknown or unmatched and `502` on a provider error.
- `GET /api/telegram/status/` — whether Telegram delivery is configured, with masked chat ids.
- `POST /api/telegram/find-chat/` (`bot_token`) — call Telegram `getUpdates` and return the chat id and name of the most recent chat.
- `POST /api/telegram/test/` (`bot_token`, `chat_id`) — send a one-off test message. Never persists the submitted credentials.
- `GET /api/engine/jobs/` — the recurring polling jobs that can be run on demand: `alerts`, `predictions`, and `events`.
- `POST /api/engine/run/` (`job`, optional `symbols`) — run one scheduler job synchronously and return its captured output. `alerts` checks price/MACD/EMA/line rules once, `predictions` advances stage A/B by one poll, and `events` scrapes CoinMarketCal for the watchlist (`symbols` limits the run).
- `GET /api/health/` — API health.

Interactive API documentation is served by [drf-spectacular](https://drf-spectacular.readthedocs.io/): Swagger UI at `/api/docs/`, ReDoc at `/api/redoc/`, and the OpenAPI 3 schema at `/api/schema/`. The `POST` Telegram helpers use Django's CSRF protection, so fetch a token from `GET /api/telegram/csrf/` first (Swagger UI reuses the `csrftoken` cookie automatically).

Example price rule JSON: `{"symbol":"BTCUSDT","kind":"price","condition":"cross_up","price":"68000","frequency":"once","note":"breakout"}`.

Example MACD rule JSON: `{"symbol":"ETHUSDT","kind":"macd","condition":"cross_down","timeframe":"1h","frequency":"every"}`. Supported intervals are `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, and `1w`. The optional `rsi_timeframe` and `trend_timeframe` fields choose the RSI and EMA context intervals; RSI follows the MACD interval by default and EMA defaults to `1h`. MACD uses 12/26/9 EMA parameters seeded with an SMA, matching the calculation in the original page.

Example EMA-cross rule JSON: `{"symbol":"BTCUSDT","kind":"ema","condition":"cross","timeframe":"1h","frequency":"every","ema_period":100,"rsi_timeframe":"1h","macd_context_enabled":true,"macd_context_timeframe":"1h"}`. `ema_period` accepts `100` or `200` and defaults to `100`. RSI follows the main timeframe unless `rsi_timeframe` is set. MACD context defaults to enabled on `1h`; set `macd_context_enabled` to `false` to omit the MACD line. EMA-cross alerts are armed at the latest completed candle and then report only a side change, not every close above or below the EMA.

Example prediction rule JSON: `{"symbol":"BTCUSDT","kind":"prediction","condition":"cross","timeframe":"1h","frequency":"every","prediction_stage_a":true,"prediction_stage_b":true,"trend_period":100}`. At least one stage must be enabled. Stage A always evaluates the 1H chart with 4H context and optional 15M refinement, so its alert timeframe must be `1h`; Stage B alone may use any supported timeframe. `trend_period` accepts 2–500 and defaults to the 100 EMA. Prediction alerts ignore the regular cooldown and instead track each stage's setup so a completed-candle breakout is reported once. Stage A's score weights can be overridden with the optional `PREDICTION_STAGE_A_SCORE_WEIGHTS` Django setting and its high-confluence line with `PREDICTION_STAGE_A_HIGH_CONFLUENCE_SCORE`.

## Configuration and deployment notes

See [.env.example](.env.example) for Django, PostgreSQL, and CORS settings. Exchange URL/timeout, polling, and Telegram settings are stored in PostgreSQL and editable in Django admin. The frontend example is [frontend/.env.local.example](frontend/.env.local.example).

Market events are scraped from CoinMarketCal coin pages: the daily 00:00 UTC run requests `https://coinmarketcal.com/coin/<slug>` once per watchlist pair and reads the event payload embedded in the page. Only upcoming events are stored; rows whose date has passed are deleted on every run, as are rows for pairs removed from the watchlist. The scraped impact score runs 0-10, with 5.0 and above stored as **high** impact and 8.0 and above as **critical**. The coin page URL wants canonical coin **slugs** (`bitcoin`), not tickers (`btc`), because tickers collide across projects, so each watchlist pair caches its slug in the `slug` column: the slug is a CoinGecko coin id read from `GET /api/v3/coins/list`, cached for a day and stored whenever a pair is added to the watchlist or a slug is still missing during a scrape. When several coins share a ticker, the largest one wins using a once-a-day `GET /api/v3/coins/markets` ranking of the top 250 coins, so `UNIUSDT` resolves to `uniswap` rather than a same-ticker token; coins outside that list fall back to the shortest id. Size-prefixed pairs map to the underlying coin unless the prefixed ticker is the bigger market, so `1000SHIBUSDT` resolves to `shiba-inu`. Staff can also resolve slugs on demand from the watchlist admin action or `POST /api/watchlist/{symbol}/slug/`, and can edit a stored slug in the watchlist admin rows. No provider key is needed: scraping and slug lookups only need outbound HTTPS access to `https://coinmarketcal.com` and `https://api.coingecko.com`. If CoinMarketCal changes its page markup, the scrape reports a failure per pair instead of storing partial data.

The API is intentionally unauthenticated for local single-user development. **Do not expose it publicly as-is.** Before deployment, add authentication/authorization and API throttling, set a strong `DJANGO_SECRET_KEY`, turn `DJANGO_DEBUG` off, configure trusted hosts/CORS and secure database credentials. Do not commit real `.env` files or Telegram tokens. The project uses exchange market data for demonstration; rate limits, temporary outages, symbol availability, and data-source terms apply.

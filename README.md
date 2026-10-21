# TradeDojo

Learn to trade MCX **gold and silver** with **virtual points** instead of money. TradeDojo is a mobile-first web app (installable as a PWA) where you trade against real MCX futures prices from Upstox, and every closed trade gets a detailed review so you get better at making decisions.

- **No real orders are ever placed.** The backend only reads market data.
- **Points are not money.** Everyone starts with 1,00,000 points (1 point behaves like ₹1 of buying power). Points can't be bought, topped up or redeemed.
- **Live mode** trades against current MCX prices during market hours. **Replay mode** replays past days candle by candle, 24/7, on a separate balance.

> TradeDojo is an educational simulator. Points have no monetary value and cannot be bought, sold, or redeemed. Prices come from MCX futures data via Upstox and may be delayed or interrupted. Simulated fills may differ from real execution. Nothing in this app is investment advice.

---

## What's inside

```
trade-dojo/
├── backend/    Node 22 + TypeScript, Express, PostgreSQL, WebSocket (port 4000)
│   ├── migrations/          SQL migrations (npm run migrate)
│   ├── src/market/          Upstox / mock / licensed-vendor price providers, contracts, candles, market hours
│   ├── src/engine/          simulated trading engine (orders, positions, SL/TP, rollover, ledger)
│   ├── src/reviews/         trade reviews, coaching flags, what-ifs, optional AI coach
│   ├── src/stats/           performance dashboard metrics
│   ├── src/replay/          replay sessions
│   └── test/                tests (real PostgreSQL + mock prices)
└── frontend/   Vite + React + TypeScript PWA (port 5173)
```

---

## 1. One-time setup

You need **Node.js 22** (https://nodejs.org) and a terminal. Commands below are typed in the `trade-dojo` folder.

### 1a. Create a free PostgreSQL database on Aiven

1. Sign up at https://aiven.io and create a new **PostgreSQL** service on the **Free** plan (1 GB, up to 20 connections).
2. When it is running, open the service **Overview** page:
   - copy the **Service URI** (looks like `postgres://avnadmin:…@….aivencloud.com:12345/defaultdb?sslmode=require`), and
   - click **CA certificate → Download** and save the file as `backend/ca.pem`.
3. TradeDojo uses at most 10 connections (`DB_POOL_MAX`), well under Aiven's limit. Old raw ticks are pruned after 7 days so the 1 GB disk is enough; candles are kept.

### 1b. Get an Upstox Analytics Token (read-only market data)

1. Open an Upstox account if you don't have one.
2. Go to the **Upstox Developer Apps** page (https://account.upstox.com/developer/apps) → **Analytics** tab → **Generate token**.
3. Copy the token. It is **read-only** (it cannot place orders), free, and **valid for 1 year**. Put a reminder in your calendar: when it expires, live prices stop (the app shows "Live prices unavailable") until you generate a new one. The admin panel shows the expiry date.

The token stays on the backend. Users never connect to Upstox and the token is never sent to the browser.

### 1c. Configure

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

| Setting | What to put |
|---|---|
| `DATABASE_URL` | the Aiven Service URI **without** `?sslmode=require` |
| `DB_CA_CERT_PATH` | `./ca.pem` (leave empty only for a local Postgres without SSL) |
| `JWT_SECRET` | any long random string |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | the admin login that is created on first start |
| `PRICE_PROVIDER` | `upstox` (real prices) or `mock` (simulated prices, no internet needed) |
| `UPSTOX_ANALYTICS_TOKEN` | the token from step 1b |

Everything else has sensible defaults. The frontend needs no configuration for local use.

### 1d. Install, create the tables, download history, add demo users

```bash
npm run install:all     # installs root, backend and frontend packages
npm run migrate         # creates the tables (safe to run again)
npm run backfill        # downloads ~2 years of daily + 3 months of 1-minute candles (a few minutes)
npm run seed:demo       # admin + demo1@local … demo5@local with practice trades
```

`seed:demo` prints the shared demo password (`demo-pass-123`). Run `npm run seed:demo -- --reset` to recreate the demo users.

---

## 2. Run it

```bash
npm run dev
```

This starts both parts:

- backend on **http://localhost:4000** (listening on all network interfaces),
- frontend on **http://localhost:5173**.

Open http://localhost:5173 and log in (admin or a demo user), or sign up.

### Offline, or outside market hours

MCX trades roughly 9:00 AM to 11:30 PM IST on weekdays (11:55 PM during US winter time). Outside those hours live trading is paused, but you can:

- use **Replay** (always available, uses stored history), or
- set `PRICE_PROVIDER=mock` in `backend/.env` and restart. The mock provider generates realistic random-walk prices with a fake order book, works without internet, and keeps the market "open" all the time. Great for demos and development.

### Open it on your phone (same Wi-Fi)

1. Find your laptop's local IP address (Windows: `ipconfig` → IPv4 Address; macOS: System Settings → Wi-Fi → Details; Linux: `hostname -I`). For example `192.168.1.23`.
2. On the phone, open **http://192.168.1.23:5173**. The app automatically talks to the backend on port 4000 of the same address.
3. If it doesn't load, allow incoming connections on ports **5173** and **4000** in your laptop's firewall (Windows usually asks the first time Node runs; click "Allow" for private networks).

**Installing as an app (PWA):** browsers only allow installing from `https://` or `localhost`. Over `http://192.168…` on Wi-Fi the app works fully in the browser, but "Add to Home screen" may only create a bookmark. Once deployed with HTTPS (see below) it installs properly.

**Several users at once:** the login is stored per browser tab, so you can log in as different demo users in different tabs.

---

## 3. Using TradeDojo

- **Trade**: Gold/Silver switcher with live price; candlestick chart (1m to 1D) with indicators (SMA, EMA, VWAP, Bollinger, RSI, MACD, ATR, volume average, open interest, previous-day levels and pivots); depth, stats and drawing tools under the chart; big **BUY / SELL** buttons open the order ticket with a risk calculator, position-size helper and a short mandatory trade plan. Drag the Stop/Target lines on the chart.
- **Positions**: live P&L, edit stop-loss/target/trailing stop, partial or full close, pending orders, rollover notices.
- **Journal**: every trade with filters, tags, notes, review link and **CSV export**. Available read-only offline.
- **Trade review**: R-multiple, best/worst moments (MFE/MAE), what-ifs, coaching flags ("moved stop further away", "revenge trade", …), your plan vs the outcome, and a reflection box.
- **Stats**: equity curve, win rate, profit factor, expectancy, drawdown, streaks, breakdowns, calendar heatmap and **top 3 habits to fix**.
- **Replay**: choose a past date range and a candle step, then play at 1x/5x/20x/100x or step one candle at a time. Future candles are never shown. Replay uses its own balance.
- **Account**: balances, season reset (allowed below 10% of starting points, once every 7 days), points ledger, theme, glossary.
- **Admin** (admins only): users (search, stats, grant points with a note, disable), settings (starting points, spreads and brokerage per instrument, tracked MCX product, rollover days, market hours, holidays, reset cooldown, leaderboard), and **feed health** (provider, WebSocket status, token validity and expiry, last tick per instrument, active contracts, backfill progress, recent errors).

### How prices and fills work

- Gold tracks **GOLDM** (quoted ₹ per 10 g) and silver tracks **SILVERM** (₹ per kg) by default; admins can switch to GOLD, GOLDPETAL, SILVERMIC, etc. Quantities are in grams.
- MCX futures expire, so the app tracks the near-month contract and **rolls over 3 days before expiry** (configurable). Users with open live positions get a notice first; on rollover day those positions close at the old contract's last price.
- Market orders buy at the best **ask** and sell at the best **bid** (or last price ± half the configured spread when depth is missing). Limit/stop entries fill at their level. Stops fill at their level, or at the opening price if the market gapped past them. If one replay candle touches both stop and target, the stop is assumed to have hit first.
- No leverage: opening a position sets aside its full value from your free points. Optional simulated brokerage is charged per order.

---

## 4. Tests

The tests need a real PostgreSQL. With a local Postgres:

```bash
createdb tradedojo_test     # once
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/tradedojo_test npm test
```

Or let the tests start a throwaway server with the `embedded-postgres` package (cannot run as root):

```bash
USE_EMBEDDED_PG=1 npm test
```

The test database is wiped on every run. Tests use the mock price provider and cover P&L math in MCX units, partial closes, bid/ask and fallback-spread fills, brokerage, SL/target triggering (both-touched candles, gap fills), limit/stop entries, closed/stale markets, insufficient points, reset cooldown, R-multiple/MFE/MAE, every coaching flag, dashboard metrics against hand-calculated numbers, replay never leaking future candles, contract resolution from a sample instruments file, rollover, protobuf decoding of a sample feed message, and historical-API request chunking. The frontend has unit tests for the indicator library.

---

## 5. About the Upstox integration

- REST calls go straight to the Upstox API with `fetch` (the official `upstox-js-sdk` is callback-based and was not needed for these few read-only endpoints). The official **MarketDataFeed V3 `.proto`** is vendored in `backend/src/market/upstox/proto/`.
- The backend opens **one** Market Data Feed V3 WebSocket (Upstox allows two per account): it calls `/v3/feed/market-data-feed/authorize`, connects to the returned URL, subscribes to the active gold and silver contracts in `full` mode, reconnects with exponential backoff and resubscribes after reconnects and rollovers.
- The token is validated at startup with `/v2/market/status/MCX`. If it fails, live prices are marked unavailable and replay keeps working from stored candles.
- Contracts come from the gzipped MCX instruments master file (`UPSTOX_INSTRUMENTS_URL`), downloaded at startup and once a day.
- History uses `/v3/historical-candle/…` with the documented limits (1-minute candles from Jan 2022, at most one month per request; daily candles from Jan 2000, at most ten years per request) at about 20 requests/second, backing off on HTTP 429. Older near-month contracts come from the expired-instruments endpoints when your plan allows them. Everything is cached in the database and never fetched per user.
- Exchange timings and holidays are read from `/v2/market/timings` and `/v2/market/holidays` when available; admins can also edit market hours and holidays.

### ⚠️ Data licensing before going public

Upstox recommends that only Upstox customers consume its data through third-party platforms. Before opening TradeDojo to the public, **get written permission from Upstox** to show their data to your users, **or switch to a licensed MCX data vendor**: implement `backend/src/market/licensed/LicensedVendorProvider.ts` (the TODOs list what's needed) and set `PRICE_PROVIDER=licensed`.

---

## 6. Moving to production (Render + Cloudflare Pages)

The backend is a normal long-running Node process (it keeps the Upstox WebSocket open and runs timers), so it goes on **Render**; the frontend is static files, so it goes on **Cloudflare Pages**. Serverless hosts such as Vercel functions cannot run the backend.

### Backend on Render

1. Push this repository to GitHub (already done if you're reading this there).
2. In Render: **New + → Blueprint**, pick the repository. Render reads `render.yaml` and creates the `tradedojo-api` web service.
3. When asked, fill in:
   - `DATABASE_URL`: the Aiven Service URI **without** `?sslmode=require`
   - `CORS_ORIGINS`: your Cloudflare Pages URL, e.g. `https://tradedojo.pages.dev` (you can add it after step 4 and redeploy)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `UPSTOX_ANALYTICS_TOKEN`
   (`JWT_SECRET` is generated for you.)
4. In the service's **Environment → Secret Files**, add a file named `ca.pem` with the contents of Aiven's CA certificate. Render mounts it at `/etc/secrets/ca.pem`, which `DB_CA_CERT_PATH` already points to.
5. Deploy. Migrations run on startup and the first history backfill starts in the background. Check `https://<your-service>.onrender.com/api/health`.

Keep it on the **Starter** plan (or above) with **one** instance: the free plan sleeps after 15 idle minutes, which drops the live feed, and a second instance would open a second Upstox connection and split replay sessions.

### Frontend on Cloudflare Pages

1. In Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**, pick the repository.
2. Settings: framework preset **None**, root directory `frontend`, build command `npm run build`, output directory `dist`.
3. Environment variables: `VITE_API_URL` = `https://<your-service>.onrender.com` and `NODE_VERSION` = `22`.
4. Deploy. Pages serves `index.html` for unknown paths, so links like `/trades/12` work. Put the resulting `*.pages.dev` URL (or your custom domain) into the backend's `CORS_ORIGINS`.

With HTTPS on both sides the app can be installed to the home screen as a PWA, and the browser connects to the backend's WebSocket at `wss://<your-service>.onrender.com/ws` automatically. The service worker caches only the app shell, never API responses.

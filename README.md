# ByTrader: Telegram signal forwarder and Vantage MT5 AutoTrader

ByTrader listens to private Telegram signal channels as a user account, parses
gold (XAUUSD) trade signals, forwards them to a destination channel, and can
execute them on a Vantage MetaTrader 5 account through a small Expert Advisor
bridge. A Next.js dashboard provides monitoring, execution profiles, safety
limits, alerts and emergency controls.

> **Status.** Execution is implemented and tested offline (simulated broker,
> in-memory Firestore, Firestore emulator). It has **not** been verified against
> Vantage: no order has been sent through the current bridge protocol. Do not
> run it against a live account. See
> `docs/project_memory/VANTAGE_TEST_REPORT.md` and
> `docs/project_memory/VANTAGE_BROKER_ASSUMPTIONS.md`.

---

## Key features

- **Telegram user-session listener** (MTProto): channels, edits and replies, no bot admin rights needed. Signals are forwarded in a fixed format whether or not execution is enabled.
- **Durable hand-off** between the forwarder and the AutoTrader through Firestore: per-event queue state, leases, backoff, dead letters with operator requeue/discard, and a local outbox when Firestore is unreachable.
- **Execution modes**: `disabled`, `paper` (simulated fills on live quotes, never sends orders), `demo` (DEMO accounts only) and `live` (REAL account plus an explicit environment flag).
- **Execution profiles** ("Optimal Report"): versioned, strictly validated settings for sizing, entries, partial take-profits, stop-loss moves, edits and cancels, with draft → approve → activate → rollback. Each trade keeps the profile it started with.
- **Safety**: account-wide hard limits, fail-closed configuration, kill switch, emergency close-all, broker-side SL/TP on every entry, and gates for spread, signal age, quote staleness, clock skew, exposure and daily loss.
- **Order-outcome safety**: intent is recorded before every order, a timed-out order is never resent, and the reconciler settles unknown outcomes from broker state.
- **Operator alerts** on the dashboard (bridge, unresolved orders, failed partial closes or stop moves, unknown positions, Firestore, configuration, service health), with optional webhook or Telegram-bot notifications (off by default).
- **Access control**: Google sign-in limited to an email allow-list (refuses everyone when unset), admin role for every change, and Firestore rules that deny all client writes.

---

## Architecture

```
web/                    Next.js 14 dashboard and server-verified API routes
worker/src/index.ts     Forwarder (:4000): owns the Telegram session, forwards, publishes signal_events
worker/src/autotrader.ts AutoTrader (:4001): signal queue, engine, lifecycle, reconciler, alerts
worker/src/lib/         Worker modules and co-located Vitest tests
mql5/VantageBridgeEA.mq5 ZeroMQ bridge inside MT5 (protocol v2, localhost only)
deploy/                 systemd units, deploy/rollback scripts, MT5 GUI scripts
tests/firestore-rules/  Firestore security rules tests (emulator)
```

The two worker services communicate only through Firestore and can be restarted
independently. Firestore holds configuration and state; the EA is the source of
truth for broker state. Details: `docs/project_memory/ARCHITECTURE.md` and
`docs/project_memory/VANTAGE_DESIGN_CONTRACTS.md`.

## Tech stack

Next.js (App Router), React, TypeScript, Tailwind CSS · Node.js 20+, Express,
GramJS, ZeroMQ · Google Cloud Firestore, Firebase Authentication · MQL5 ·
Vitest, Firebase emulator · systemd (VPS) or Docker Compose.

---

## Getting started

### Prerequisites

- Node.js 20 or newer, npm 9 or newer
- Telegram API credentials (`api_id`, `api_hash`)
- A Firebase project with Firestore and Authentication
- For execution: a Windows/Wine MetaTrader 5 terminal with `VantageBridgeEA` attached (`deploy/MT5_GUI.md`)
- For the rules tests: Java 21 (downloaded automatically if missing)

### Install and run locally

```bash
npm install
cp .env.example .env.local          # fill in values; never commit it
npm run dev                         # web :3000 + forwarder :4000
npm run dev:autotrader              # the AutoTrader (separately)
```

Do not run a development AutoTrader against the same Firestore project and MT5
account as a production one.

### Tests

```bash
npm run lint
npm run typecheck
npm test                 # worker
npm run test:web         # dashboard API routes and view models
npm run test:rules       # Firestore rules in the local emulator
```

### Deployment

On the VPS the services run as systemd user units from `worker/dist/`. Deploy
with `deploy/deploy-v2.sh` (a dry run unless `--execute`); see
`docs/project_memory/VANTAGE_EXECUTION_GUIDE.md` §17. Start with execution
`disabled`, and enable demo trading only through the checklist in §16.

---

## Configuration

`.env.example` documents every variable. The most important:

- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`: service account for the worker and web server.
- `NEXT_PUBLIC_FIREBASE_*`: client SDK settings for the dashboard.
- `ALLOWED_EMAILS`: comma-separated dashboard allow-list. **Required**; unset refuses everyone.
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_PATH`, `MASTER_KEY`: Telegram session and its encryption.
- `WORKER_API_TOKEN`: bearer token for the worker HTTP APIs (loopback-only when unset).
- `MT5_ZMQ_ENDPOINT`: bridge endpoint, loopback only (default `tcp://127.0.0.1:5555`).
- `BYTRADER_LIVE_TRADING`: must be exactly `enabled` before live mode can open trades.
- `ALERT_*`: optional external alert notifications (off by default).

Execution mode, kill switch, safety limits and execution profiles live in
Firestore and are changed from the dashboard (Admin and Profiles pages).

---

## Security practices

- Never commit `.env*` files, service-account keys or the Telegram session.
- The bridge and the worker APIs listen on loopback only.
- Every dashboard change goes through a server route that checks the token, the allow-list and the admin role, and writes an audit entry.
- Alerts and logs redact credential-shaped values; health endpoints expose no secrets.

---

## License

Private and proprietary. All rights reserved.

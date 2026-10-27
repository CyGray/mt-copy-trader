# ByTrader services — Forwarder vs AutoTrader

The worker is split into **two independent systemd services** so one can be
rebuilt / restarted without touching the other. They share code in
`worker/src/lib` but run as separate processes and never import each other's
entry point.

| Service (unit) | Entry point | Port | Bind address | Role |
|---|---|---|---|---|
| `bytrader-worker.service` | `dist/index.js` | `4000` | `WORKER_HOST` (`127.0.0.1`) | **Forwarder** — owns the single Telegram session, parses VIP gold signals, forwards them to Marine Trader FX |
| `bytrader-autotrader.service` | `dist/autotrader.js` | `4001` | `AUTOTRADER_HOST` (`127.0.0.1`) | **AutoTrader** — consumes signal events, executes on MT5, runs the break-even / trailing / cancellation lifecycle |

> Only **one** process may hold the Telegram session at a time — that is the
> forwarder. The AutoTrader never connects to Telegram.

## Installed units vs repo copies

The unit files in `deploy/` are the **repo copies**. On the VPS the services run
as **user units** from `~/.config/systemd/user/` (nvm Node, no `EnvironmentFile`;
dotenv loads `../.env.local`). `deploy/install-services.sh` installs **system**
units into `/etc/systemd/system/` instead and is not what the host uses. Changing `deploy/*.service` does **not** change
the running services. The owner must re-copy and reload:

```bash
sudo cp deploy/bytrader-worker.service deploy/bytrader-autotrader.service /etc/systemd/system/
sudo systemctl daemon-reload
# then restart each service during a maintenance window (see "Deploying safely")
```

Note: `install-services.sh` installs **system** units, while the commands in the
operations section below use `systemctl --user`. Use whichever scope the units
were actually installed under.

## Hand-off: `signal_events`

The forwarder publishes every actionable event to `signal_events`
(`worker/src/lib/signalEvents.ts`) with `create()` on
`${chatId}_${messageId}_${textHash}` and an initial durable queue state
`autotrader.status = "pending"`. If Firestore refuses the write, the event is
spooled to `signal_outbox.jsonl` (next to the Telegram session) and flushed in
order every 15 s; new events queue behind it.

The AutoTrader (`worker/src/lib/signalFeed.ts`, rules in `signalQueue.ts`)
claims unfinished events with a leased transaction, one event per trade set at a
time in `created_at` order, retries transient failures with backoff, and
dead-letters an event after 8 attempts (Dashboard → Signal queue). Restarts
lose nothing: the state is on each document. Full description:
`docs/project_memory/VANTAGE_EXECUTION_GUIDE.md` §12.

Event shape:

```jsonc
{
  "chat_id": "-1003271337051",
  "message_id": "3664",
  "message_type": "new" | "edit",
  "text_hash": "sha256…",
  "kind": "signal" | "cancel",
  "cancel_reason": "unparseable_edit" | "explicit_cancel",   // cancels only
  "signal": { "symbol": "XAUUSD", "direction": "sell", "orderType": "market",
              "entryLow": 4258.5, "entryHigh": 4261, "stopLoss": 4264,
              "takeProfits": [4254, 4247, 4240, 4225] },
  "message_date": "2026-09-24T10:54:22.908Z",
  "created_at": "2026-09-24T10:54:23.100Z",
  "autotrader": { "status": "pending", "attempts": 0, "next_attempt_at": "…", "lease_id": null, … }
}
```

The AutoTrader only acts on events whose `chat_id` is in
`settings/default.mt5.source_chat_ids` (default `["-1003271337051"]`); others
are marked `ignored`.

## MT5 terminal: `bytrader-mt5.service`

A third user unit starts the Wine MT5 terminal on Xvfb `:99` through
`deploy/mt5-start.sh`: it logs in with `MT5_LOGIN` / `MT5_PASSWORD` /
`MT5_SERVER` from the repo `.env` (via a temporary 0600 startup config that is
deleted after start), attaches VantageBridgeEA to EURUSD M1 and waits until
`127.0.0.1:5555` listens. It refuses a server whose name does not end in `-Demo`
unless `MT5_ALLOW_NON_DEMO=1`. A plain terminal restart is not enough: MT5 does
not keep the password and opens a Login dialog with no EA.

```bash
systemctl --user status bytrader-mt5.service
systemctl --user restart bytrader-mt5.service   # recover the terminal + bridge
```

## Heartbeats and alerts

Each service writes `service_status/{forwarder|autotrader}` every 15 s and
raises `service_unhealthy` when the other's heartbeat is older than 3 minutes.
Problems become documents in `alerts/` (Dashboard → Alerts). See the guide §19.

## Host binding and access control

Both HTTP APIs bind to loopback by default:

- `WORKER_HOST` (forwarder) and `AUTOTRADER_HOST` (AutoTrader) default to
  `127.0.0.1`. The units set them explicitly. Containers set `0.0.0.0` on the
  private compose network (see `docker-compose.yml`); the host never publishes
  those ports.
- **`WORKER_API_TOKEN`** (shared secret, optional). When set and non-empty,
  every `/telegram/*` request on the forwarder must send
  `Authorization: Bearer <token>`; anything else gets `401`. When unset, only
  loopback callers are allowed; other callers get `403` (fail closed). The check
  is `requireBearerToken()` in `worker/src/lib/httpAuth.ts`.
- `/health` on both services is unauthenticated and returns no phone number or
  secret values. The forwarder's `/telegram/status` (and the status returned by
  `/telegram/start|verify-otp|verify-password`) masks the phone to its last
  3 digits.

Generate a token with `openssl rand -hex 32` and put it in `.env.local`. Do not
commit it.

> **Before setting `WORKER_API_TOKEN` on a host where the dashboard runs:** the
> web server proxies `/telegram/*` to the forwarder
> (`web/src/lib/workerApi.ts`). That proxy must send the same header first, or
> the Telegram page will get `401`. Until it does, leave the token unset on that
> host. Loopback-only binding is then the protection.

> **`EnvironmentFile=` overrides `Environment=`** in systemd. Do not set
> `WORKER_HOST` or `AUTOTRADER_HOST` in `.env.local`, or the unit's loopback
> default is silently replaced.

## Operating the services

```bash
# status / health
systemctl --user is-active bytrader-worker.service bytrader-autotrader.service
curl -s localhost:4000/health   # {"service":"forwarder","telegram":"authorized","listenerStarted":true,"signalOutbox":0,...}
curl -s localhost:4001/health   # {"ok":true,"protocolVersion":2,"bridge":{...},"account":{...},"execution":{...},"loops":{...},"signalQueue":{...},"issues":[]}

# restart one service without touching the other
systemctl --user restart bytrader-worker.service
systemctl --user restart bytrader-autotrader.service
```

Never compile into `worker/dist/` in place (`npx tsc -p tsconfig.json` without
`--outDir`): it is what the running services load. Deploy with the script below.

## Deploying safely: `worker/dist` is the production artifact

Use the scripts; the full procedure is in
`docs/project_memory/VANTAGE_EXECUTION_GUIDE.md` §17.

```bash
deploy/deploy-v2.sh              # DRY RUN: temp build + read-only preflight + plan; changes nothing
deploy/deploy-v2.sh --execute    # typed confirmation 'DEPLOY V2 <stamp>'
deploy/rollback-v2.sh            # DRY RUN of the rollback
deploy/rollback-v2.sh --execute  # typed confirmation 'ROLLBACK <stamp>'
```

`--execute` builds into `worker/.dist-next-<stamp>`, re-runs the preflight
(aborting before any change on failure), backs up `worker/dist`, the units and
the EA (`MT5_EXPERTS_DIR`) into `~/bytrader-deploy/<stamp>/` with a checksum
manifest, stops the AutoTrader then the forwarder, swaps with two renames,
waits for EA v2 to be attached by hand, starts both, and runs the post-deploy
preflight (EA v2, DEMO account, execution disabled). A failed post check stops
the AutoTrader again and prints the rollback command.

Rules: deploy the worker and EA v2 together (each rejects the other's old
protocol); keep execution `disabled` and the kill switch engaged; keep
`.dist-prev-<stamp>` and the backup for at least a day; do not run `npm ci` /
`npm prune` until then (the v1 build needs `node_modules/bybit-api`).

## Development: running the AutoTrader

`npm run dev` starts the **forwarder only**. To run the AutoTrader with hot
reload:

```bash
npm run dev:autotrader          # from the repo root; runs worker/src/autotrader.ts
```

It reads `../.env.local` from `worker/`, like the production units.

> **Do not run the dev AutoTrader while the production AutoTrader is running
> against the same Firestore project and MT5 account.** Both consume
> `signal_events` and both can drive the broker. Stop the production unit first,
> or use paper/demo mode with a separate Firebase project.

## Environment knobs

| Variable | Default | Service | Meaning |
|---|---|---|---|
| `WORKER_PORT` | `4000` | forwarder | Forwarder HTTP port |
| `WORKER_HOST` | `127.0.0.1` | forwarder | Forwarder bind address (set `0.0.0.0` only inside a container network) |
| `WORKER_API_TOKEN` | unset | forwarder | Bearer token for `/telegram/*`; unset = loopback only |
| `AUTOTRADER_PORT` | `4001` | autotrader | AutoTrader HTTP port |
| `AUTOTRADER_HOST` | `127.0.0.1` | autotrader | AutoTrader bind address (see note below) |
| `BYTRADER_LIVE_TRADING` | unset | autotrader | Must be exactly `enabled` to allow live mode; anything else refuses it |
| `MT5_ZMQ_ENDPOINT` | `tcp://127.0.0.1:5555` | autotrader | VantageBridgeEA ZeroMQ endpoint. Private network only |
| `MT5_TIMEOUT_MS` | `5000` | autotrader | MT5 REQ/REP timeout |
| `SIGNAL_FEED_INTERVAL_MS` | `3000` | autotrader | Feed poll interval |
| `SIGNAL_FEED_LOOKBACK_MS` | `600000` | autotrader | First start only (no stored cursor): look back this far for events written without a queue status |
| `SIGNAL_FEED_MAX_ATTEMPTS` | `8` | autotrader | Attempts before an event is dead-lettered |
| `SIGNAL_FEED_LEASE_MS` | `120000` | autotrader | Claim lease (renewed while running) |
| `SIGNAL_FEED_RETRY_BASE_MS` / `_MAX_MS` | `5000` / `300000` | autotrader | Exponential backoff |
| `LIFECYCLE_INTERVAL_MS` | `2000` | autotrader | Position-management poll interval |
| `MAX_QUOTE_AGE_SEC` | `60` | autotrader | Entries refused (`quote_stale`) when the last tick is older |
| `MAX_CLOCK_SKEW_SEC` | `5` | autotrader | Entries refused (`clock_skew`) when the EA clock is further off |
| `PAPER_SPEC_TTL_MS` / `PAPER_MAX_QUOTE_AGE_MS` | `900000` / `60000` | autotrader | Paper spec refresh; paper market-closed threshold |
| `ALERT_MONITOR_INTERVAL_MS` | `15000` | autotrader | Health checks + heartbeat |
| `SERVICE_STALE_MS` | `180000` | both | Peer heartbeat age that raises `service_unhealthy` |
| `SIGNAL_OUTBOX` / `SIGNAL_OUTBOX_PATH` / `SIGNAL_OUTBOX_MAX` | enabled / next to the session / `5000` | forwarder | Local spool for events Firestore refused |
| `ALERT_NOTIFICATIONS` | unset (off) | both | `enabled` + a channel turns on external notifications |
| `ALERT_WEBHOOK_URL`, `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID`, `ALERT_NOTIFY_MIN_SEVERITY` | unset, `error` | both | Notification channels (https webhook; a bot, not the user session) |

`AUTOTRADER_HOST` and `WORKER_HOST` are passed to `listen` (default `127.0.0.1`).

## Docker (optional)

`docker-compose.yml` runs `web`, `forwarder`, and `autotrader`. Only `web` is
published (`3001`). Service names changed from the old single `worker` service:
use `docker compose logs forwarder` / `autotrader`. The Telegram session lives
in the `telegram_session` named volume, mounted only on `forwarder`.

# ByTrader services — Forwarder vs AutoTrader

The worker is split into **two independent systemd services** so one can be
rebuilt / restarted without touching the other. They share code in
`worker/src/lib` but run as separate processes and never import each other's
entry point.

| Service (user unit) | Entry point | Port | Role |
|---|---|---|---|
| `bytrader-worker.service` | `dist/index.js` | `4000` | **Forwarder** — owns the single Telegram session, parses VIP gold signals, forwards them to Marine Trader FX |
| `bytrader-autotrader.service` | `dist/autotrader.js` | `4001` | **AutoTrader** — consumes signal events, executes on MT5, runs the break-even / trailing / cancellation lifecycle |

> Only **one** process may hold the Telegram session at a time — that is the
> forwarder. The AutoTrader never connects to Telegram.

## Hand-off: `signal_events`

The forwarder publishes every actionable event to the Firestore collection
`signal_events` (`worker/src/lib/signalEvents.ts`). The AutoTrader polls it
(`worker/src/lib/signalFeed.ts`, ordered single-field query on `created_at`, no
composite index required) and dispatches to `mt5TradeEngine`.

Event shape:

```jsonc
{
  "chat_id": "-1003271337051",
  "message_id": "3664",
  "message_type": "new" | "edit",
  "text_hash": "sha256…",
  "kind": "signal" | "cancel",
  "signal": { "symbol": "XAUUSD", "direction": "sell", "orderType": "market",
              "entryLow": 4258.5, "entryHigh": 4261, "stopLoss": 4264,
              "takeProfits": [4254, 4247, 4240, 4225] },
  "message_date": "2026-09-24T10:54:22.908Z",
  "created_at": "2026-09-24T10:54:23.100Z"
}
```

- `kind: "signal"` → `handleGoldSignal` (idempotent by `trade_set` id; stale
  signals are dropped by `max_signal_delay_sec`).
- `kind: "cancel"` → `cancelGoldTrade` (fires when an edited message no longer
  parses as a signal).

The AutoTrader only acts on events whose `chat_id` is in
`settings/default.mt5.source_chat_ids` (default `["-1003271337051"]`).

## Operating the services

```bash
# status / health
systemctl --user is-active bytrader-worker.service bytrader-autotrader.service
curl -s localhost:4000/health   # {"service":"forwarder","telegram":"authorized",...}
curl -s localhost:4001/health   # {"mt5Bridge":"ok","signalFeed":"running","lifecycleManager":"running",...}

# update ONLY the forwarder
cd ~/projects/ByTrader/worker && npx tsc -p tsconfig.json
systemctl --user restart bytrader-worker.service

# update ONLY the autotrader
cd ~/projects/ByTrader/worker && npx tsc -p tsconfig.json
systemctl --user restart bytrader-autotrader.service
```

The `npx tsc` build is shared, but the restart is per-service — that is what
keeps the two from affecting each other.

## Environment knobs

| Variable | Default | Service | Meaning |
|---|---|---|---|
| `WORKER_PORT` | `4000` | forwarder | Forwarder HTTP port |
| `AUTOTRADER_PORT` | `4001` | autotrader | AutoTrader HTTP port |
| `SIGNAL_FEED_INTERVAL_MS` | `3000` | autotrader | Feed poll interval |
| `SIGNAL_FEED_LOOKBACK_MS` | `300000` | autotrader | Replay window on startup |
| `LIFECYCLE_INTERVAL_MS` | `2000` | autotrader | Position-management poll interval |

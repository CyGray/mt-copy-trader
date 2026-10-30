---
name: bytrader-go-ops
description: How to change and operate the LIVE ByTrader Go stack on this host (forwarder, executor, web, MT5 bridge EA) — where the code really is, offline build and test, backup/deploy/restart, changing settings that have no API, compiling and reloading the EA, a synthetic end-to-end trade check, monitoring, and rollback. Use when asked to wire a parser, profile or setting into the auto trader or forwarder, to deploy a Go change, to fix "executor not trading", or to check the live system. Not for research-only questions (use clean-research and signal-provider-analysis).
---

# ByTrader Go stack: change and operate

Learned on 2026-10-29 deploying the GAB ladder profile to demo (record:
`docs/research/signal_provider/2026-10-27-two-channels/deploy_gab_demo/README.md`). Follow it instead of
rediscovering the system.

## 0. Authority first

Anything here touches a live trading system. Do **only** what the owner explicitly authorized in this
conversation: deploys, restarts, profile activation, mode, kill switch, EA changes, test orders, source chats.
Demo vs live matters: confirm `ACCOUNT_INFO.trade_mode == "DEMO"` before any demo work, and never enable `live`
without a separate, explicit instruction. The owner's stop control is the dashboard **kill switch** (blocks new
entries; protective management keeps running). Never print `.env`, `web.env`, MT5 credentials, session data,
or the full broker login (mask to the last 3 digits).

## 1. What is live (the repo docs are stale here)

| Piece | Where |
|---|---|
| Units (systemd **--user**) | `bytrader-go-forwarder`, `bytrader-go-executor`, `bytrader-go-web` (127.0.0.1:8081), `bytrader-go-tunnel` (Cloudflare), `bytrader-mt5` (oneshot: Xvfb + Wine terminal) |
| Binary (all three roles) | `~/services/bytrader-go/bin/bytrader` (`bytrader version` shows the revision) |
| Source | `~/services/bytrader-go/src` — **not a git repo**. It is the newest copy (an older one sits uncommitted in a codex worktree `task-20261024-042111-8f798f59`). Its `AGENTS.md`/`DEPLOYMENT.md` are copies of the Node docs: ignore them except the Go note at the top |
| State | `~/services/bytrader-go/state/state.sqlite` (table `documents`: `collection`, `id`, `body` JSON + index columns). Read with `python3 -I` + `sqlite3.connect("file:...?mode=ro", uri=True)`; the `sqlite3` CLI is not installed |
| Env | `~/.config/bytrader-go/web.env` (Telegram API id/hash, master key; never print). MT5 login for the terminal: `~/projects/ByTrader/.env` (read by `deploy/mt5-start.sh`) |
| Toolchain | `~/services/bytrader-go/toolchain/go/bin/go` (go1.27.3), module cache `~/services/bytrader-go/.gomod`; offline only |
| EA | `~/.wine-mt5/drive_c/Program Files/MetaTrader 5/MQL5/Experts/VantageBridgeEA.mq5/.ex5`; Go needs **EA ≥ 2.0.1** (source `src/mql5/VantageBridgeEA.mq5`) |
| Bridge (read-only) | `docs/research/signal_provider/2026-10-21/analysis/oos2/bridge_ro.mjs [SYMBOL]` (PING, ACCOUNT_INFO, SYMBOL_INFO, positions, orders; refuses mutations; masks login) |

Data flow: forwarder (owns the only Telegram session) → `domain.ParseGoldSignal` → `signal_events` (durable
queue in SQLite) → executor `engine.HandleEvent` → `prepare()` (gates, sizing, checkpoints) → MT5 bridge →
lifecycle loop every **5 s** (breakeven, trailing, checkpoints) and reconciler every 30 s.

Settings live in `settings/default`:
- `execution.mode` (`disabled|paper|demo|live`), `execution.active_profile_doc_id` (`<profile_id>__v<n>`),
  `trading.kill_switch`, `safety` (defaults in `domain.DefaultSafetyLimits`), `migration.replay_not_before`.
- **`mt5.source_chat_ids`** = which chats the *executor* trades (default `["-1003271337051"]`). It has **no API
  or UI**. Others' events end as `chat_not_configured`.
- `telegram.signal_source_chat_ids` = which chats the *forwarder republishes* to `forward_chat_id` (Marine
  Trader FX, a public channel — outward-facing; never add a chat without asking).
- `telegram.allowed_chat_ids` empty = the forwarder records every chat not in `blocked_chat_ids`.
- There is **one active profile for all source chats**. Adding a chat with different management means the other
  chats trade with it too; restrict `mt5.source_chat_ids` instead.

## 2. Change the code

1. Copy, never edit in place first:
   `rsync -a --exclude node_modules --exclude web --exclude worker --exclude tests ~/services/bytrader-go/src/ <scratch>/src/`
2. Env for every go command:
   `GOMODCACHE=~/services/bytrader-go/.gomod GOCACHE=<scratch>/gocache GOPROXY=off GOFLAGS=-mod=mod GOTOOLCHAIN=local GOTELEMETRY=off CGO_ENABLED=0`
3. Where things are: parser `internal/domain/parser.go`; profile schema + validation `internal/domain/profile.go`
   (strict key lists `*Keys`; unknown keys are rejected, so the **web role must run the new binary** before a
   profile with new keys can be read anywhere); entry gates `internal/domain/entry.go`; order preparation
   `internal/engine/signals.go` `prepare()`; edits `internal/engine/revisions.go`; stop logic
   `internal/domain/lifecycle.go` `DesiredStopLoss`; executor chat list `internal/engine/control.go`.
4. Tests: `go test ./...` (about 3 to 10 min here; run in the background). `internal/domain/golden_test.go`
   guards parser parity with the old TypeScript corpus. Engine tests use `newIntentTestWorld` +
   `runner.prepare(...)` on the simulated broker (see `engine/gab_ladder_test.go`). Check a new parser against
   the provider's real history offline (a throwaway `cmd/` tool reading the dump; delete it before deploying).
5. Build: `go build -trimpath -buildvcs=false -ldflags "-X main.version=<v> -X main.revision=<rev>" -o <scratch>/bytrader ./cmd/bytrader`
   (several minutes; the embedded web assets in `internal/assets/dist` are reused, so no npm build). `gofmt -l`
   your files.

## 3. Deploy

1. Backups into `~/services/bytrader-go/backups/<tag>-<UTC>/` (mode 700):
   `bin/bytrader backup --db state/state.sqlite --output <dir>/state.sqlite` (online, safe), the old binary as
   `bin/bytrader.<tag>-<UTC>`, every source file you replace (keep backups **outside** package dirs: a stray
   `.go` copy breaks the build), and the EA `.mq5/.ex5` if touched.
2. Copy changed source into `~/services/bytrader-go/src`, then `install -m 755 new bin/bytrader.new && mv -f bin/bytrader.new bin/bytrader`.
3. `systemctl --user restart bytrader-go-executor bytrader-go-forwarder bytrader-go-web`.
4. Check: `systemctl --user is-active ...`; `journalctl --user -u bytrader-go-executor --since -2min -o cat`;
   `service_status` docs `healthy: true` (forwarder `telegram_status: authorized`, executor `readiness.ready`);
   `alerts` `service_unhealthy__*` raised during the restart must turn `resolved` within about 15 s.

## 4. Settings without an API

The web routes (`/api/profiles/*`, `/api/execution/mode`, `/api/execution/kill-switch`) need an admin browser
login an agent does not have, and `mt5.source_chat_ids` has no route at all. Use a one-off Go tool built against
the same module (`references/tools/gabsetup.go.txt`) that, in **one store transaction**, validates the profile
(`domain.ValidateProfile` + `ValidateProfileAgainstSafety`), creates it `active` with the same envelope fields
as the handlers, supersedes the previous active profile, sets mode / kill switch / source chats, and writes the
same `admin_audit` and `execution_profile_audit` rows (actor `claude-agent (owner-authorized …)`). Dry run first
(it rolls back), rehearse `--apply` on a copy of the backup DB, then apply live. The store opens SQLite in WAL with
a busy timeout, so it is safe beside the running services.

## 5. The MT5 EA

- Symptom of an old EA: executor logs `reconcile demo broker state: server time offset is unknown` and events stay
  `pending` / get `signal_too_old`. Cause: Go `bridge/broker.go` needs PING `server_time_source: TimeTradeServer`
  (EA 2.0.1). Check with `bridge_ro.mjs` (`ea_version`).
- Compile from the shell (exit code unreliable; read the log):
  `cd ".../MetaTrader 5" && WINEPREFIX=~/.wine-mt5 wine MetaEditor64.exe /compile:"MQL5\Experts\VantageBridgeEA.mq5" /log:"MQL5\Experts\compile.log"; iconv -f UTF-16LE -t UTF-8 MQL5/Experts/compile.log | tail -3`
- **A shell compile does not reload the EA in the running terminal.** Restart the terminal while flat: kill
  `pgrep -f '^terminal64\.exe'`, wait until it is gone, `systemctl --user restart bytrader-mt5`. If the unit says
  "bridge already listening" the old socket was still closing: run the restart again. `mt5-start.sh` logs in
  from `~/projects/ByTrader/.env` (refuses non-demo servers) and returns when :5555 listens (about 60 s).
- Afterwards confirm PING `ea_version`, `ACCOUNT_INFO.trade_mode`, no unexpected positions, and an executor
  `reconciler_pass_completed` with `skipped_modes: null`.

## 6. Prove it end to end

Synthetic signal (only with authorization; it opens a real demo order): `references/tools/gabsmoke.go.txt`
parses a provider-format text with the production parser and publishes the event exactly as the forwarder does
(`store.PublishSignalEvent`, id `chat_message_sha256(text)`, `message_date` = now). Use a message id that cannot
collide (`99000000x`), get the ask from `bridge_ro.mjs` just before, and inject promptly: the age gate is 120 s.
Then `references/tools/trade_status.py <chat>_<msg>` shows state, plan (SL, broker TP, checkpoints, risk),
broker refs and the trade events (`signal_validated → entry_submitted → entry_confirmed → protection_confirmed`).
Compare SL/TP with `bridge_ro.mjs` positions. Record the synthetic ids so results analysis excludes them. Watch
breakeven/trailing with a Monitor or background until-loop on `lifecycle.be_applied` / `trailing_active` / state.

## 7. Rollback

Kill switch on → restore `bin/bytrader.<tag>` → restart the three units → restore source files → re-activate the
previous profile and source chats (same tool, or the dashboard for profile/mode). Full DB restore
(`bytrader restore`, services stopped) loses every record since the backup; use it last. Keep EA ≥ 2.0.1.

## 8. Traps hit so far

- `expandShortRange` turns a descending full-price range "4010.5 - 4008" into 44008; only use it for real short
  forms ("4010-08").
- `DecideEntry` refuses a market signal outside the zone ± `market_tolerance_price`, even with `market_only`.
- Checkpoints reference *signal* TP indices unless `take_profit.distance_step_price` is set (targets at fill ±
  k·step); `stop_loss.widen_price` moves the posted stop out. Both are optional and default to old behaviour.
- `BreakEvenTriggered` / `TrailingActivated` look at the *current* price; persistence comes from
  `lifecycle.be_applied` / `trailing_active`. Unit tests must pass those flags.
- Restart alerts (`service_unhealthy__*`) are expected for one heartbeat.
- Executor `signal intake failed: context deadline exceeded` about hourly at :17 (since at least 2026-10-26):
  root's `/etc/cron.hourly` runs `drop_caches` and `fstrim /`, stalling disk I/O. Readiness drops until the next
  reconcile (≤ 30 s); the queue is durable and the age gate is 120 s, so a signal is delayed, not lost. Changing
  it needs root and the owner's decision.
- Non-signal posts reach the executor as `kind: cancel` → `noop / no_trade_set`; that is not a parser failure.
  Check `telegram_messages` text before suspecting the parser.
- `pkill -f <pattern>` kills your own shell if the pattern is in its command line; anchor with `^`.
- The connected demo is the ~50k account (login ending 961) unless the owner re-logs MT5; check before quoting
  account size.

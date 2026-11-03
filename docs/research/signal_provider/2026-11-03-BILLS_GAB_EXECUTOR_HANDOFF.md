# ByTrader: Bills Trading + GAB demo routing (3 November 2026)

## Evidence and boundaries

- GAB FX channel `-1003740937489`: research-backed *demo* profile `gab-ladder-w80-n1__v1`, fixed **0.01 lot**, posted stop widened **8 USD** (80 GAB pips), breakeven at **+10 USD** and **3 USD** trailing distance, 100 USD final synthetic target. The 2026-10-29 replay found **negative August–October out-of-sample expectancy**. Not suitable as a claimed profitable or live-money setup.
- Bills Trading channel `-1003192025181`: present in `TELEGRAM_CHATS.md` as a previously blocked chat. No messages for it existed in the Go `telegram_messages` store on 2026-11-03; no Bills-specific backtest or verified signal syntax exists. No optimal TP/SL can be stated. The included `bills-observation-tp1` 0.01-lot, posted-stop, TP1-only profile is explicitly **draft**, a placeholder for review, **not execution enabled**.
- The unrelated old VIP gold provider `-1003271337051` is not Bills Trading. Its second out-of-sample performance was negative (-0.66 R); do not reuse that provider's TP4 findings for Bills.

## Go executor change

The current running system is Go, under `~/services/bytrader-go/src`, not the older Node worker. Code in `go/` adds optional `settings/default.mt5.source_profile_doc_ids` with exact chat-ID-to-profile-document-ID mapping. If present, every source requires an explicit approved/active profile. Missing, draft, malformed, or vanished profiles fail closed. Source-specific profile choice is checked **again before broker mutation**; protection of already open positions continues under their immutable snapshot. With the map absent, the legacy global profile behavior is unchanged.

## Intended demo-only configuration

- Keep `execution.mode=demo`, `execution.active_profile_doc_id=gab-ladder-w80-n1__v1`, and existing safety limits / kill switch unchanged.
- `mt5.source_chat_ids`: **only GAB FX** at first, while Bills is researched; don't add Bills until historical signals and parser are validated.
- `mt5.source_profile_doc_ids`: GAB maps to `gab-ladder-w80-n1__v1`; Bills maps to `bills-observation-tp1__v1`, a **draft** that cannot place orders even if Bills is accidentally added to `source_chat_ids`.
- Remove Bills alone from `telegram.blocked_chat_ids` to capture *future* signals. Keep `telegram.signal_source_chat_ids` unchanged, so Bills is not forwarded to Marine Trader FX.
- Do not trigger synthetic orders, upgrade Wine, turn on real-money execution, or touch the MT5 account login as part of this change.

## Validation and rollback

Run `go test ./...`, build to a temp output, inspect the diff and ensure all trade sets are settled. Before any restart, take a consistent database backup with the Go store backup function and back up the existing binary and modified source files. Restart **only** the Go executor (then forwarder if needed for the chat unblock); confirm systemd active, logs normal, reconciliation ready, service heartbeats advancing and web/API healthy. Check GAB source mapping and Bills draft status from the actual SQLite store. Restore only the changed settings/code if rollback is needed, never overwrite the running SQLite database with an old backup without planning for lost records.

A successful process restart or test run is not a guarantee of future broker fills or profitability.

## Deployment record (verified 2026-11-03, VPS Europe/Berlin time)

**Applied by direct shell commands, not delegated agents.** `go test -p 1 ./...` passed all Go packages after staging the production Go source and its test fixtures in this worktree. The compiled 103 MB Go executable was staged and installed via an atomic rename to `~/services/bytrader-go/bin/bytrader` after creating:

- Consistent SQLite backup: `~/services/bytrader-go/backups/pre-bills-gab-20261103/state.sqlite` (`PRAGMA integrity_check: ok`).
- Original executable and original `internal/engine/{control,signals}.go` at `~/services/bytrader-go/backups/pre-bills-gab-20261103/`.

The validated setup command was applied once to the live SQLite store in a transaction. Readback proved `demo` mode, unchanged global GAB profile/kill switch/active source and safety, per-source map for GAB and Bills, draft-only 0.01-lot Bills profile, and removal of Bills from the Telegram blocked list. No live-money mode was enabled, no synthetic signal was sent and no broker order was submitted by the rollout.

The pre-existing Wine 9 MT5 terminal had stopped although its one-shot unit still showed active; `systemctl --user --no-block restart bytrader-mt5.service` restored the `terminal64.exe` process and the 127.0.0.1:5555 ZeroMQ bridge. Wine was *not* upgraded.

The Go executor was restarted at approximately 2026-11-03 10:30 CET, PID `2829194`. Reconciliation passes succeeded. One initial `context deadline exceeded` on queue intake was observed, then the next reconciliation recovered. Follow-up SQLite `service_status` records reported **executor, forwarder and web all `healthy=true`, `issues=[]`**; MT5 bridge listening; all five systemd user units active; zero open risk-state trade sets. **This is point-in-time health, not a guarantee of future fills, sustained uptime or profitability.**

## Safe continuation

Before activating Bills, first collect and inspect actual messages and edits, validate the Bills parser and entry/SL/TP syntax, reproduce a backtest with conservative broker costs and holdout performance, and require owner review of a new approved profile. Until then, keep the Bills source out of `mt5.source_chat_ids`, even though its messages are now recorded. Current GAB demo is a research exercise with negative out-of-sample expectancy; do not automatically promote it to real-money mode.

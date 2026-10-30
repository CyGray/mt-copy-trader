# GAB FX ladder: demo deployment (2026-10-29)

The owner asked for the best case from `../REPORT_GAB_LADDER.md` to be wired into the live Go stack on the Vantage
**demo** account, autonomously. The kill switch remains the owner's stop control.

## What runs now

| Item | Value |
|---|---|
| Executor source chats | **GAB FX only** (`settings.mt5.source_chat_ids = ["-1003740937489"]`). The VIP channel no longer trades: there is one active profile for all chats. |
| Active profile | `gab-ladder-w80-n1__v1` (`gab-ladder-w80-n1.json`); previous `demo-xauusd-qa__v1` superseded |
| Mode / kill switch | `demo` / off |
| Entry | market, if the price is within 10.00 of GAB's zone |
| Stop | GAB's stop moved 8.00 further away (80 pips) |
| Size | 0.01 lot |
| Breakeven / trail | at +10.00 from the fill: stop to the fill, then a 3.00 trail (step 0.10) |
| Target | +100.00 (engine-managed; no broker TP) |
| Limits | 1 position, spread ≤ 0.50, signal age ≤ 120 s, daily loss 100, profile and safety unchanged otherwise |
| GAB edits / cancels | ignored (as in the backtest) |
| Forwarding to Marine Trader FX | not enabled for GAB |

## What changed

1. **Go code** (`bytrader-go-gabladder.patch`, deployed to `~/services/bytrader-go/src` and `bin/bytrader`,
   revision `435466f-forwardfix-gabladder`):
   - parser: the "Gold BUY|SELL Now INSTANT" template (only when the standard parser fails; the golden corpus is
     unchanged). On GAB's 130 May–Oct signals it gives the same side, zone and stop as the research parser on
     126 (3 of them have a mistyped second target, which is dropped). It rejects 3 provider typos that the
     research parser also flagged, and 1 signal whose stop sits on the zone edge;
   - profile: optional `stop_loss.widen_price` and `take_profit.distance_step_price` (targets at fill ± k·step);
     applied when a trade is prepared and to edit revisions; absent or 0 means the old behaviour;
   - tests: `domain/signal_adjust_test.go`, `engine/gab_ladder_test.go`; `go test ./...` passes.
2. **Bridge EA 2.0.0 → 2.0.1** (`ea-2.0.0-to-2.0.1.patch`). The Go broker needs `server_time_source` in PING; with
   2.0.0 every demo broker read failed ("server time offset is unknown"), so the Go executor could not have traded
   at all. Compiled 0 errors / 0 warnings; MT5 restarted with `deploy/mt5-start.sh` (same demo login).
3. **Settings** written in one transaction by `gabsetup` (`gabsetup.go.txt`; dry run first, then `--apply`), with
   the same audit records as the web handlers (`admin_audit`, `execution_profile_audit`, actor
   `claude-agent (owner-authorized GAB ladder demo)`).

## End-to-end check

A synthetic GAB-template signal (message id `990000002`, marked `synthetic` on the event) was published like the
forwarder does. The executor opened 0.01 BUY at 4043.16 with stop 4023.20 (= 4031.20 − 8.00), no broker TP, final
target 4143.15, risk 19.95. **Exclude message ids 990000001–990000002 when evaluating GAB's demo results.**
(990000001 was skipped as too old while the EA was being fixed.)

Outcome (Verified from `trade_events`): the best price reached 4046.16, short of the +10.00 breakeven
trigger (4053.16), and the stop closed the position at 4023.20 at 05:55:54 UTC, about −19.96 USD before
commission. Entry, stop placement, engine-managed target and the stop exit all behaved as configured;
breakeven and trailing have not yet been seen live.

First day (to 2026-10-30 03:55 UTC, Verified): GAB posted 37 messages, all promotion; no signal, so no trade.
Non-signal messages reach the executor as `kind: cancel` and end `noop / no_trade_set`; that is expected.

## Known differences from the backtest

- The engine checks prices every 5 s, not every tick; breakeven and trail react to 5-second samples.
- Entry needs the price within 10.00 of the zone; the backtest entered anywhere.
- The account is the 50k demo (login ending 961, the one in `.env`), not a 5,000 account.

## Rollback

```
B=~/services/bytrader-go/backups/pre-gabladder-20261029-034054
# 1. stop new entries: kill switch on in the dashboard
# 2. binary
cp ~/services/bytrader-go/bin/bytrader.pre-gabladder-20261029-034054 ~/services/bytrader-go/bin/bytrader
systemctl --user restart bytrader-go-executor bytrader-go-forwarder bytrader-go-web
# 3. source: copy $B/src/internal/... back, delete signal_adjust*.go, testdata/gab_ladder_profile.json, engine/gab_ladder_test.go
# 4. settings: re-activate demo-xauusd-qa__v1 in the dashboard and set mode; mt5.source_chat_ids has no UI
#    (or restore $B/state.sqlite with `bytrader restore` while services are stopped: loses all records since)
```
Keep EA 2.0.1: the Go stack needs it whatever the profile (backup of 2.0.0 in `$B/ea`).

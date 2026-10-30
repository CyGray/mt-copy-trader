# Signal-provider research: history

Research record for the Telegram signal providers studied so far: the XAUUSD provider (channel `-1003271337051`,
evidence in `2026-10-21/`) and, from 2026-10-27, GAB FX (`-1003740937489`) and LUCAS GOLD LEGEND
(`-1002371904451`, evidence in `2026-10-27-two-channels/`). Newest conclusion first, then how we got there. The
repeatable procedure is the skill `.claude/skills/signal-provider-analysis/SKILL.md`.

Up to 2026-10-28 nothing was approved or activated, and no broker order, close, restart, deploy, Firestore
write, Telegram send, `.env` change or profile activation took place. **On 2026-10-29 the owner ordered the GAB
ladder best case live on the Vantage demo account** (section 0a). That deployment is operations, not research:
`2026-10-27-two-channels/deploy_gab_demo/README.md` and the skill `.claude/skills/bytrader-go-ops/SKILL.md`.

## 0a. GAB FX, full history and the owner's ladder (2026-10-28 / 29)

| Step | Result | Label |
|---|---|---|
| Live read of the whole channel (owner-authorized separate research session, read-only allowlist) | 5,231 messages since 2026-02-02; **303 gold signals**. The "0 signals" below was true only for the recorded day | Verified |
| GAB's own signals, May-Oct (126), posted levels | Losing under every entry and target rule: mean -0.06 to -0.13 R, profit factor 0.63-0.85; worse since July. Main product is a crypto "trading bot" offer that looks like a scam; engagement looks bought; claims are raised by edits | Modeled / Inferred |
| Owner's ladder: stop widened 80 or 130 pips, 0.01 closed every 100 pips, breakeven at +100, last 0.01 trailing, 1-6 legs | Best: 80 pips, 1 leg, 30-pip trail, +1.2 USD per signal (CI -1.5 to +4.0). Loses in Sep-Oct and in every lot size out of sample. 130 pips and more legs are worse | Modeled |
| Demo deployment (2026-10-29, owner's order) | Go parser for the GAB template, profile fields `widen_price` / `distance_step_price`, profile `gab-ladder-w80-n1__v1`, executor limited to GAB, mode demo. Fixed a blocker: EA 2.0.0 made every Go demo broker read fail (EA 2.0.1 deployed). A synthetic signal (ids 990000001-2, exclude from results) opened 0.01 with the widened stop | Verified |

Reports: `REPORT_GAB_LIVE.md`, `REPORT_GAB_LADDER.md`. Expected value of the demo run: about zero or negative.

## 0. Two more channels (2026-10-27): no data yet

| Channel | Data available | Verdict | Label |
|---|---|---|---|
| GAB FX `-1003740937489` | 28 messages, 1 day; **0 entry signals** (signals are sold in a paid "circle"; the channel has profit claims and a forwarded crypto-bot offer) | Unknown, no data. Nothing to trade; do not pay for the circle on this evidence | Verified (contents), Inferred (funnel) |
| LUCAS GOLD LEGEND `-1002371904451` (the provider's free channel) | 50 messages, 1 day, **2 gold signals** | Unknown, insufficient data. Pilot n = 2 (one TP3 win, one stop) proves the pipeline only | Modeled |

- Neither channel trades forex. Both quote gold, and both call 0.10 USD a "pip".
- History before 2026-10-26 does not exist in any store the research may read (Firestore, journals,
  exports, public previews). The Go forwarder now records every revision of both. A Telegram Desktop export of
  the Lucas channel (`OWNER_ACTION.md`) is the fast path to 160 signals.
- The live Go parser does not read the Lucas zone format, and the executor ignores both chats (not source chats).
- Holm across the three providers: none has a CI above zero, so nothing survives.
- Second pass (same day): a Lucas-specific grammar and a live-follower simulation show the provider's own
  management made about 0 R on its 2 signals (best reading +0.46 R mean). One instruction was rewritten after the
  price moved, and all 9 sell claims quote an unreachable price. Other channels in the account:
  dannygenwealth VIP `-1004426286726` (1 signal in 725 messages, posted past its stop) and `-1004427167750`
  (3 signals, 2 posted after price had passed TP1). All Unknown; none tradable on this evidence
  (`REPORT_LUCAS_DEEP.md`, `REPORT_OTHER_CHANNELS.md`).

## 1. XAUUSD provider `-1003271337051`: current conclusion (2026-10-26)

**No stable, tradable edge has been shown. Do not trade this provider with real money.**

| Period | Signals | Result | Label |
|---|---|---|---|
| 2025-10-30 .. 2026-09-24, train + validation | 325 | Used to pick finalists; nothing distinguishable from zero afterwards | Modeled |
| Same period, out-of-sample slice | 81 | Conservative draft (single exit at TP4, break-even at +4.0 USD) about +0.20 R, CI spans zero | Modeled |
| 2026-09-24 .. 2026-10-22, OOS2 (pre-registered) | 58 | **Every frozen strategy negative.** Conservative draft -0.66 R, 95% CI [-0.79, -0.52], n = 53; none reached TP4 (33 stopped out, 20 at break-even) | Modeled |

- The sign flips between periods, so the edge is not stable.
- Price touched the stop within 72 h in about 95% of OOS2 signals, TP1 in 91%, TP4 in 50%: stops are tight
  relative to the swings.
- Only about 16% of signals can be filled strictly at the posted price; about 90% fill with the project's
  `pending_at_range` policy.
- Runners, trailing stops, multi-checkpoint splits and the SELL > BUY / trend > range filters did not help.
- The Conservative draft is an **operations test** for the demo account (order mechanics, sizing, break-even
  handling), with no profit expectation.

Open: why the early sample looked slightly positive; whether late edits carry information; provider quality
after 2026-10-22; Vantage commission, margin and in-hours spread.

## 2. Timeline

| Date | Step | Output |
|---|---|---|
| 2026-10-21 | Main study. Three parallel investigators (history, live Telegram, market data), then engine + baseline, TP/runner optimiser, Vantage sizing, then profile architect + independent auditor. 415 accepted signals (406 clean), 83.6M Dukascopy ticks | `2026-10-21/*.md`, `execution_profile.draft.json`, `alternates/`, `analysis/` |
| 2026-10-21 | Finalists frozen by hash before any OOS look; one-time OOS run guarded by a lock file | `analysis/b2/`, `aggregates/b2_finalists.json` |
| 2026-10-21 | Independent auditor (C2) rebuilt decoder and simulator from the spec; reproduced B2 trades with 0 mismatches and found the edit-timing bias | `RESEARCH_VALIDATION.md` section 6 |
| 2026-10-24 | Cross-check against the live system: read-only bridge queries (demo account and XAUUSD spec), forwarder journal, Firestore quota diagnosis, review of the `auto-trader` session's v2 deployment | `OOS2_AND_LIVE_CROSSCHECK.md` section 5 |
| 2026-10-24 | OOS2: pre-registration written before any message text of the period was read (sha256 `073151fa...6702`), then the test | `PREREGISTRATION_OOS2.md`, `OOS2_AND_LIVE_CROSSCHECK.md` |
| 2026-10-25 | Not research: the AutoTrader was stopped cleanly at 14:02Z and the forwarder stopped at 14:09Z on Telegram `401 AUTH_KEY_UNREGISTERED` (session invalidated). No new signals are received until the owner re-authorises the Telegram session | forwarder journal |
| 2026-10-26 | Plain-language synthesis for the owner; this history and the skill written | this file, the skill |
| 2026-10-27 | Two-channel study (GAB FX, LUCAS GOLD LEGEND): data ladder (Go SQLite store, Firestore count, journals, public previews), pre-registration, new parser for the zone / multi-signal format, symbol-generalised engine (FX), pilot, read-only Vantage specs, independent audit, OWNER_ACTION | `2026-10-27-two-channels/` |
| 2026-10-28 | GAB FX live full-history read (separate research session), parser for 12 templates, M1 replay validated on ticks, forensics (edits, deletions, hooks, engagement) | `2026-10-27-two-channels/REPORT_GAB_LIVE.md`, `analysis/gab/` |
| 2026-10-29 | Owner's ladder plan on GAB (widened stop, 100-pip rungs, breakeven, trail, 1-6 legs), out-of-sample trail choice | `REPORT_GAB_LADDER.md` |
| 2026-10-29 | Ladder best case deployed to the Vantage demo on the owner's order (Go code, EA 2.0.1, settings, synthetic end-to-end trade) | `deploy_gab_demo/README.md` |
| 2026-10-27 | Second pass: Lucas grammar, live-follower simulation and claims audit; inventory of every stored chat, prelim and deep check of the two other channels; public-preview scrape (bulk reposts, unusable) | `2026-10-27-two-channels/REPORT_LUCAS_DEEP.md`, `REPORT_OTHER_CHANNELS.md` |

## 3. Decisions that shaped the result

1. **Read-only research mode.** Allowed: repo files, local datasets, read-only broker queries, offline analysis,
   reports and draft configs. Forbidden: orders, closes, restarts, `worker/dist`, `.env*`, profile activation,
   kill switch, Firestore trading settings, Telegram sends, a second Telegram session.
2. **Prices come from Dukascopy ticks, not Vantage.** Cost scenarios BASE / MID / PESS stand in for the spread
   and latency difference. MID is primary.
3. **Three entry models:** E1 market within 2.0 USD of the range, E2 the project's `pending_at_range`
   (tolerance 0.5 USD, 60 min), E3 strict market inside the range.
4. **Freeze then test.** Train and validation choose finalists; the finalist list is hashed and locked before the
   OOS slice is evaluated, once. Holm correction across the frozen set, White's Reality Check for the search.
5. **Pre-register the next test.** OOS2 hypotheses H1 to H3 and the decision rules were written first and the
   file hashed.
6. **Fail toward "no edge".** A positive point estimate with a CI spanning zero is not an edge.

## 4. Defects and corrections (keep these in mind)

| What | Found by | Resolution |
|---|---|---|
| Engine bug: pending-at-range SELL limits never filled (202 / 202 expired) and BUY limits triggered on Bid; the first "49% fill rate" was wrong | B2, confirmed by C2 | Patched `sim_engine_b2.py`; B1 results for that policy withdrawn; market-entry results reproduced exactly |
| Pending stop-loss move with latency took effect one tick late | B1 unit tests | Fixed |
| **Edit-timing bias:** signals edited more than 300 s after posting carried the gains (TP4 +1.44 R, n = 76) versus -0.22 R for the rest; the final text may embed hindsight | C2 | Warning in every draft profile. In OOS2 the first-version levels changed R by only about 0.02, so the mechanism is **not confirmed** |
| Stored Firestore `parsed_ok` comes from the legacy history parser (needs the word "NOW") and rejected all 499 OOS2 revisions | Coordinator | Re-parse with the Python port of `vipSignalParser` (`analysis/a1/parser_port.py`, matched the repo parser on 3,317 / 3,317 records) |
| Earlier claim that the 120 s age gate skips the profitable group | Coordinator, OOS2 | Withdrawn: the gate would skip only 2 of 58 |
| "Strict fill 16%" is a first-tick definition | C2 | Reported as definition-dependent; waiting for the band fills 94-98% |
| "+1 USD adverse fill turns BASE negative" overstated for TP4 | C2 | Corrected |
| An unnamed "8 provider-claim comparisons" figure could not be traced | C2 | Removed |
| Free Firestore plan exhausted by AutoTrader polling (`RESOURCE_EXHAUSTED`, 2026-10-22T22:00Z to 10-23T07:00Z and 10-23T18:00Z to 10-24T07:00Z) | Journal review, `gcloud beta billing projects describe` shows billing off | Fail-closed worked (48 `execution_control_fail_closed`, no entries). Owner decision pending: enable billing or lengthen poll intervals |

## 5. Facts established about the environment

- Vantage demo XAUUSD (read via the bridge, 2026-10-24): contract 100 oz, tick value 1 USD, volume min and step
  0.01, max 100, stops level 20 points (0.20 USD), IOC filling only, market execution, hedging account, leverage
  1:100, balance about 49,999.51 USD (demo). The spread seen was a stale Friday-close quote (0.35 USD): not
  representative.
- About 60% of provider messages (240 of 399) reached the forwarder first as an *edit* event, not a new message.
  Cause unknown. The engine treats a first-seen edit as a fresh signal.
- The engine's signal-age gate uses the original `messageDate` (default `max_signal_age_sec` 120).
- Default `max_spread_price` is 0.5; three of four draft profiles need at least 1.0 to pass default safety.
- Firestore: free (Spark) plan, about 50k reads and 20k writes a day, reset at Pacific midnight (07:00Z until 2026-11-01).
- **Since 2026-10-25 the live stack is Go** (`bytrader-go-forwarder`, `-executor`, `-web`; state in
  `/home/kyle/services/bytrader-go/state/state.sqlite`, read it only with `mode=ro`). It does not use Firestore,
  so research reads no longer compete with live trading (Inferred from the Go source, 2026-10-27). The Go forwarder
  records every chat not blocked (`telegram.allowed_chat_ids` empty), so a new channel's history starts when the
  account joins it.
- Go stack operations (2026-10-29): source `~/services/bytrader-go/src` is **not in git**; the executor trades only
  `settings.mt5.source_chat_ids` (no API; default the VIP channel); one active profile serves all source chats;
  lifecycle checks every 5 s; Go needs bridge EA >= 2.0.1, and a shell recompile does not reload the EA (restart
  the terminal). Details: skill `bytrader-go-ops`.
- The connected Vantage demo is the ~50k account (login ending 961, from `~/projects/ByTrader/.env`).
- Vantage demo, 2026-10-27T02:25Z (Asian session, market open): XAUUSD spread 0.29 USD; EURUSD 1.4, GBPUSD 1.5,
  USDJPY 1.7 pips; FX contract 100,000, min/step 0.01; USDJPY tick value about 0.634 USD per point.

## 6. What would change the conclusion

- At least 100 further signals recorded with first-seen and final versions (already stored in
  `telegram_messages`), evaluated with the frozen strategies and pre-registered rules: the skill's
  **refresh runbook**.
- A CI for the Conservative draft that sits entirely above zero in two consecutive independent periods.
- Evidence for the late-edit mechanism from live data (levels published before the move versus after).
- Real Vantage fills (slippage, commission, in-hours spread) from a demo operations test.

## 7. Where things are

| Item | Path |
|---|---|
| Main report and recommendation | `2026-10-21/OPTIMAL_REPORT.md` (see its 2026-10-24 update box) |
| Data audit | `2026-10-21/SIGNAL_DATA_AUDIT.md` |
| Performance and comparison tables | `2026-10-21/SIGNAL_PERFORMANCE_REPORT.md`, `STRATEGY_COMPARISON.md` |
| How it was validated | `2026-10-21/RESEARCH_VALIDATION.md` |
| OOS2 and live cross-check | `2026-10-21/OOS2_AND_LIVE_CROSSCHECK.md`, `PREREGISTRATION_OOS2.md` |
| Draft profiles (unapproved) | `2026-10-21/execution_profile.draft.json`, `alternates/` |
| Scripts, aggregates, setup | `2026-10-21/analysis/` (`setup_workdir.sh`) |
| Not committed (regenerate) | tick data (about 1 GB), per-trade tables, raw message text, caches |

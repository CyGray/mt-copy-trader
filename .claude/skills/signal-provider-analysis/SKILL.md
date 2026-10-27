---
name: signal-provider-analysis
description: Evidence-based workflow for judging a Telegram trading-signal provider (win rate, best TP/trailing, lot size, whether to trade it) and for turning findings into a draft Vantage execution profile. Use when asked "is this signal profitable", "what TP/lots should we use", to re-test the provider on new signals, to compare strategies, or to write an Optimal Report. Read-only research; never trades.
---

# Signal-provider analysis

Repeatable procedure used for the XAUUSD provider study (history: `docs/research/signal_provider/HISTORY.md`,
evidence: `docs/research/signal_provider/2026-10-21/`). Follow it instead of rediscovering the method.

## Ground rules (read first)

This is **research mode: read-only**. Allowed: repo files, local datasets, read-only broker queries, offline
analysis, reports, local draft configs, isolated validation scripts. **Forbidden without explicit owner
authorization:** broker orders (even demo), closing or modifying positions, restarting the forwarder or
AutoTrader, `npm run build` / `npm ci` / `npm prune` (production `worker/dist` and `bybit-api` are live), editing
`.env*`, activating a profile, changing the kill switch / execution mode / Firestore trading settings, sending
Telegram messages, committing secrets or raw message text.

- **Never open a second Telegram session.** The forwarder owns the only one. Live evidence comes from Firestore
  `telegram_messages` (read) and `journalctl --user -u bytrader-worker` (ids, new/edit, timestamps; no text).
- **Never print credentials** from `.env*`, MT5 config or session files. Mask the broker login in outputs.
- **Firestore budget.** The project is on the free plan and the AutoTrader's polling can exhaust the daily quota;
  an exhausted quota stops real trading. Agree a hard read cap with the owner, route every read through
  `analysis/a2/budget.mjs` (reserve, then settle), do **zero writes**, prefer a document-id range or `count()`
  to scans. A full month of revisions cost about 500 reads.
- **Broker bridge:** TCP `127.0.0.1:5555` (`analysis/oos2/bridge_ro.mjs` refuses mutating actions). Allowed
  actions are queries only (`PING`, `ACCOUNT_INFO`, `SYMBOL_INFO`, `GET_POSITIONS`, `GET_ORDERS`).
- Label every claim **Verified** (observed), **Modeled** (simulated), **Inferred** or **Unknown**. Report
  intervals, not just means. Say plainly when a result is negative or unstable.

## Decide the mode

| Question | Do |
|---|---|
| "Is it profitable / what settings?" with no new data | Read `HISTORY.md` and `OPTIMAL_REPORT.md`, answer from them, and say what is stale. Do not rerun anything. |
| New signals exist since the last test | **Refresh runbook** (`references/refresh-runbook.md`): about 500 Firestore reads, 30 minutes of compute. |
| New provider, new symbol or a changed engine | **Full study**, phases 1 to 9 below. |
| Turn a result into a profile | Phase 9, then `docs/project_memory/OPTIMAL_REPORT_SCHEMA.md`. |

## Full study (phases)

Run scripts through `analysis/setup_workdir.sh WORKDIR` first (rewrites the scratchpad path prefix), then use
`nice -n 10 python3 -I <script>` (`-I` hides user site; scripts add numpy's path themselves) and Node 24 for
`.mjs`. Heavy artefacts (ticks about 1 GB, caches, per-trade tables, raw text) stay in WORKDIR, not the repo.

1. **Data audit** (`analysis/a1`). Inventory the history export, classify messages, build the accepted-signal
   list with `parser_port.py` (Python port of `vipSignalParser.ts`; re-verify parity against the repo parser
   before relying on it). Do **not** trust the stored Firestore `parsed_ok`: it is the legacy history parser
   and rejects revisions. Flag bad signals (comma-decimal truncation, implausible distances, wrong-side stop,
   TP order, duplicate TP label, duplicate of an earlier signal) and keep a `clean` subset.
2. **Prices** (`analysis/a3`). Download Dukascopy XAUUSD ticks for every signal window plus 72 h
   (`download_ticks.py`; resumable, at most 4 workers; URL months are 0-indexed, on-disk folders 1-indexed;
   retry HTTP 503 hours; treat an unresolved hour as unknown, never as no ticks). Check coverage, gaps and
   median spread, and check that the provider's levels sit near the market at posting time.
3. **Engine** (`analysis/b1`, patched in `b2/sim_engine_b2.py`). Tick-by-tick: BUY enters Ask / exits Bid, SELL
   the reverse; stop before TP on a shared tick; exits start the tick after the fill; stops fill at the tick
   price when gapped. Run both engine test suites (`test_sim_engine_on_b2.py` 35 and
   `test_b2_engine_patch.py` 4) and an independent re-decode on a random sample before any result is used.
4. **Entry models and costs** (`b2_core.py`). E1 market within 2.0 USD of the range, E2 `pending_at_range`
   (tol 0.5, 60 min; the project policy), E3 strict inside-range market. Costs BASE / MID / PESS; MID primary.
5. **Split, search, freeze** (`b2`, steps 1 to 6 of `b2/README.md`). Chronological train / validation / OOS.
   Search only on train + validation, select, write `finalists.json` with its sha256, then run OOS **once**
   (lock file). Never re-tune after looking at OOS.
6. **Statistics.** Bootstrap CIs (seed fixed, 10,000), paired differences, Holm across the frozen set,
   White's Reality Check for the search, drop-top-5-winners, day-clustered bootstrap, power (minimum
   detectable mean). A positive mean whose CI spans zero, or that flips when the top winners are dropped, is
   not an edge.
7. **Independent audit** (`analysis/c2`). A second agent writes its own decoder and simulator from the spec,
   not from the first agent's code, and must reproduce fills and trades with 0 mismatches. Findings and their
   resolution go in `RESEARCH_VALIDATION.md`.
8. **Sizing** (`analysis/b3`). Port of `positionSizing.ts`; check feasibility at the account size (how many
   signals reach the 0.01 minimum, which checkpoint splits are exact), drawdown by bootstrap, margin.
   Verify the port against the compiled TypeScript on randomised cases.
9. **Reports and drafts.** Write the reports, draft profiles (`status` not set, `broker_symbol` placeholder),
   run `node docs/research/signal_provider/2026-10-21/validate_profiles.mts` (Node 24; imports the real
   validators, no compile into `worker/dist`). Each draft carries an `audit_warning`. Nothing is activated.

## Always check (the traps this project already hit)

See `references/pitfalls.md` for details. Short list:

- Edited signals: compare first-seen levels with the final text; the final text can embed hindsight.
- Signal-age gate uses the original `messageDate` (120 s default); a first-seen edit counts as fresh.
- About 60% of messages reach the forwarder first as an edit; do not assume a `new` event exists.
- Pending-at-range SELL limits fill on Bid for sells; the first engine got this wrong.
- Re-run the evaluator on old signals and require identical trades before trusting it on new ones.
- Timestamp error of 60 s flips the TP1 sign; report timing sensitivity.
- Weekend: gold is closed (reopens Sunday 22:00Z); crypto symbols had no quotes on the demo; stale quotes show
  a misleading spread.
- Profile limits: default `max_spread_price` 0.5 blocks most fills; a profile above a safety limit is refused,
  not clamped; `use_min_if_within_cap` can risk 2 to 4 times the target.

## Reporting standard

1. One plain-language answer first: profitable or not, best TP / trailing, lot size, what to do next.
2. A table of results with n, mean R, 95% CI, and the label.
3. The deviations from the plan, the corrections to earlier claims, and what was not tested.
4. Keep raw Telegram text, credentials and per-trade tables out of committed docs; commit scripts and
   aggregates only. Add a dated entry to `docs/research/signal_provider/HISTORY.md` for every new study.
5. Lot-size advice for the owner: risk 0.25% of equity per trade, skip a signal that rounds below 0.01 lots,
   never `use_min_if_within_cap`; at 5,000 USD equity tradeable for all signals, at 1,000 USD for about 4%.
   Present it as risk control, not as a profit setting.

## Orchestration notes

- Subagents ran as Haiku 5.5 at `xhigh` effort in waves: A (history, live, market data) in parallel, then B1,
  then B2 / B3 in parallel, then C1 / C2. Give each a written brief with the ground rules above, an output
  directory, and "report gaps, do not fabricate". Re-run a wave's key numbers yourself before quoting them.
- State any model substitution (the original brief named Opus 5.5; the coordinator was Sonnet 5.5).
- The `auto-trader` agent-hub session owns deployments of the AutoTrader. Check its work read-only; do not
  duplicate or undo it.

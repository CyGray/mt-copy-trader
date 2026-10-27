# Refresh runbook: test the frozen strategies on new signals

Goal: one more out-of-sample period, cheap and pre-registered. About 500 Firestore reads, zero writes, a few
tens of minutes of compute. This is exactly how OOS2 (2026-10-24) was run.

Use absolute paths. `A` = `docs/research/signal_provider/2026-10-21/analysis`, `W` = a work directory outside the
repo (for example the session scratchpad).

## 0. Preconditions

- Owner has agreed a read cap (default 2,500 via `SP_READ_CAP`). Firestore quota available: the free plan
  resets at 07:00Z; check the AutoTrader is not in `RESOURCE_EXHAUSTED`
  (`journalctl --user -u bytrader-autotrader --since -1h | grep -c RESOURCE_EXHAUSTED`). Do not spend the
  AutoTrader's quota while it is trading.
- At least 100 new signals for a meaningful test; fewer still run but report the power (OOS2: 58 signals could
  only detect |mean| above about 0.4 R).
- `sh $A/setup_workdir.sh $W/study` and restore heavy inputs in `$W/study`: `a3/raw` ticks for the old period are
  not needed; `b1/signals_universe.csv` and `b2/out/finalists.json` (copy `aggregates/b2_finalists.json`) are.
  The frozen set and engine must be unchanged: S_TP4|M5, S_TP4|M0, Q_25x4|M3, Q_25x4|M0, S_TP3|M0, benchmark
  S_TP1|M0; engine `b2/sim_engine_b2.py`; sha256 of `finalists.json`
  `907790184fd086998e07533102e1e6f8a332c55e5626ef52b0a4d60b63432235`.

## 1. Pre-register (before reading any text)

Copy `analysis/oos2/PREREGISTRATION_OOS2.md` to `PREREGISTRATION_<name>.md`, change the dates, the data
window, the frozen set if it changed (it should not), and any new hypotheses. Hash it
(`sha256sum`) and record the hash in the study doc. Only journal metadata (ids, new/edit, timestamps) may have
been looked at beforehand.

## 2. Find the message-id range

Last id of the previous study: OOS2 used ids 3660 to 4099 (up to 2026-10-22T19:45Z). Find the new range from the
forwarder journal, which carries no text:

```
journalctl --user -u bytrader-worker --since "<date>" --no-pager | grep telegram_message_received \
  | grep 1003271337051 | grep -o '"messageId":"[0-9]*","type":"[a-z]*"' | sort -u | tail
```

Event `telegram_message_received` carries `chatId`, `messageId` and `type` (`new` or `edit`), never text. If
the forwarder is down (see its journal for `AUTH_KEY_UNREGISTERED` / a stopped unit), no new signals arrive:
stop here and tell the owner; do not restart services or touch the Telegram session.

Pick `FIRST` and `LAST_EXCL` with the same number of digits (document ids sort lexically).

## 3. Fetch revisions (read-only)

```
cd $A/oos2 && SP_BUDGET_DIR=$W/budget node oos2_fetch.mjs FIRST LAST_EXCL $W/new_messages.json
```

It counts first (2 reads), aborts above 1,500 documents, and logs to `$W/budget/fs_reads_log.txt`. The output
holds raw text: keep it in `$W`, never commit it.

## 4. Build the universes

```
python3 -I $A/oos2/oos2_build.py $W/new_messages.json $W/universe --min-id FIRST
```

Outputs `universe_final.csv` (post time, final text: same method as the main study), `universe_first.csv` (first
parseable revision), `universe_live.csv` (first revision seen within 120 s) and `revisions_summary.json`. Check
that `signals` is plausible against the journal counts.

## 5. Ticks

```
python3 -I $A/a3/download_ticks.py $W/study/a3/raw $W/ticks_manifest.csv <START>T00 <END>T00 4
```

Cover the first signal minus 1 h to the last signal plus 80 h, capped at "now". Re-run `retry_errors.py` for
HTTP 503 hours until none are unresolved. Check coverage and the median spread.

## 6. Evaluate

Validate first: run `oos2_eval.py` on the **previous** universe and confirm the stored trade results match
exactly (OOS2: 0 mismatches in 1,398 trades). Then:

```
for u in final first live; do
  python3 -I $A/oos2/oos2_eval.py $W/universe/universe_$u.csv $W/out/$u
done
# late-edit vs stable split: h2.py reads oos2/final_trades.csv and oos2/first_trades.csv relative to its
# working directory, so copy $W/out/final_trades.csv and first_trades.csv to $W/oos2/ and run it from $W.
cd $W && python3 -I $A/oos2/h2.py
```

Report E1 and E2 at MID: mean R, 95% bootstrap CI, Holm p, fill rate, split by edit delay (>300 s). Add the
no-strategy touch check (TP1, TP4, stop within 72 h) as a plausibility test.

## 7. Write up

- `docs/research/signal_provider/<date>/<NAME>.md`: results table (all strategies, all universes), pre-registered
  hypotheses with verdicts, deviations, what changed versus earlier statements.
- Copy only scripts, the pre-registration and summary JSON into the analysis folder (no text, no per-trade rows).
- Update `HISTORY.md` (timeline row, conclusion table) and the draft profiles' `audit_warning` if the conclusion
  moved; re-run `validate_profiles.mts`.
- Secret scan before committing: `grep -rEi "api_hash|session|password|private_key|BEGIN [A-Z ]*KEY" <new files>`
  and check no message text is present.

## Decision rules (keep fixed)

- Nothing is selected, tuned or filtered on the new period.
- Support for the Conservative draft needs a CI entirely above zero for S_TP4|M5 in this period **and** the
  previous one. Anything else leaves the conclusion "no established edge".
- Do not pool periods without a regime explanation.

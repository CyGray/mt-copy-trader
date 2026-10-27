# LUCAS pilot: independent audit (wave 5)

Scope: an independent rebuild of the tick decoder, the signal parser and the trade simulator from the
specification, used to reproduce the LUCAS pilot (`universe/lucas/universe_final.csv`, `universe_first.csv`,
`pilot/out_final/`, `pilot/out_first/`, `pilot/posthoc/`). Code and outputs are in
`/tmp/claude-1001/twochan/audit/`. No network, Telegram, Firestore, broker or service access. No git
repository touched, nothing committed, nothing written outside the audit folder.

## 1. Result

- **Zero mismatches** in all nine comparison sets (section 4). Fill prices and times, exit prices and
  times, exit sequences, total_R, usd per lot, universe levels, flags, touch values and the summary
  n / mean / CI reproduce from the raw ticks and the specification.
- **All seven claimed tick facts reproduce** to the millisecond and to 0.001 USD (section 5).
- **The reproduction is not a full validation of the engine.** Neither signal triggers a market entry, a
  stop after a partial take-profit, a stop after a move to entry, or a break-even. Those paths agree with
  the specification but this data does not test them (F1).
- **No finding changes a pilot number.** Three findings are Medium (F1 coverage, F2 flag-policy gap,
  F3 mislabelled live universe). The rest are Low or Info (section 6).

## 2. Method

1. **Specification.** Read the documents listed in section 3 and the owner's rules (RULES.md, section 2).
2. **Decoder (auditor's own, `bi5_audit.py`).** LZMA "alone" decode; 20-byte big-endian records
   (uint32 ms offset, uint32 ask, uint32 bid, two float32 volumes). Prices are kept as exact integers in
   units of 0.001 USD, and comparisons use integers only. Hours in the window: 26 entries, namely 25 bi5 files and the 21h empty marker. The 25 files decode
   (233,346 ticks from 2026-10-26 00:00 to 2026-10-27 02:00 UTC); 2026-10-26 21h is a zero-length marker
   (daily break); 2026-10-27 02h is missing, so the known-until bound is 02:00 UTC. Time-order violations: 0.
   On-disk sizes equal the manifest byte counts for 25 of 25 downloaded hours.
3. **Parser (auditor's own, `audit_parse.py`).** Reads only the structured SIGNAL blocks (zone, stop,
   take-profit line) of the two revisions of message 23218. Final = the revision with the latest edit date
   (time = message date). First = the first revision that parses (time = its timestamp). Hard flags use the
   pre-registration list. Pips annotations are checked at 0.1 USD per pip, which is inferred (F6).
4. **Simulator (auditor's own, `audit_sim.py`).** Entry models E1, E2, E3 and costs BASE, MID, PESS as in
   the specification. Latency sets the decision tick. Tick-by-tick management: exits start at the tick after
   the fill; a stop is checked before take-profits on the same tick; a take-profit fills at its price; a
   stop fills at min(bid', SL) minus slippage (BUY) or max(ask', SL) plus slippage (SELL); R = |fill - SL|;
   total_R = sum(fraction x signed move) / R in exact fractions; usd per lot = sum(fraction x move) x 100 oz.
5. **Comparison (`audit_driver.py`).** Every pilot value is compared, tolerance 1e-6 R on total_R and 1e-9 on
   prices; mean and CI are compared at 3 dp (the pilot's rounding). Per-row results are in `cmp_*.csv`.
6. **Controls.** A mutation (MID slippage 0.04 instead of 0.05) must be flagged; it is (section 4). Six
   readings of open spec points were run through the same comparator (`sensitivity.py`, `sensitivity.json`).

## 3. What I read

- Specification: `docs/research/signal_provider/2026-10-21/analysis/b1/README.md`,
  `analysis/b2/README.md`, `analysis/b2/REPORT.md` (sections 0 to 5, 14 and 15; the R definition is in section 1
  and the table of expressibility in section 5), `RESEARCH_VALIDATION.md` section 6,
  `.claude/skills/signal-provider-analysis/SKILL.md` and `references/pitfalls.md`.
  Also `PREREGISTRATION_LUCAS.md`, `DECISIONS.md` (orchestrator notes) and `RULES.md`.
- Constants: from `analysis/b2/b2_core.py`, the constants COSTS, ENTRIES, ALLOCS, TRAIL_DISTS, TRAIL_STEP,
  BE_PRICE_USD and PROJ_MIN_DIST / PROJ_MAX_DIST. The body of `mgmt_options` was printed in the same command
  as the constants. I used only the meaning of M0, M1, M3 and M5, which REPORT section 5 also states. No
  function body was copied. Nothing else in the b2 folder was opened; file names were listed only.
- Data: `data/lucas_revisions.json` (the two revisions of message 23218 were parsed; the text is not
  reproduced here), the 25 decoded bi5 hours, and the universe and pilot files, which I read as results.
  I did not use any `lucas_cache` directory (implementation outputs).
- **Not read:** `sim_engine.py`, `sim_engine_b2.py`, `dukas_lib.py`, `parser_port.py`, `parser_multi.py`,
  `build_multi.py`, `oos2_build.py`, `pilot_eval.py`, and `prepare_signals.py` (not on the list; the hard-flag
  rules were taken from the pre-registration text).

## 4. Rows compared and mismatches

| File | Pilot rows | Field comparisons | Mismatches |
|---|---|---|---|
| universe_final.csv | 2 | 31 | 0 |
| universe_first.csv | 2 | 31 | 0 |
| pilot/out_final/lucas_fills.csv | 18 | 145 | 0 |
| pilot/out_first/lucas_fills.csv | 18 | 145 | 0 |
| pilot/out_final/lucas_trades.csv | 42 (30 FILLED, 12 SKIPPED_tp_missing) | 546 | 0 |
| pilot/out_first/lucas_trades.csv | 42 (30 FILLED, 12 SKIPPED_tp_missing) | 546 | 0 |
| pilot/posthoc/lucas_trades.csv | 48 (36 FILLED, 12 SKIPPED_tp_missing) | 624 | 0 |
| pilot/out_final/lucas_summary.json (fills, results, touch) | 83 | 469 | 0 |
| pilot/out_first/lucas_summary.json (fills, results, touch) | 83 | 469 | 0 |

Mutation control: MID slippage 0.04 instead of 0.05 flags 2 of 18 fills and 10 of 42 trades. The comparator
is sensitive.

Sensitivity (each row is a different reading of an open point; mismatches on every file):

| Reading | Fills (final) | Trades (final, first, posthoc) |
|---|---|---|
| Reference (as reported) | 0 / 18 | 0 / 42, 0 / 42, 0 / 48 |
| Strict stop inequality | 0 / 18 | 0 / 42, 0 / 42, 0 / 48 |
| Strict take-profit inequality | 0 / 18 | 0 / 42, 0 / 42, 0 / 48 |
| Pending touch from the tick after the decision tick | 0 / 18 | 0 / 42, 0 / 42, 0 / 48 |
| Strict pending touch | 0 / 18 | 0 / 42, 0 / 42, 0 / 48 |
| SL to entry uses the signal mid, not the fill | 0 / 18 | 0 / 42, 0 / 42, 0 / 48 |

## 5. Verified tick facts

Signal times: final 2026-10-26 13:53:08.000 UTC (message date); first 13:53:12.062 UTC (first revision).

| # | Claim (orchestrator) | Auditor, from raw bi5 | Result |
|---|---|---|---|
| 1 | SIGNAL 3 min ask, 13:53:08 to 14:05:00 | 3989.075 at 13:58:46.282 (first of nine ticks at this value, 13:58:46.282 to 13:58:46.887) | Confirmed |
| 2 | SIGNAL 3 max bid, 13:53:08 to 17:00 | 4026.745 at 14:58:26.936 (one tick) | Confirmed |
| 3 | SIGNAL 4 first bid >= 4011 | 14:19:15.938 (same from the final and the first time) | Confirmed |
| 4 | SIGNAL 4 first bid >= 4013 | 14:19:39.006 | Confirmed |
| 5 | Best ask 14:19 to 14:40 | 4007.425 at 14:27:21.417 (one tick) | Confirmed |
| 6 | First ask >= 4018 after 14:19 | 14:38:10.433 | Confirmed |
| 7 | Median spread, 2026-10-26 13h | 0.524 USD (median over 22,030 ticks) | Confirmed |

## 6. Findings

Severity: **High** changes a pilot number or a validity claim; **Medium** leaves a mechanic or claim
unverified, or a file mislabelled; **Low** a convention or documentation gap; **Info** no action. No finding
is High: no pilot number disagrees with the specification.

**F1. Medium. The two signals do not exercise most of the engine.** For both signals, at every cost, the
decision price is about 3995 (the first tick after latency). That is above the BUY bands (E1 top 3994, E2/E3
top 3992.5) and below the SELL bands. So E1 and E3 never fill, E2 is always pending, and the market-entry
path is never run (0 market fills in 18 combinations). After TP1 the lowest bid before TP3 was 3996.505, and
after TP2 it was 4004.061, against an entry of 3992.0. So the move to entry (M1, M3 and the posthoc
D13_50_50|M1 row) never stops out, and those rows equal their M0 counterparts by construction. S_TP4|M5 is
always skipped (no TP4), so break-even never runs. There is no stop after a partial TP, no tick where a stop
and a TP coincide, no trailing (not in the pilot set), and no horizon, mark-to-market or missing-data case.
The zero-mismatch result therefore validates tick decoding, the levels, pending-limit entries, TP fills, SELL
stops with spread and slippage, and the R and cost arithmetic. It does **not** validate market entries, the
M1, M3 or M5 mechanics, or the horizon and missing-data handling.

**F2. Medium. A flag-policy gap on the first revision of SIGNAL 4.** The first revision's stop is 15 to 17 USD
from the zone, but its own annotation gives 50 to 70 pips, which is 5 to 7 USD at the pip size the
annotations imply (F6). The universe records this only as an info flag (`sl_annotation_mismatch`), and
keeps the signal in the sample (`in_clean` = 1). The pre-registration's hard-flag list does not cover this
case. Effect on the pilot: the first-universe SELL stops out in all five strategies with a 17 USD risk
(7 USD in the final universe). Total R is about -1.00 in both universes, but the USD loss per lot is about
2.4 times larger. Which side is right: the pilot follows the written rule, and the specification has no
rule for this case. An owner or orchestrator decision is needed before the first-versus-final test (H2) uses
the first universe.

**F3. Medium. `universe_live.csv` is byte-identical to `universe_first.csv`** (checked with `cmp`).
DECISIONS.md (02:26Z entry) records that the live Go parser classifies the same message as `cancel`
(`missing_entry`). The file therefore cannot show live behaviour. I did not read or run the Go parser, so I
cannot say which output is right, only that this file does not represent the live parser. Regenerate it
from the live parser or rename it.

**F4. Low. The `tp_ks` column is undocumented.** The pilot writes the take-profit indices that actually
filled, and leaves the field blank when no TP filled (all stop-outs). My first reading (the checkpoint set)
differed from the pilot in 48 rows across the three trade files (15 final, 15 first, 18 posthoc; SELL rows only). The executed reading
matches all 48 rows. I chose it after seeing the difference, so treat it as an inference. Document the column.

**F5. Low. Open spec points that no pilot number depends on.** (i) inclusive or strict stop and TP
inequalities; (ii) pending touch from the decision tick or the tick after; (iii) the SL-to-entry reference
(fill or signal mid); (iv) whether exit checks start at the fill tick or after it. All six readings give
identical numbers (section 4). Not pinned by any test: the pending expiry reference (I used the decision
tick) and whether a stop shares a tick with a TP. Pin these in the specification before a larger run.

**F6. Low. Conventions that are inferred, not stated.** The text has no symbol, so XAUUSD is inferred from the
price level. The pip size of 0.1 USD for gold is inferred from the annotations. It fits the final revision
and not the first (F2). The pre-registration gives the FX pip (0.0001) but not the gold pip. State both.

**F7. Low. The touch-table definitions are not in the specification.** I inferred them from the pilot's
values and then matched them (entry zone: first tick reaching the unfavourable edge with no spread or
latency; stop and TP touches: first tick at or after the signal time; min and max over 6 h; n_ticks: ticks
from the signal time to the known-until bound). This is a consistency check, not an independent one.

**F8. Low. Duplicate file.** `data/lucas_check.json` is byte-identical to `data/lucas_revisions.json`. Remove
it or document it.

**F9. Info. The n = 2 confidence intervals carry no information.** Each reported 95% CI equals the minimum
and maximum of the two per-signal results. The percentile bootstrap with seed 12345 reproduces those bounds.
The pre-registration already says the pilot is descriptive.

## 7. Auditor-side corrections (process disclosure)

- In the first full run, every numeric trade field already matched. The mismatches were in my comparator:
  (a) fills compared the final pilot rows against the first universe's stop (21 fields); (b) my message-id
  formatting, which mis-keyed the summary's per-signal lists (with (d)); (c) the posthoc-only D13 row was
  expected in the main files (6 rows); (d) the same per-signal lists left out skipped statuses (42 summary
  entries in total across (b) and (d)); (e) the `tp_ks` reading (F4). All were fixed in the
  comparator. The simulator's reference behaviour did not change after the first run. The sensitivity
  switches were added later, and they default to the reference behaviour.
- The touch definitions (F7) were chosen after seeing the pilot's touch values.

## 8. Not done, or gaps

- Not exercised by this data: market entries, a stop after a partial TP, a stop after a move to entry, the
  break-even (M5), trailing, horizon and mark-to-market exits, NO_PRICE_DATA, and same-tick stop and TP. Results
  for these paths are unverified (F1).
- No second source for the Dukascopy ticks. Integrity was checked by decoding, time order (0 violations) and
  manifest byte counts (25 of 25). Prices are not checked against Vantage.
- The parser was tested only on the two messages of this study. It is not a general parser audit. The hard-flag
  rules come from the pre-registration text, not from `prepare_signals.py` (not read).
- The live Go parser and `universe_live.csv` were not checked (F3).
- The bootstrap reproduction uses my percentile implementation. At n = 2 it returns the minimum and maximum, so
  it proves little.
- No Firestore reads or writes (budget unused). No broker, Telegram or service access. No secrets read.

## 9. Files

- `audit/AUDIT_REPORT.md` (this report)
- `audit/bi5_audit.py`, `audit/audit_parse.py`, `audit/audit_sim.py`, `audit/audit_driver.py`,
  `audit/sensitivity.py`, `audit/verify_facts.py`, `audit/coverage.py`, `audit/coverage2.py`
- `audit/cmp_universe_{final,first}.csv`, `audit/cmp_fills_{final,first}.csv`,
  `audit/cmp_trades_{final,first,posthoc}.csv`, `audit/cmp_summary_{final,first}.csv` (per-row comparisons;
  no message text)
- `audit/audit_counts.json`, `audit/sensitivity.json`, `audit/driver_run.log`

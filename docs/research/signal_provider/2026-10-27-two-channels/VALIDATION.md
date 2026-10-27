# Validation: how the two-channel study was checked

Orchestrator: Claude Opus 5.5. Subagents: Claude Haiku 5.5 at xhigh effort (engine implementer, FX market-data
explorer, independent auditor). The orchestrator re-ran every headline number below before quoting it.

## 1. Checks and results

| # | Check | Command (from `analysis/`, work directory W) | Result | Label |
|---|---|---|---|---|
| 1 | Data ladder: every source for both chats | see `DECISIONS.md` rows 02:13-02:17Z | history only from 2026-10-26 (GAB 28, Lucas 50 messages); Firestore 0 / 3 docs (2 reads, 0 writes) | Verified |
| 2 | Parser vs hand labels (every message) | `a1/eval_parser.py` | Lucas: signal precision 1.0, recall 1.0, levels exact in all revisions, class accuracy 0.92. GAB: 0 signals, 0 false positives, class accuracy 0.82 | Verified (n tiny) |
| 3 | Parser parity with the repo parser on the earlier provider's 3,317 messages | inline, see `DECISIONS.md` | 415/415 identical, 0 extra accepts | Verified |
| 4 | Parser and loader unit tests | `a1/test_parser_multi.py`, `a1/test_loaders.py` | 10 + 4 OK (synthetic fixtures, no real text) | Verified |
| 5 | Read-only Go-store exporter reproduces the first export | `a1/export_go_store.py` + `cmp` | identical | Verified |
| 6 | Engine suites after generalisation | `b2/` 35 + 4 existing + 11 new (`test_symbols.py`) | 50/50 OK, re-run by the orchestrator | Verified |
| 7 | **Gold regression**: generalised engine re-runs the old OOS2 evaluation | `oos2/oos2_eval.py <OOS2 universe> ... --symbol XAUUSD` | 1,716/1,716 trades identical in all 35 columns, 522/522 fills, summary byte-identical to `2026-10-21/analysis/oos2/final_summary.json`; re-run by the orchestrator | Verified |
| 8 | FX scale invariance (synthetic) | `b2/test_symbols.py` | frozen set: 0 mismatches in 4,140 comparisons (EURUSD, USDJPY); full grid at exact power-of-two scale: 0 in 67,620 | Verified |
| 9 | FX decode vs independent source (ECB reference rates) | `a3/ecb_check.py` | 15/15 pair-days within 15 pips (worst 5.16; means 1.68 / 2.71 / 1.62 pips EURUSD / USDJPY / GBPUSD); orchestrator recomputed EURUSD 2026-10-05 with a separate decoder: -1.65 pips, identical | Verified |
| 10 | FX decoder unit tests | `a3/test_fx_decode.py` | 25/25 OK | Verified |
| 11 | Gold ticks for the pilot | `a3/download_ticks.py` | 26/27 hours; the empty one is the 21:00Z daily break; median spread 0.52-0.56 USD | Verified |
| 12 | **Independent audit** (own decoder, parser, simulator from the spec) | `audit/audit_driver.py` | 0 mismatches in every set: universes (final, first), fills, trades (final, first, post hoc), summaries; 7/7 claimed tick facts reproduced to the millisecond and 0.001 USD | Verified |
| 13 | Vantage specs, read-only bridge | `2026-10-21/analysis/oos2/bridge_ro.mjs` | XAUUSD contract 100, tick 0.01 = 1 USD; FX contract 100,000; min/step 0.01; 0 positions, 0 orders; login masked | Verified |
| 14 | Draft profile, TypeScript validators | `node ../profiles/validate_profiles_two_channels.mts` | `validateProfile` ok; only `max_spread_price` 1.0 > 0.5 against default safety | Verified |
| 15 | Draft profile, live Go validator (isolated copy) | `../profiles/go_validator/` | `ValidateProfile` ok; same single safety issue; `ParseGoldSignal` on the Lucas signal message: `missing_entry` | Verified |
| 16 | Timestamp sensitivity ±60 s (pilot) | `pilot/pilot_eval.py` on shifted universes | means move by at most 0.10 R; no sign change | Modeled |
| 17 | Gold decode vs Vantage live quotes | see section 3 | see section 3 | Verified |

Not applicable at n = 2 or n = 0 (stated, not skipped silently): train/validation/OOS split, grid search,
finalist freeze, Holm within a provider, White's Reality Check, drop-top-5, day-clustered bootstrap, minimum
detectable effect beyond "about |1| R or more", and a second OOS period. Holm across providers:
none of the three providers has a positive CI, so nothing survives any adjustment.

## 2. Audit findings and resolutions

| Finding (severity) | Resolution |
|---|---|
| F1 (Medium): the two signals exercise only pending entries, TP and stop exits; market entries, break-even, stop-to-entry, horizon and missing-data paths are untested by this pilot | Accepted. Those paths are covered by the engine suites (50 tests) and the exact 1,716-trade gold regression, which includes market entries, M5 break-even and M3 stop moves. Any future channel run must repeat the audit on its own data. |
| F2 (Medium): the first revision of SIGNAL 4 contradicts its own pips annotation but is kept (info flag only) | Kept on purpose: the hard-flag rules were pre-registered unchanged from the earlier study. Both universes are reported, and SIGNAL 4 is -1.0 R in both. For the next pre-registration, `sl_annotation_mismatch` is proposed as a **hard** flag (pitfalls updated). |
| F3 (Medium): `universe_live.csv` is byte-identical to `universe_first.csv` | Correct, not a bug: "live" means first parseable revision observed within the 120 s age gate, and the signal was stored 4.1 s after posting. It assumes a parser that reads the format; the **live Go parser does not** (row 15), so today the executor would see no signal at all. Stated in REPORT_LUCAS. |
| F4 (Low): `tp_ks` undocumented | It lists the TP indices actually executed; documented here. |
| F5 (Low): stop/TP inequality and stop-reference conventions not pinned in the spec | Engine conventions unchanged from 2026-10-21 (`b1/README.md`); the audit reproduced every trade under the inclusive reading. |
| F6 (Low): gold pip and symbol inference are conventions | Stated: gold "pip" 0.10 USD (`a3/symbols.py`), symbol inferred from the price level and flagged `symbol_inferred`. |
| F7 (Low): touch-table definitions inferred by the auditor | Definitions: first tick at or after the signal time with ask ≤ zone top (BUY) / bid ≥ zone bottom (SELL), stop on bid (BUY) / ask (SELL), TP on bid (BUY) / ask (SELL). The touch table is descriptive only. |
| F8 (Low): duplicate file in the work directory | Work-directory copy from check 5; not committed. |
| F9 (Info): n = 2 CIs carry no information | Agreed; every report says so. |
| Engine implementer: M2 stop buffer (0.3 USD) was unscaled in the first FX version | Fixed (`0.3 * UNIT`); a full-grid test now covers it. Gold unaffected. |
| Engine implementer: 56 of 135,240 full-grid FX comparisons differ at decimal scale factors (E1/MID, 4-unit trailing) | Residual: floating-point rounding at exact decimal ties (one case traced). Not in the frozen set. Gold unchanged. A tolerance in the comparison would alter gold results, so none was added. Real FX runs with trailing stops should report this. |
| Engine implementer: the FX maximum stop (100 pips) is 4 times the gold-equivalent 25 | Pre-registered deliberately (`PREREGISTRATION_*.md`): the gold bound in pips would reject typical FX stops. |

## 3. Gold decode versus the broker

Four read-only Vantage demo quotes (bridge `SYMBOL_INFO`, 2026-10-27, Asian session) compared with the Dukascopy
tick in force at the same UTC instant. Vantage `tick_time_msc` is server time GMT+3 and was converted
(`PING`: `server_time - gmt_time = 10800 s`).

| UTC | Vantage mid | Dukascopy mid | Difference | Vantage spread | Dukascopy spread |
|---|---|---|---|---|---|
| 02:25:30 | 4017.375 | 4017.358 | +0.017 | 0.29 | 0.494 |
| 02:35:11 | 4014.830 | 4014.775 | +0.055 | 0.28 | 0.580 |
| 02:35:32 | 4013.920 | 4013.817 | +0.103 | 0.28 | 0.544 |
| 02:35:52 | 4016.075 | 4015.913 | +0.162 | 0.29 | 0.564 |

Result (Verified): the gold decode (divisor 1000) agrees with the broker to within 0.17 USD. In this session the
Vantage spread was about half of Dukascopy's, so the MID cost scenario (Dukascopy spread + 0.10) is conservative
here. Spreads in the London and New York sessions remain unmeasured.

## 4. Residual uncertainty

- Verdicts rest on one day of data; both are Unknown by pre-registered rule, not by judgement.
- Dukascopy is not Vantage: spread at the London and New York sessions, slippage, commission, swap and margin
  factor are Unknown. One Asian-session Vantage spread (0.28-0.29 USD) was observed.
- The paid groups behind both channels were not observed; their signals may differ from the free channel's.
- Provider management messages (moving stops, closing "bad entries") were not simulated.
- The FX path is validated on synthetic data and the ECB check only; no real FX signal exists yet.

## 5. Second pass (Lucas deep check, other channels)

| Check | Command (from `analysis/`) | Result | Label |
|---|---|---|---|
| Lucas grammar on every revision | `lucas/lucas_grammar.py` (via `lucas_followup.py`) | 87 revisions typed; both signals' levels exact in both revisions after the TP-capture fix | Verified |
| Grammar and extra-channel parser tests | `lucas/test_lucas_grammar.py` | 6/6 OK (synthetic texts, incl. the typo rule) | Verified |
| Live-follower simulation | `lucas/lucas_followup.py <revisions> RAW out --stops {global,per_layer} --pending {keep,cancel_unnamed} --latency {10,30,60}` | all 12 variants reported; SIGNAL 4 hand-recomputed: -29.17 USD per lot plan, identical | Modeled |
| Claims audit | same script | 40 claims; arithmetic 36/38; BUY reached 28/30; SELL reached 0/9 (max overstatement 1.10 USD) | Verified |
| Tick loader cross-check | `window_ticks` vs `decode_hour` over 13:52-07:00 | 135,971 = 135,971 | Verified |
| Extra-channel signals | `other/parse_other.py`, `pilot/pilot_eval.py` | 3 + 1 signals; price at posting measured; dannygen unfillable (beyond stop) | Verified / Modeled |
| Channel vs group | stored raw message `Post` / `FromID` | 4 channels, 3 non-channels excluded | Verified |
| Public preview | `a1/scrape_tme_preview.py LUCAS_GOLD_LEGEND <dir>` | 698 posts, 116 distinct timestamps; all 74 SL+TP posts in batches | Verified |

Not done in the second pass: an independent re-implementation audit of the follower simulator (two signals; hand
check instead), and any statistic beyond description (n = 2 and n = 3).

#!/bin/sh
# C2 audit: exact commands used, in the order run. Working dir: scratchpad/c2. All runs: nice -n 10, python3 -I, one or two processes.
# numpy is added to sys.path inside each script (user site is hidden by -I). Nothing here touches the repo, worker/dist, services,
# Telegram, Firestore, or any broker. Reads only the scratchpad inputs (a1/, a3/raw, b1/signals_universe.csv, b2/out, b3/).
set -e
cd /tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2
mkdir -p out
# 1. own tick decoder (module) and layout/price QC (daily median vs provider levels)
nice -n 10 python3 -I c2_selftest.py          # simulator self-tests (synthetic ticks) must print ALL PASS
nice -n 10 python3 -I c2_qc_levels.py         # decodes all 7,992 hours; daily market vs entry_mid
# 2. own simulator grids (entry rules, costs, strategies); each writes out/c2_entries_<set>.csv and out/c2_trades_<set>.csv
nice -n 10 python3 -I c2_explore_cap.py       # E1/E3 fill counts vs search cap (first-tick vs wait)
nice -n 10 python3 -I c2_run.py core          # primary + entry sensitivities (E1/E2/E3 FT, E2 no-guard, pending slip, wait variants)
nice -n 10 python3 -I c2_run.py sens          # spread 0.30/0.50, timestamp shift +/-60 s, persistence filter (2 ticks, 1 s)
nice -n 10 python3 -I c2_run.py extra         # +1 USD adverse fill (entry only, entry+stop)
nice -n 10 python3 -I c2_run.py extra2        # PESS costs (spread 0.20, slip 0.10, latency 15 s)
# 3. statistics and tables
nice -n 10 python3 -I c2_analysis.py          # out/c2_analysis.json (bootstrap 10,000, seed 42; day-cluster; top-k; drop-k; trimmed)
nice -n 10 python3 -I c2_sens_tables.py       # out/c2_sens_tables.json (spread / shift / persistence / +1 USD)
nice -n 10 python3 -I c2_spike_list.py        # out/c2_spike_flips.json (trades flipped by the persistence rule)
nice -n 10 python3 -I c2_final.py             # out/c2_final.json (TP4-subset comparison, edit groups, Holm, power, status counts, MTM legs)
nice -n 10 python3 -I c2_excl_late.py         # out/c2_excl_late.json (means with and without edits >300 s)
nice -n 10 python3 -I c2_edit.py              # edit-delay groups; level vs market at posting and at edit
nice -n 10 python3 -I c2_edit2.py             # TP/SL placement by edit group
nice -n 10 python3 -I c2_edit3.py             # TP1 / SL already touched before the final edit (by group)
nice -n 10 python3 -I c2_pess.py              # PESS summary by split
nice -n 10 python3 -I c2_h1_block.py          # H1 (SELL minus BUY), B2-style block-5 drawdown on OOS
nice -n 10 python3 -I c2_h2.py                # H2 (prior-4h efficiency-ratio terciles, cut points fixed on TRAIN)
# 4. market / data robustness
nice -n 10 python3 -I c2_posting.py           # provider level vs market at posting (date_utc) and at edit (edit_date_utc)
nice -n 10 python3 -I c2_jumps.py             # one-tick mid jumps >= 5 USD, reversion within 60 s (two definitions)
nice -n 10 python3 -I c2_claims.py            # provider TP-hit claims: unambiguous link, strict-entry NA, own touch test
nice -n 10 python3 -I c2_sizing.py            # full-tape spread histogram; spread at fills; risk overshoot (background)
nice -n 10 python3 -I c2_sizing_rules.py      # repo sizing rule (computeVolume) recomputed by hand (pure python)
# 5. cross-checks against earlier agents (run only after the C2 numbers were final)
nice -n 10 python3 -I c2_match.py             # per-trade match vs b2/out/oos_trades.csv.gz and phase1_trades.csv.gz
# 6. read-only repo checks (grep / sed only): worker/src/lib/positionSizing.ts, executionProfile.ts (DEFAULT_SAFETY_LIMITS)
#    and the B2 freeze check (sha256 of the canonical body of b2/out/finalists.json, recomputed in-line).

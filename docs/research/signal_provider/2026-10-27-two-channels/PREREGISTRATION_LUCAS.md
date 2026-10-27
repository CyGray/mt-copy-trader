# Pre-registration: LUCAS GOLD LEGEND (channel -1002371904451)

Written 2026-10-27T02:25Z, before any message text of this channel was read and before any price after a signal
was looked at. Only metadata had been seen: document counts, ids, dates, new/edit types, a has-text count, and one
public contact handle found by a regex scan for t.me links (not read as a message).

## Data

- Source: Go forwarder SQLite `telegram_messages` (read-only), ids 23203-23252, 2026-10-26T01:44Z..17:56Z, 83 revision documents (50 messages). This is the whole history available
  without opening Telegram (see DECISIONS.md, ladder steps 0-4).
- Prices: Dukascopy ticks per symbol (public HTTP), from first signal - 1 h to the latest published hour.
- Final text = the revision with the latest edit_date; first universe = first revision that parses as a signal.

## Power statement (fixed now)

The data window is about one day. Under the brief's rules an out-of-sample test needs at least 40 OOS signals
(at least 25% of the sample), so **no train / validation / OOS split will be made and no strategy will be
searched or selected on this data.** The verdict is fixed in advance as **"Unknown: insufficient data"** whatever
the pilot shows. The pilot exists to prove the pipeline end to end and to describe the channel; its numbers are
descriptive only. A 95% CI will be reported; with n under 30 it cannot detect less than about |1| R.

## Pilot (descriptive, no selection)

- Signals: accepted entry signals after classification and the hard flags of b1/prepare_signals.py (comma
  decimal, implausible distance, wrong-side stop, TP order, duplicate TP label, duplicate of an earlier signal).
- Fixed strategy set, not searched: S_TP1|M0, S_TP2|M0, S_TP3|M0, S_TP4|M0, S_TP4|M5, Q_25x4|M0, Q_25x4|M3
  (definitions in b2_core.py), plus a "no strategy" touch check (TP1, last TP, stop within the horizon).
- Entry models E1, E2, E3 and costs BASE / MID / PESS as in b2_core.py; MID primary.
- Horizon 72 h; legs still open at the last available tick are marked to market and flagged UNRESOLVED.
- Symbol scaling (fixed now, before seeing levels): every price-unit parameter that is in USD for XAUUSD is in
  pips for FX (1 pip = 0.0001; 0.01 for JPY quotes): E1 tolerance 2.0, E2 tolerance 0.5, BE trigger 4.0,
  trailing distances 1.5/2.5/4/6, step 0.5, extra spread MID 0.10 / PESS 0.20, slippage MID 0.05 / PESS 0.10.
  Stop-distance bounds: gold 2.0..25.0 USD (project default); FX 2..100 pips (the gold upper bound in pips would
  reject typical FX stops; recorded as a deviation). Contract size 100 oz gold, 100,000 units FX.
- Statistics: n, mean R, bootstrap 95% CI (seed 12345, 10,000 resamples), fill rate.

## Future protocol (applies when the owner supplies data; fixed now)

- At least 160 accepted signals before a split: train 60%, validation 15%, OOS the last 25% (at least 40).
- Search the b2_core.py grid with the scaling above on train + validation only; select finalists with the B2
  rules; write finalists.json, sha256 it; evaluate OOS once (lock file); then a second pre-registered period.
- Decision rules: brief section 8 verbatim (CI entirely above 0 out of sample, net of MID, in two independent
  periods or a labelled single-period caveat, surviving drop-top-5 and Holm across providers).
- Holm across providers: the earlier provider (-1003271337051) plus these two channels = 3 provider tests.

## Hypotheses for the future test (directional)

- H1: no frozen strategy has a 95% CI entirely above zero at MID out of sample (the base rate seen so far).
- H2: first-seen levels give lower mean R than the final edited levels (edit-timing bias, as in C2).

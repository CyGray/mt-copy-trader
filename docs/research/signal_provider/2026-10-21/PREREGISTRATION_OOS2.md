# Pre-registration: second out-of-sample test (OOS2), written before any OOS2 message was read

Written: 2026-10-24 (before the Firestore read of telegram_messages for the period after 2026-09-24T14:34:48Z).

Data: provider channel -1003271337051, messages with date > 2026-09-24T14:34:48Z, last live event seen in the
forwarder journal 2026-10-22T19:45Z (journal metadata only so far: ids, new/edit, timestamps; NO text, NO levels,
NO outcomes were examined). Prices: Dukascopy XAUUSD ticks (same downloader/engine as the main study).

Frozen strategy set (no re-tuning): S_TP4|M5, S_TP4|M0, Q_25x4|M3, Q_25x4|M0, S_TP3|M0, benchmark S_TP1|M0
(variant names and the engine `sim_engine_b2.py` exactly as frozen in finalists.json,
sha256 907790184fd086998e07533102e1e6f8a332c55e5626ef52b0a4d60b63432235).
Entry models E1 and E2 as defined in b2_core.py, cost scenario MID (primary), BASE and PESS reported.
Signal universe rules: identical hard-flag rules to b1/prepare_signals.py (comma-decimal, implausible distances,
wrong side, TP order, duplicate TP label, duplicate-of-earlier). Final text of each message = the version with the
latest edit_date (matches how the original export stored messages).

Primary hypotheses (directional, stated now):
- H1 (replication of the headline): for every frozen strategy, OOS2 mean R under E2/MID is not distinguishable from
  zero (95% bootstrap CI contains 0). A confidence interval entirely above 0 for S_TP4|M5 would be evidence for
  the Conservative draft; entirely below 0 would be evidence against it.
- H2 (edit-timing mechanism): mean R of signals whose final text was edited >300 s after posting is HIGHER than
  that of signals edited <=300 s (or never), for S_TP4|M5. Direction as in the main study.
- H3 (live-engine view): restricting to what the AutoTrader could act on (first revision that parses as a signal,
  observed within the default 120 s signal-age gate, entry clock = that revision's edit_date or date, levels as of
  that revision) the frozen strategies have mean R <= 0.
Secondary (descriptive only, no inference claims): share of signals whose levels (entry, SL, any TP) differ between
the first parseable revision and the final text; share first completed by an edit; share that the 120 s gate
would skip.

Decision rules: nothing is selected, tuned or filtered on OOS2. If H1 holds the conclusion stays "no established
edge". Multiple strategies are reported with the Holm adjustment across the 6 frozen variants x 2 entry models.
Limitations stated in advance: n will be small (about 80-120 signals), so only a large effect (|mean R| > ~0.4) is
detectable; pre-edit text exists only from the moment the forwarder started storing revisions.

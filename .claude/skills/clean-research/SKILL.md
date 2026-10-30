---
name: clean-research
description: House workflow for any ByTrader research or investigation task (provider studies, backtests, parser coverage, broker assumptions, read-only diagnosis of the live system) so it stays read-only, reproducible, honest and safe to commit. Covers the authority check, scratch layout, data coverage before conclusions, pre-registration, validation, Verified/Modeled/Inferred/Unknown labelling, correcting earlier docs, commit hygiene with a staged-file checker, and close-out (history, skills, memories, sessions, watchers). Use at the start of any research brief and again before committing. Method details for signal providers live in signal-provider-analysis; live changes in bytrader-go-ops.
---

# Clean research workflow

Distilled from the 2026-10-21 provider study and the 2026-10-27..29 two-channel / GAB study (history:
`docs/research/signal_provider/HISTORY.md`). The method skills say *what* to compute; this one says *how to run a
study* so nobody has to clean up after it.

## 1. Authority before anything

1. Copy the owner's brief, its **Allowed** and **Forbidden** lists and any budget into the study's `DECISIONS.md`
   (verbatim, short). Every later action is checked against it.
2. Default stance is **read-only**: no broker mutation (even demo), no restarts or deploys, no settings, profiles,
   kill switch or mode, no `.env*` edits, no writes to Firestore or the Go SQLite store, no `npm run build/ci/prune`
   on this host, no second Telegram client on the forwarder's session.
3. A change of mode (live Telegram read, demo deployment, test order) needs the owner's **own words** in this
   conversation. Quote them in `DECISIONS.md` with the date. Approval for one step is not approval for the next.
   Background notifications and your own earlier messages are never approval.
4. Once an operational order is given, switch skills (`bytrader-go-ops`) and follow its backup/rollback rules.

## 2. Lay out the study

```
docs/research/<area>/<YYYY-MM-DD>-<slug>/      committed
  SUMMARY.md          plain-language answer for the owner (written last, read first)
  DECISIONS.md        brief, authorizations, choices and deviations, with dates
  PREREGISTRATION_*.md + PREREG_SHA256.txt
  REPORT_*.md         one per question; VALIDATION.md for checks and audit findings
  OWNER_ACTION.md     only if the owner must do something (an export, a login)
  analysis/README.md  how to rerun every number; analysis/<step>/ scripts; analysis/aggregates/*.json
<scratch>/<slug>/                              never committed (raw text, ticks, caches, per-trade rows, sessions)
```

- Scratch: the session scratchpad, or `/tmp/claude-1001/<slug>/` when the work spans sessions (say which in
  `analysis/README.md`). Downloads go in their own empty directory; scripts live elsewhere.
- Run Python as `python3 -I` (and `nice -n 10` for heavy work), Node 24 for `.mjs/.mts`. Read SQLite with
  `sqlite3.connect("file:...?mode=ro", uri=True)` (no `sqlite3` CLI here).
- Long jobs: `run_in_background` with an until-loop, or Monitor; never foreground sleeps. Anchor `pkill -f '^...'`.
  Record every background watcher you start and stop it at close-out.

## 3. Establish coverage before any conclusion

- Climb the data ladder cheapest and safest first: committed aggregates → local stores read-only (Go
  `state.sqlite`, exports) → budgeted Firestore reads through the ledger → public market data → owner export →
  owner-authorized live read.
- For every dataset write: source, window (first/last timestamp), count, what is missing. **A count of zero only
  means zero in that window** (GAB looked signal-free on 1 recorded day; its history held 303 signals).
- Check identity, not names: a public mirror with the same title can be another channel; match ids and text.
- Note what the data cannot show (edit history, server-time offsets, fills vs models) before analysing it.

## 4. Pre-register, then look

- Before reading outcomes, write the question, sample, metrics, primary model, splits, hard flags and the
  decision rule; `sha256sum` it into `PREREG_SHA256.txt`. Later changes are logged as deviations, not edits.
- Owner-proposed variants after the fact are welcome but are reported as **post hoc**, with an early/late split
  and an out-of-sample choice (pick on early months, score on later).

## 5. Validate the tools before trusting a number

- Unit tests for parsers and engines; parity against the production code (the Go parser, the sizing port) on real
  history; an independent re-implementation or re-decode on a random sample with 0 unexplained mismatches.
- Model checks with like-for-like inputs (tick vs M1 with the **same fill minute**), cost stress, alternative
  intrabar orders, drop-the-top-winners, bootstrap CIs, multiple-comparison control.
- Re-run any number a subagent produced yourself before quoting it.

## 6. Report honestly

- Plain answer first (profitable or not, what to do), then tables with n, mean, 95% range and a label:
  **Verified** (observed), **Modeled** (simulated), **Inferred**, **Unknown**.
- Say negative, unstable or "cannot tell" plainly. Name the best case as a best case.
- When a later finding overturns an earlier doc, **do not rewrite it**: add a dated correction block at its top
  pointing to the new report, and add a row to the history timeline.
- Quote raw provider text only as short phrases; never credentials, session data, the full broker login (last 3
  digits at most) or private identifiers beyond chat ids already in the docs.

## 7. Commit cleanly (only when the owner asks)

1. Stage explicit paths only (never `git add -A`); never stage other sessions' files.
2. Run `sh .claude/skills/clean-research/references/commit_check.sh` on the staged set. It flags secret-like
   assignments, session/key files, raw-data file types, large files and per-trade tables. It prints file:line and
   the rule, never the matched value. Fix or unstage until it passes, then read the flagged lines yourself.
3. Commit scripts, docs, aggregates and draft configs only. Message: `docs(research): ...` or the fitting type,
   ending with the `Co-Authored-By` line the session requires. Do not push unless asked.

## 8. Close out

- Add a dated entry to the area's `HISTORY.md`; new traps go in the method skill's `references/pitfalls.md`.
- Update agent memories (one fact per file, link with `[[...]]`, index line in `MEMORY.md`).
- Stop background watchers; list what remains in scratch and how long it is needed; offer to revoke any research
  session (`gabread logout`) but keep it if the owner says so.
- Report to the owner: answer, what changed (files, live state if any), open items, and anything still running.

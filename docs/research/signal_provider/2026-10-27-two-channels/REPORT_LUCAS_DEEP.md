# LUCAS GOLD LEGEND: deep check (second pass, 2026-10-27)

Owner request: "check Lucas properly; a new parsing pattern is allowed". This pass adds a channel-specific grammar
for the whole vocabulary (signals, management, entry hits, completions, recap claims), a simulation of
**following the provider's own instructions as they appear**, an audit of every numeric claim against tick
prices, and a search for more history. Labels: **Verified**, **Modeled**, **Inferred**, **Unknown**.

**Bottom line: still Unknown, and the provider's results do not survive a live follower.** The headline
"+360 pips" outcome relies on an instruction that was rewritten after the price moved. Followed live, the same two
signals give about 0 R per signal, up to +0.7 R under the most charitable reading.

## 1. More data?

| Source | Result | Label |
|---|---|---|
| Private channel, Go store, refreshed 07:30Z | 54 messages to 2026-10-27 07:22Z; **no new signal** (analysis posts only) | Verified |
| Firestore, all 3 older docs (3 reads) | 2 media-only edits and one boast about "signals of October 5th to 9th"; no levels | Verified |
| Public preview `t.me/s/lucas_gold_legend` (full scrape, 47 pages, 1.5 s apart, no login) | 698 posts from 2026-09-04, 74 with SL+TP; **all 74 sit in bulk-repost batches** (698 posts share only 116 timestamps, up to 30 per second), with mixed formats, crypto pairs (AVA/USDT 20×) and Malay-language reposts. Post time is not signal time, so these cannot be tested | Verified |

The sample stays at 2 signals (SIGNAL 3 BUY, SIGNAL 4 SELL, 2026-10-26).

## 2. New grammar (`analysis/lucas/lucas_grammar.py`)

Reads every revision separately. Over 87 revisions: 4 signal blocks (2 signals × 2 revisions), 27 management,
4 completed, 2 entry hits, 2 breakeven, 1 runner note, 3 recap claims, 46 other. One defect was found and fixed while
building it: under `re.I` the word "open" in the TP character class swallowed the next paragraph's "On", dropping
SIGNAL 4's last target. Synthetic tests: `test_lucas_grammar.py` (6 OK).

The provider's method, as written: enter in **layers** across the zone (3992 / 3991 / 3990), soon **close the
"bad entries"** near break-even, keep the best-priced layer with the stop at its entry, close half at a target, then
trail the stop by hand (3995 → 4000 → 4005).

## 3. The instruction that was rewritten (Verified from revision history and ticks)

| Time (UTC) | What the channel said about SIGNAL 3 | Market |
|---|---|---|
| 13:56:23 | "close bad entries 3992, **move stoploss 3991**, keep the remaining **3991** position" | ask about 3993 |
| about 13:58 | (nothing) | dip: ask 3989.08 at 13:58:46, bid under 3991, so the 3991 stop is hit |
| 14:00:27 | **same message edited**: "close bad entries 3992 -3991, **move stoploss 3990**, keep **3990**" | price back above 3995 |

The instruction a reader sees afterwards was written after the dip had already stopped out the position that the
first version told followers to keep.

## 4. Following the provider live (Modeled; `analysis/lucas/lucas_followup.py`)

Rules: one limit layer per whole price in the zone, equal size, valid 60 min; every revision applied at its own
time + latency; stops checked on every Dukascopy tick; "close half" once; optional trailing advice ignored;
anything still open at 2026-10-27 07:00Z marked to market. R is measured against the plan's risk to the posted
stop. Two readings were tested because the text is ambiguous: whether a stop move applies to every layer
(`global`) or only to the layer the message names (`per_layer`), and whether pending layers the message does
not name stay live (`keep`) or are cancelled (`cancel_unnamed`).

| Reading | Latency | SIGNAL 3 (BUY) | SIGNAL 4 (SELL) |
|---|---|---|---|
| global stop, pending kept | 10 / 30 / 60 s | -0.07 / -0.01 / -0.08 R | -0.05 / +0.15 / +0.25 R |
| global stop, unnamed pending cancelled | 10 / 30 / 60 s | -0.05 / +0.02 / -0.06 R | -0.05 / +0.15 / +0.25 R |
| per-layer stop, unnamed pending cancelled | 10 / 30 / 60 s | -0.05 / +0.02 / -0.06 R | -0.05 / +0.15 / +0.25 R |
| **per-layer stop, pending kept (most charitable)** | 10 / 30 / 60 s | **+0.59 / +0.71 / +0.68 R** | -0.05 / +0.15 / +0.25 R |

For comparison, the posted levels alone (E2 entry, all closed at TP3) give SIGNAL 3 **+2.73 R** and SIGNAL 4 **-1.01 R**
(first study). The provider's "+360 pips" for SIGNAL 3 needs the 3990 layer to survive the 13:58 dip with a stop at
3990. That is impossible: the layer filled only when the ask reached 3990, with the bid already below it. In the
charitable reading it survives only because the 13:56 instruction never mentioned it, so it still carried the
original 3984 stop.

Under the provider's own management, SIGNAL 4 is a small loss or gain (the channel called it "returned to
breakeven"). Followed at the posted levels without management, it lost 1 R.

## 5. Claims audit (Verified on Dukascopy)

40 distinct numeric claims ("Entry X → Y = +N pips" in management messages, plus the recaps):

| Check | Result |
|---|---|
| Arithmetic (N = \|Y − X\| / 0.10) | 36 of 38 correct (two errors at 14:05:15: "80" should be 90, "60" should be 80) |
| BUY claims: price Y had traded on the bid by posting time | **28 of 30** (one entry not yet fillable when claimed; one 0.035 USD short) |
| SELL claims: price Y had traded on the ask by posting time | **0 of 9**; overstated by up to 1.10 USD (11 pips), consistent with quoting the bid |
| Claims about realised results | none: every number is a floating best case, never a close |

## 6. Verdict

- **Profitable?** Unknown (n = 2). Nothing here supports trading it.
- **What the evidence does show:** the published results are floating best cases, sell results are quoted on
  the favourable side, and one key management instruction was rewritten after the fact. Followed live, the
  provider's own plan made about nothing on these two signals.
- **If the owner still wants a test:** collect at least 160 signals together with every management revision
  (the forwarder already keeps them) and evaluate **both** the posted levels and the live-follower model above.
  Pre-register the per-layer reading as primary, since it is the most charitable. Do not use the final edited text.

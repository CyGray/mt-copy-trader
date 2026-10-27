"""Verify the orchestrator's claimed tick facts for LUCAS SIGNAL 3 / SIGNAL 4 (auditor, from raw bi5)."""
import json
import statistics
import sys

sys.path.insert(0, '/tmp/claude-1001/twochan/audit')
import bi5_audit as B  # noqa: E402

T_FINAL = B.ms_utc(2026, 10, 26, 13, 53, 8, 0)      # message date (final universe signal time)
T_FIRST = B.ms_utc(2026, 10, 26, 13, 53, 12, 62)    # first revision timestamp (first universe)

ticks = B.Ticks(B.ms_utc(2026, 10, 26, 0), B.ms_utc(2026, 10, 27, 2, 0))
out = {'hours': {}, 'sorted_violations': ticks.check_sorted(), 'n_ticks': len(ticks.t),
       'known_until': B.fmt_utc_full(ticks.known_until)}
for h in sorted(ticks.hour_status):
    st, n = ticks.hour_status[h]
    out['hours'][B.fmt_utc_full(h)[:13]] = (st, n)


def window(t0, t1):
    """indices of ticks with t0 <= t < t1 (t1 exclusive for the bisect), and also inclusive t1 check."""
    i0 = ticks.index_at_or_after(t0)
    i1 = ticks.index_at_or_after(t1 + 1)   # inclusive of t1 millisecond
    return range(i0, i1)


def extreme(rng, arr, kind):
    best = None
    best_i = None
    for i in rng:
        v = arr[i]
        if best is None or (kind == 'min' and v < best) or (kind == 'max' and v > best):
            best, best_i = v, i
    return best, best_i


def first_at_or_above(t0, arr, level, t_end=None):
    i0 = ticks.index_at_or_after(t0)
    for i in range(i0, len(ticks.t)):
        if t_end is not None and ticks.t[i] > t_end:
            return None
        if arr[i] >= level:
            return i
    return None


def fmt_px(milli):
    return f'{milli / 1000:.3f}'


res = {}
# F1: SIGNAL 3 min ask between 13:53:08 and 14:05:00 UTC
r = window(T_FINAL, B.ms_utc(2026, 10, 26, 14, 5, 0))
v, i = extreme(r, ticks.ask, 'min')
res['F1_sig3_min_ask_13:53:08-14:05:00'] = {'value': fmt_px(v), 'time': B.fmt_utc_full(ticks.t[i]), 'n_ties_at_min': sum(1 for j in r if ticks.ask[j] == v)}
# F2: max bid 13:53:08 - 17:00
r = window(T_FINAL, B.ms_utc(2026, 10, 26, 17, 0, 0))
v, i = extreme(r, ticks.bid, 'max')
res['F2_sig3_max_bid_13:53:08-17:00'] = {'value': fmt_px(v), 'time': B.fmt_utc_full(ticks.t[i]), 'n_ties_at_max': sum(1 for j in r if ticks.bid[j] == v)}
# F3/F4: SIGNAL 4 first bid >= 4011 / >= 4013 after the signal (final and first times)
for lbl, t0 in (('final', T_FINAL), ('first', T_FIRST)):
    i = first_at_or_above(t0, ticks.bid, 4011000)
    res[f'F3_sig4_first_bid_ge_4011_after_{lbl}'] = B.fmt_utc_full(ticks.t[i])
    i = first_at_or_above(t0, ticks.bid, 4013000)
    res[f'F4_sig4_first_bid_ge_4013_after_{lbl}'] = B.fmt_utc_full(ticks.t[i])
# F5: best ask 14:19 - 14:40 (minimum ask in window)
r = window(B.ms_utc(2026, 10, 26, 14, 19, 0), B.ms_utc(2026, 10, 26, 14, 40, 0))
v, i = extreme(r, ticks.ask, 'min')
res['F5_best_ask_14:19-14:40_min'] = {'value': fmt_px(v), 'time': B.fmt_utc_full(ticks.t[i]), 'n_ties_at_min': sum(1 for j in r if ticks.ask[j] == v)}
# F6: first ask >= 4018 after 14:19
i = first_at_or_above(B.ms_utc(2026, 10, 26, 14, 19, 0), ticks.ask, 4018000)
res['F6_first_ask_ge_4018_after_14:19'] = B.fmt_utc_full(ticks.t[i]) if i is not None else None
# F7: median spread (ask - bid) on 2026-10-26 13h
r = range(ticks.index_at_or_after(B.ms_utc(2026, 10, 26, 13)), ticks.index_at_or_after(B.ms_utc(2026, 10, 26, 14)))
spreads = [ticks.ask[j] - ticks.bid[j] for j in r]
res['F7_median_spread_2026-10-26_13h_USD'] = {'median': statistics.median(spreads) / 1000, 'n': len(spreads),
                                               'negative_spreads': sum(1 for s in spreads if s < 0)}
out['facts'] = res
print(json.dumps(out, indent=1, default=str))

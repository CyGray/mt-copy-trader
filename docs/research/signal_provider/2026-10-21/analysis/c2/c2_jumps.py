"""C2: one-tick mid jumps >= 5 USD in the full XAUUSD tape (own decoder). Reversion within 60 s, two definitions."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import datetime as dt, json, os
import numpy as np
import c2_ticks as T_

store = T_.HourStore(max_hours=200)
start = int(dt.datetime(2025, 10, 30, tzinfo=dt.timezone.utc).timestamp() * 1000)
end = int(dt.datetime(2026, 9, 28, tzinfo=dt.timezone.utc).timestamp() * 1000)
DAY = 86400000
res = dict(jumps=0, reverted50_60s=0, reverted_within1_60s=0, isolated_spikes=0, isolated_spike_reverted=0,
           gap_excluded=0, jumps_ge10=0, jumps_ge10_rev50=0)
sizes = []
d0 = start
while d0 < end:
    # block = this UTC day plus 2 min of the next day for look-ahead of reversion
    ts, a, b = store.window(d0 - 60000, d0 + DAY + 120000)
    if len(ts) > 2:
        mid = (a + b) / 2.0
        dtm = np.diff(ts)
        jump = np.abs(np.diff(mid))
        cand = np.flatnonzero((jump >= 5.0))
        for c in cand:
            j = c + 1  # index of the jumped tick
            if not (d0 <= ts[j] < d0 + DAY):
                continue
            if dtm[c] > 5000:  # previous tick more than 5 s earlier: market-open / gap, excluded from one-tick class
                res['gap_excluded'] += 1
                continue
            pre = mid[c]
            jmp = mid[j] - pre
            res['jumps'] += 1
            sizes.append(abs(jmp))
            win_end = np.searchsorted(ts, ts[j] + 60000, 'right')
            after = mid[j + 1:win_end]
            if after.size:
                ret50 = (np.sign(after - pre) == -np.sign(jmp)) & (np.abs(after - pre) <= 0.5 * abs(jmp))
                ret1 = np.abs(after - pre) <= 1.0
                if ret50.any():
                    res['reverted50_60s'] += 1
                if ret1.any():
                    res['reverted_within1_60s'] += 1
                if abs(jmp) >= 10:
                    res['jumps_ge10'] += 1
                    if ret50.any():
                        res['jumps_ge10_rev50'] += 1
            # isolated single-tick spike: next tick returns to within 1 USD of pre-jump mid
            if j + 1 < len(mid) and abs(mid[j + 1] - pre) <= 1.0:
                res['isolated_spikes'] += 1
    d0 += DAY
res['jump_size_quantiles_p50_p90_p99'] = [float(x) for x in np.percentile(sizes, [50, 90, 99])] if sizes else None
res['reverted50_share'] = res['reverted50_60s'] / res['jumps'] if res['jumps'] else None
res['reverted1_share'] = res['reverted_within1_60s'] / res['jumps'] if res['jumps'] else None
res['isolated_spike_share'] = res['isolated_spikes'] / res['jumps'] if res['jumps'] else None
res['jumps_ge10_rev50_share'] = res['jumps_ge10_rev50'] / res['jumps_ge10'] if res['jumps_ge10'] else None
res['missing_hours'] = len(store.missing)
json.dump(res, open(os.path.join(T_.SCRATCH, 'c2', 'out', 'c2_jumps.json'), 'w'), indent=1)
print(json.dumps(res, indent=1))

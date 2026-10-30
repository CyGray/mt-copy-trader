"""Tick vs M1 check for gab_ladder.py: same signals, same fill minute, 24 h horizon, market entry. Per leg:
share with the same exit type, median |P&L difference|, mean P&L on each feed (USD per 0.01 lot). Read-only research."""
import json, sys
S = "/tmp/claude-1001/twochan/gab/study"
M = {r['id']: r for r in json.load(open(f"{S}/ladder_m1_h24.json"))}
T = [r for r in json.load(open(f"{S}/ladder_ticks.json")) if r['ticks']['status'] == 'ok']
out = {}
for W in ('80', '130'):
    for leg in ('f1', 'f2', 'f3', 'f4', 'f5', 'r30_1', 'r50_1', 'r75_1', 'r100_1', 'r200_1', 'r500_1', 'rNone_1', 'r50_5'):
        same = 0; n = 0; dif = []; a_s = 0; b_s = 0
        for t in T:
            m = M[t['id']]['market']
            if m['status'] != 'ok': continue
            g = lambda L: L['fixed'][leg[1:]] if leg[0] == 'f' else L['runner'][leg[1:]]
            a = g(m['orders']['ohlc'][W]); b = g(t['ticks']['legs'][W])
            n += 1; same += a[2] == b[2]; dif.append(abs(a[0] - b[0])); a_s += a[0]; b_s += b[0]
        dif.sort()
        out[f"W{W}_{leg}"] = dict(n=n, same_exit_type=round(same / n, 3), median_abs_diff=round(dif[n // 2], 2),
                                  mean_m1=round(a_s / n, 2), mean_ticks=round(b_s / n, 2))
if len(sys.argv) > 1: json.dump(out, open(sys.argv[1], 'w'), indent=1)
for k, v in out.items(): print(k, v)

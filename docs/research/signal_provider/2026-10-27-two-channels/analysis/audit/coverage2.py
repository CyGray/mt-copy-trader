"""Ties at trigger ticks, BE/SL-after-partial exits, and the margin to an M1/M3 stop (counts only)."""
import sys, bisect
sys.path.insert(0, '/tmp/claude-1001/twochan/audit')
import bi5_audit as B, audit_parse as P, audit_sim as S
ticks = B.Ticks(B.ms_utc(2026, 10, 26, 0), B.ms_utc(2026, 10, 27, 2, 0))
revs, fin, first = P.load_signal_revisions()
sigs = {s['label']: s for s in P.parse_text(fin['text'])}
t_final = P.iso_ms(fin['date'])
sim = S.Sim(ticks)
ties = {'exit_tp_bid_equals_tp': 0, 'exit_tp_ask_equals_tp': 0, 'exit_sl_equal': 0, 'pending_fill_equal_limit': 0, 'exits_checked': 0}
partial_stop = 0
for lbl, s in sigs.items():
    f, tr = S.run_signal(sim, s, t_final)
    for (e, c, name), row in tr.items():
        if row['status'] != 'FILLED': continue
        if row['final_exit'] in ('SL', 'BE') and '>' in (row['exit_seq'] or ''):
            partial_stop += 1
        ties['exits_checked'] += 1
    fill = f[('E2', 'BASE')]
    j = bisect.bisect_left(ticks.t, fill['fill_ms'])
    limit = fill['pending_limit']
    if s['direction'] == 'buy' and ticks.ask[j] == limit: ties['pending_fill_equal_limit'] += 1
    if s['direction'] == 'sell' and ticks.bid[j] == limit: ties['pending_fill_equal_limit'] += 1
# TP trigger ties: first tick where the TP is touched, bid/ask equal to the TP exactly
for lbl, s in sigs.items():
    buy = s['direction'] == 'buy'
    fill = sim.fill_for(s, t_final, 'E2', 'BASE')
    for k, tp in enumerate(s['tps'], start=1):
        j0 = bisect.bisect_left(ticks.t, fill['fill_ms'] + 1)
        for j in range(j0, len(ticks.t)):
            if buy and ticks.bid[j] >= tp:
                if ticks.bid[j] == tp: ties['exit_tp_bid_equals_tp'] += 1
                break
            if (not buy) and ticks.ask[j] <= tp:
                if ticks.ask[j] == tp: ties['exit_tp_ask_equals_tp'] += 1
                break
print('ties', ties, 'partial_stop_BE_or_SL', partial_stop)
# margin: lowest bid between TP1 and TP3 touch for the BUY signal (BE/SL move would trigger at <= fill)
s = sigs['3']
fill = sim.fill_for(s, t_final, 'E2', 'BASE')
j1 = bisect.bisect_left(ticks.t, fill['fill_ms'] + 1)
t_tp1 = next(ticks.t[j] for j in range(j1, len(ticks.t)) if ticks.bid[j] >= s['tps'][0])
t_tp2 = next(ticks.t[j] for j in range(j1, len(ticks.t)) if ticks.bid[j] >= s['tps'][1])
t_tp3 = next(ticks.t[j] for j in range(j1, len(ticks.t)) if ticks.bid[j] >= s['tps'][2])
def minbid(a, b):
    lo = bisect.bisect_left(ticks.t, a); hi = bisect.bisect_left(ticks.t, b)
    return min(ticks.bid[lo:hi]) / 1000
print('TP1', B.fmt_utc_full(t_tp1), 'TP2', B.fmt_utc_full(t_tp2), 'TP3', B.fmt_utc_full(t_tp3))
print('min bid after TP1 until TP3 =', minbid(t_tp1, t_tp3), 'fill price', fill['fill_px']/1000)
print('min bid after TP2 until TP3 =', minbid(t_tp2, t_tp3), 'fill price', fill['fill_px']/1000)

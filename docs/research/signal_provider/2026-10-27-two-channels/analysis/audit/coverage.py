"""Path coverage of the pilot data under the auditor's simulator (counts only, no message text)."""
import sys, json, bisect
sys.path.insert(0, '/tmp/claude-1001/twochan/audit')
import bi5_audit as B, audit_parse as P, audit_sim as S
ticks = B.Ticks(B.ms_utc(2026, 10, 26, 0), B.ms_utc(2026, 10, 27, 2, 0))
revs, fin, first = P.load_signal_revisions()
sigs = {s['label']: s for s in P.parse_text(fin['text'])}
t_final = P.iso_ms(fin['date'])
sim = S.Sim(ticks)
cov = {}
for lbl, s in sigs.items():
    for entry in ('E1', 'E2', 'E3'):
        for cost in ('BASE', 'MID', 'PESS'):
            f = sim.fill_for(s, t_final, entry, cost)
            i = bisect.bisect_left(ticks.t, t_final + S.COST[cost]['lat_ms'])
            half = S.COST[cost]['spread'] // 2
            px_dec = (ticks.ask[i] + half) if s['direction'] == 'buy' else (ticks.bid[i] - half)
            print(lbl, entry, cost, 'decision', B.fmt_utc_full(ticks.t[i]), 'price', px_dec/1000,
                  'band', (s['lo']-S.ENT[entry]['tol'])/1000, (s['hi']+S.ENT[entry]['tol'])/1000,
                  'status', f['status'], f['kind'], (f['fill_px'] or 0)/1000)
# trade-level path checks for the FILLED combos
tr_stats = {'same_tick_sl_tp': 0, 'sl_moved_and_stopped': 0, 'stop_after_partial': 0, 'exits': 0}
for lbl, s in sigs.items():
    for entry in ('E2',):
        for cost in ('BASE', 'MID', 'PESS'):
            f, tr = None, None
            f, tr = S.run_signal(sim, s, t_final)
            for (e, c, name), row in tr.items():
                if row['status'] != 'FILLED':
                    continue
                if row.get('same_tick_sl_tp'):
                    tr_stats['same_tick_sl_tp'] += 1
                if row['final_exit'] == 'SL' and row['exit_seq'] and '>' in row['exit_seq']:
                    tr_stats['stop_after_partial'] += 1
                tr_stats['exits'] += 1
print(json.dumps(tr_stats))

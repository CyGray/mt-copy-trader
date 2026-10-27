"""C2 per-trade reproduction vs B2 OOS/phase1 trade files. Agreement: fill time exact, fill price and R within 0.01."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, gzip, json, os, collections
from c2_run import OUT, SCR, load_signals
sigs = {s['msg']: s for s in load_signals()}
B2 = os.path.join(SCR, 'b2', 'out')
def rows_gz(fn):
    return list(csv.DictReader(gzip.open(fn, 'rt')))
b2 = rows_gz(os.path.join(B2, 'oos_trades.csv.gz'))
ph = rows_gz(os.path.join(B2, 'phase1_trades.csv.gz'))
print('b2 oos rows', len(b2), 'phase1 rows', len(ph), 'phase1 splits', collections.Counter(r['split'] for r in ph))
# my side
ENT = {}
TRD = {}
for fn in ('c2_entries_core.csv',):
    for r in csv.DictReader(open(os.path.join(OUT, fn))):
        ENT[(r['variant'], r['msg'])] = r
for fn in ('c2_trades_core.csv',):
    for r in csv.DictReader(open(os.path.join(OUT, fn))):
        TRD[(r['variant'], r['msg'], r['strat'])] = r
MAP = {('E2', 'MID'): 'MID_E2_noguard_pendslip', ('E1', 'MID'): 'MID_E1_FT', ('E2', 'BASE'): 'BASE_E2_noguard', ('E1', 'BASE'): 'BASE_E1_FT', ('E3', 'MID'): 'MID_E3_FT', ('E3', 'BASE'): 'BASE_E3_FT'}
def cmp(src, label):
    stats = collections.Counter()
    mism = collections.defaultdict(list)
    for r in src:
        if r['cost'] not in ('BASE', 'MID') or r['entry'] not in ('E1', 'E2', 'E3') or r['variant'] not in ('S_TP1|M0', 'S_TP4|M0', 'S_TP4|M5', 'Q_25x4|M0'):
            continue
        msg = r['message_id']
        v = MAP[(r['entry'], r['cost'])]
        b_filled = r['status'] == 'FILLED'
        me = ENT.get((v, msg))
        if me is None:
            stats['no_mine'] += 1
            continue
        m_filled = me['status'] == 'FILLED'
        stats[f'{r["cost"]} {r["entry"]} filled_both' if (b_filled and m_filled) else f'{r["cost"]} {r["entry"]} fill_status_diff ({r["status"]} vs {me["status"]})'] += 1
        if not (b_filled and m_filled):
            mism[f'{r["cost"]} {r["entry"]} fill status'].append((msg, r['status'], me['status']))
            continue
        ms_b, px_b = int(r['fill_ms']), float(r['fill_px'])
        ms_m, px_m = int(me['t_fill']), float(me['fill_real'])
        if ms_b == ms_m:
            stats['fill_time_exact'] += 1
        else:
            stats['fill_time_diff'] += 1
            mism['fill time'].append((msg, r['entry'], ms_b, ms_m))
        if abs(px_b - px_m) <= 0.01:
            stats['fill_px_within_0.01'] += 1
        else:
            stats['fill_px_diff'] += 1
            mism['fill price'].append((msg, r['entry'], round(px_b, 3), round(px_m, 3), r['kind'], me['kind']))
        t = TRD.get((v, msg, r['variant']))
        if t is None or t['status'] != 'OK':
            stats['trade_missing_mine'] += 1
            mism['trade missing'].append((msg, r['variant'], t['status'] if t else None))
            continue
        Rb, Rm = float(r['total_R']), float(t['R'])
        if abs(Rb - Rm) <= 0.01:
            stats['R_within_0.01'] += 1
        else:
            stats['R_diff'] += 1
            mism['R'].append((msg, r['entry'], r['variant'], round(Rb, 3), round(Rm, 3), r['final_exit'], t['legs'][:120]))
    print(label, dict(stats))
    for k, v in mism.items():
        print('  mismatch class', k, len(v), 'examples:', v[:4])
    return stats, mism
st1, m1 = cmp(b2, 'OOS (B2 oos_trades vs mine)')
st2, m2 = cmp(ph, 'TRAIN+VAL (B2 phase1 vs mine)')
json.dump({'oos': {k: v for k, v in st1.items()}, 'trval': {k: v for k, v in st2.items()}}, open(os.path.join(OUT, 'c2_match_stats.json'), 'w'), indent=1)

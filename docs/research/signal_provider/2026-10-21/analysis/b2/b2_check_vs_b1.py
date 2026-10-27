"""Cross-check: B2 rebuilt E3 (P1 tol 0.5, BASE) 100%TP1 trades vs B1 strategy_outcomes.csv (BASE, CLEAN, TP1_100).
Expected: identical fill set and total_R (B1 has no project SL-distance filter; a difference would show here)."""
import csv, gzip, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import b2_core as c
B1 = os.path.join(c.SCRATCH, 'b1', 'strategy_outcomes.csv')
b1 = {r['message_id']: r for r in csv.DictReader(open(B1)) if r['scenario'] == 'BASE' and r['strategy'] == 'TP1_100' and r['in_clean'] == '1'}
b2 = {}
for path in ('out/phase1_trades.csv.gz', 'out/oos_trades.csv.gz'):
    with gzip.open(path, 'rt') as f:
        for r in csv.DictReader(f):
            if r['entry'] == 'E3' and r['cost'] == 'BASE' and r['variant'] == 'S_TP1|M0':
                b2[r['message_id']] = r
both = set(b1) & set(b2)
print('B1 CLEAN BASE TP1 filled', len(b1), 'B2 E3 BASE TP1 rows', len(b2), 'common', len(both))
print('only in B1', sorted(set(b1) - set(b2))[:10], 'only in B2', sorted(set(b2) - set(b1))[:10])
diffs = [abs(float(b1[m]['total_R']) - float(b2[m]['total_R'])) for m in both if b1[m]['total_R'] and b2[m]['total_R']]
print('max |total_R diff|', round(max(diffs), 6) if diffs else None, 'n compared', len(diffs))
mb1 = sum(float(b1[m]['total_R']) for m in b1 if b1[m]['total_R']) / max(1, sum(1 for m in b1 if b1[m]['total_R']))
mb2 = sum(float(r['total_R']) for r in b2.values() if r['total_R']) / max(1, sum(1 for r in b2.values() if r['total_R']))
print('mean R B1', round(mb1, 4), 'B2', round(mb2, 4))

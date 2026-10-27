"""Compare provider signal entries with Dukascopy market at the message time.

usage: alignment.py RAWDIR DERIVED_DIR
Reads derived/signals_a3.csv (reparsed entries). Writes derived/alignment_per_signal.csv
and prints summary statistics. Only signals whose message time has ticks within +/-120 s are used.
"""
import sys, os, csv, bisect, statistics as st, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import window_ticks, load_hour_arrays, _floor_hour

RAW, DER = sys.argv[1], sys.argv[2]
P = 1000.0

def ms_of(iso):
    return int(dt.datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp() * 1000)

def nearest_quote(raw, t_ms, tol_ms):
    """Return (bid,ask) of the last tick at/before t_ms, and first tick at/after; both within tol."""
    before = after = None
    # look back then forward within tol window
    for ts, b, a in window_ticks(raw, t_ms - tol_ms, t_ms):
        before = (ts, b, a)
    for ts, b, a in window_ticks(raw, t_ms, t_ms + tol_ms):
        after = (ts, b, a)
        break
    return before, after

def mid_at(raw, t_ms, tol_ms=120000):
    bef, aft = nearest_quote(raw, t_ms, tol_ms)
    if bef is None and aft is None:
        return None
    if bef is None:
        return dict(bid=aft[1] / P, ask=aft[2] / P, lag_ms=aft[0] - t_ms)
    if aft is None:
        return dict(bid=bef[1] / P, ask=bef[2] / P, lag_ms=t_ms - bef[0])
    return dict(bid=(bef[1] + aft[1]) / 2 / P, ask=(bef[2] + aft[2]) / 2 / P, lag_ms=min(abs(aft[0]-t_ms), abs(t_ms-bef[0])))

rows = list(csv.DictReader(open(os.path.join(DER, 'signals_a3.csv'), encoding='utf-8')))
out = []
for r in rows:
    t = ms_of(r['date_utc'])
    lo = float(r['reparse_entry_low'] or r['entry_low']); hi = float(r['reparse_entry_high'] or r['entry_high'])
    emid = (lo + hi) / 2
    d = r['direction']
    q = mid_at(RAW, t)
    rec = dict(msg_id=r['msg_id'], date_utc=r['date_utc'], direction=d, entry_mid=emid, entry_low=lo, entry_high=hi)
    if q is None:
        rec.update(mkt_mid='', mkt_bid='', mkt_ask='', quote_lag_s='', off_mid='', off_exec='', note='no_ticks_within_120s')
        out.append(rec); continue
    m = (q['bid'] + q['ask']) / 2
    exec_px = q['ask'] if d == 'buy' else q['bid']
    rec.update(mkt_mid=round(m, 3), mkt_bid=round(q['bid'], 3), mkt_ask=round(q['ask'], 3),
               quote_lag_s=round(q['lag_ms'] / 1000, 2), off_mid=round(emid - m, 3),
               off_exec=round((emid - exec_px) * (1 if d == 'buy' else -1), 3), note='')
    # off_exec>0 means the entry is better than market for the trader (buy below ask, sell above bid)
    out.append(rec)

with open(os.path.join(DER, 'alignment_per_signal.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)

used = [o for o in out if o['note'] == '']
def stats(xs, name):
    if not xs:
        print(name, 'n=0'); return
    xs = sorted(xs); q = lambda p: xs[min(len(xs)-1, int(p*(len(xs)-1)))]
    print(f'{name}: n={len(xs)} median={st.median(xs):+.3f} mean={st.mean(xs):+.3f} p10={q(.1):+.3f} p90={q(.9):+.3f} '
          f'median_abs={st.median([abs(x) for x in xs]):.3f} p95_abs={sorted(abs(x) for x in xs)[int(.95*(len(xs)-1))]:.3f} max_abs={max(abs(x) for x in xs):.3f}')

print('signals total', len(out), 'with market quote within 120s', len(used))
stats([float(o['off_mid']) for o in used], 'entry_mid - market_mid (signed, USD)')
stats([float(o['off_exec']) for o in used], 'exec-side offset (buy: ask-entry, sell: entry-bid), USD, +ve = market worse than entry')
big = [o for o in used if abs(float(o['off_mid'])) > 5]
print('signals with |entry_mid - market_mid| > 5 USD:', len(big))
for o in big[:20]:
    print('  ', o['msg_id'], o['date_utc'], o['direction'], 'entry', o['entry_mid'], 'mkt_mid', o['mkt_mid'], 'off', o['off_mid'])

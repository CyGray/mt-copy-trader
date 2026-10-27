"""Same-candle ambiguity over ALL signals (not only the 20-sample).
Same entry/exit rules as recon_demo.py, but lazy tick iteration stops at each trade's first event.
For the first event minute, a 1m bar 'contains both' when the bar's extremes touch SL and a TP.
usage: ambiguity_all.py RAWDIR DERIVED_DIR -> derived/ambiguity_all.csv and prints summary
"""
import sys, os, csv, datetime as dt, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import window_ticks
RAW, DER = sys.argv[1], sys.argv[2]
P = 1000.0; ENTRY_H = 2; HOR_H = 48
def ms_of(s): return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)
rows = list(csv.DictReader(open(os.path.join(DER, 'signals_a3.csv'), encoding='utf-8')))
rows.sort(key=lambda r: (r['date_utc'], r['msg_id']))
out = []
for s in rows:
    buy = s['direction'] == 'buy'
    lo = float(s['reparse_entry_low']); hi = float(s['reparse_entry_high'])
    sl = float(s['reparse_sl']) if s['reparse_sl'] else None
    tps = [float(x) for x in s['reparse_tps'].split(';') if x]
    t0 = ms_of(s['date_utc'])
    rec = dict(msg_id=s['msg_id'], date_utc=s['date_utc'], direction=s['direction'], n_tp=len(tps))
    if sl is None or not tps:
        rec['result'] = 'no_levels'; out.append(rec); continue
    fill = None
    for ts, b, a in window_ticks(RAW, t0, t0 + ENTRY_H * 3600000):
        if (buy and a / P <= hi) or ((not buy) and b / P >= lo):
            fill = (ts, b, a); break
    if fill is None:
        rec['result'] = 'no_entry_touch'; out.append(rec); continue
    fts = fill[0]; hz = fts + HOR_H * 3600000
    ev = None  # (ts, kind)
    cur_min = None; bl = bh = al = ah = None; mtouch = None; ambig_min = None
    minute_done = False
    bar_first = None
    for ts, b, a in window_ticks(RAW, fts + 1, hz):
        m = ts // 60000
        if cur_min is None or m != cur_min:
            # finish previous minute
            if cur_min is not None and bar_first is None and mtouch is not None:
                bar_first = mtouch
            cur_min = m; bl = bh = al = ah = None
            if bar_first is not None:
                break
        if bl is None:
            bl = bh = b; al = ah = a
        else:
            bl = min(bl, b); bh = max(bh, b); al = min(al, a); ah = max(ah, a)
        if buy:
            sl_t = sl is not None and bl / P <= sl
            tp_t = [k for k, tp in enumerate(tps) if bh / P >= tp]
        else:
            sl_t = sl is not None and ah / P >= sl
            tp_t = [k for k, tp in enumerate(tps) if al / P <= tp]
        if sl_t or tp_t:
            if mtouch is None:
                mtouch = dict(minute=m, sl=sl_t, tp=bool(tp_t))
            else:
                mtouch['sl'] = mtouch['sl'] or sl_t; mtouch['tp'] = mtouch['tp'] or bool(tp_t)
    # Determine first-touch minute and ambiguity
    if mtouch is None:
        rec['result'] = 'no_event_48h'
    else:
        both = mtouch['sl'] and mtouch['tp']
        rec['result'] = 'event'
        rec['first_event_minute'] = dt.datetime.fromtimestamp(mtouch['minute'] * 60, dt.timezone.utc).strftime('%Y-%m-%d %H:%M')
        rec['first_minute_sl_touch'] = int(mtouch['sl'])
        rec['first_minute_tp_touch'] = int(mtouch['tp'])
        rec['ambiguous_first_minute'] = int(both)
        rec['fill_minute_equals_event_minute'] = int(mtouch['minute'] == fts // 60000)
    out.append(rec)
keys = sorted(set(k for r in out for k in r))
with open(os.path.join(DER, 'ambiguity_all.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(out)
c = collections.Counter(r['result'] for r in out)
print('signals', len(out), dict(c))
ev = [r for r in out if r['result'] == 'event']
print('events with 1m-bar first-touch minute containing BOTH SL and TP:', sum(int(r['ambiguous_first_minute']) for r in ev), 'of', len(ev))
print('fill minute == first exit-touch minute (fill vs exit order not resolvable on 1m candles):', sum(int(r.get('fill_minute_equals_event_minute',0)) for r in ev), 'of', len(ev))
print('first-minute SL-only:', sum(1 for r in ev if r['first_minute_sl_touch']=='1' and r['first_minute_tp_touch']=='0'),
      ' TP-only:', sum(1 for r in ev if r['first_minute_sl_touch']=='0' and r['first_minute_tp_touch']=='1'))

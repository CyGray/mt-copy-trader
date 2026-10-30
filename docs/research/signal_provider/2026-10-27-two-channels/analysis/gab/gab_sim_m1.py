"""M1 bid/ask replay of GAB FX gold signals (Dukascopy daily candles). Same-minute SL/TP ties are scored
both ways: 'pess' (SL first) and 'opt' (TP first), giving a range. Read-only research."""
import json, os, lzma, struct, collections, datetime as dt
M1 = "/tmp/claude-1001/twochan/gab/m1"
LAT = 20; FILL_WINDOW = 4 * 3600; HORIZON = int(os.environ.get("HORIZON_H", "72")) * 3600
_days = {}
def day(d):
    if d in _days: return _days[d]
    out = {}
    ok = True
    for side in ('BID', 'ASK'):
        p = f"{M1}/{d.isoformat()}_{side}.bi5"
        if not os.path.exists(p):
            ok = os.path.exists(p + '.missing') or d.weekday() == 5; continue
        raw = open(p, 'rb').read()
        if not raw: continue
        base = int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp())
        for s, o, c, l, h, v in struct.iter_unpack('>5if', lzma.decompress(raw, format=lzma.FORMAT_ALONE)):
            if v == 0 and o == c == l == h: continue      # flat filler bar (no trading)
            out.setdefault(base + s, {})[side] = (o / 1e3, c / 1e3, l / 1e3, h / 1e3)
    _days[d] = (ok, out)
    return _days[d]

def bars(t0, t1):
    """Yield (minute_ts, bid(o,c,l,h), ask(o,c,l,h)) from the minute after t0; raise if a weekday file is absent."""
    d = dt.datetime.utcfromtimestamp(t0).date(); end = dt.datetime.utcfromtimestamp(t1).date()
    while d <= end:
        ok, rows = day(d)
        if not ok: raise LookupError(d)
        for ts in sorted(rows):
            if t0 <= ts < t1 and 'BID' in rows[ts] and 'ASK' in rows[ts]:
                yield ts, rows[ts]['BID'], rows[ts]['ASK']
        d += dt.timedelta(days=1)

def replay(r, model, tp, mode):
    buy = r['side'] == 'BUY'; sl = r['sl']
    start = r['date'] + LAT; start_bar = start - start % 60 + 60   # first full minute after the follower reacts
    entry = None; ambiguous = False; first = None
    try:
        for ts, B, A in bars(start_bar, start_bar + HORIZON):
            bo, bc, bl, bh = B; ao, ac, al, ah = A
            if first is None: first = (ts, bo, ao)
            fill_bar = False
            if entry is None:
                if model == 'market' or r['market_only']:
                    entry = ao if buy else bo; fill_bar = False
                else:
                    if ts - start > FILL_WINDOW: return dict(status='no_fill')
                    if buy:
                        if bl <= sl and al > r['entry_hi']: return dict(status='sl_before_fill')
                        if al <= r['entry_hi']: entry = min(r['entry_hi'], ao); fill_bar = ao > r['entry_hi']
                    else:
                        if ah >= sl and bh < r['entry_lo']: return dict(status='sl_before_fill')
                        if bh >= r['entry_lo']: entry = max(r['entry_lo'], bo); fill_bar = bo < r['entry_lo']
                    if entry is None: continue
                risk = (entry - sl) if buy else (sl - entry)
                if risk <= 0: return dict(status='beyond_sl_at_entry')
                # a broker rejects a TP that is already on the wrong side of the price: the follower misses the trade
                if (buy and tp <= (bo if model == 'market' or r['market_only'] else entry)) or \
                   (not buy and tp >= (ao if model == 'market' or r['market_only'] else entry)):
                    return dict(status='missed_tp_already_passed')
            hit_sl = (bl <= sl) if buy else (ah >= sl)
            hit_tp = (bh >= tp) if buy else (al <= tp)
            if hit_sl and hit_tp: ambiguous = True
            if fill_bar and (hit_sl or hit_tp): ambiguous = True
            if hit_sl and (not hit_tp or mode == 'pess'):
                return dict(status='sl', R=-1.0, t_exit=ts, entry=entry, risk=risk, amb=ambiguous, first=first)
            if hit_tp:
                g = (tp - entry) if buy else (entry - tp)
                return dict(status='tp', R=g / risk, t_exit=ts, entry=entry, risk=risk, amb=ambiguous, first=first)
    except LookupError as e:
        return dict(status='incomplete_data', missing=str(e))
    if entry is None: return dict(status='no_data' if first is None else 'no_fill')
    px = bc if buy else ac
    return dict(status='timeout', R=((px - entry) if buy else (entry - px)) / risk, t_exit=ts, entry=entry, risk=risk, amb=ambiguous, first=first)

def phase(r):
    d = dt.datetime.utcfromtimestamp(r['date'])
    if d >= dt.datetime(2026, 5, 1): return 'C_gabfx_may_oct'
    if d < dt.datetime(2026, 3, 6): return 'A_uncledin_feb_mar'
    return 'B_multi_feed_mar_apr'

if __name__ == '__main__':
    S = [r for r in json.load(open("/tmp/claude-1001/twochan/gab/study/signals.json"))
         if r['symbol'] == 'XAUUSD' and r['check'] == 'ok' and 'dup_of' not in r]
    out = []
    for r in S:
        rec = dict(id=r['id'], date=r['date'], side=r['side'], phase=phase(r), edit=r['edit'], market_only=r['market_only'],
                   entry_lo=r['entry_lo'], entry_hi=r['entry_hi'], sl=r['sl'], tps=r['tps'], fwd=r['fwd'])
        for model in ('market', 'level'):
            for name, idx in (('tp1', 0), ('tp2', 1), ('tplast', -1)):
                tp = r['tps'][min(idx, len(r['tps']) - 1)] if idx >= 0 else r['tps'][-1]
                for mode in ('pess', 'opt'):
                    rec[f'{model}_{name}_{mode}'] = replay(r, model, tp, mode)
        out.append(rec)
    json.dump(out, open("/tmp/claude-1001/twochan/gab/study/sim_m1.json", "w"))
    print("simulated", len(out), collections.Counter(o['market_tp1_pess']['status'] for o in out))

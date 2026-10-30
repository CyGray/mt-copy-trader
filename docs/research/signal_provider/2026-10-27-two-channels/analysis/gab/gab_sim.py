"""Tick replay of GAB FX gold signals (Dukascopy bid/ask). Read-only research."""
import json, sys, os, re, collections, statistics as st, datetime as dt
sys.path.insert(0, "/home/kyle/agent-worktrees/ByTrader/task-20261027-021048-d8322860/docs/research/signal_provider/2026-10-27-two-channels/analysis/a3")
from dukas_lib import window_ticks, hour_path
RAW = "/tmp/claude-1001/twochan/gold/raw"
LAT = 20_000          # ms from post to follower order
FILL_WINDOW = 4 * 3600_000
HORIZON = int(os.environ.get("HORIZON_H", "72")) * 3600_000
DIV = 1000.0

def covered_until(t0, t1):
    """End (ms) of the contiguous span from t0 that has a downloaded/empty/missing marker for every hour."""
    h = t0 - t0 % 3600_000
    while h < t1:
        p = hour_path(RAW, dt.datetime.utcfromtimestamp(h / 1000))
        if not (os.path.exists(p) or os.path.exists(p + '.empty') or os.path.exists(p + '.missing')):
            return h
        h += 3600_000
    return t1

def replay(r, model, tp_idx):
    t0 = r['date'] * 1000 + LAT
    buy = r['side'] == 'BUY'
    tps = r['tps']; tp = tps[min(tp_idx, len(tps) - 1)] if tp_idx >= 0 else tps[-1]
    sl = r['sl']; entry = None; fill_t = None; first = None
    end = covered_until(t0, t0 + HORIZON)
    for ts, b, a in window_ticks(RAW, t0, end):
        bid, ask = b / DIV, a / DIV
        if first is None: first = (ts, bid, ask)
        if entry is None:
            if model == 'market' or r['market_only']:
                entry, fill_t = (ask if buy else bid), ts
            else:
                if ts - t0 > FILL_WINDOW: return dict(status='no_fill', first=first)
                if (buy and bid <= sl) or (not buy and ask >= sl): return dict(status='sl_before_fill', first=first)
                if buy and ask <= r['entry_hi']: entry, fill_t = ask, ts
                elif not buy and bid >= r['entry_lo']: entry, fill_t = bid, ts
            if entry is None: continue
            risk = (entry - sl) if buy else (sl - entry)
            if risk <= 0: return dict(status='beyond_sl_at_entry', first=first, entry=entry)
        px = bid if buy else ask
        if (buy and px <= sl) or (not buy and px >= sl):
            return dict(status='sl', R=-1.0 + 0 * risk, entry=entry, exit=sl, t_exit=ts, fill_t=fill_t, first=first, risk=risk,
                        R_exact=((px - entry) if buy else (entry - px)) / risk)
        if (buy and px >= tp) or (not buy and px <= tp):
            g = (tp - entry) if buy else (entry - tp)
            return dict(status='tp', R=g / risk, entry=entry, exit=tp, t_exit=ts, fill_t=fill_t, first=first, risk=risk)
    if end < t0 + HORIZON: return dict(status='incomplete_data', first=first)
    if first is None: return dict(status='no_data')
    if entry is None: return dict(status='no_fill', first=first)
    px = bid if buy else ask
    g = (px - entry) if buy else (entry - px)
    return dict(status='timeout', R=g / risk, entry=entry, exit=px, t_exit=ts, fill_t=fill_t, first=first, risk=risk)

def phase(r):
    d = dt.datetime.utcfromtimestamp(r['date'])
    if r['first'].lower().startswith(('gold buy now instant', 'gold sell now instant')) or (d >= dt.datetime(2026, 5, 1)):
        return 'C_gabfx_may_oct'
    if d < dt.datetime(2026, 3, 6): return 'A_uncledin_feb_mar'
    return 'B_multi_feed_mar_apr'

if __name__ == '__main__':
    S = [r for r in json.load(open("/tmp/claude-1001/twochan/gab/study/signals.json"))
         if r['symbol'] == 'XAUUSD' and r['check'] == 'ok' and 'dup_of' not in r]
    out = []
    for r in S:
        rec = dict(id=r['id'], date=r['date'], side=r['side'], phase=phase(r), edit=r['edit'], market_only=r['market_only'],
                   entry_lo=r['entry_lo'], entry_hi=r['entry_hi'], sl=r['sl'], tps=r['tps'])
        for model in ('market', 'level'):
            for name, idx in (('tp1', 0), ('tp2', 1), ('tplast', -1)):
                rec[f'{model}_{name}'] = replay(r, model, idx)
        out.append(rec)
    json.dump(out, open("/tmp/claude-1001/twochan/gab/study/sim.json", "w"))
    print("simulated", len(out), collections.Counter(o['market_tp1']['status'] for o in out))

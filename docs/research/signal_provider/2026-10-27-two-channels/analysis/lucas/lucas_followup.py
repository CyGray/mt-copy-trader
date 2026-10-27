"""Claims audit and provider-managed simulation for LUCAS GOLD LEGEND (descriptive, Modeled; 2026-10-27).

usage: lucas_followup.py REVISIONS_JSON RAWDIR OUT_JSON [--latency 10] [--end 2026-10-27T07:00:00Z]

1. Claims audit. Every "Entry X -> Y = +N pips" line in every management/completed revision and every recap claim:
   arithmetic (N vs |Y-X| / 0.10), whether the claimed price Y had traded (BUY: bid >= Y; SELL: ask <= Y) at or before
   the revision's time, whether entry X was fillable (BUY: ask <= X; SELL: bid >= X) between the signal and that time,
   and the best price actually reached by then.
2. Provider-managed simulation ("follow every instruction as it appears"):
   - one limit layer per whole price in the zone (e.g. 3990, 3991, 3992), equal size, placed at signal time + latency,
     valid 60 min; BUY fills when ask <= level, SELL when bid >= level;
   - the stop of open layers = the signal's stop in force (revision edits apply from their time + latency);
   - each management revision at its time + latency: close the named "bad entries" (market), move the stop,
     "close 1/2" closes half of what remains (once); later revisions repeat earlier instructions, which are idempotent;
   - stops are checked on every tick (BUY bid <= stop, SELL ask >= stop) and fill at the tick price;
   - optional "swing/trail" advice is ignored; anything open at the end is marked to market (flag UNRESOLVED).
   The same signals at the posted levels (E2 pending_at_range, single exits) are in the pilot outputs for comparison.
"""
import bisect, datetime as dt, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(os.path.dirname(HERE), 'a3')]
import lucas_grammar as g  # noqa: E402
import dukas_lib as dl  # noqa: E402

rev_path, raw, out_path = sys.argv[1:4]
LAT = float(sys.argv[sys.argv.index('--latency') + 1]) * 1000 if '--latency' in sys.argv else 10_000
END = sys.argv[sys.argv.index('--end') + 1] if '--end' in sys.argv else '2026-10-27T07:00:00Z'
PENDING = sys.argv[sys.argv.index('--pending') + 1] if '--pending' in sys.argv else 'keep'   # keep | cancel_unnamed
STOPS = sys.argv[sys.argv.index('--stops') + 1] if '--stops' in sys.argv else 'global'     # global | per_layer
ms = lambda s: int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)  # noqa: E731
hhmmss = lambda t: dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).strftime('%H:%M:%S')  # noqa: E731
PIP = 0.10

rows = json.load(open(rev_path))
evs = []
for r in rows:
    t = ms(r.get('edit_date') or r['date'])
    for e in g.parse(r.get('text')):
        if e['type'] != 'other':
            evs.append(dict(e, t=t, mid=int(r['message_id']), reply_to=(r.get('debug') or {}).get('reply_to_msg_id')))
evs.sort(key=lambda e: (e['t'], e['mid']))
sig_first = {}
for e in evs:
    if e['type'] == 'signal' and e['label'] not in sig_first:
        sig_first[e['label']] = e
t0 = min(e['t'] for e in sig_first.values()) - 60_000
t_end = ms(END)
TS, BID, ASK = [], [], []
for ts, b, a in dl.window_ticks(raw, t0, t_end):
    TS.append(ts); BID.append(b / 1000.0); ASK.append(a / 1000.0)
print('ticks', len(TS), 'from', hhmmss(TS[0]), 'to', dt.datetime.fromtimestamp(TS[-1] / 1000, dt.timezone.utc).isoformat())

def idx(t):
    return bisect.bisect_left(TS, t)

# ---------------------------------------------------------------- 1. claims audit
def audit_claim(direction, sig, entry, price, pips, t):
    i0, i1 = idx(sig['t']), idx(t + 1)
    if i1 <= i0:
        return None
    buy = direction == 'buy'
    fills = [k for k in range(i0, i1) if ((ASK[k] <= entry) if buy else (BID[k] >= entry))]
    fillable = bool(fills)
    j0 = fills[0] if fills else i1                      # everything is counted from the first possible fill
    reached = any((BID[k] >= price) if buy else (ASK[k] <= price) for k in range(j0, i1)) if price else None
    if j0 >= i1:
        return dict(direction=direction, entry=entry, claimed_price=price, claimed_pips=pips, at=hhmmss(t), arith_pips=None,
                    arith_ok=None, price_reached_by_then=False if price else None, entry_fillable_by_then=False,
                    best_price_by_then=None, best_pips_by_then=None)
    best = max(BID[j0:i1]) if buy else min(ASK[j0:i1])
    arith = round(abs(price - entry) / PIP) if price else None
    return dict(direction=direction, entry=entry, claimed_price=price, claimed_pips=pips, at=hhmmss(t),
                arith_pips=arith, arith_ok=(arith == pips) if price else None, price_reached_by_then=reached,
                entry_fillable_by_then=fillable, best_price_by_then=round(best, 3),
                best_pips_by_then=round(((best - entry) if buy else (entry - best)) / PIP, 1))

claims = []
for e in evs:
    if e['type'] in ('management', 'completed'):
        sig = sig_first[e['label']]
        for (x, y, n) in e['perf']:
            c = audit_claim(sig['direction'], sig, x, y, n, e['t'])
            if c: claims.append(dict(c, label=e['label'], mid=e['mid']))
    elif e['type'] == 'recap_claim':
        for (d, x, y, n) in e['claims']:
            sig = next(s for s in sig_first.values() if s['direction'] == d)
            c = audit_claim(d, sig, x, y if y else None, n, e['t'])
            if c: claims.append(dict(c, label=sig['label'], mid=e['mid'], recap=True))
# dedupe identical claims repeated in successive revisions (keep the first time each distinct claim appeared)
seen, uniq = set(), []
for c in claims:
    k = (c['label'], c['entry'], c['claimed_price'], c['claimed_pips'])
    if k not in seen:
        seen.add(k); uniq.append(c)

# ---------------------------------------------------------------- 2. provider-managed simulation
def simulate(label):
    s0 = sig_first[label]
    buy = s0['direction'] == 'buy'
    levels = [float(v) for v in range(int(round(s0['lo'])), int(round(s0['hi'])) + 1)]
    layers = {L: dict(level=L, size=1.0 / len(levels), state='pending', fill_ms=None, exit=None, exit_ms=None, why=None,
                      stop=s0['sl']) for L in levels}
    place = s0['t'] + LAT
    expiry = place + 60 * 60_000
    sig_revs = [e for e in evs if e['type'] == 'signal' and e['label'] == label]
    mg = [e for e in evs if e['type'] in ('management', 'completed') and e['label'] == label]
    if label == 4:
        mg += [e for e in evs if e['type'] == 'breakeven']
    acts = sorted([(e['t'] + LAT, 'sig', e) for e in sig_revs] + [(e['t'] + LAT, 'mgmt', e) for e in mg],
                  key=lambda x: x[0])
    stop = s0['sl']; half_done = False; log = []; ai = 0
    first_stop = s0['sl']
    def close(L, k, why):
        px = BID[k] if buy else ASK[k]
        L.update(state='closed', exit=px, exit_ms=TS[k], why=why)
    for k in range(idx(place), len(TS)):
        t = TS[k]
        while ai < len(acts) and acts[ai][0] <= t:
            _, kind, e = acts[ai]; ai += 1
            if kind == 'sig':
                if e['sl'] != stop and not any(x.get('why') == 'moved' for x in log):
                    log.append(dict(at=hhmmss(t), act=f"signal stop revised {stop} -> {e['sl']}", why='sig'))
                    for L in layers.values():
                        if L['stop'] == stop: L['stop'] = e['sl']
                    stop = e['sl']
                continue
            if e['type'] == 'breakeven':
                continue
            if PENDING == 'cancel_unnamed' and e.get('keep_level') is not None:
                for L in layers.values():
                    if L['state'] == 'pending' and L['level'] != e['keep_level'] and L['level'] not in e.get('close_levels', []):
                        L['state'] = 'cancelled'; log.append(dict(at=hhmmss(t), act=f"cancel pending layer {L['level']} (not named)"))
            for lv in e.get('close_levels', []):
                L = layers.get(lv)
                if L and L['state'] == 'open':
                    close(L, k, 'close_bad_entry'); log.append(dict(at=hhmmss(t), act=f'close layer {lv} at {L["exit"]:.3f}'))
                elif L and L['state'] == 'pending':
                    L['state'] = 'cancelled'; log.append(dict(at=hhmmss(t), act=f'cancel pending layer {lv}'))
            if e.get('move_sl') is not None:
                targets = [L for L in layers.values() if L['state'] in ('open', 'pending')]
                if STOPS == 'per_layer' and e.get('keep_level') is not None:
                    targets = [L for L in targets if L['level'] == e['keep_level']]
                ch = [L for L in targets if L['stop'] != e['move_sl']]
                for L in ch: L['stop'] = e['move_sl']
                if ch: log.append(dict(at=hhmmss(t), act=f"move stop -> {e['move_sl']} on layers {[L['level'] for L in ch]}", why='moved'))
                stop = e['move_sl'] if STOPS == 'global' else stop
            if e.get('close_half') and not half_done:
                half_done = True
                for L in [L for L in layers.values() if L['state'] == 'open']:
                    vol = L['size'] / 2
                    part = dict(L, size=vol, state='closed', exit=BID[k] if buy else ASK[k], exit_ms=t, why='close_half')
                    L['size'] -= vol
                    layers[f'{L["level"]}_half'] = part
                    log.append(dict(at=hhmmss(t), act=f'close half of layer {L["level"]} ({vol:.3f} lot) at {part["exit"]:.3f}'))
        for L in list(layers.values()):
            if L['state'] == 'pending':
                if t > expiry:
                    L['state'] = 'expired'
                elif (ASK[k] <= L['level']) if buy else (BID[k] >= L['level']):
                    L.update(state='open', fill_ms=t)
                    log.append(dict(at=hhmmss(t), act=f'fill layer {L["level"]}'))
            elif L['state'] == 'open' and L['fill_ms'] < t:
                if (BID[k] <= L['stop']) if buy else (ASK[k] >= L['stop']):
                    close(L, k, 'stop'); log.append(dict(at=hhmmss(t), act=f'stop {L["stop"]} hit, layer {L["level"]} out at {L["exit"]:.3f}'))
        if all(L['state'] not in ('pending', 'open') for L in layers.values()) and t > expiry:
            break
    for L in layers.values():
        if L['state'] == 'open':
            L.update(state='closed', exit=BID[-1] if buy else ASK[-1], exit_ms=TS[-1], why='UNRESOLVED_mark_to_market')
    sign = 1 if buy else -1
    filled = [L for L in layers.values() if L['fill_ms']]
    usd = sum(sign * (L['exit'] - L['level']) * L['size'] * 100 for L in filled)     # per 1.0 lot total plan
    size0 = 1.0 / len(levels)                               # plan risk: every layer at its original size
    risk_first = sum(abs(lv - first_stop) * size0 * 100 for lv in levels)
    risk_final = sum(abs(lv - sig_revs[-1]['sl']) * size0 * 100 for lv in levels)
    return dict(label=label, direction=s0['direction'], layers=[dict(level=L['level'], size=round(L['size'], 4), state=L['state'], exit=None if L['exit'] is None else round(L['exit'], 3), why=L['why']) for L in layers.values()],
                pnl_usd_per_1lot_plan=round(usd, 2), R_vs_final_stop=round(usd / risk_final, 3), R_vs_first_stop=round(usd / risk_first, 3),
                log=log)

sims = [simulate(l) for l in sorted(sig_first)]
out = dict(latency_ms=LAT, end=END, pending_policy=PENDING, stops_policy=STOPS, claims=uniq,
           claims_summary=dict(n=len(uniq), arith_ok=sum(1 for c in uniq if c['arith_ok']), arith_checked=sum(1 for c in uniq if c['arith_ok'] is not None),
                               price_reached=sum(1 for c in uniq if c['price_reached_by_then']), price_checked=sum(1 for c in uniq if c['price_reached_by_then'] is not None),
                               entry_fillable=sum(1 for c in uniq if c['entry_fillable_by_then'])),
           provider_managed=sims)
json.dump(out, open(out_path, 'w'), indent=1)
print(json.dumps(out['claims_summary']))
for c in uniq:
    print(c['label'], c['at'], c['direction'], c['entry'], '->', c['claimed_price'], c['claimed_pips'], '| arith', c['arith_pips'], '| reached', c['price_reached_by_then'], '| entry fillable', c['entry_fillable_by_then'], '| best', c['best_price_by_then'], f"({c['best_pips_by_then']} pips)")
for s in sims:
    print('SIM', s['label'], s['direction'], 'USD/1lot', s['pnl_usd_per_1lot_plan'], 'R(final stop)', s['R_vs_final_stop'], 'R(first stop)', s['R_vs_first_stop'])
    for L in s['layers']: print('   ', L)
    for x in s['log']: print('   ', x['at'], x['act'])

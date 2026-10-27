"""Auditor's own entry-model and trade simulator for the LUCAS pilot (written from the spec).

Conventions (from the b1/b2 README and REPORT, the pre-registration and the skill):
- extra spread E (total): ask' = ask + E/2 ; bid' = bid - E/2. BUY enters/stops on Ask'/Bid' as
  ask'/bid' respectively; SELL the mirror image. Exits use the opposite side.
- Entry decision at the first tick at or after signal time + latency (BASE 5 s, MID 10 s, PESS 15 s).
- E1 (market): inside [lo - 2.0, hi + 2.0] at the decision tick, fill at price +/- slippage; else skip.
  Then project stop check 2.0 <= |fill - SL| <= 25.0 and the 1.5 x nominal guard (|mid - SL|).
- E2 (pending_at_range): market if inside [lo - 0.5, hi + 0.5] (same fill rule). Else a limit at the
  unfavourable edge (BUY at hi, SELL at lo), valid 60 min from the decision tick; fills when Ask' <= limit
  (BUY) or Bid' >= limit (SELL), at limit +/- adverse slippage.
- E3 (strict, report only): market inside [lo - 0.5, hi + 0.5], else skip.
- Exits start at the tick after the fill. Per tick: stop first (BUY: Bid' <= SL fills at min(Bid', SL) - slip;
  SELL: Ask' >= SL fills at max(Ask', SL) + slip), then TP checkpoints in index order (BUY Bid' >= TP,
  SELL Ask' <= TP, filled at the TP price, no slippage). Management moves effective from the next tick.
- R = |fill - SL| (signal stop, fill price). total_R = sum(fraction x signed move) / R. usd_per_1lot =
  sum(fraction x signed move) x 100 oz.
- Single-exit variant with a missing TP: SKIPPED_tp_missing. Multi: missing shares fold into the last
  existing checkpoint.
- Horizon 72 h from fill; never use ticks at or after known_until (first missing hour).
"""
import bisect
from fractions import Fraction as Fr

HORIZON_MS = 72 * 3_600_000
COST = {'BASE': dict(spread=0, slip=0, lat_ms=5_000),
        'MID': dict(spread=100, slip=50, lat_ms=10_000),
        'PESS': dict(spread=200, slip=100, lat_ms=15_000)}
ENT = {'E1': dict(policy='market', tol=2000, guard=True),
       'E2': dict(policy='pending', tol=500, guard=False, expiry_ms=60 * 60_000),
       'E3': dict(policy='market', tol=500, guard=False)}
STRATS = [
    ('S_TP1|M0', [(1, Fr(1))], 'M0'),
    ('S_TP2|M0', [(2, Fr(1))], 'M0'),
    ('S_TP3|M0', [(3, Fr(1))], 'M0'),
    ('S_TP4|M0', [(4, Fr(1))], 'M0'),
    ('S_TP4|M5', [(4, Fr(1))], 'M5'),
    ('Q_25x4|M0', [(1, Fr(1, 4)), (2, Fr(1, 4)), (3, Fr(1, 4)), (4, Fr(1, 4))], 'M0'),
    ('Q_25x4|M3', [(1, Fr(1, 4)), (2, Fr(1, 4)), (3, Fr(1, 4)), (4, Fr(1, 4))], 'M3'),
    ('D13_50_50|M1', [(1, Fr(1, 2)), (3, Fr(1, 2))], 'M1'),
]
BE_PRICE_MILLI = 4000     # M5 break-even trigger: +4.0 USD price distance, buffer 0
CONTRACT_OZ = 100


class Sim:
    def __init__(self, ticks, opts=None):
        self.t, self.ask, self.bid = ticks.t, ticks.ask, ticks.bid
        self.known = ticks.known_until
        self.n = len(self.t)
        self.opts = opts or {}

    def first_idx_at_or_after(self, ms):
        return bisect.bisect_left(self.t, ms)

    def _market_fill(self, buy, p, slip, i):
        return {'status': 'FILLED', 'fill_ms': self.t[i], 'fill_px': p + slip if buy else p - slip,
                'kind': 'buy' if buy else 'sell'}

    def fill_for(self, s, sig_ms, entry, cost):
        c, e = COST[cost], ENT[entry]
        half, slip = c['spread'] // 2, c['slip']
        buy = s['direction'] == 'buy'
        lo, hi = s['lo'], s['hi']
        out = {'entry': entry, 'cost': cost, 'status': None, 'reason': '', 'fill_ms': None,
               'fill_px': None, 'kind': '', 'decision_ms': None, 'pending_limit': None}
        i = self.first_idx_at_or_after(sig_ms + c['lat_ms'])
        if i >= self.n or self.t[i] >= self.known:
            out.update(status='NO_PRICE_DATA', reason='no_price_data')
            return out
        out['decision_ms'] = self.t[i]
        p = (self.ask[i] + half) if buy else (self.bid[i] - half)
        inside = (lo - e['tol']) <= p <= (hi + e['tol'])
        if e['policy'] == 'market' or inside:
            if not inside:
                out.update(status='SKIPPED_price_outside_range', reason='price_outside_range')
                return out
            out.update(self._market_fill(buy, p, slip, i))
            return out
        # E2 pending at the unfavourable edge
        limit = hi if buy else lo
        out['pending_limit'] = limit
        expiry = self.t[i] + e['expiry_ms']
        j = i + (1 if self.opts.get('pending_from_next_tick') else 0)
        while True:
            if j >= self.n or self.t[j] >= self.known:
                break
            if self.t[j] > expiry:
                break
            q = (self.ask[j] + half) if buy else (self.bid[j] - half)
            touched = (q <= limit) if buy else (q >= limit)
            if self.opts.get('strict_pending'):
                touched = (q < limit) if buy else (q > limit)
            if touched:
                out.update(status='FILLED', fill_ms=self.t[j],
                           fill_px=limit + slip if buy else limit - slip,
                           kind='buy_limit' if buy else 'sell_limit')
                return out
            j += 1
        if j < self.n and self.t[j] <= expiry and self.t[j] >= self.known:
            out.update(status='NO_PRICE_DATA', reason='no_price_data')   # data ends before expiry
        elif expiry < self.known:
            out.update(status='SKIPPED_pending_expired', reason='pending_expired')
        else:
            out.update(status='NO_PRICE_DATA', reason='no_price_data')
        return out

    def guard(self, s, fill_px, entry):
        dist = abs(fill_px - s['sl'])
        if not (2000 <= dist <= 25000):
            return 'SKIPPED_sl_distance'
        if ENT[entry]['guard'] and dist > Fr(3, 2) * abs(s['mid'] - s['sl']):
            return 'SKIPPED_nominal_guard'
        return None

    def manage(self, s, fill_ms, fill_px, cost, checkpoints, mgmt, tps):
        """Tick-by-tick exits. checkpoints: [(tp_index, fraction)] after folding. Returns exits and status."""
        c = COST[cost]
        half, slip = c['spread'] // 2, c['slip']
        buy = s['direction'] == 'buy'
        sl0 = s['sl']
        sl = sl0
        legs = {k: f for k, f in checkpoints}
        order = [k for k, _ in checkpoints]
        exits = []           # [label, ms, px, fraction] ; one stop record for all remaining legs
        be_armed = (mgmt == 'M5')
        same_tick_sl_tp = False
        horizon_end = fill_ms + HORIZON_MS
        j = self.first_idx_at_or_after(fill_ms + 1)
        status = None
        while True:
            if j >= self.n or self.t[j] >= self.known:
                status = 'NO_PRICE_DATA'
                break
            if self.t[j] > horizon_end:
                status = 'UNRESOLVED_MTM'
                break
            bp, ap = self.bid[j] - half, self.ask[j] + half
            strict_stop = self.opts.get('strict_stop', False)
            strict_tp = self.opts.get('strict_tp', False)
            if buy:
                stop_hit = (bp < sl) if strict_stop else (bp <= sl)
                tp_hit = lambda tp: (bp > tp) if strict_tp else (bp >= tp)  # noqa: E731
            else:
                stop_hit = (ap > sl) if strict_stop else (ap >= sl)
                tp_hit = lambda tp: (ap < tp) if strict_tp else (ap <= tp)  # noqa: E731
            tp_now = [k for k in order if k in legs and tp_hit(tps[k - 1])]
            if stop_hit:
                if tp_now:
                    same_tick_sl_tp = True
                px = min(bp, sl) - slip if buy else max(ap, sl) + slip
                label = 'SL' if sl == sl0 else ('BE' if sl == fill_px else 'SL_PREV_TP')
                frac = sum(legs.values())
                exits.append([label, self.t[j], px, frac])
                legs = {}
                status = 'STOPPED'
                break
            for k in tp_now:
                frac = legs.pop(k)
                exits.append([f'TP{k}', self.t[j], tps[k - 1], frac])
                if (mgmt == 'M1' and k == 1) or (mgmt == 'M3' and k == 2):
                    if legs:
                        # SL to entry (buffer 0), effective from the next tick; 'sl_to_mid' = sensitivity only
                        sl = s['mid'] if self.opts.get('sl_to_mid') else fill_px
            if not legs:
                status = 'TP_COMPLETE'
                break
            if be_armed and not tp_now:
                if (buy and bp >= fill_px + BE_PRICE_MILLI) or ((not buy) and ap <= fill_px - BE_PRICE_MILLI):
                    sl = fill_px
                    be_armed = False
            j += 1
        if status == 'UNRESOLVED_MTM':
            # mark the open legs to the last tick before the horizon, exit side, no slippage
            last = self.first_idx_at_or_after(horizon_end + 1) - 1
            bpm, apm = self.bid[last] - half, self.ask[last] + half
            px = bpm if buy else apm
            exits.append(['MTM', self.t[last], px, sum(legs.values())])
            legs = {}
        return {'exits': exits, 'status': status, 'same_tick_sl_tp': same_tick_sl_tp}


def build_checkpoints(spec, present_ks):
    """Fold missing checkpoint shares into the last existing checkpoint. Returns (cps, folded_ks) or None."""
    if len(spec) == 1:
        k, f = spec[0]
        return ([(k, f)], []) if k in present_ks else None
    cps = [(k, f) for k, f in spec if k in present_ks]
    folded = [k for k, _ in spec if k not in present_ks]
    if not cps:
        return None
    missing = sum((f for k, f in spec if k not in present_ks), Fr(0))
    if missing:
        k_last, f_last = cps[-1]
        cps[-1] = (k_last, f_last + missing)
    return cps, folded


def simulate_trade(sim, s, fill, name, spec, mgmt, cost):
    buy = s['direction'] == 'buy'
    sgn = 1 if buy else -1
    fill_px, fill_ms = fill['fill_px'], fill['fill_ms']
    R = abs(fill_px - s['sl'])
    row = {'strategy': name, 'status': None, 'reason': '', 'fill_ms': fill_ms, 'fill_px': fill_px,
           'R_usd': R / 1000, 'total_R': None, 'usd_per_1lot': None, 'last_exit_ms': None,
           'final_exit': None, 'exit_seq': None, 'tp_ks': None, 'tp_exec': '', 'flags': ''}
    present = {k for k in range(1, 8) if k - 1 < len(s['tps'])}
    built = build_checkpoints(spec, present)
    if built is None:
        row.update(status='SKIPPED_tp_missing', reason='tp_missing')
        return row
    cps, folded = built
    row['tp_ks'] = '|'.join(str(k) for k, _ in cps)
    if folded:
        row['flags'] = 'tp_missing_folded:' + ','.join(str(k) for k in folded)
    res = sim.manage(s, fill_ms, fill_px, cost, cps, mgmt, s['tps'])
    row['same_tick_sl_tp'] = res['same_tick_sl_tp']
    if res['status'] in ('NO_PRICE_DATA',):
        row.update(status='NO_PRICE_DATA', reason='no_price_data')
        return row
    total = Fr(0)
    usd_num = Fr(0)
    for label, ms, px, frac in res['exits']:
        move = sgn * (px - fill_px)           # milli-USD, favourable positive
        total += frac * Fr(move, R)
        usd_num += frac * move
    row['status'] = 'FILLED' if res['status'] != 'UNRESOLVED_MTM' else 'UNRESOLVED_MTM'
    row['total_R'] = float(total)
    row['usd_per_1lot'] = float(usd_num * CONTRACT_OZ / 1000)
    row['last_exit_ms'] = res['exits'][-1][1]
    row['final_exit'] = 'TP_COMPLETE' if res['status'] == 'TP_COMPLETE' else res['exits'][-1][0]
    row['exit_seq'] = '>'.join(e[0] for e in res['exits'])
    row['tp_exec'] = '|'.join(e[0][2:] for e in res['exits'] if e[0].startswith('TP'))
    return row


def run_signal(sim, s, sig_ms, opts=None):
    """All entry models x costs for one signal. Returns (fills, trades) dicts keyed as in the pilot."""
    fills, trades = {}, {}
    for entry in ('E1', 'E2', 'E3'):
        for cost in ('BASE', 'MID', 'PESS'):
            f = sim.fill_for(s, sig_ms, entry, cost)
            if f['status'] == 'FILLED':
                g = sim.guard(s, f['fill_px'], entry)
                if g:
                    f.update(status=g, reason=g.replace('SKIPPED_', ''), fill_ms=None, fill_px=None, kind=f['kind'])
            fills[(entry, cost)] = f
            if f['status'] == 'FILLED':
                for name, spec, mgmt in STRATS:
                    trades[(entry, cost, name)] = simulate_trade(sim, s, f, name, spec, mgmt, cost)
    return fills, trades

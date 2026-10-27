#!/usr/bin/env python3
"""B3 risk model: a line-by-line Python port of worker/src/lib/positionSizing.ts
(computeVolume, planCheckpoints, roundVolumeDown, volumeDecimals, riskPerLot) plus a
read-only equity-path simulator that applies the entry gates of mt5TradeEngine.ts in the
same order. Pure functions; no I/O, no network, no broker, no repo writes.

Account specs are NOT verified for Vantage. Every default in SPEC_UNVERIFIED and in the
safety sets is either copied from repo code (labelled) or an UNVERIFIED assumption.
Run tests: nice -n 10 python3 -I test_risk_model.py
"""
import math
from decimal import Decimal, ROUND_HALF_UP

EPS = 1e-9

# ---- Verified from repo code (worker/src/lib/executionProfile.ts) -------------------------
HARD_CEILINGS = {  # outer bound; a safety value above these is invalid in code
    'max_risk_percent_per_trade': 5, 'max_risk_money_per_trade': 5000, 'max_lots_per_trade': 20,
    'max_concurrent_positions': 20, 'max_positions_per_symbol': 10, 'daily_loss_limit_money': 20000,
    'max_total_risk_percent': 20, 'max_spread_price': 10, 'max_deviation_points': 500,
    'max_signal_age_sec': 3600, 'min_margin_level_percent': 10000,
}
DEFAULT_SAFETY = {  # baseline policy (used only when settings.safety is absent)
    'max_risk_percent_per_trade': 1, 'max_risk_money_per_trade': 50, 'max_lots_per_trade': 1,
    'max_concurrent_positions': 3, 'max_positions_per_symbol': 1, 'daily_loss_limit_money': 100,
    'max_total_risk_percent': 3, 'max_spread_price': 0.5, 'max_deviation_points': 30,
    'max_signal_age_sec': 120, 'min_margin_level_percent': 200,
}
# Outer-bound safety: hard ceilings for every axis that has a ceiling; margin floor kept at 200
# (the 10000 ceiling is a maximum allowed floor, not a sensible operating value).
HARD_SAFETY = dict(HARD_CEILINGS, min_margin_level_percent=200)

# ---- UNVERIFIED for Vantage XAUUSD. Parameters only; see VERIFY checklist in the report. ---
SPEC_UNVERIFIED = {
    'tickSize': 0.01, 'tickValueLoss': 1.0,  # => 100 USD per 1.00 price move per 1.0 lot (contract 100 oz)
    'volumeMin': 0.01, 'volumeMax': 100.0, 'volumeStep': 0.01,
}


def to_fixed(x, digits):
    """JavaScript Number.prototype.toFixed semantics (exact binary value, ties away from zero)."""
    return float(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def volume_decimals(step):
    for d in range(0, 9):
        scaled = step * 10 ** d
        if abs(scaled - round(scaled)) < 1e-9:
            return d
    return 8


def round_volume_down(volume, step):
    units = math.floor(volume / step + EPS)
    return to_fixed(units * step, volume_decimals(step))


def risk_per_lot(distance, spec):
    return (abs(distance) / spec['tickSize']) * spec['tickValueLoss']


def _valid_spec(spec):
    def pos(v):
        return v is not None and math.isfinite(v) and v > 0
    return (pos(spec['tickSize']) and pos(spec['tickValueLoss']) and pos(spec['volumeMin'])
            and pos(spec['volumeMax']) and pos(spec['volumeStep']) and spec['volumeMax'] >= spec['volumeMin'])


def _fail(reason, detail=''):
    return {'ok': False, 'reason': reason, 'detail': detail}


def compute_volume_at_distance(sizing, distance, equity, spec, limits):
    """Sizing core. `distance` = |entry - stop| in price units (same as computeVolume)."""
    if not _valid_spec(spec):
        return _fail('invalid_symbol_spec')
    if not (math.isfinite(distance) and distance > 0):
        return _fail('invalid_stop_distance')
    if not (equity is not None and math.isfinite(equity) and equity > 0):
        return _fail('invalid_equity')
    per_lot = risk_per_lot(distance, spec)
    cap = min(limits['maxRiskMoney'], (equity * limits['maxRiskPercent']) / 100)
    max_volume = min(spec['volumeMax'], limits['maxLots'])
    step = spec['volumeStep']
    clamped = None
    mode = sizing['mode']
    if mode == 'fixed_lots':
        lots = sizing.get('fixed_lots')
        if not (lots is not None and math.isfinite(lots) and lots > 0):
            return _fail('missing_sizing_value')
        units = lots / step
        if abs(units - round(units)) > EPS:
            return _fail('volume_not_step_aligned')
        volume = round_volume_down(lots, step)
        if volume > max_volume + EPS:
            return _fail('volume_exceeds_max')
    else:
        if mode == 'fixed_risk_money':
            rm = sizing.get('risk_money')
            if not (rm is not None and math.isfinite(rm) and rm > 0):
                return _fail('missing_sizing_value')
            target = rm
        else:
            rp = sizing.get('risk_percent')
            if not (rp is not None and math.isfinite(rp) and rp > 0):
                return _fail('missing_sizing_value')
            target = (equity * rp) / 100
        volume = round_volume_down(min(target, cap) / per_lot, step)
        if volume > max_volume + EPS:
            volume = round_volume_down(max_volume, step)
            clamped = 'volume_max' if spec['volumeMax'] <= limits['maxLots'] else 'max_lots'
    if volume + EPS < spec['volumeMin']:
        can_use_min = (sizing.get('below_min_volume') == 'use_min_if_within_cap'
                       and spec['volumeMin'] <= max_volume + EPS
                       and per_lot * spec['volumeMin'] <= cap + EPS)
        if not can_use_min:
            return _fail('volume_below_min')
        volume = spec['volumeMin']
        clamped = None
    risk_money = volume * per_lot
    if risk_money > cap + EPS:
        return _fail('risk_exceeds_limit')
    out = {'ok': True, 'volume': volume, 'riskMoney': risk_money, 'riskPercent': (risk_money / equity) * 100,
           'cap': cap, 'perLot': per_lot}
    if clamped:
        out['clampedBy'] = clamped
    return out


def compute_volume(sizing, entry, stop, equity, spec, limits):
    if not _valid_spec(spec):
        return _fail('invalid_symbol_spec')
    distance = abs(entry - stop)
    if not (math.isfinite(distance) and distance > 0):
        return _fail('invalid_stop_distance')
    return compute_volume_at_distance(sizing, distance, equity, spec, limits)


def _split_volumes(total, pcts, step):
    dec = volume_decimals(step)
    closes, allocated = [], 0.0
    n = len(pcts)
    for k, pct in enumerate(pcts):
        if k == n - 1:
            close = to_fixed(total - allocated, dec)
        else:
            close = round_volume_down((total * pct) / 100, step)
        closes.append(close)
        allocated += close
    remaining, left = [], total
    for close in closes:
        left = to_fixed(left - close, dec)
        remaining.append(left)
    return closes, remaining


def _first_undersized(closes, remaining, vmin):
    for k in range(len(closes)):
        if closes[k] + EPS < vmin:
            return k
        if k < len(closes) - 1 and remaining[k] + EPS < vmin:
            return k
    return -1


def plan_checkpoints(total_volume, direction, entry, take_profits, tp_cfg, spec):
    """tp_cfg = {'checkpoints': [{'tp_index', 'close_percent'}], 'missing_tp', 'infeasible_split', 'broker_tp'}.
    take_profits: list of prices (index tp_index-1). Returns dict like the TS CheckpointPlanResult."""
    warnings = []
    candidates, missing = [], []
    for cp in tp_cfg['checkpoints']:
        idx = cp['tp_index']
        price = take_profits[idx - 1] if idx - 1 < len(take_profits) else None
        if price is None or not math.isfinite(price):
            missing.append(idx)
        else:
            candidates.append({'tpIndex': idx, 'price': price, 'percent': cp['close_percent']})
    if missing:
        if tp_cfg['missing_tp'] == 'skip_trade' or not candidates:
            return {'ok': False, 'reason': 'tp_missing'}
        folded = sum(cp['close_percent'] for cp in tp_cfg['checkpoints'] if cp['tp_index'] in missing)
        last = candidates[-1]
        last['percent'] += folded
        warnings.append('TP missing; %s%% merged into TP%d' % (folded, last['tpIndex']))
    for k, c in enumerate(candidates):
        beyond = c['price'] > entry if direction == 'buy' else c['price'] < entry
        if not beyond:
            return {'ok': False, 'reason': 'tp_order_invalid'}
        if k > 0:
            prev = candidates[k - 1]['price']
            mono = c['price'] > prev if direction == 'buy' else c['price'] < prev
            if not mono:
                return {'ok': False, 'reason': 'tp_order_invalid'}
    if not (math.isfinite(total_volume) and total_volume > 0) or total_volume + EPS < spec['volumeMin']:
        return {'ok': False, 'reason': 'tp_split_infeasible'}
    while True:
        closes, remaining = _split_volumes(total_volume, [c['percent'] for c in candidates], spec['volumeStep'])
        bad = _first_undersized(closes, remaining, spec['volumeMin'])
        if bad == -1:
            dec = volume_decimals(spec['volumeStep'])
            cps = []
            for k, c in enumerate(candidates):
                cps.append({'tpIndex': c['tpIndex'], 'price': c['price'], 'closePercent': c['percent'],
                            'closeVolume': closes[k],
                            'targetRemainingVolume': 0.0 if k == len(candidates) - 1 else to_fixed(remaining[k], dec)})
            final = candidates[-1]
            return {'ok': True, 'checkpoints': cps,
                    'brokerTp': final['price'] if tp_cfg['broker_tp'] == 'final_checkpoint' else 0.0,
                    'warnings': warnings}
        if tp_cfg['infeasible_split'] == 'skip_trade' or len(candidates) == 1:
            return {'ok': False, 'reason': 'tp_split_infeasible'}
        target = bad + 1 if bad < len(candidates) - 1 else bad - 1
        removed = candidates[bad]
        receiver = candidates[target]
        receiver['percent'] += removed['percent']
        candidates = [c for k, c in enumerate(candidates) if k != bad]
        warnings.append('TP%d split infeasible; merged %s%% into TP%d' % (removed['tpIndex'], removed['percent'], receiver['tpIndex']))


def plan_volume_split(total, pcts, spec, policy):
    """Volume-only split of `total` over checkpoint percents `pcts` (TP1..TPn in order).
    Returns (status, legs) where legs = [(orig_leg_index1, close_volume)] after any merge, and
    status in {'exact','merged','skipped'}. Uses plan_checkpoints with dummy ascending prices."""
    n = len(pcts)
    tp_cfg = {'checkpoints': [{'tp_index': i + 1, 'close_percent': p} for i, p in enumerate(pcts)],
              'missing_tp': 'skip_trade', 'infeasible_split': policy, 'broker_tp': 'none'}
    prices = [1.0 + i for i in range(n)]
    res = plan_checkpoints(total, 'buy', 0.0, prices, tp_cfg, spec)
    if not res['ok']:
        return 'skipped', []
    legs = [(c['tpIndex'], c['closeVolume']) for c in res['checkpoints']]
    if any(w for w in res['warnings']):
        return 'merged', legs
    return 'exact', legs


# ---- Safety-derived effective limits (mirrors effectiveLimits; profile limits assumed non-binding) ----
def effective_limits(safety):
    return {
        'maxRiskPercent': safety['max_risk_percent_per_trade'],
        'maxRiskMoney': safety['max_risk_money_per_trade'],
        'maxLots': safety['max_lots_per_trade'],
        'maxConcurrent': safety['max_concurrent_positions'],
        'maxPerSymbol': safety['max_positions_per_symbol'],
        'dailyLossLimit': safety['daily_loss_limit_money'],
        'maxTotalRiskPercent': safety['max_total_risk_percent'],
        'minMarginLevelPercent': safety['min_margin_level_percent'],
    }


def margin_per_lot(price, leverage, contract=100.0, factor=1.0):
    """Margin for 1.0 lot = contract * price / leverage * factor. factor=1 is an UNVERIFIED assumption."""
    return contract * price / leverage * factor


def run_path(trades, sizing, equity0, cfg, gates=True):
    """Chronological equity path with the engine's gate order (sizing -> split -> concurrency ->
    per-symbol -> daily realised loss -> total open risk -> post-trade margin level).
    trades: list of dicts with open_ms, close_ms, direction, entry_px, sd (sizing distance),
            legs: [(pct, move)] where move is signed USD/oz from entry at the leg's exit.
    cfg: spec, limits (effective), leverage, margin_factor, commission_rt (USD/lot round trip),
         adverse (USD/oz extra adverse fill, applied to every leg), infeasible_split.
    Equity used for sizing is CLOSED equity (floating P&L ignored: a stated simplification).
    """
    spec, lim = cfg['spec'], cfg['limits']
    contract = spec['tickValueLoss'] / spec['tickSize']
    open_pos, realised, curve = [], [], [(0, equity0)]
    equity = equity0
    skips, taken = {}, []

    def realise_until(t_ms):
        nonlocal equity
        open_pos.sort(key=lambda p: p['close_ms'])
        while open_pos and open_pos[0]['close_ms'] <= t_ms:
            p = open_pos.pop(0)
            equity += p['pnl']
            realised.append((p['close_ms'], p['pnl']))
            curve.append((p['close_ms'], equity))

    for tr in sorted(trades, key=lambda t: (t['open_ms'], t.get('id', ''))):
        realise_until(tr['open_ms'])
        res = compute_volume_at_distance(sizing, tr['sd'], equity, spec, lim)
        if not res['ok']:
            skips[res['reason']] = skips.get(res['reason'], 0) + 1
            continue
        L = res['volume']
        status, legs = plan_volume_split(L, [p for p, _ in tr['legs']], spec, cfg.get('infeasible_split', 'merge_into_next'))
        if status == 'skipped':
            skips['tp_split_infeasible'] = skips.get('tp_split_infeasible', 0) + 1
            continue
        new_risk = L * (tr['sd'] / spec['tickSize']) * spec['tickValueLoss']
        new_margin = margin_per_lot(tr['entry_px'], cfg['leverage'], contract, cfg.get('margin_factor', 1.0)) * L
        if gates:
            if len(open_pos) >= lim['maxConcurrent']:
                skips['max_concurrent_positions'] = skips.get('max_concurrent_positions', 0) + 1
                continue
            if len(open_pos) >= lim['maxPerSymbol']:
                skips['max_positions_per_symbol'] = skips.get('max_positions_per_symbol', 0) + 1
                continue
            day0 = (tr['open_ms'] // 86400000) * 86400000
            day_pnl = sum(p for t, p in realised if t >= day0)
            if -day_pnl >= lim['dailyLossLimit']:
                skips['daily_loss_limit'] = skips.get('daily_loss_limit', 0) + 1
                continue
            open_risk = sum(p['risk'] for p in open_pos)
            if open_risk + new_risk > (equity * lim['maxTotalRiskPercent']) / 100 + 1e-9:
                skips['total_risk_limit'] = skips.get('total_risk_limit', 0) + 1
                continue
            if lim['minMarginLevelPercent'] > 0:
                tot = sum(p['margin'] for p in open_pos) + new_margin
                if tot > 0 and (equity / tot) * 100 < lim['minMarginLevelPercent']:
                    skips['margin_level_too_low'] = skips.get('margin_level_too_low', 0) + 1
                    continue
        # P&L at close: lot-exact closes from the planner, move per leg; adverse fill and commission on total L.
        pnl = 0.0
        for (idx, vol) in legs:
            pnl += vol * tr['legs'][idx - 1][1]
        pnl = pnl * contract - cfg.get('adverse', 0.0) * contract * L - cfg.get('commission_rt', 0.0) * L
        rec = {'id': tr.get('id'), 'open_ms': tr['open_ms'], 'close_ms': tr['close_ms'], 'L': L,
               'risk': new_risk, 'margin': new_margin, 'pnl': pnl, 'status': status,
               'equity_at_open': equity, 'risk_pct_planned': 100 * new_risk / equity if equity > 0 else float('nan')}
        open_pos.append(rec)
        taken.append(rec)
    realise_until(float('inf'))
    return {'taken': taken, 'skips': skips, 'curve': curve, 'final_equity': equity}


def max_drawdown(curve):
    peak, mdd_usd, mdd_pct, peak_at_mdd = None, 0.0, 0.0, None
    for _, eq in curve:
        if peak is None or eq > peak:
            peak = eq
        dd = peak - eq
        if dd > mdd_usd:
            mdd_usd = dd
            mdd_pct = 100 * dd / peak if peak > 0 else 100.0
    return mdd_pct, mdd_usd


def daily_breaches(realised_by_day, limit):
    return sum(1 for _, v in realised_by_day.items() if v <= -limit)


def sizing_policy(kind, value, below='skip'):
    """kind in {'pct','money','lots'}"""
    if kind == 'pct':
        return {'mode': 'equity_risk_percent', 'risk_percent': value, 'below_min_volume': below}
    if kind == 'money':
        return {'mode': 'fixed_risk_money', 'risk_money': value, 'below_min_volume': below}
    if kind == 'lots':
        return {'mode': 'fixed_lots', 'fixed_lots': value, 'below_min_volume': below}
    raise ValueError(kind)


def make_cfg(safety=DEFAULT_SAFETY, spec=SPEC_UNVERIFIED, leverage=100.0, margin_factor=1.0,
             commission_rt=0.0, adverse=0.0, infeasible_split='merge_into_next', **overrides):
    lim = effective_limits(safety)
    lim.update(overrides)
    return {'spec': dict(spec), 'limits': lim, 'leverage': leverage, 'margin_factor': margin_factor,
            'commission_rt': commission_rt, 'adverse': adverse, 'infeasible_split': infeasible_split}

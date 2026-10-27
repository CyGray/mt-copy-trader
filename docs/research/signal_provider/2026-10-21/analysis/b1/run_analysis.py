"""Task 2 runner: baseline reconstruction, strategy outcomes, sensitivities, provider-claim comparison.

usage: python3 -I run_analysis.py
Outputs (b1/):
  baseline_outcomes.csv         every signal (415, quality flags kept) x {BASE, PESS}
  baseline_outcomes_clean.csv   clean subset (in_clean = 1)
  strategy_outcomes.csv         every signal x strategy x {BASE, PESS}
  results.json                  compact per-signal records for the report builder (all scenarios)
Inputs: signals_universe.csv, cache/ (built by build_cache.py), a1 claim events (comparison only).
Re-runnable: re-run after A3 finishes downloading and build_cache.py has been re-run.
"""
import csv
import json
import os
import statistics as st
import sys
import time
from collections import OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sim_engine as se  # noqa: E402
import numpy as np  # noqa: E402

SCR = os.path.dirname(HERE)
RAW = os.path.join(SCR, 'a3', 'raw')
CACHE = os.path.join(HERE, 'cache')
UNIVERSE = os.path.join(HERE, 'signals_universe.csv')
CLAIM_EVENTS = os.path.join(SCR, 'a1', 'provider_claim_events.csv')
CLAIM_SUMMARY = os.path.join(SCR, 'a1', 'provider_claims.csv')
SPAN_MS = 80 * 3_600_000          # ticks loaded per signal: [t, t + 80h)
HZ_H = 72.0
MIN_MS = 60_000

store = se.TickStore(RAW, CACHE, mem_hours=64)
conv = se.Conventions(contract_oz=se.CONTRACT_OZ, swap_usd_per_lot_per_rollover=0.0)

MAIN_SCEN = OrderedDict([
    ('BASE', se.EntryParams('P1', latency_s=5, tol=0.5, expiry_min=60, extra_spread=0.0, slippage=0.0)),
    ('PESS', se.EntryParams('P1', latency_s=15, tol=0.5, expiry_min=60, extra_spread=0.20, slippage=0.10)),
])
SENS_SCEN = OrderedDict([
    ('LAT60', se.EntryParams('P1', latency_s=60, tol=0.5, extra_spread=0.0, slippage=0.0)),
    ('P2_EXP60', se.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=60, extra_spread=0.0, slippage=0.0)),
    ('P2_EXP240', se.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=240, extra_spread=0.0, slippage=0.0)),
    ('TOL0', se.EntryParams('P1', latency_s=5, tol=0.0, extra_spread=0.0, slippage=0.0)),
    ('TOL2', se.EntryParams('P1', latency_s=5, tol=2.0, extra_spread=0.0, slippage=0.0)),
    ('P3_IDEAL_NONEXEC', se.EntryParams('P3', latency_s=0, tol=0.0, extra_spread=0.0, slippage=0.0)),
])
ALL_SCEN = OrderedDict(list(MAIN_SCEN.items()) + list(SENS_SCEN.items()))

THIRDS = ((1, 100 / 3), (2, 100 / 3), (3, 100 / 3))
STRATS = OrderedDict([
    ('TP1_100', se.Strategy('TP1_100', checkpoints=((1, 100.0),), missing_tp='skip_trade')),
    ('TP2_100', se.Strategy('TP2_100', checkpoints=((2, 100.0),), missing_tp='skip_trade')),
    ('TP3_100', se.Strategy('TP3_100', checkpoints=((3, 100.0),), missing_tp='skip_trade')),
    ('EQ3', se.Strategy('EQ3', checkpoints=THIRDS, missing_tp='merge_into_last_available')),
    ('EQ3_LOT010', se.Strategy('EQ3_LOT010', checkpoints=THIRDS, missing_tp='merge_into_last_available',
                               units='lots', total_lots=0.10)),
    ('TP1_50_TP2_50', se.Strategy('TP1_50_TP2_50', checkpoints=((1, 50.0), (2, 50.0)), missing_tp='skip_trade')),
    ('TP1_50_TP2_50_BE', se.Strategy('TP1_50_TP2_50_BE', checkpoints=((1, 50.0), (2, 50.0)),
                                     sl_after=((1, 'entry', 0.0),), missing_tp='skip_trade')),
    ('EQ3_BE', se.Strategy('EQ3_BE', checkpoints=THIRDS, sl_after=((1, 'entry', 0.0),),
                           missing_tp='merge_into_last_available')),
])
CSV_STRATS = list(STRATS.keys())
SENS_STRATS = ['TP1_100', 'EQ3']


def load_universe():
    out = []
    for r in csv.DictReader(open(UNIVERSE, encoding='utf-8')):
        tps = [float(r[f'tp{k}']) if r[f'tp{k}'] else None for k in range(1, 8)]
        sig = se.Signal(r['message_id'], int(r['t_ms']), r['direction'], float(r['entry_low']),
                        float(r['entry_high']), float(r['sl']), tps, r['hard_flags'])
        sig.meta.update(dict(in_clean=int(r['in_clean']), info=r['info_flags'], lead_in=int(r['lead_in_prev_header']),
                             edit_delay_s=float(r['edit_delay_s'] or 0), layout=r['layout_first_line'],
                             num_tps=int(r['num_tps'])))
        out.append(sig)
    return out


def load_claims():
    """Unambiguous provider claim events per signal (reply, or temporal with exactly one candidate)."""
    unamb = defaultdict(list)
    for r in csv.DictReader(open(CLAIM_EVENTS, encoding='utf-8')):
        if not r['signal_msg_id']:
            continue
        if r['link_method'] == 'reply' or (r['link_method'] == 'temporal' and r['candidates_n'] == '1'):
            unamb[r['signal_msg_id']].append(dict(cls=r['claim_class'],
                                                 tp=int(r['tp_index']) if r['tp_index'] else None,
                                                 utc=r['claim_utc'], lag_h=r['lag_hours']))
    summ = {r['signal_msg_id']: r for r in csv.DictReader(open(CLAIM_SUMMARY, encoding='utf-8'))}
    return unamb, summ


def market_mid_at(t_ms, store_):
    """Dukascopy mid at message time: average of last tick before and first tick at/after t (within +/-120 s)."""
    w = se.load_window(store_, t_ms - 120_000, t_ms + 120_000)
    before = np.flatnonzero(w.ms < t_ms)
    after = np.flatnonzero(w.ms >= t_ms)
    pts = []
    if len(before):
        j = before[-1]
        pts.append((w.bid[j] + w.ask[j]) / 2)
    if len(after):
        j = after[0]
        pts.append((w.bid[j] + w.ask[j]) / 2)
    if not pts:
        return None
    return float(sum(pts) / len(pts))


def shifted(sig, off):
    """Copy of sig with every level moved by -off (offset sensitivity)."""
    tps = [None if t is None else t - off for t in sig.tps]
    return se.Signal(sig.message_id, sig.t_ms, sig.direction, sig.entry_low - off, sig.entry_high - off,
                     sig.sl - off, tps, sig.quality_flag, dict(sig.meta))


def fmt_iso(ms):
    return '' if ms is None else se.iso_utc(int(ms))


def compact_record(sig, fill, bl, mk):
    """Per (signal, scenario) facts as ms-timestamps and prices (no tick indices leave this function)."""
    rec = dict(status=fill.status, reason=fill.reason, fill_ms=fill.fill_ms, fill_px=fill.fill_px,
               kind=fill.kind, outside_dist=fill.outside_dist, first_tick_ms=fill.first_tick_ms,
               first_entry_px=fill.first_entry_px, pending_placed_ms=fill.pending_placed_ms,
               bl_status=None, sequence='', sl_ms=None, tp_ms={}, truncated=None, same_tick=False,
               mae_pre_usd=None, mfe_pre_usd=None, mae_all_usd=None, mfe_all_usd=None, flags=[], strat={})
    if fill.status != 'FILLED' or not bl:
        return rec
    rec['bl_status'] = bl['status']
    rec['sequence'] = bl.get('sequence', '')
    rec['truncated'] = bl.get('truncated')
    rec['same_tick'] = bool(bl.get('same_tick_ambiguity'))
    rec['flags'] = list(bl.get('flags', []))
    if bl.get('sl_idx') is not None:
        rec['sl_ms'] = int(mk.ms[bl['sl_idx']])
    for k, j in bl.get('tp_idx', {}).items():
        if j is not None:
            rec['tp_ms'][k] = int(mk.ms[j])
    for tag in ('pre', 'all'):
        rec['mae_%s_usd' % tag] = bl.get('mae_%s_usd' % tag)
        rec['mfe_%s_usd' % tag] = bl.get('mfe_%s_usd' % tag)
    return rec


def strat_record(res):
    keep = ('status', 'reason', 'outcome', 'exit_seq', 'final_exit', 'total_R', 'usd_per_1lot', 'R',
            'min_to_first_tp', 'min_to_stop', 'horizon_reason', 'same_tick_ambiguity', 'bars_to_resolution',
            'max_tick_gap_min', 'mae_all_R', 'mfe_all_R', 'mae_pre_R', 'mfe_pre_R')
    out = {k: res.get(k) for k in keep}
    out['exits'] = [(e[0], e[1], e[2], e[3]) for e in res.get('exits', [])]
    out['flags'] = res.get('flags', [])
    return out


def main():
    t0 = time.time()
    uni = load_universe()
    unamb, summ = load_claims()
    print('signals', len(uni), flush=True)

    # pass 1: market mid at message time and the systematic offset
    mkt_mid = {}
    for sig in uni:
        mkt_mid[sig.message_id] = market_mid_at(sig.t_ms, store)
    offs = [sig.entry_mid - mkt_mid[sig.message_id] for sig in uni
            if mkt_mid[sig.message_id] is not None and abs(sig.entry_mid - mkt_mid[sig.message_id]) <= 5.0]
    systematic = float(st.median(offs)) if offs else 0.0
    offset_info = dict(n_estimates=len(offs), median_entry_minus_market_abs_le5=round(systematic, 4),
                       mean=round(st.mean(offs), 4) if offs else None,
                       sd=round(st.pstdev(offs), 4) if len(offs) > 1 else None,
                       n_with_quote=sum(1 for v in mkt_mid.values() if v is not None))
    print('pass1 done', round(time.time() - t0, 1), offset_info, flush=True)

    base_rows, strat_rows = [], []
    recs = {}
    for idx, sig in enumerate(uni):
        t = sig.t_ms
        win = se.load_window(store, t, t + SPAN_MS)
        mks = {}

        def mk_for(spread):
            key = round(spread, 6)
            if key not in mks:
                mks[key] = se.Market(win, sig.direction, spread)
            return mks[key]

        rec_sig = dict(in_clean=sig.meta['in_clean'], direction=sig.direction, t_ms=t,
                       num_tps=sig.meta.get('num_tps'), info=sig.meta.get('info', ''),
                       lead_in=sig.meta.get('lead_in', 0), quality_flag=sig.quality_flag,
                       market_mid=mkt_mid[sig.message_id], scen={})
        for scen, ep in ALL_SCEN.items():
            mk = mk_for(ep.extra_spread)
            fill = se.decide_entry(sig, ep, mk)
            if fill.status == 'FILLED':
                # no look-ahead: nothing before signal time + latency may be used for the fill
                assert fill.fill_ms >= t + int(round(ep.latency_s * 1000)), (sig.message_id, scen)
            bl = se.baseline_touch(sig, fill, mk, HZ_H) if fill.status == 'FILLED' else {}
            if fill.status == 'FILLED':
                for j in list(bl.get('tp_idx', {}).values()) + [bl.get('sl_idx')]:
                    if j is not None:
                        assert mk.ms[j] >= fill.fill_ms, (sig.message_id, scen, 'touch before fill')
            rec = compact_record(sig, fill, bl, mk)
            if fill.status == 'FILLED' and scen in ('BASE', 'PESS', 'LAT60', 'P2_EXP60', 'P2_EXP240'):
                for sname in (CSV_STRATS if scen in MAIN_SCEN else SENS_STRATS):
                    res = se.simulate(sig, fill, STRATS[sname], mk, conv=conv, slip=ep.slippage)
                    rec['strat'][sname] = strat_record(res)
                    if scen in MAIN_SCEN:
                        strat_rows.append(OrderedDict([
                            ('message_id', sig.message_id), ('scenario', scen), ('strategy', sname),
                            ('in_clean', sig.meta['in_clean']), ('direction', sig.direction),
                            ('status', res['status']), ('reason', res.get('reason', '')),
                            ('outcome', res.get('outcome', '')), ('exit_seq', res.get('exit_seq', '')),
                            ('final_exit', res.get('final_exit', '')),
                            ('total_R', '' if 'total_R' not in res else round(res['total_R'], 4)),
                            ('usd_per_1lot', '' if 'usd_per_1lot' not in res else round(res['usd_per_1lot'], 3)),
                            ('horizon_reason', res.get('horizon_reason', '')),
                            ('last_exit_iso', fmt_iso(res['exits'][-1][1]) if res.get('exits') else ''),
                            ('fill_iso', fmt_iso(fill.fill_ms)),
                            ('R_usd', '' if 'R' not in res else round(res['R'], 3)),
                            ('min_to_first_tp', '' if res.get('min_to_first_tp') is None else round(res['min_to_first_tp'], 3)),
                            ('min_to_stop', '' if res.get('min_to_stop') is None else round(res['min_to_stop'], 3)),
                            ('bars_to_resolution', res.get('bars_to_resolution', '')),
                            ('max_tick_gap_min', '' if res.get('max_tick_gap_min') is None else round(res['max_tick_gap_min'], 2)),
                            ('mae_all_R', '' if res.get('mae_all_R') is None else round(res['mae_all_R'], 3)),
                            ('mfe_all_R', '' if res.get('mfe_all_R') is None else round(res['mfe_all_R'], 3)),
                            ('flags', ';'.join(res.get('flags', []))),
                        ]))
            rec_sig['scen'][scen] = rec
            if scen in MAIN_SCEN:
                base_rows.append(csv_row(sig, scen, fill, bl, mk, mkt_mid[sig.message_id], unamb, summ))

        # offset sensitivity: levels corrected by the systematic offset (BASE entry rules)
        ss = shifted(sig, systematic)
        ep = MAIN_SCEN['BASE']
        mk = mk_for(ep.extra_spread)
        fill = se.decide_entry(ss, ep, mk)
        bl = se.baseline_touch(ss, fill, mk, HZ_H) if fill.status == 'FILLED' else {}
        rec_sig['scen']['OFFSET_BASE'] = compact_record(ss, fill, bl, mk)
        # diagnostic: re-anchor levels so the entry mid equals the Dukascopy mid at posting (distances kept)
        if mkt_mid[sig.message_id] is not None:
            ra = shifted(sig, sig.entry_mid - mkt_mid[sig.message_id])
            fill = se.decide_entry(ra, ep, mk)
            bl = se.baseline_touch(ra, fill, mk, HZ_H) if fill.status == 'FILLED' else {}
            rec_sig['scen']['REANCHOR_BASE'] = compact_record(ra, fill, bl, mk)
        else:
            rec_sig['scen']['REANCHOR_BASE'] = dict(status='NO_QUOTE', reason='no_market_quote')
        recs[sig.message_id] = rec_sig
        if idx % 100 == 0:
            print('signal', idx, round(time.time() - t0, 1), flush=True)

    fields = list(base_rows[0].keys())
    for name, rows in (('baseline_outcomes.csv', base_rows),
                       ('baseline_outcomes_clean.csv', [r for r in base_rows if r['in_clean'] == 1])):
        with open(os.path.join(HERE, name), 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
    with open(os.path.join(HERE, 'strategy_outcomes.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(strat_rows[0].keys()))
        w.writeheader()
        w.writerows(strat_rows)
    dump = dict(systematic_offset=systematic, offset_info=offset_info, main_scen=list(MAIN_SCEN),
                sens_scen=list(SENS_SCEN), strategies=CSV_STRATS, sens_strats=SENS_STRATS,
                n_signals=len(uni), span_h=SPAN_MS / 3_600_000, horizon_h=HZ_H,
                per_signal=recs, claims_unambiguous={k: v for k, v in unamb.items()})
    with open(os.path.join(HERE, 'results.json'), 'w') as f:
        json.dump(dump, f, default=str)
    print('done', round(time.time() - t0, 1), flush=True)


def csv_row(sig, scen, fill, bl, mk, mid_px, unamb, summ):
    row = OrderedDict()
    row['message_id'] = sig.message_id
    row['scenario'] = scen
    row['in_clean'] = sig.meta['in_clean']
    row['quality_flag'] = sig.quality_flag or ''
    row['info_flags'] = sig.meta.get('info', '')
    row['t_iso'] = se.iso_utc(sig.t_ms)
    row['direction'] = sig.direction
    row['entry_low'], row['entry_high'], row['sl'] = sig.entry_low, sig.entry_high, sig.sl
    for k in range(1, 8):
        tp = sig.tps[k - 1]
        row[f'tp{k}'] = '' if tp is None else tp
    row['market_mid_at_msg'] = '' if mid_px is None else round(mid_px, 3)
    row['entry_minus_market_mid'] = '' if mid_px is None else round(sig.entry_mid - mid_px, 3)
    filled = fill.status == 'FILLED'
    row['status'] = bl.get('status', fill.status) if filled else fill.status
    row['skip_reason'] = '' if filled else fill.reason
    row['outside_dist_usd'] = '' if fill.outside_dist is None else round(fill.outside_dist, 3)
    row['first_tick_iso'] = fmt_iso(fill.first_tick_ms)
    row['first_tick_exec_px'] = '' if fill.first_entry_px is None else round(fill.first_entry_px, 3)
    row['fill_iso'] = fmt_iso(fill.fill_ms)
    row['fill_px'] = '' if fill.fill_px is None else round(fill.fill_px, 3)
    row['fill_kind'] = fill.kind
    row['signal_to_fill_s'] = '' if fill.fill_ms is None else round((fill.fill_ms - sig.t_ms) / 1000.0, 3)
    R = abs(fill.fill_px - sig.sl) if filled else None
    row['R_usd'] = '' if not filled else round(R, 3)
    sl_ms = None
    tp_ms = {}
    if filled and bl:
        if bl.get('sl_idx') is not None:
            sl_ms = int(mk.ms[bl['sl_idx']])
        for k, j in bl.get('tp_idx', {}).items():
            if j is not None:
                tp_ms[k] = int(mk.ms[j])
    row['sl_touch_iso'] = fmt_iso(sl_ms)
    row['sl_min_after_fill'] = '' if sl_ms is None else round((sl_ms - fill.fill_ms) / MIN_MS, 3)
    for k in range(1, 8):
        v = tp_ms.get(k)
        row[f'tp{k}_touch_iso'] = fmt_iso(v)
        row[f'tp{k}_min_after_fill'] = '' if v is None else round((v - fill.fill_ms) / MIN_MS, 3)
    row['sequence'] = bl.get('sequence', '') if filled else ''
    row['same_tick_ambiguity'] = int(bool(bl.get('same_tick_ambiguity'))) if filled else ''
    for tag in ('pre', 'all'):
        u = bl.get('mae_%s_usd' % tag) if filled else None
        m = bl.get('mfe_%s_usd' % tag) if filled else None
        row['mae_%s_usd' % tag] = '' if u is None else round(u, 3)
        row['mfe_%s_usd' % tag] = '' if m is None else round(m, 3)
        row['mae_%s_R' % tag] = '' if (u is None or not R) else round(u / R, 3)
        row['mfe_%s_R' % tag] = '' if (m is None or not R) else round(m / R, 3)
    row['flags'] = ';'.join(bl.get('flags', [])) if filled else ''
    # provider claims: compared after the reconstruction; never an input to it
    evs = unamb.get(sig.message_id, [])
    tp_claims = sorted({(e['tp'], e['utc']) for e in evs if e['cls'] == 'update_tp_hit' and e['tp']})
    row['claim_tp_unambig'] = ';'.join(f'TP{k}@{u}' for k, u in tp_claims)
    checks = []
    for k, u in tp_claims:
        if not filled:
            verdict = 'NA_NOT_FILLED'
        elif bl.get('status') == 'NO_PRICE_DATA' and k not in tp_ms:
            verdict = 'NA_NO_DATA'
        elif k in tp_ms and (sl_ms is None or tp_ms[k] < sl_ms):
            verdict = 'SUPPORTED'
        elif k in tp_ms:
            verdict = 'SL_FIRST'
        else:
            verdict = 'NOT_TOUCHED_IN_HORIZON'
        checks.append(f'TP{k}:{verdict}')
    row['claim_tp_check'] = ';'.join(checks)
    row['claim_be_unambig'] = int(any(e['cls'] == 'update_stopped_at_be' for e in evs))
    row['claim_loss_unambig'] = int(any(e['cls'] == 'update_loss_claim' for e in evs))
    s = summ.get(sig.message_id, {})
    row['provider_closed_by_claim_any_link'] = s.get('closed_by_claim', '')
    row['provider_max_tp_claimed_any_link'] = s.get('max_tp_claimed', '')
    return row


if __name__ == '__main__':
    main()

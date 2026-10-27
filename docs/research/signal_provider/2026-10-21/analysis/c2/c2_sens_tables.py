"""C2 sensitivity tables: paired comparisons vs the primary variant on the same signals (clean 406 unless noted)."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, collections
import numpy as np
from c2_run import OUT, load_signals

sig = {s['msg']: s for s in load_signals()}
TR = {}
EN = {}


def load_all():
    for fn in ('c2_trades_core.csv', 'c2_trades_sens.csv', 'c2_trades_extra.csv'):
        p = os.path.join(OUT, fn)
        if os.path.exists(p):
            for r in csv.DictReader(open(p)):
                TR[(r['variant'], r['msg'], r['strat'])] = r
    for fn in ('c2_entries_core.csv', 'c2_entries_sens.csv', 'c2_entries_extra.csv'):
        p = os.path.join(OUT, fn)
        if os.path.exists(p):
            for r in csv.DictReader(open(p)):
                EN[(r['variant'], r['msg'])] = r


def fills(v):
    return {m for (vv, m), r in EN.items() if vv == v and r['status'] == 'FILLED' and sig[m]['clean']}


def mean_R(v, strat, msgs=None):
    vals = []
    for (vv, m, st), r in TR.items():
        if vv == v and st == strat and r['status'] == 'OK' and sig[m]['clean'] and (msgs is None or m in msgs):
            vals.append(float(r['R']))
    return (np.mean(vals) if vals else float('nan')), len(vals)


def split_mean(v, strat, split):
    msgs = {m for m in sig if sig[m]['clean'] and sig[m]['split'] == split}
    return mean_R(v, strat, msgs)


def main():
    load_all()
    out = {}
    base = 'MID_E2_noguard'
    for v in ['MID_E2_spread030', 'MID_E2_spread050', 'MID_E2_shift-60s', 'MID_E2_shift+60s', 'MID_E2_noguard_persist2tk',
              'MID_E2_noguard_persist1s', 'BASE_E2_noguard_persist2tk']:
        if not any(k[0] == v for k in TR):
            continue
        b = base if not v.startswith('BASE') else 'BASE_E2_noguard'
        fb, fv = fills(b), fills(v)
        rows = {'fills_base': len(fb), 'fills_variant': len(fv), 'filled_in_both': len(fb & fv),
                'entered_only_base': len(fb - fv), 'entered_only_variant': len(fv - fb)}
        for st in ['S_TP1|M0', 'S_TP4|M0', 'S_TP4|M5', 'Q_25x4|M0']:
            mb, nb = mean_R(b, st)
            mv, nv = mean_R(v, st)
            common = fb & fv
            cb, _ = mean_R(b, st, common)
            cv, _ = mean_R(v, st, common)
            # paired changes on trades present in both
            diffs = []
            flips = []
            for m in common:
                rb, rv = TR.get((b, m, st)), TR.get((v, m, st))
                if rb and rv and rb['status'] == 'OK' and rv['status'] == 'OK':
                    x, y = float(rb['R']), float(rv['R'])
                    diffs.append(y - x)
                    if (x > 0) != (y > 0) or abs(y - x) > 0.5:
                        flips.append((m, round(x, 3), round(y, 3)))
            rows[st] = dict(n_base=nb, n_var=nv, mean_base=round(mb, 4), mean_var=round(mv, 4),
                            mean_paired_common_base=round(cb, 4), mean_paired_common_var=round(cv, 4),
                            mean_paired_diff=round(float(np.mean(diffs)), 4) if diffs else None,
                            n_flips_gt0p5_or_sign=len(flips), flips_sample=flips[:12])
        out[v] = rows
    # +1 USD tests (extra set) vs BASE_E2_noguard
    for v in ['BASE_E2_noguard_adv05entry', 'BASE_E2_noguard_adv1entry', 'BASE_E2_noguard_adv1all', 'BASE_E1_FT_adv1entry', 'BASE_E3_FT_adv1entry']:
        if not any(k[0] == v for k in TR):
            continue
        out[v] = {'fills': len(fills(v))}
        for st in ['S_TP1|M0', 'S_TP4|M0', 'S_TP4|M5', 'Q_25x4|M0']:
            for sp in ('TRAIN', 'VALID', 'OOS'):
                m_, n_ = split_mean(v, st, sp)
                out[v][f'{st} {sp}'] = (round(float(m_), 4), n_)
    json.dump(out, open(os.path.join(OUT, 'c2_sens_tables.json'), 'w'), indent=1, default=str)
    for v, rows in out.items():
        print('==', v)
        for k, val in rows.items():
            if isinstance(val, dict):
                print('  ', k, {kk: vv for kk, vv in val.items() if kk != 'flips_sample'})
            else:
                print('  ', k, val)


if __name__ == '__main__':
    main()

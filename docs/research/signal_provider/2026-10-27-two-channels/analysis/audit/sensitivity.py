"""Sensitivity and mutation checks for the auditor's reproduction.

Runs the auditor's simulator under alternative readings of points the spec leaves open, and under one
deliberately wrong cost parameter (a mutation that the comparator must flag). Counts pilot mismatches on
the same fields as audit_driver.py. Output: sensitivity.json (counts only).
"""
import csv
import json
import sys
from fractions import Fraction as Fr

sys.path.insert(0, '/tmp/claude-1001/twochan/audit')
import bi5_audit as B  # noqa: E402
import audit_parse as P  # noqa: E402
import audit_sim as S  # noqa: E402

PILOT = '/tmp/claude-1001/twochan/pilot'
AUD = '/tmp/claude-1001/twochan/audit'


def load(path):
    with open(path, newline='') as fh:
        return list(csv.DictReader(fh))


def run_variant(ticks, opts, uni, sigs, tsig):
    sim = S.Sim(ticks, opts)
    fills, trades = {}, {}
    for lbl, s in sigs.items():
        f, tr = S.run_signal(sim, s, tsig)
        fills[lbl] = f
        trades[lbl] = tr
    return fills, trades


def count_mismatches(uni, fills, trades, posthoc=False):
    bad = {'fills': 0, 'trades': 0}
    nf = nt = 0
    for r in load(f'{PILOT}/out_{uni}/lucas_fills.csv'):
        lbl = r['message_id'][-1]
        a = fills[lbl][(r['entry'], r['cost'])]
        nf += 1
        ok = (r['status'] == a['status'] and r['reason'] == a['reason'] and r['kind'] == a['kind']
              and r['fill_ms'] == ('' if a['fill_ms'] is None else str(a['fill_ms']))
              and (r['fill_px'] == '' and a['fill_px'] is None or
                   a['fill_px'] is not None and abs(float(r['fill_px']) - a['fill_px'] / 1000) <= 1e-9))
        bad['fills'] += 0 if ok else 1
    src = f'{PILOT}/posthoc/lucas_trades.csv' if posthoc else f'{PILOT}/out_{uni}/lucas_trades.csv'
    for r in load(src):
        lbl = r['message_id'][-1]
        a = trades[lbl].get((r['entry'], r['cost'], r['variant']))
        nt += 1
        if a is None:
            bad['trades'] += 1
            continue
        ok = (r['status'] == a['status'] and r['exit_seq'] == (a['exit_seq'] or '')
              and r['final_exit'] == (a['final_exit'] or '') and r['flags'] == a['flags']
              and r['last_exit_ms'] == ('' if a['last_exit_ms'] is None else str(a['last_exit_ms'])))
        if a['status'] == 'FILLED' or a['status'] == 'UNRESOLVED_MTM':
            ok = ok and abs(float(r['total_R']) - a['total_R']) <= 1e-6
            ok = ok and abs(float(r['usd_per_1lot']) - a['usd_per_1lot']) <= 1e-6
        bad['trades'] += 0 if ok else 1
    return nf, nt, bad


def main():
    ticks = B.Ticks(B.ms_utc(2026, 10, 26, 0), B.ms_utc(2026, 10, 27, 2, 0))
    revs, final_rev, first_rev = P.load_signal_revisions()
    sig_final = {s['label']: s for s in P.parse_text(final_rev['text'])}
    sig_first = {s['label']: s for s in P.parse_text(first_rev['text'])}
    t_final = P.iso_ms(final_rev['date'])
    t_first = P.iso_ms(first_rev['timestamp'])
    variants = [
        ('reference (auditor, as reported)', {}),
        ('strict stop inequality (<, >)', {'strict_stop': True}),
        ('strict TP inequality (>, <)', {'strict_tp': True}),
        ('pending check from the tick after decision', {'pending_from_next_tick': True}),
        ('strict pending touch (<, >)', {'strict_pending': True}),
        ('SL to entry uses signal mid, not fill', {'sl_to_mid': True}),
    ]
    out = []
    for name, opts in variants:
        row = {'variant': name}
        for uni, sigs, tsig in (('final', sig_final, t_final), ('first', sig_first, t_first)):
            f, tr = run_variant(ticks, opts, uni, sigs, tsig)
            nf, nt, bad = count_mismatches(uni, f, tr)
            row[f'{uni}_fills_mismatch'] = f"{bad['fills']}/{nf}"
            row[f'{uni}_trades_mismatch'] = f"{bad['trades']}/{nt}"
        f, tr = run_variant(ticks, opts, 'final', sig_final, t_final)
        nf, nt, bad = count_mismatches('final', f, tr, posthoc=True)
        row['posthoc_trades_mismatch'] = f"{bad['trades']}/{nt}"
        out.append(row)
        print(json.dumps(row))
    # mutation: a wrong MID slippage (0.04 instead of 0.05). The comparator must flag it.
    saved = dict(S.COST['MID'])
    S.COST['MID']['slip'] = 40
    f, tr = run_variant(ticks, {}, 'final', sig_final, t_final)
    nf, nt, bad = count_mismatches('final', f, tr)
    S.COST['MID'].update(saved)
    mut = {'variant': 'MUTATION: MID slip 0.04 (should be flagged)',
           'final_fills_mismatch': f"{bad['fills']}/{nf}", 'final_trades_mismatch': f"{bad['trades']}/{nt}"}
    out.append(mut)
    print(json.dumps(mut))
    json.dump(out, open(f'{AUD}/sensitivity.json', 'w'), indent=1)


if __name__ == '__main__':
    main()

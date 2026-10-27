"""POST-HOC, DESCRIPTIVE, IN-SAMPLE ONLY (TRAIN+VALIDATION, MID, E1 and E2). The frozen grid used a fixed 4.0 USD
break-even distance, which is ~0.6-0.7R of the median fill risk (median R_usd: E1 6.56, E2 6.05 on TRAIN). This
checks a fixed 6.0 USD break-even (~1R) for the same exits. Not a selection and not evaluated on OOS.
Output: out/be_1r_check.csv. usage: python3 -I b2_be_1r_check.py"""
import csv, os, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import b2_core as c, b2_stats as st  # noqa: E401
import sim_engine_b2 as se  # noqa: E402


def main():
    base = {v['name']: v for v in c.build_grid()}
    variants = []
    for name in ('S_TP4|M0', 'S_TP3|M0', 'S_TP1|M0', 'Q_25x4|M0'):
        for tag, be in (('BE4', 4.0), ('BE6', 6.0)):
            s = c.make_strategy(base[name])
            s.break_even = ('price', be, 0.0)
            variants.append(dict(base[name], name=f'{name}+{tag}', strategy=s))
    store = se.TickStore(c.RAW, c.CACHE, mem_hours=64)
    sigs = [s for s in c.load_signals() if s.meta['in_clean'] == 1]
    c.assign_splits(sigs)
    sigs = [s for s in sigs if s.meta['split'] in ('train', 'val')]
    rows = []
    for s in sigs:
        _, tr = c.evaluate_signal(store, s, variants, entries=('E1', 'E2'), costs=('MID',))
        rows += tr
    g = collections.defaultdict(list)
    for r in rows:
        g[(r['entry'], r['variant'], r['split'])].append(r)
    out = []
    for (en, vn, sp), xs in sorted(g.items()):
        m = st.metrics(xs)
        out.append(dict(entry=en, variant=vn, split=sp, n=m.get('n'), mean_R=round(m['mean_R'], 4) if m.get('n') else '',
                        ci95_lo=round(m['ci95_lo'], 4) if m.get('n') else '', ci95_hi=round(m['ci95_hi'], 4) if m.get('n') else '',
                        mdd_R_closed=round(m['mdd_R_closed'], 3) if m.get('n') else '', be_rate=round(m['be_rate'], 3) if m.get('n') else ''))
    with open(os.path.join(c.OUT, 'be_1r_check.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
    for o in out:
        if o['split'] == 'train' or o['split'] == 'val':
            print(o['entry'], o['variant'], o['split'], 'n', o['n'], 'mean', o['mean_R'], 'CI', o['ci95_lo'], o['ci95_hi'], 'mdd', o['mdd_R_closed'], 'BE', o['be_rate'])


if __name__ == '__main__':
    main()

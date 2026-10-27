"""(a) White Reality Check vs ZERO (is the best of the grid's mean R > 0 after multiplicity), TRAIN+VAL, MID.
(b) Horizon / weekend sensitivity for the frozen benchmark and finalists (DESCRIPTIVE, run after OOS; not used
    for any selection). 72 h is the baseline already in the grid; 24 h and close-before-weekend (Fri 20:45 UTC)
    are added here on all CLEAN signals, E1 and E2, MID.
(c) ALL-universe sensitivity: hard-flagged signals (9) evaluated for the frozen family, by split."""
import csv, gzip, json, os, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402
import b2_stats as st  # noqa: E402
import numpy as np  # noqa: E402
import sim_engine_b2 as se  # noqa: E402


def load(path):
    with gzip.open(path, 'rt', newline='') as f:
        return list(csv.DictReader(f))


def main():
    out = {}
    tv = load(os.path.join(c.OUT, 'phase1_trades.csv.gz'))
    fam = c.build_grid()
    names = [v['name'] for v in fam]
    for en in ('E1', 'E2'):
        maps = {vn: {r['message_id']: float(r['total_R']) for r in tv if r['entry'] == en and r['cost'] == 'MID'
                     and r['variant'] == vn and r['total_R'] not in ('', None)} for vn in names}
        full = [vn for vn in names if len(maps[vn]) > 0]
        common = sorted(set.intersection(*[set(maps[vn]) for vn in full]))
        # signals with all variants defined are few for singles; use signals where all but S_TP4 defined
        sel = [vn for vn in full if vn not in ('S_TP4|M0', 'S_TP4|M5')]
        com2 = sorted(set.intersection(*[set(maps[vn]) for vn in sel]))
        D = np.array([[maps[vn][m] for vn in sel] for m in com2])
        rc = st.reality_check(D)           # centred bootstrap of max mean vs zero
        out.setdefault('rc_vs_zero_TV', {})[en] = dict(rc, variants=len(sel), signals=len(com2),
                                                        best=sel[int(np.argmax(D.mean(axis=0)))],
                                                        best_mean=round(float(D.mean(axis=0).max()), 4))
    # (b) horizon sensitivity, post-OOS, descriptive
    fin = json.load(open(os.path.join(c.OUT, 'finalists.json')))
    targets = [d['variant'] for d in fin['finalists']] + [fin['benchmark']]
    base = {v['name']: v for v in fam if v['name'] in targets}
    sigs = c.load_signals(); c.assign_splits(sigs)
    clean = [s for s in sigs if s.meta['in_clean'] == 1]
    store = se.TickStore(c.RAW, c.CACHE, mem_hours=64)
    variants = []
    for name, v in base.items():
        for tag, hz, cbw in (('H72', 72.0, False), ('H24', 24.0, False), ('WKND', 72.0, True)):
            s = c.make_strategy(v)
            s.horizon_h = hz; s.close_before_weekend = cbw
            variants.append(dict(v, name=f'{name}@{tag}', strategy=s))
    rows = []
    for sig in clean:
        _, tr = c.evaluate_signal(store, sig, variants, entries=('E1', 'E2'), costs=('MID',))
        rows += tr
    summ = []
    grp = collections.defaultdict(list)
    for r in rows:
        grp[(r['entry'], r['variant'], r['split'])].append(r)
    for (en, vn, sp), g in sorted(grp.items()):
        m = st.metrics(g)
        summ.append(dict(entry=en, variant=vn, split=sp, n=m.get('n'), mean_R=round(m['mean_R'], 4) if m.get('n') else None,
                         ci95_lo=round(m['ci95_lo'], 4) if m.get('n') else None, ci95_hi=round(m['ci95_hi'], 4) if m.get('n') else None,
                         unresolved_horizon_close=m.get('n_horizon_close'), mdd_R_closed=round(m['mdd_R_closed'], 3) if m.get('n') else None))
    if summ:
        with open(os.path.join(c.OUT, 'horizon_sensitivity.csv'), 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(summ[0].keys())); w.writeheader(); w.writerows(summ)
    out['horizon_sensitivity_rows'] = len(summ)
    # (c) flagged signals, by split (frozen family, MID) from phase 2 outputs
    fl = load(os.path.join(c.OUT, 'flagged_trades.csv.gz'))
    fg = collections.defaultdict(list)
    for r in fl:
        if r['cost'] == 'MID' and r['variant'] in targets:
            fg[(r['entry'], r['variant'], r['split'])].append(r)
    flsum = []
    for (en, vn, sp), g in sorted(fg.items()):
        m = st.metrics(g)
        flsum.append(dict(entry=en, variant=vn, split=sp, n=m.get('n', 0), mean_R=round(m['mean_R'], 4) if m.get('n') else None))
    with open(os.path.join(c.OUT, 'flagged_sensitivity.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['entry', 'variant', 'split', 'n', 'mean_R']); w.writeheader(); w.writerows(flsum)
    out['flagged_rows'] = len(flsum)
    json.dump(out, open(os.path.join(c.OUT, 'extra.json'), 'w'), indent=1, default=str)
    print(json.dumps({k: v for k, v in out.items() if k != 'horizon_sensitivity_rows'}, indent=1, default=str))


if __name__ == '__main__':
    main()

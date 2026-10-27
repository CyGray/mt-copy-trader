"""Ex-ante regime features from ticks BEFORE the signal time (prior 4 h, 5-minute mid grid).
ER4h = Kaufman efficiency ratio |mid(t) - mid(t-4h)| / sum |diff mid| over 48 five-minute bins (1 = straight line).
PATH4h = sum |diff mid| in USD over the same bins. Nothing at or after the signal time is read.
Tercile cut-points are fixed on TRAIN clean signals only (see b2_regime_tercile). usage: python3 -I b2_regime.py
"""
import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402
import sim_engine_b2 as se  # noqa: E402
import numpy as np  # noqa: E402

BIN_MS = 300_000
NBIN = 48


def features(store, t):
    w = se.load_window(store, t - NBIN * BIN_MS, t)
    if len(w.ms) < 10 or w.truncated:
        return None
    edges = (t - NBIN * BIN_MS) + BIN_MS * np.arange(NBIN + 1)
    idx = np.searchsorted(w.ms, edges, 'left') - 1       # last tick strictly before each edge
    ok = idx >= 0
    if ok.sum() < NBIN:
        return None
    mid = (w.bid[idx.clip(0)] + w.ask[idx.clip(0)]) / 2.0
    # require a tick within the bin before each edge (coverage); count bins with a fresh tick
    fresh = np.array([(w.ms[j] >= edges[k] - BIN_MS) if j >= 0 else False for k, j in enumerate(idx)])
    cover = int(fresh[1:].sum())
    if cover < 40:
        return None
    d = np.abs(np.diff(mid))
    path = float(d.sum())
    er = float(abs(mid[-1] - mid[0]) / path) if path > 0 else None
    return dict(er4h=er, path4h_usd=path, cover_bins=cover)


def main():
    store = se.TickStore(c.RAW, c.CACHE, mem_hours=8)
    sigs = c.load_signals()
    c.assign_splits(sigs)
    rows = []
    for s in sigs:
        f = features(store, s.t_ms)
        rows.append(dict(message_id=s.message_id, t_ms=s.t_ms, split=s.meta['split'], in_clean=s.meta['in_clean'],
                         direction=s.direction, er4h='' if not f or f['er4h'] is None else round(f['er4h'], 5),
                         path4h_usd='' if not f else round(f['path4h_usd'], 4),
                         cover_bins='' if not f else f['cover_bins']))
    with open(os.path.join(c.OUT, 'regime_features.csv'), 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    n_ok = sum(1 for r in rows if r['er4h'] != '')
    print('features', len(rows), 'with features', n_ok)


if __name__ == '__main__':
    main()

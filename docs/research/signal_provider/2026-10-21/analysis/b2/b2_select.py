"""FREEZE STEP. Selects <= 5 finalist variants from the phase-1 grid using TRAIN (shortlist) and TRAIN+VALIDATION
(final ranking). Reads ONLY train_metrics.csv and val_metrics.csv. Writes out/finalists.json with a sha256 of its
own canonical content. Must be run once; re-running with different rules after OOS was seen is forbidden.
Rule (fixed before any OOS evaluation, MID costs, entries E1 and E2 separately; E3 is report-only):
  S1  TRAIN: eligible if n_train >= 60 fills (determined trades). Shortlist = top 12 by TRAIN mean R for E1,
      union top 12 by TRAIN mean R for E2.
  S2  Score(v) = min over {E1,E2} of the pooled TRAIN+VALIDATION mean R (sum R / n), requiring n_val >= 20 for
      both entries. Finalists = top 5 by Score (ties: larger min n).
  Benchmark (frozen reference, not a finalist): 100% at TP1 with original SL (S_TP1|M0).
"""
import csv
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402

BENCH = 'S_TP1|M0'
MIN_TRAIN_N = 60
MIN_VAL_N = 20


def rd(path):
    return list(csv.DictReader(open(path, encoding='utf-8')))


def main():
    tr = [r for r in rd(os.path.join(c.OUT, 'train_metrics.csv')) if r['cost'] == 'MID']
    va = [r for r in rd(os.path.join(c.OUT, 'val_metrics.csv')) if r['cost'] == 'MID']
    trd = {(r['entry'], r['variant']): r for r in tr}
    vad = {(r['entry'], r['variant']): r for r in va}
    short = set()
    for en in ('E1', 'E2'):
        cands = [r for r in tr if r['entry'] == en and r['n'] and int(r['n']) >= MIN_TRAIN_N]
        cands.sort(key=lambda r: -float(r['mean_R']))
        short |= {r['variant'] for r in cands[:12]}
    scored = []
    for vn in sorted(short):
        per = {}
        for en in ('E1', 'E2'):
            a, b = trd.get((en, vn)), vad.get((en, vn))
            if a is None or b is None or not a['n'] or not b['n'] or int(b['n']) < MIN_VAL_N:
                per = None
                break
            n_tr, n_va = int(a['n']), int(b['n'])
            pooled = (float(a['sum_R']) + float(b['sum_R'])) / (n_tr + n_va)
            per[en] = dict(n_train=n_tr, n_val=n_va, n_tv=n_tr + n_va, pooled_mean_R=round(pooled, 5),
                           train_mean_R=round(float(a['mean_R']), 5), val_mean_R=round(float(b['mean_R']), 5),
                           min_n=min(n_tr, n_va))
        if per is None:
            continue
        score = min(per[e]['pooled_mean_R'] for e in ('E1', 'E2'))
        scored.append(dict(variant=vn, score=score, min_n=min(per[e]['min_n'] for e in ('E1', 'E2')), per_entry=per))
    scored.sort(key=lambda d: (-d['score'], -d['min_n'], d['variant']))
    fin = scored[:5]
    # rank stability (all eligible TRAIN variants, per entry) for the finalists
    stab = {}
    for en in ('E1', 'E2'):
        elig = sorted([r for r in tr if r['entry'] == en and r['n'] and int(r['n']) >= MIN_TRAIN_N],
                      key=lambda r: -float(r['mean_R']))
        vel = sorted([r for r in va if r['entry'] == en and r['n'] and int(r['n']) >= MIN_VAL_N],
                     key=lambda r: -float(r['mean_R']))
        rk_tr = {r['variant']: i + 1 for i, r in enumerate(elig)}
        rk_va = {r['variant']: i + 1 for i, r in enumerate(vel)}
        stab[en] = dict(n_eligible_train=len(elig), n_eligible_val=len(vel),
                        ranks={d['variant']: dict(train=rk_tr.get(d['variant']), val=rk_va.get(d['variant']))
                               for d in fin})
    body = dict(
        selection_rule=__doc__.split('Rule (fixed before any OOS evaluation, MID costs, entries E1 and E2 separately; E3 is report-only):')[1].strip(),
        grid_size=len(c.build_grid()), entries_optimised=['E1', 'E2'], cost_for_selection='MID',
        trials_total=len(c.build_grid()) * 2 * 3, shortlist=sorted(short),
        n_scored=len(scored),
        finalists=[dict(variant=d['variant'], score_pooled_TV_mean_R=round(d['score'], 5), per_entry=d['per_entry'])
                   for d in fin],
        benchmark=BENCH, rank_stability=stab,
        hypotheses_preregistered=[
            dict(id='H1', text='SELL trades have higher mean R than BUY trades under the top finalist (E1, MID).',
                 test='sign of mean R(SELL)-mean R(BUY) positive in TRAIN, VALIDATION and OOS'),
            dict(id='H2', text='Trending regime (prior-4h Kaufman efficiency ratio, top TRAIN tercile) has higher mean R '
                               'than ranging (bottom tercile) under the top finalist (E1, MID).',
                 test='sign positive in TRAIN, VALIDATION and OOS; tercile cut-points fixed on TRAIN'),
        ],
        oos_plan=dict(finalists_evaluated_once=len(fin), plus_benchmark=1,
                      entries=['E1', 'E2'], E3_reference_descriptive_only=True,
                      costs=['BASE', 'MID', 'PESS']),
    )
    canon = json.dumps(body, sort_keys=True, indent=1)
    body['sha256_of_body'] = hashlib.sha256(canon.encode()).hexdigest()
    with open(os.path.join(c.OUT, 'finalists.json'), 'w') as f:
        json.dump(body, f, indent=1, sort_keys=True)
    print(json.dumps(dict(finalists=[d['variant'] for d in fin], shortlist_n=len(short), scored=len(scored),
                          sha=body['sha256_of_body']), indent=1))
    print('TOP SCORED (pooled TRAIN+VAL MID, min over E1/E2):')
    for d in scored[:12]:
        print(d['variant'], round(d['score'], 4), {e: (d['per_entry'][e]['n_train'], d['per_entry'][e]['n_val'],
                                                  d['per_entry'][e]['train_mean_R'], d['per_entry'][e]['val_mean_R'])
                                            for e in ('E1', 'E2')})


if __name__ == '__main__':
    main()

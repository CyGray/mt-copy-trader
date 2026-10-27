"""C2 final checks: TP4-subset apples-to-apples, edit-time split, Holm + power, unresolved/status counts."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, collections
import numpy as np
from c2_run import OUT, SCR, load_signals
sigs = {s['msg']: s for s in load_signals()}
uni = {r['message_id']: r for r in csv.DictReader(open(os.path.join(SCR, 'b1', 'signals_universe.csv')))}
TR = {}
for fn in ('c2_trades_core.csv', 'c2_trades_sens.csv', 'c2_trades_extra.csv'):
    for r in csv.DictReader(open(os.path.join(OUT, fn))):
        TR[(r['variant'], r['msg'], r['strat'])] = r
EN = {}
for fn in ('c2_entries_core.csv', 'c2_entries_sens.csv', 'c2_entries_extra.csv'):
    for r in csv.DictReader(open(os.path.join(OUT, fn))):
        EN[(r['variant'], r['msg'])] = r
rng0 = np.random.default_rng(42)
out = {}

def R_of(v, st, msgs):
    return {m: float(TR[(v, m, st)]['R']) for m in msgs if (v, m, st) in TR and TR[(v, m, st)]['status'] == 'OK'}

def boot_mean(x, nb=10000):
    x = np.asarray(x); rng = np.random.default_rng(42)
    idx = rng.integers(0, len(x), size=(nb, len(x)))
    return x[idx].mean(axis=1)

# (a) TP4 apples-to-apples on OOS and TRAIN, primary MID E2 (no guard) and E1 FT MID
for v in ('MID_E2_noguard', 'MID_E1_FT', 'BASE_E2_noguard'):
    for sp in ('OOS', 'TRAIN', 'VALID'):
        msgs = [m for m in sigs if sigs[m]['clean'] and sigs[m]['split'] == sp and (v, m) in EN and EN[(v, m)]['status'] == 'FILLED']
        has4 = [m for m in msgs if sigs[m]['tps'][3] is not None]
        full = msgs
        row = {}
        for st in ('S_TP1|M0', 'S_TP4|M0', 'S_TP4|M5', 'S_TP4FB|M0', 'Q_25x4|M0'):
            a = R_of(v, st, has4 if st.startswith('S_TP4|') or st == 'S_TP4|M5' else full)
            row[st] = (round(float(np.mean(list(a.values()))), 3), len(a)) if a else None
        # S_TP1 on the TP4-carrying subset (apples to apples) and on full population
        s1_sub = R_of(v, 'S_TP1|M0', has4); s1_full = R_of(v, 'S_TP1|M0', full)
        row['S_TP1 on TP4-subset'] = (round(float(np.mean(list(s1_sub.values()))), 3), len(s1_sub))
        row['S_TP1 full population'] = (round(float(np.mean(list(s1_full.values()))), 3), len(s1_full))
        row['TP4-subset share of fills'] = (len(has4), len(full))
        out.setdefault('tp4_subset', {})[f'{v} {sp}'] = row

# (b) edit-time split (clean, filled under primary MID E2 no guard and E1 FT MID)
def edit_group(m):
    d = uni[m]['edit_delay_s']
    if d in ('', None):
        return 'no_edit_field'
    d = float(d)
    return 'never_or_0s' if d == 0 else ('<=300s' if d <= 300 else '>300s')
groups = collections.defaultdict(list)
for m in sigs:
    if sigs[m]['clean']:
        groups[edit_group(m)].append(m)
out['edit_groups_clean_counts'] = {k: len(v) for k, v in groups.items()}
eb = {}
for v in ('MID_E2_noguard', 'MID_E1_FT'):
    for g, msgs in groups.items():
        filled = [m for m in msgs if (v, m) in EN and EN[(v, m)]['status'] == 'FILLED']
        rowg = dict(n_signals=len(msgs), filled=len(filled), fill_rate=round(len(filled) / len(msgs), 3) if msgs else None)
        for st in ('S_TP1|M0', 'S_TP4|M0', 'S_TP4FB|M0'):
            a = R_of(v, st, filled)
            rowg[st] = (round(float(np.mean(list(a.values()))), 3), len(a)) if a else None
        eb[f'{v} {g}'] = rowg
out['edit_groups'] = eb
# (c) finalists: one-sample bootstrap p (H0 mean<=0), Holm across the 5 finalists (+ benchmark)
fin = ['S_TP4|M0', 'S_TP4|M5', 'Q_25x4|M3', 'Q_25x4|M0', 'S_TP3|M0']
for v in ('MID_E2_noguard', 'MID_E1_FT'):
    oosm = [m for m in sigs if sigs[m]['clean'] and sigs[m]['split'] == 'OOS' and (v, m) in EN and EN[(v, m)]['status'] == 'FILLED']
    pv = {}
    for st in fin + ['S_TP1|M0']:
        a = R_of(v, st, oosm)
        x = np.array(list(a.values()))
        bm = boot_mean(x)
        p_one = float((bm <= 0).mean())
        pv[st] = dict(n=len(x), mean=round(float(x.mean()), 3), p_one_sided_boot=round(p_one, 4),
                      sd=round(float(x.std(ddof=1)), 3))
    # Holm over the 5 finalists
    ps = sorted([(pv[s]['p_one_sided_boot'], s) for s in fin])
    m_ = len(ps); adj = {}
    running = 0.0
    for i, (p, s) in enumerate(ps):
        running = max(running, min(1.0, (m_ - i) * p))
        adj[s] = round(running, 4)
    for s in fin:
        pv[s]['holm_p'] = adj[s]
    # power: minimum detectable mean R at n with SD from the data (two-sided 5%, 80% power)
    for s in fin + ['S_TP1|M0']:
        n = pv[s]['n']; sd = pv[s]['sd']
        pv[s]['MDE_R_80pct_power_n'] = round((1.959964 + 0.841621) * sd / np.sqrt(n), 3)
    out.setdefault('finalists_oos', {})[v] = pv

# (d) status counts for the primary entries (clean and non-clean)
st_c = collections.defaultdict(collections.Counter)
for (v, m), r in EN.items():
    if v in ('MID_E2_noguard', 'MID_E1_FT', 'BASE_E2_noguard', 'BASE_E3_FT', 'MID_E3_FT', 'BASE_E1_FT'):
        sp = 'NONCLEAN' if not sigs[m]['clean'] else sigs[m]['split']
        st_c[v][sp + ':' + r['status']] += 1
out['status_counts'] = {k: dict(v) for k, v in st_c.items()}
# (e) unresolved (horizon MTM) legs anywhere
mtm = collections.Counter()
for (v, m, st), r in TR.items():
    if r['status'] == 'OK' and 'MTM' in r['legs']:
        mtm[(v, st, sigs[m]['split'])] += 1
out['mtm_legs'] = {'|'.join(k): n for k, n in mtm.items()}
json.dump(out, open(os.path.join(OUT, 'c2_final.json'), 'w'), indent=1, default=str)
print(json.dumps(out, indent=1, default=str)[:9000])

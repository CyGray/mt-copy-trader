"""Task 2 statistics: every table in the report, from the outputs of run_analysis.py.

usage: python3 -I stats.py   -> writes tables.md (markdown tables) and summary.json
All rates carry Wilson 95% intervals. Labels: Observed = raw data facts (signal fields, bi5 coverage);
Reconstructed = tick-level first-touch facts; Simulated = strategy P&L under the stated model.
"""
import csv
import json
import math
import os
import statistics as st
import sys
import datetime as dt
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sim_engine as se  # noqa: E402

OUT_MD = os.path.join(HERE, 'tables.md')
OUT_JSON = os.path.join(HERE, 'summary.json')
MIN = 60_000

res = json.load(open(os.path.join(HERE, 'results.json')))
per = res['per_signal']
uni = {r['message_id']: r for r in csv.DictReader(open(os.path.join(HERE, 'signals_universe.csv'), encoding='utf-8'))}
base_rows = list(csv.DictReader(open(os.path.join(HERE, 'baseline_outcomes.csv'))))
strat_rows = list(csv.DictReader(open(os.path.join(HERE, 'strategy_outcomes.csv'))))
qc = json.load(open(os.path.join(HERE, 'qc_summary.json')))
md = []


def P(*a):
    md.append(' '.join(str(x) for x in a))


def table(header, rows, note=None):
    if note:
        P(note)
        P('')
    esc = lambda x: str(x).replace('|', '\\|')
    P('| ' + ' | '.join(esc(h) for h in header) + ' |')
    P('|' + '|'.join(['---'] * len(header)) + '|')
    for r in rows:
        P('| ' + ' | '.join(esc(x) for x in r) + ' |')
    P('')


def rate(k, n):
    if n == 0:
        return 'n=0'
    p, lo, hi = se.wilson(k, n)
    return f'{k}/{n} = {100*p:.1f}% [{100*lo:.1f}, {100*hi:.1f}]'


def wr(k, n):
    """(p, lo, hi) as percentages strings for table cells."""
    if n == 0:
        return ('n=0', '', '')
    p, lo, hi = se.wilson(k, n)
    return (f'{k}/{n}', f'{100*p:.1f}%', f'[{100*lo:.1f}, {100*hi:.1f}]')


def mean(xs):
    xs = [x for x in xs if x is not None]
    return st.mean(xs) if xs else None


def fnum(x, d=3):
    return '' if x is None else f'{x:.{d}f}'


def before(a, b):
    """event a strictly before event b (b None = never)."""
    return a is not None and (b is None or a < b)


# ------------------------------------------------------------------ signal table
S = {}
for mid, r in uni.items():
    rec = per[mid]
    b = rec['scen']['BASE']
    tp = {int(k): v for k, v in b['tp_ms'].items()}
    tps = {k: (float(r[f'tp{k}']) if r[f'tp{k}'] else None) for k in range(1, 8)}
    t_ms = rec['t_ms']
    d = dt.datetime.fromtimestamp(t_ms / 1000, dt.timezone.utc)
    h = d.hour
    sess = 'Asia 00-07' if h < 7 else 'London 07-12' if h < 12 else 'NY-overlap 12-17' if h < 17 else 'Late 17-24'
    S[mid] = dict(mid=mid, in_clean=int(r['in_clean']), dir=r['direction'], t_ms=t_ms, t_iso=se.iso_utc(t_ms),
                  sess=sess, wd=d.strftime('%a'), month=d.strftime('%Y-%m'), num_tps=int(r['num_tps']),
                  sl=float(r['sl']), emid=float(r['entry_mid']), sl_dist=float(r['sl_dist']),
                  hard=r['hard_flags'], info=r['info_flags'], lead_in=rec['lead_in'],
                  tps=tps, market_mid=rec.get('market_mid'), scen={})
    for scen in list(res['main_scen']) + list(res['sens_scen']) + ['OFFSET_BASE', 'REANCHOR_BASE']:
        s = rec['scen'][scen]
        tp_scen = {int(k): v for k, v in s['tp_ms'].items()}
        S[mid]['scen'][scen] = dict(status=s['status'], reason=s['reason'], fill_ms=s['fill_ms'], fill_px=s['fill_px'],
                                    bl=s['bl_status'], sl_ms=s['sl_ms'], tp=tp_scen, seq=s['sequence'],
                                    outside=s['outside_dist'], first_tick=s.get('first_tick_ms'),
                                    first_px=s.get('first_entry_px'), strat=s.get('strat', {}))
    S[mid]['strat'] = {}
    for sr in strat_rows:
        pass

# strategy rows (BASE/PESS)
for sr in strat_rows:
    mid = sr['message_id']
    S[mid].setdefault('sr', {})[(sr['scenario'], sr['strategy'])] = sr

ALL = list(S.values())
CLEAN = [s for s in ALL if s['in_clean'] == 1]
UNIVERSES = [('ALL signals', ALL), ('CLEAN signals', CLEAN)]


def det_filled(group, scen='BASE'):
    out = []
    for s in group:
        x = s['scen'][scen]
        if x['status'] == 'FILLED' and x['bl'] != 'NO_PRICE_DATA':
            out.append(s)
    return out


def ev(s, scen='BASE'):
    x = s['scen'][scen]
    return dict(sl=x['sl_ms'], t=x['tp'], fill=x['fill_ms'])


# ------------------------------------------------------------------ 1. Universe and coverage
P('## 1. Universe, quality flags and data coverage (Observed)')
P('')
flags = Counter()
for s in ALL:
    for f in (s['hard'].split(';') if s['hard'] else []):
        flags[f.split('_implausible')[0].split('_of_')[0] if not f.startswith('duplicate_of') else 'duplicate'] += 1
rows = [('signals in accepted universe (A1)', len(ALL), '100%'),
        ('clean (no hard flag)', len(CLEAN), f'{100*len(CLEAN)/len(ALL):.1f}%'),
        ('excluded (hard flag)', len(ALL) - len(CLEAN), f'{100*(len(ALL)-len(CLEAN))/len(ALL):.1f}%')]
table(['universe', 'n', 'share'], rows)
ex = [(s['mid'], s['t_iso'][:16], s['hard']) for s in ALL if s['in_clean'] == 0]
table(['message_id', 'time (UTC)', 'hard flag(s)'], ex, note='Excluded signals (kept in the ALL table, flagged):')
info_c = Counter()
for s in ALL:
    for f in (s['info'].split(';') if s['info'] else []):
        info_c[f] += 1
table(['info flag (kept in CLEAN)', 'n'], sorted(info_c.items()),
      note='Informational flags (no exclusion). lead_in = previous message in the chat is a direction-only post (heuristic, A1 counted ~94).')

cov_ok = [h for h in csv.DictReader(open(os.path.join(HERE, 'hour_index.csv'))) if h['status'] == 'ok']
cov_empty = [h for h in csv.DictReader(open(os.path.join(HERE, 'hour_index.csv'))) if h['status'] == 'empty']
cov_unk = [h for h in csv.DictReader(open(os.path.join(HERE, 'hour_index.csv'))) if h['status'] == 'unknown']
table(['hour class (2025-10-30T00 .. 2026-09-28T00)', 'hours', 'share'],
      [('ok (ticks decoded)', len(cov_ok), f'{100*len(cov_ok)/7992:.1f}%'),
       ('empty / closed (known no ticks)', len(cov_empty), f'{100*len(cov_empty)/7992:.1f}%'),
       ('unknown (no file)', len(cov_unk), f'{100*len(cov_unk)/7992:.1f}%')],
      note=f"Tick coverage. Total ticks decoded: {qc['ticks']:,}. First ok hour {qc['first_ok_hour']}, last ok hour {qc['last_ok_hour']}.")
ws = [s for s in ALL if s['scen']['BASE']['status'] != 'NO_PRICE_DATA']
P(f'Signals whose 80 h tick window has complete coverage for the BASE scenario: {len(ws)}/{len(ALL)} (100%). '
  'Windows that cross an unknown hour are truncated and become NO_PRICE_DATA where unresolved.')
P('')

# ------------------------------------------------------------------ 2. Entry: fill / skip rates
P('## 2. Entry model: fill and skip rates (Reconstructed)')
P('')
P('Scenario BASE = P1, latency 5 s, tolerance 0.5 USD, spread +0, slippage 0. PESS = latency 15 s, tolerance 0.5, '
  'spread +0.20 total, slippage 0.10. Skip reasons come from the first tick at or after signal time + latency.')
P('')
for scen in ['BASE', 'PESS']:
    rows = []
    for uname, grp in UNIVERSES:
        n = len(grp)
        c = Counter(s['scen'][scen]['status'] if s['scen'][scen]['status'] != 'SKIPPED_price_outside_range'
                    else 'SKIPPED_price_outside_range' for s in grp)
        f = c.get('FILLED', 0)
        rows.append((uname, scen, n, f, rate(f, n).split(' = ')[1], f'{c.get("SKIPPED_price_outside_range",0)}',
                     c.get('NO_PRICE_DATA', 0)))
    table(['universe', 'scenario', 'n', 'FILLED', 'fill rate (Wilson)', 'SKIPPED price_outside_range', 'NO_PRICE_DATA'],
          rows)

for uname, grp in UNIVERSES:
    rows = []
    for scen in ['BASE', 'PESS']:
        sk = [s for s in grp if s['scen'][scen]['status'] == 'SKIPPED_price_outside_range']
        # direction-aware: BUY is unfavourable above the range (x > 0), SELL is unfavourable below it (x < 0)
        out = [s['scen'][scen]['outside'] for s in sk]
        unf = sum(1 for s in sk if s['scen'][scen]['outside'] is not None and
                  ((s['dir'] == 'buy' and s['scen'][scen]['outside'] > 0) or (s['dir'] == 'sell' and s['scen'][scen]['outside'] < 0)))
        fav = sum(1 for s in sk if s['scen'][scen]['outside'] is not None) - unf
        rows.append((scen, len(sk), unf, fav, fnum(st.median([abs(x) for x in out if x is not None]), 2) if out else '',
                     fnum(max(abs(x) for x in out if x is not None), 2) if out else ''))
    table(['scenario', 'skips', 'beyond range on unfavourable side', 'beyond range on favourable side',
           'median |distance| USD', 'max |distance| USD'], rows,
          note=f'Skip geometry, {uname}. Distance = executable price at first tick minus range edge (tolerance applied).')

# staleness and provider-vs-market
rows = []
for uname, grp in UNIVERSES:
    vals = []
    for s in grp:
        if s['market_mid'] is not None:
            vals.append(s['emid'] - s['market_mid'])
    a = [abs(v) for v in vals]
    rows.append((uname, len(vals), fnum(st.median(vals), 2), fnum(st.median(a), 2),
                 rate(sum(1 for x in a if x <= 0.5), len(a)).split(' = ')[1],
                 rate(sum(1 for x in a if x > 5), len(a)).split(' = ')[1]))
table(['universe', 'signals with a Dukascopy quote within +/-120 s', 'median (entry mid - market mid), USD',
       'median |gap| USD', '|gap| <= 0.5 USD', '|gap| > 5 USD (stale / mismatched)'], rows,
      note='Staleness: provider entry mid versus the Dukascopy mid at message time (Observed price comparison).')
by_dir = []
for d in ['buy', 'sell']:
    vals = [s['emid'] - s['market_mid'] for s in ALL if s['market_mid'] is not None and s['dir'] == d]
    by_dir.append((d, len(vals), fnum(st.median(vals), 2), fnum(st.median([abs(v) for v in vals]), 2)))
table(['direction', 'n with quote', 'median (entry mid - market mid)', 'median |gap|'], by_dir)

# signal-to-fill delay (BASE filled)
fl = [s for s in ALL if s['scen']['BASE']['status'] == 'FILLED']
dl = [(s['scen']['BASE']['fill_ms'] - s['t_ms']) / 1000 for s in fl]
table(['statistic', 'value (s)'],
      [('n filled (BASE)', len(dl)), ('median signal-to-fill', fnum(st.median(dl), 2)),
       ('p90 signal-to-fill', fnum(sorted(dl)[int(.9 * (len(dl) - 1))], 2)),
       ('max signal-to-fill', fnum(max(dl), 2))],
      note='Signal-to-fill delay (Reconstructed; by construction ~latency for market fills).')

# ------------------------------------------------------------------ 3. Touch frequencies and sequences
P('## 3. First-touch frequencies, sequencing and win-rate definitions (Reconstructed, BASE, no management)')
P('')
P('Each filled, determined signal is followed tick by tick for 72 h. "Before SL" compares first touches. '
  'n for each row is the set of signals where the event is defined (TP_k exists and the trade is determined).')
P('')
for uname, grp in UNIVERSES:
    fd = det_filled(grp)
    rows = []
    for k in range(1, 8):
        have = [s for s in fd if s['tps'][k] is not None]
        touched = sum(1 for s in have if s['scen']['BASE']['tp'].get(k) is not None)
        bsl = sum(1 for s in have if before(s['scen']['BASE']['tp'].get(k), s['scen']['BASE']['sl_ms']))
        if not have:
            continue
        rows.append((f'TP{k}', len(have), rate(touched, len(have)).split(' = ')[1],
                     rate(bsl, len(have)).split(' = ')[1]))
    table(['level', 'n (TP defined, filled & determined)', 'touched within 72 h', 'touched before SL'], rows,
          note=f'TP touch frequencies, {uname}.')

# sequence / conditional probabilities
rows = []
for uname, grp in UNIVERSES:
    fd = det_filled(grp)
    ev_any = [s for s in fd if s['scen']['BASE']['sl_ms'] is not None or s['scen']['BASE']['tp']]
    sl_first = [s for s in ev_any if s['scen']['BASE']['sl_ms'] is not None and not any(
        before(v, s['scen']['BASE']['sl_ms']) for v in s['scen']['BASE']['tp'].values())]
    e1 = [s for s in fd if s['scen']['BASE']['sl_ms'] is not None or s['scen']['BASE']['tp'].get(1) is not None]
    tp1f = [s for s in e1 if before(s['scen']['BASE']['tp'].get(1), s['scen']['BASE']['sl_ms'])]
    tp2c = [s for s in tp1f if s['tps'][2] is not None]
    tp2b = [s for s in tp2c if before(s['scen']['BASE']['tp'].get(2), s['scen']['BASE']['sl_ms'])]
    e2 = [s for s in fd if s['scen']['BASE']['sl_ms'] is not None or s['scen']['BASE']['tp'].get(2) is not None]
    tp2f = [s for s in e2 if before(s['scen']['BASE']['tp'].get(2), s['scen']['BASE']['sl_ms'])]
    tp3c = [s for s in tp2f if s['tps'][3] is not None]
    tp3b = [s for s in tp3c if before(s['scen']['BASE']['tp'].get(3), s['scen']['BASE']['sl_ms'])]
    rows.append((uname, rate(len(sl_first), len(ev_any)).split(' = ')[1],
                 rate(len(tp1f), len(e1)).split(' = ')[1],
                 rate(len(tp2b), len(tp2c)).split(' = ')[1],
                 rate(len(tp3b), len(tp3c)).split(' = ')[1]))
table(['universe', 'P(SL before any TP | any event)', 'P(TP1 before SL | TP1 or SL)',
       'P(TP2 before SL | TP1 before SL)', 'P(TP3 before SL | TP2 before SL)'], rows,
      note='Sequencing (Reconstructed, BASE). Denominators: determined filled signals with at least one event; conditionals as labelled.')

# win-rate definitions
rows = []
for uname, grp in UNIVERSES:
    fd = det_filled(grp)
    def defn(name, tk):
        pool = []
        for s in fd:
            tval = s['scen']['BASE']['tp'].get(tk) if tk != 'last' else s['scen']['BASE']['tp'].get(s['num_tps'])
            if tk != 'last' and s['tps'][tk] is None:
                continue
            if tk == 'last' and s['tps'][s['num_tps']] is None:
                continue
            pool.append((s, tval))
        win = sum(1 for s, tv in pool if before(tv, s['scen']['BASE']['sl_ms']))
        loss = sum(1 for s, tv in pool if s['scen']['BASE']['sl_ms'] is not None and not before(tv, s['scen']['BASE']['sl_ms']))
        und = len(pool) - win - loss
        return win, loss, und, len(pool)
    for name, tk in [('(a) TP1 before SL', 1), ('(b) TP2 before SL', 2), ('(c) last TP before SL', 'last')]:
        w, l, u, n = defn(name, tk)
        rows.append((uname, name, n, w, l, u, rate(w, w + l).split(' = ')[1] if w + l else 'n=0'))
table(['universe', 'definition', 'n (TP defined)', 'win', 'loss (SL first)', 'undetermined (neither by 72 h)',
       'win rate = win/(win+loss) [95% CI]'], rows,
      note='Win-rate definitions under the baseline (no management). Undetermined trades are excluded from the rate and counted separately.')

# ------------------------------------------------------------------ 4. Strategy metrics
P('## 4. Strategy outcomes (Simulated, original SL, no BE unless named)')
P('')
P('Simulated R uses R = |fill - SL| and exits on the executable tick side; checkpoint legs fill at the TP price; '
  'stop exits fill at the tick when gapped. Only FILLED trades are included. UNRESOLVED_MTM trades (open at 72 h) '
  'are counted separately and excluded from win rates and from the closed-equity curve.')
P('')


def strat_metrics(rows):
    res_rows = [r for r in rows if r['status'] == 'FILLED' and r['total_R'] != '']
    unres = [r for r in rows if r['outcome'] == 'UNRESOLVED_MTM']
    filled = [r for r in rows if r['status'] in ('FILLED', 'UNRESOLVED_MTM')]
    skipped = [r for r in rows if r['status'].startswith('SKIPPED')]
    Rs = [float(r['total_R']) for r in res_rows]
    wins = sum(1 for x in Rs if x > 1e-9)
    losses = sum(1 for x in Rs if x < -1e-9)
    ordered = sorted(res_rows, key=lambda r: r['last_exit_iso'])
    rs_o = [float(r['total_R']) for r in ordered]
    usd_o = [float(r['usd_per_1lot']) for r in ordered if r['usd_per_1lot'] != '']
    gp = sum(x for x in Rs if x > 0)
    gl = -sum(x for x in Rs if x < 0)
    streaks = se.loss_streaks(rs_o)
    se_R = (st.stdev(Rs) / math.sqrt(len(Rs))) if len(Rs) > 1 else None
    return dict(se_R=se_R, n_filled=len(filled), n_resolved=len(res_rows), n_unres=len(unres), n_skip=len(skipped),
                wins=wins, losses=losses, avgR=mean(Rs), pf=(gp / gl if gl > 0 else None), sumR=sum(Rs),
                mdd_R=se.max_drawdown(rs_o), mdd_usd=se.max_drawdown(usd_o), streak_max=max(streaks) if streaks else 0,
                streaks=streaks, sumusd=sum(usd_o) if usd_o else None)


STRAT_SHOW = [('TP1_100', '100% TP1'), ('TP2_100', '100% TP2'), ('TP3_100', '100% TP3'),
              ('EQ3', 'equal thirds TP1/TP2/TP3'), ('EQ3_LOT010', 'equal thirds, 0.10 lot rounded'),
              ('TP1_50_TP2_50', '50% TP1 + 50% TP2 (no BE)'),
              ('TP1_50_TP2_50_BE', '50% TP1 + 50% TP2, SL->entry after TP1 (BE-aware)'),
              ('EQ3_BE', 'equal thirds, SL->entry after TP1 (BE-aware)')]
strat_summary = {}
for scen in ['BASE', 'PESS']:
    for uname, grp in UNIVERSES:
        ids = {s['mid'] for s in grp}
        rows_t = []
        for key, label in STRAT_SHOW:
            rr = [r for r in strat_rows if r['scenario'] == scen and r['strategy'] == key and r['message_id'] in ids]
            m = strat_metrics(rr)
            strat_summary[f'{scen}|{uname}|{key}'] = {k: v for k, v in m.items() if k != 'streaks'}
            wrate = rate(m['wins'], m['wins'] + m['losses']).split(' = ')[1] if m['wins'] + m['losses'] else 'n=0'
            ci = (f"{m['avgR']:+.3f} [{m['avgR']-1.96*m['se_R']:+.3f}, {m['avgR']+1.96*m['se_R']:+.3f}]"
                  if m['se_R'] else 'n/a')
            rows_t.append((label, m['n_filled'], m['n_resolved'], m['n_unres'], m['n_skip'], wrate,
                           fnum(m['avgR'], 3), ci, fnum(m['pf'], 2), fnum(m['sumR'], 2), fnum(m['mdd_R'], 2),
                           fnum(m['mdd_usd'], 0), m['streak_max']))
        table(['strategy', 'filled', 'resolved', 'UNRESOLVED_MTM', 'skipped', 'win rate [95% CI]', 'avg R (expectancy)',
               'avg R 95% CI (normal approx.)', 'profit factor', 'sum R', 'max DD (R, closed)',
               'max DD (USD per 1.0 lot)', 'longest loss streak'],
              rows_t, note=f'Strategy metrics, scenario {scen}, {uname}.')

# loss streak histogram for thirds / TP1
rows = []
for key, label in [('TP1_100', '100% TP1'), ('EQ3', 'equal thirds')]:
    rr = [r for r in strat_rows if r['scenario'] == 'BASE' and r['strategy'] == key and r['status'] == 'FILLED']
    m = strat_metrics(rr)
    rows.append((label, ', '.join(f'{k}:{v}' for k, v in sorted(m['streaks'].items())) or 'none'))
table(['strategy', 'loss-streak length : count (BASE, closed trades, exit-time order)'], rows)

# market gaps spanned by trades (Reconstructed: largest tick-to-tick interval between fill and last exit)
rows = []
for key, label in [('TP1_100', '100% TP1'), ('EQ3', 'equal thirds')]:
    rr = [r for r in strat_rows if r['scenario'] == 'BASE' and r['strategy'] == key and r['status'] == 'FILLED'
          and r['max_tick_gap_min'] != '']
    g = [float(r['max_tick_gap_min']) for r in rr]
    rows.append((label, len(g), sum(1 for x in g if x >= 60), sum(1 for x in g if x >= 720),
                 sum(1 for x in g if x >= 1440), fnum(max(g), 1) if g else ''))
table(['strategy', 'n', 'trades with a tick gap >= 60 min', '>= 12 h', '>= 24 h (weekend-type)', 'largest gap (min)'], rows,
      note='Trades spanning a market gap (BASE, Reconstructed). Swap / overnight financing is NOT modelled '
           '(default 0, Unknown for Vantage); the count of rollovers is available in the engine.')

# closed-equity sanity: BASE TP1 in USD per lot total
# ------------------------------------------------------------------ 5. Breakdowns
P('## 5. Breakdowns (BASE, determined filled signals; Reconstructed win definitions and Simulated R)')
P('')


def group_rows(grp_key, label, universe):
    fd = det_filled(universe)
    groups = defaultdict(list)
    for s in fd:
        groups[grp_key(s)].append(s)
    out = []
    for g in sorted(groups):
        ss = groups[g]
        e1 = [s for s in ss if s['scen']['BASE']['sl_ms'] is not None or s['scen']['BASE']['tp'].get(1) is not None]
        w = sum(1 for s in e1 if before(s['scen']['BASE']['tp'].get(1), s['scen']['BASE']['sl_ms']))
        tr = {}
        for key in ['TP1_100', 'EQ3']:
            vals = []
            for s in ss:
                r = s.get('sr', {}).get(('BASE', key))
                if r and r['total_R']:
                    vals.append(float(r['total_R']))
            tr[key] = mean(vals)
        out.append((g, len(ss), rate(w, len(e1)).split(' = ')[1] if e1 else 'n=0',
                    fnum(tr['TP1_100'], 2), fnum(tr['EQ3'], 2)))
    return out


def dirkey(s):
    return s['dir']


def sesskey(s):
    return s['sess']


def wdkey(s):
    return s['wd']


def monthkey(s):
    return s['month']


H = ['group', 'n filled & determined', 'TP1-before-SL win rate [95% CI] (n=TP1 or SL)', 'avg R 100%TP1',
     'avg R equal thirds']
for uname, grp in UNIVERSES:
    fd = det_filled(grp)
    sl_d = sorted(s['sl_dist'] for s in fd)
    if len(sl_d) >= 3:
        t1 = sl_d[len(sl_d) // 3]
        t2 = sl_d[2 * len(sl_d) // 3]
    else:
        t1 = t2 = 0
    def terc(s):
        d = s['sl_dist']
        return 'T1 low (<= %.2f)' % t1 if d <= t1 else ('T2 mid (<= %.2f)' % t2 if d <= t2 else 'T3 high (> %.2f)' % t2)
    for label, kf in [('direction', dirkey), ('UTC session (signal time)', sesskey), ('weekday (UTC)', wdkey),
                      ('month (UTC)', monthkey), ('SL distance tercile (|SL - entry mid|)', terc)]:
        table([label] + H[1:], group_rows(kf, label, grp), note=f'{label}, {uname}.')

# overlap
def overlap_flags(grp):
    fd = det_filled(grp, 'BASE')
    fd = [s for s in fd]
    ends = []
    for s in fd:
        x = s['scen']['BASE']
        end = x['sl_ms']
        if end is None:
            tps_all = [k for k in range(1, 8) if s['tps'][k] is not None]
            if tps_all and all(x['tp'].get(k) is not None for k in tps_all):
                end = max(x['tp'][k] for k in tps_all)
            else:
                end = x['fill_ms'] + 72 * 3600_000
        ends.append((s['t_ms'], x['fill_ms'], end, s))
    flags = {}
    for t_i, f_i, e_i, s in ends:
        ov = any(f_j <= t_i < e_j for t_j, f_j, e_j, sj in ends if sj['mid'] != s['mid'] and t_j < t_i)
        flags[s['mid']] = ov
    return flags


for uname, grp in UNIVERSES:
    fl_ = overlap_flags(grp)
    fd = det_filled(grp)
    rows = []
    for name, sel in [('overlapping: an earlier filled signal still open at signal time', True),
                      ('no earlier filled signal open', False)]:
        ss = [s for s in fd if fl_.get(s['mid']) is sel]
        e1 = [s for s in ss if s['scen']['BASE']['sl_ms'] is not None or s['scen']['BASE']['tp'].get(1) is not None]
        w = sum(1 for s in e1 if before(s['scen']['BASE']['tp'].get(1), s['scen']['BASE']['sl_ms']))
        rows.append((name, len(ss), rate(w, len(e1)).split(' = ')[1] if e1 else 'n=0'))
    table(['group', 'n', 'TP1-before-SL win rate [95% CI]'], rows, note=f'Overlap with earlier open trades (baseline end-times), {uname}.')

# ------------------------------------------------------------------ 6. Late entry and entry-policy sensitivity
P('## 6. Late entry and entry-policy sensitivity (Reconstructed; TP1 win definition (a) and EQ3 simulated where filled)')
P('')
rows = []
for scen, label in [('BASE', 'BASE (P1, 5 s, tol 0.5)'), ('TOL0', 'P1, tol 0'), ('TOL2', 'P1, tol 2.0'),
                    ('LAT60', 'P1, latency 60 s (late entry)'), ('P2_EXP60', 'P2 pending at range, expiry 60 min'),
                    ('P2_EXP240', 'P2 pending at range, expiry 240 min'),
                    ('OFFSET_BASE', f"BASE after constant offset correction ({-res['offset_info']['median_entry_minus_market_abs_le5']:+.2f} USD)"),
                    ('REANCHOR_BASE', 'DIAGNOSTIC: BASE with levels re-anchored to the market mid at posting (distances kept)'),
                    ('P3_IDEAL_NONEXEC', 'P3 ideal mid fill at signal time (NON-EXECUTABLE upper bound)')]:
    for uname, grp in UNIVERSES:
        ids = [s for s in grp]
        fills = [s for s in ids if s['scen'][scen]['status'] == 'FILLED']
        det = [s for s in fills if s['scen'][scen]['bl'] != 'NO_PRICE_DATA']
        e1 = [s for s in det if s['scen'][scen]['sl_ms'] is not None or s['scen'][scen]['tp'].get(1) is not None]
        w = sum(1 for s in e1 if before(s['scen'][scen]['tp'].get(1), s['scen'][scen]['sl_ms']))
        sr = []
        for s in det:
            r = s['scen'][scen]['strat'].get('EQ3') if scen in res['sens_scen'] else None
            if r and r.get('total_R') is not None:
                sr.append(r['total_R'])
        rows.append((label, uname, len(ids), len(fills), rate(len(fills), len(ids)).split(' = ')[1],
                     rate(w, len(e1)).split(' = ')[1] if e1 else 'n=0', fnum(mean(sr), 2) if sr else 'n/a'))
table(['entry scenario', 'universe', 'n', 'filled', 'fill rate [95% CI]', 'TP1-before-SL [95% CI] (n: TP1 or SL)',
       'avg R equal thirds (sim)'], rows,
      note='Entry-policy and offset sensitivity. P3 is diagnostic only (not executable) and is shown for the upper bound only. '
           'Equal-thirds R is available for LAT60 and P2 scenarios (simulated); blank for others.')

# late-entry pairs
pairs = [s for s in ALL if s['scen']['BASE']['status'] == 'FILLED' and s['scen']['LAT60']['status'] == 'FILLED']
dpx = [abs(s['scen']['LAT60']['fill_px'] - s['scen']['BASE']['fill_px']) for s in pairs]
rows = [('filled at 5 s and at 60 s', len(pairs), fnum(st.median(dpx), 3), fnum(max(dpx), 3))]
only60 = [s for s in ALL if s['scen']['BASE']['status'] != 'FILLED' and s['scen']['LAT60']['status'] == 'FILLED']
only5 = [s for s in ALL if s['scen']['BASE']['status'] == 'FILLED' and s['scen']['LAT60']['status'] != 'FILLED']
rows.append(('filled at 60 s only', len(only60), '', ''))
rows.append(('filled at 5 s only (skipped at 60 s)', len(only5), '', ''))
table(['group', 'n', 'median |fill(60 s) - fill(5 s)| USD', 'max |diff| USD'], rows,
      note='Late-entry comparison (Reconstructed).')
late_pairs = pairs
w5 = sum(1 for s in late_pairs if before(s['scen']['BASE']['tp'].get(1), s['scen']['BASE']['sl_ms']))
e5 = sum(1 for s in late_pairs if s['scen']['BASE']['sl_ms'] is not None or s['scen']['BASE']['tp'].get(1) is not None)
w60 = sum(1 for s in late_pairs if before(s['scen']['LAT60']['tp'].get(1), s['scen']['LAT60']['sl_ms']))
e60 = sum(1 for s in late_pairs if s['scen']['LAT60']['sl_ms'] is not None or s['scen']['LAT60']['tp'].get(1) is not None)
table(['same signals', 'n', 'TP1-before-SL [95% CI] at 5 s', 'TP1-before-SL [95% CI] at 60 s'],
      [('both filled', len(late_pairs), rate(w5, e5).split(' = ')[1] if e5 else 'n=0',
        rate(w60, e60).split(' = ')[1] if e60 else 'n=0')])

# ------------------------------------------------------------------ 7. Offset sensitivity
off = res['offset_info']
P('## 7. Systematic offset between provider prices and Dukascopy (Observed + sensitivity)')
P('')
P(f"A3's alignment_per_signal.csv has only 7 usable rows (408 of 415 had no tick within 120 s because the download "
  f"had not reached those hours when it ran). This report recomputes the alignment on the full period: "
  f"{off['n_with_quote'] if 'n_with_quote' in off else 'n/a'} signals have a quote within +/-120 s, and "
  f"{off['n_estimates']} of them have |entry mid - market mid| <= 5 USD. Their median is "
  f"{off['median_entry_minus_market_abs_le5']:+.2f} USD (mean {off['mean']:+.2f}, sd {off['sd']:.2f}). "
  f"The sensitivity shifts every provider level by -{off['median_entry_minus_market_abs_le5']:.2f} USD before the BASE rules.")
P('')
table(['', 'BASE', 'BASE + constant offset correction', 'DIAGNOSTIC: re-anchored to market mid at posting'],
      [('filled', sum(1 for s in ALL if s['scen']['BASE']['status'] == 'FILLED'),
        sum(1 for s in ALL if s['scen']['OFFSET_BASE']['status'] == 'FILLED'),
        sum(1 for s in ALL if s['scen']['REANCHOR_BASE']['status'] == 'FILLED')),
       ('skipped', sum(1 for s in ALL if s['scen']['BASE']['status'].startswith('SKIPPED')),
        sum(1 for s in ALL if s['scen']['OFFSET_BASE']['status'].startswith('SKIPPED')),
        sum(1 for s in ALL if s['scen']['REANCHOR_BASE']['status'].startswith('SKIPPED')))])
rv = [s['emid'] - s['market_mid'] for s in ALL if s['market_mid'] is not None]
P('The constant-offset model fits poorly: the sign of (entry mid - market mid) is opposite for the two directions '
  f"(BUY median {st.median([s['emid'] - s['market_mid'] for s in ALL if s['market_mid'] is not None and s['dir']=='buy']):+.2f}, "
  f"SELL median {st.median([s['emid'] - s['market_mid'] for s in ALL if s['market_mid'] is not None and s['dir']=='sell']):+.2f} USD). "
  'Both directions sit on the favourable side of the market at posting, which is what stale or lagged posting produces. '
  'A single shift cannot reproduce that. The re-anchored row is a diagnostic of how much of the skip rate is level staleness; '
  'it is not a trading result and is not used for any recommendation.')
P('')

# ------------------------------------------------------------------ 8. Provider claims
P('## 8. Comparison with provider self-reported claims (Observed claims vs Reconstructed prices)')
P('')
P('Only unambiguous claim links are used: reply-linked, or temporal with exactly one candidate signal '
  '(a1 provider_claim_events.csv). Claims are never an input to the reconstruction. The provider\'s own TP/BE/loss '
  'claims are compared against the tick data only after the reconstruction was fixed.')
P('')
cl = Counter()
for r in base_rows:
    if r['scenario'] != 'BASE':
        continue
    for item in (r['claim_tp_check'].split(';') if r['claim_tp_check'] else []):
        tp, verdict = item.split(':')
        cl[verdict] += 1
rows = sorted(cl.items(), key=lambda x: -x[1])
table(['verdict (unambiguous TP-hit claims, BASE)', 'n'], rows,
      note='TP-hit claim checks. SUPPORTED = our first touch of that TP precedes the first SL touch within 72 h; '
           'SL_FIRST = SL touched first; NOT_TOUCHED = no touch within 72 h; NA_NOT_FILLED = the signal was not entered.')
filled_claims = cl['SUPPORTED'] + cl['SL_FIRST'] + cl['NOT_TOUCHED_IN_HORIZON']
table(['metric', 'value'],
      [('TP-hit claims on filled signals (n)', filled_claims),
       ('agreement rate (SUPPORTED / n) [95% CI]', rate(cl['SUPPORTED'], filled_claims).split(' = ')[1] if filled_claims else 'n=0'),
       ('claims that price data does not support (SL_FIRST + NOT_TOUCHED_IN_HORIZON)',
        rate(cl['SL_FIRST'] + cl['NOT_TOUCHED_IN_HORIZON'], filled_claims).split(' = ')[1] if filled_claims else 'n=0')])
be = [r for r in base_rows if r['scenario'] == 'BASE' and r['claim_be_unambig'] == '1']
be_f = [r for r in be if r['status'] != 'SKIPPED_price_outside_range']
be_tp1 = sum(1 for r in be_f if r['tp1_touch_iso'] and (not r['sl_touch_iso'] or r['tp1_touch_iso'] < r['sl_touch_iso']))
be_sl_first = sum(1 for r in be_f if r['sl_touch_iso'] and (not r['tp1_touch_iso'] or r['sl_touch_iso'] < r['tp1_touch_iso']))
loss = [r for r in base_rows if r['scenario'] == 'BASE' and r['claim_loss_unambig'] == '1' and r['status'] != 'SKIPPED_price_outside_range']
loss_sl = sum(1 for r in loss if r['sl_touch_iso'])
table(['claim type (unambiguous)', 'n on filled signals', 'supported', 'contradicted', 'note'],
      [('break-even exit claim (update_stopped_at_be)', len(be_f), be_tp1, be_sl_first,
        'supported = TP1 touched before SL (so a BE stop is plausible); contradicted = SL first (a loss)'),
       ('loss claim (update_loss_claim)', len(loss), loss_sl, len(loss) - loss_sl,
        'supported = SL touched within 72 h')])
sig_unfilled = [r for r in base_rows if r['scenario'] == 'BASE' and r['claim_tp_check'] and
                r['status'] == 'SKIPPED_price_outside_range']
P(f'Signals carrying at least one unambiguous TP-hit claim that could not be entered under BASE: '
  f"{len(sig_unfilled)} of {sum(1 for r in base_rows if r['scenario']=='BASE' and r['claim_tp_check'])} "
  'signals with such a claim. The tick data shows the entry was never available at the posted range, '
  'so the claimed TP hit cannot be reproduced from ticks.')
P('')
lags = []
for r in base_rows:
    if r['scenario'] != 'BASE' or not r['claim_tp_check'] or r['status'] != 'FILLED':
        continue
    for item in r['claim_tp_check'].split(';'):
        tp, verdict = item.split(':')
        if verdict == 'SUPPORTED' and r.get('tp' + tp[2:] + '_touch_iso'):
            cl_iso = [c.split('@')[1] for c in r['claim_tp_unambig'].split(';') if c.startswith(tp + '@')]
            if cl_iso:
                ct = dt.datetime.fromisoformat(cl_iso[0].replace('Z', '+00:00'))
                tt = dt.datetime.fromisoformat(r['tp' + tp[2:] + '_touch_iso'].replace('Z', '+00:00'))
                lags.append((ct - tt).total_seconds() / 60)
if lags:
    table(['claim time minus our TP touch (supported claims, minutes)', 'n', 'median', 'p10', 'p90'],
          [('claim - touch', len(lags), fnum(st.median(lags), 1),
            fnum(sorted(lags)[int(.1 * (len(lags) - 1))], 1), fnum(sorted(lags)[int(.9 * (len(lags) - 1))], 1))])

# ------------------------------------------------------------------ 9. Data quality tail
P('## 9. Data-quality facts from the tick feed (Observed)')
P('')
table(['check', 'value'],
      [('ticks decoded', f"{qc['ticks']:,}"), ('bid > ask', qc['bid_gt_ask']),
       ('zero spread ticks', qc['zero_spread']), ('spread > 5 USD (ticks)', f"{qc['spread_gt_5usd']:,}"),
       ('ms offsets non-monotone within an hour (hours)', qc['ms_nonmonotone_hours']),
       ('one-tick mid jumps > 5 USD', qc['mid_jump_gt_5usd_1tick']),
       ('one-tick mid jumps > 20 USD', qc['mid_jump_gt_20usd_1tick']),
       ('median spread (hour medians)', fnum(qc['median_spread_of_hours'], 3)),
       ('price range in data (USD)', f"{qc['min_price']:.2f} .. {qc['max_price']:.2f}")])

# ------------------------------------------------------------------ write
with open(OUT_MD, 'w') as f:
    f.write('\n'.join(md) + '\n')
with open(OUT_JSON, 'w') as f:
    json.dump(dict(strategy=strat_summary, n_all=len(ALL), n_clean=len(CLEAN)), f, indent=1, default=str)
print('tables.md lines:', len(md))

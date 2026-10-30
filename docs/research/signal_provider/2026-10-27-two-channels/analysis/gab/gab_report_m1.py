import json, re, random, collections, statistics as st, datetime as dt
SIM = json.load(open("/tmp/claude-1001/twochan/gab/study/sim_m1.json"))
M = json.load(open("/tmp/claude-1001/twochan/gab/live/messages.json")); M.sort(key=lambda m: m['ID'])
live_ids = {m['ID'] for m in M}
D = lambda s: dt.datetime.utcfromtimestamp(s).strftime('%Y-%m-%d')
random.seed(7)
KEYS = [f'{m}_{t}_{x}' for m in ('market', 'level') for t in ('tp1', 'tp2', 'tplast') for x in ('pess', 'opt')]
def summ(rows, key):
    R = [o[key]['R'] for o in rows if 'R' in o[key]]
    s = dict(status=dict(collections.Counter(o[key]['status'] for o in rows)))
    if not R: return dict(n=0, **s)
    gp = sum(x for x in R if x > 0); gl = -sum(x for x in R if x < 0)
    eq = peak = dd = 0
    for x in R: eq += x; peak = max(peak, eq); dd = max(dd, peak - eq)
    bs = sorted(st.mean(random.choices(R, k=len(R))) for _ in range(2000)) if len(R) >= 5 else None
    return dict(n=len(R), win=round(sum(x > 0 for x in R) / len(R), 3), meanR=round(st.mean(R), 3),
                ci95=(round(bs[50], 3), round(bs[1949], 3)) if bs else None, sumR=round(sum(R), 1),
                pf=round(gp / gl, 2) if gl else None, maxDD_R=round(dd, 1),
                ambiguous=sum(1 for o in rows if o[key].get('amb')), **s)
res = {}
for ph in ['ALL'] + sorted({o['phase'] for o in SIM}):
    rows = [o for o in SIM if ph == 'ALL' or o['phase'] == ph]
    res[ph] = dict(n_signals=len(rows), span=(D(rows[0]['date']), D(rows[-1]['date'])),
                   buys=sum(o['side'] == 'BUY' for o in rows), **{k: summ(rows, k) for k in KEYS})
# monthly, market_tp1 (pess/opt)
mon = collections.defaultdict(list)
for o in SIM: mon[D(o['date'])[:7]].append(o)
res['monthly_market_tp1'] = {k: dict(n=len(v), pess=summ(v, 'market_tp1_pess').get('meanR'), opt=summ(v, 'market_tp1_opt').get('meanR'),
                                     win_pess=summ(v, 'market_tp1_pess').get('win')) for k, v in sorted(mon.items())}
# geometry of the posted signal
rr = []; risk = []; late = 0; n = 0
for o in SIM:
    if o['market_only']: continue
    buy = o['side'] == 'BUY'; e = o['entry_hi'] if buy else o['entry_lo']
    risk.append(abs(e - o['sl'])); rr.append(abs(o['tps'][0] - e) / max(1e-9, abs(e - o['sl'])))
    f = o['market_tp1_pess'].get('first')
    if f:
        n += 1; px = f[2] if buy else f[1]
        if (buy and px >= o['tps'][0]) or (not buy and px <= o['tps'][0]): late += 1
res['geometry'] = dict(median_risk_usd=round(st.median(risk), 2), median_tp1_reward_to_risk=round(st.median(rr), 2),
                       breakeven_winrate_tp1=round(1 / (1 + st.median(rr)), 3), price_already_past_tp1_at_follow=late, of=n)
# edits relative to outcome (market_tp1_pess)
ea = collections.Counter()
for o in SIM:
    x = o['market_tp1_pess']
    if not o['edit']: ea['not_edited'] += 1
    elif 't_exit' not in x: ea['edited_no_outcome'] += 1
    else: ea[f"edited_{'after' if o['edit'] > x['t_exit'] else 'before'}_{x['status']}"] += 1
res['edits_vs_outcome'] = dict(ea)
lags = sorted(o['edit'] - o['date'] for o in SIM if o['edit'])
res['signal_edit_lag_s'] = dict(n=len(lags), median=lags[len(lags) // 2], p90=lags[int(.9 * len(lags))]) if lags else {}
# deletions in the 5 ids after each signal, by outcome
dl = collections.defaultdict(lambda: [0, 0])
for o in SIM:
    k = o['market_tp1_pess']['status']; k = k if k in ('tp', 'sl') else 'other'
    dl[k][0] += 1; dl[k][1] += sum(1 for i in range(o['id'] + 1, o['id'] + 6) if i not in live_ids)
res['deleted_ids_next5'] = {k: dict(signals=a, deleted=b, per_signal=round(b / a, 2)) for k, (a, b) in dl.items()}
res['base_deleted_share_of_ids'] = round(1 - len(M) / M[-1]['ID'], 3)
# win/loss claims within 24h after each signal, split by simulated outcome
WIN = re.compile(r"tp\s*\d?\s*(hit|done)|boo+m|\+\s*\d+\s*pips|kawkaw|profit", re.I)
LOSS = re.compile(r"\bsl\b\s*hit|stopped out|hit sl|loss\b", re.I)
cl = collections.Counter()
for o in SIM:
    k = o['market_tp1_pess']['status']; k = k if k in ('tp', 'sl') else 'other'
    nxt = [m for m in M if m['ID'] > o['id'] and 0 < m['Date'] - o['date'] < 86400]
    cl[f'{k}|n'] += 1
    cl[f'{k}|win_claim'] += any(WIN.search(m.get('Text') or '') for m in nxt)
    cl[f'{k}|loss_mention'] += any(LOSS.search(m.get('Text') or '') for m in nxt)
res['claims_24h'] = dict(sorted(cl.items()))
json.dump(res, open("/tmp/claude-1001/twochan/gab/study/report_m1.json", "w"), indent=1, default=str)
print(json.dumps(res, indent=1, default=str))

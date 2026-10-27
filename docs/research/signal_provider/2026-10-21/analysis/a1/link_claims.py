# Task 4: link provider update/result messages to signals.
# Rule order per claim: (1) reply_to_msg_id pointing at a signal -> 'reply';
# (2) else temporal: candidates = signals posted <= claim, within WINDOW_DAYS, not yet closed by an
#     exit claim, and (for TP claims) with num_tps >= n and n > highest TP already claimed.
#     Pick the most recent candidate. Candidate count is recorded as ambiguity.
# Exit claims (stopped at BE / loss / close) close the chosen signal. Pips / running / BE-move /
# level-mention claims attach as status and do not change state. All of this is PROVIDER-CLAIMED.
import json, csv, re, sys, collections, statistics
from datetime import datetime, timezone, timedelta
S='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
WINDOW_DAYS = 7
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
byid = {r['message_id']: r for r in d}
cls = {int(r['message_id']): r for r in csv.DictReader(open(S+'/classes.csv', encoding='utf-8'))}
def pdt(s):
    fmt = '%Y-%m-%dT%H:%M:%S.%fZ' if '.' in s else '%Y-%m-%dT%H:%M:%SZ'
    return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
def iso(dt): return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
EXIT = {'update_stopped_at_be', 'update_loss_claim', 'update_close', 'update_exit_generic'}
TP = {'update_tp_hit'}
STATUS = {'update_pips_claim', 'update_running', 'update_be_mgmt', 'tp_level_mention', 'sl_level_mention', 'update_sl_hit'}
CLAIM = EXIT | TP | STATUS
sig = {}   # id -> state
order = []
events = []
for mid in sorted(cls, key=lambda x: x):
    c = cls[mid]
    r = byid[str(mid)]
    if c['class'] == 'new_signal':
        s = r['signal']
        sig[mid] = dict(id=mid, date=pdt(r['date']), num_tps=len(s['takeProfits']), direction=s['direction'],
                        mid_price=(s['entryLow']+s['entryHigh'])/2, tps=s['takeProfits'], max_tp=0, closed=False,
                        closed_by=None, claims=[], close_date=None)
        order.append(mid)
        continue
    if c['class'] not in CLAIM:
        continue
    t = pdt(r['date'])
    text = r['text']
    n = None
    if c['class'] == 'update_tp_hit':
        m = re.search(r'\bTP\s*(\d)\b|\bTAKE\s+PROFIT\s*(\d)\b|\bHIT\s*#?(\d)\b', text, re.I)
        if m: n = int([g for g in m.groups() if g][0])
    reply = r['reply_to_msg_id']
    method = None; cands = []; target = None
    if reply and int(reply) in sig:
        target = sig[int(reply)]; method = 'reply'; cands = [target]
    else:
        cands = [s for s in sig.values() if s['date'] <= t and (t - s['date']) <= timedelta(days=WINDOW_DAYS) and not s['closed']]
        if c['class'] == 'update_tp_hit':
            want = n if n is not None else None
            cands = [s for s in cands if s['num_tps'] >= (want or (s['max_tp']+1)) and (want or (s['max_tp']+1)) > s['max_tp']]
        cands.sort(key=lambda s: s['id'])
        if cands:
            target = cands[-1]; method = 'temporal'
        else:
            method = 'unlinked'
    # state update
    if target is not None:
        if c['class'] == 'update_tp_hit':
            nn = n if n is not None else target['max_tp']+1
            target['max_tp'] = max(target['max_tp'], nn)
            if target['max_tp'] >= target['num_tps']:
                target['closed'] = True; target['closed_by'] = 'final_tp'; target['close_date'] = t
        elif c['class'] in EXIT:
            target['closed'] = True; target['closed_by'] = c['class']; target['close_date'] = t
        target['claims'].append((mid, c['class'], t, n, method))
    pips = re.search(r'([+-]?\s*\d+(?:[.,]\d+)?)\s*PIPS?', text, re.I)
    events.append({'claim_msg_id': mid, 'claim_utc': iso(t), 'claim_class': c['class'], 'tp_index': n if n is not None else '',
                   'pips_mentioned': pips.group(1).replace(' ','') if pips and c['class']=='update_tp_hit' else '',
                   'link_method': method or 'unlinked', 'reply_to_msg_id': reply or '',
                   'signal_msg_id': target['id'] if target else '', 'signal_utc': iso(target['date']) if target else '',
                   'candidates_n': len(cands), 'lag_hours': round((t - target['date']).total_seconds()/3600, 2) if target else '',
                   'text_excerpt': text.replace('\n', ' | ')[:120]})
with open(S+'/provider_claim_events.csv','w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f, fieldnames=list(events[0].keys())); w.writeheader(); w.writerows(events)
# per-signal summary (provider_claims.csv)
rows=[]
for sid in order:
    s=sig[sid]
    tpc=[f"TP{n if n else '?'}@{iso(t)}(msg {mid})" for (mid,k,t,n,mth) in s['claims'] if k=='update_tp_hit']
    exits=[f"{k}@{iso(t)}(msg {mid})" for (mid,k,t,n,mth) in s['claims'] if k in EXIT]
    status=[f"{k}@{iso(t)}(msg {mid})" for (mid,k,t,n,mth) in s['claims'] if k in STATUS]
    methods=collections.Counter(mth for (*_,mth) in s['claims'])
    if s['claims']:
        first=min(t for (_,_,t,_,_) in s['claims']); last=max(t for (_,_,t,_,_) in s['claims'])
    else:
        first=last=None
    rows.append({'signal_msg_id': sid, 'signal_utc': iso(s['date']), 'direction': s['direction'], 'num_tps': s['num_tps'],
                 'n_linked_claims': len(s['claims']), 'link_methods': ';'.join(f'{k}:{v}' for k,v in methods.items()),
                 'tp_claims_provider': ' ; '.join(tpc), 'max_tp_claimed': s['max_tp'],
                 'exit_claims_provider': ' ; '.join(exits), 'status_claims_provider': ' ; '.join(status),
                 'first_claim_utc': iso(first) if first else '', 'last_claim_utc': iso(last) if last else '',
                 'closed_by_claim': s['closed_by'] or '', 'label': 'PROVIDER-CLAIMED, UNVERIFIED'})
with open(S+'/provider_claims.csv','w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
# stats
tot=len(events); meth=collections.Counter(e['link_method'] for e in events)
print('claim messages considered', tot, dict(meth))
print('claims by class', collections.Counter(e['claim_class'] for e in events))
amb=[e for e in events if e['link_method']=='temporal' and int(e['candidates_n'])>1]
print('temporal claims with >1 candidate (ambiguous):', len(amb), 'of', meth.get('temporal',0), 'temporal;', 'tp_hit ambiguous:', sum(1 for e in amb if e['claim_class']=='update_tp_hit'))
print('signals total', len(rows), 'with >=1 linked claim', sum(1 for r in rows if r['n_linked_claims']>0), f"({100*sum(1 for r in rows if r['n_linked_claims']>0)/len(rows):.1f}%)")
print('signals with >=1 linked TP claim', sum(1 for r in rows if r['tp_claims_provider']), f"({100*sum(1 for r in rows if r['tp_claims_provider'])/len(rows):.1f}%)")
print('signals with exit claim', sum(1 for r in rows if r['exit_claims_provider']), f"({100*sum(1 for r in rows if r['exit_claims_provider'])/len(rows):.1f}%)")
print('closed_by counts', collections.Counter(r['closed_by_claim'] for r in rows))
print('max_tp_claimed distribution', sorted(collections.Counter(r['max_tp_claimed'] for r in rows).items()))
lags=[float(e['lag_hours']) for e in events if e['lag_hours']!='' and e['claim_class']=='update_tp_hit']
if lags: print('TP-claim lag hours (signal->claim) quantiles: p50', round(statistics.median(lags),2), 'p90', round(sorted(lags)[int(0.9*len(lags))],2), 'max', max(lags), 'n', len(lags))
print('reply-linked claims', meth.get('reply',0))
unl=[e for e in events if e['link_method']=='unlinked']
print('unlinked claims', len(unl), collections.Counter(e['claim_class'] for e in unl))
print('unlinked ids sample', [e['claim_msg_id'] for e in unl][:30])
# TP claims exceeding num_tps (not linkable under index rule)
tpc_over=[e for e in events if e['claim_class']=='update_tp_hit' and e['tp_index']!='' and e['link_method']=='unlinked']
print('TP claims unlinked (index exceeds open signals):', len(tpc_over), [(e['claim_msg_id'],e['tp_index']) for e in tpc_over][:20])

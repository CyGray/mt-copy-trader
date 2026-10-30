import sqlite3,json,sys
c=sqlite3.connect('file:/home/kyle/services/bytrader-go/state/state.sqlite?mode=ro',uri=True)
tid=sys.argv[1]
r=c.execute("select body from documents where collection='trade_sets' and id=?",(tid,)).fetchone()
if not r: print('no trade set yet'); sys.exit()
t=json.loads(r[0]); print('state', t['state'], t.get('skip_reason'))
p=t.get('plan') or {}; print('plan', {k:p.get(k) for k in ('volume','entry_ref_price','sl','broker_tp','risk_money')}, p.get('checkpoints'))
print('refs', {k:(t.get('broker_refs') or {}).get(k) for k in ('fill_price','filled_volume','position_ticket')})
l=t.get('lifecycle') or {}; print('life', {k:l.get(k) for k in ('current_sl','current_tp','best_price','be_applied','trailing_active','realized_profit')})
for (b,) in c.execute("select body from documents where collection='trade_events' and trade_set_id=? order by timestamp",(tid,)):
    d=json.loads(b); print(' ', d.get('timestamp','')[11:19], d.get('event_key'), (d.get('message') or '')[:120])

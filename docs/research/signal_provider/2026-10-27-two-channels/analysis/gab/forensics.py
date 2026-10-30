import json, re, collections, datetime as dt, sqlite3
M=json.load(open("/tmp/claude-1001/twochan/gab/live/messages.json")); M.sort(key=lambda m:m["ID"])
ent=json.load(open("/tmp/claude-1001/twochan/gab/live/entities.json"))
byid={m["ID"]:m for m in M}
T=lambda x: dt.datetime.fromtimestamp(x, dt.timezone.utc)
# entity ids
print({k:(v["Title"],v["Username"]) for k,v in ent.items()})
# forwards by source + date
src=collections.defaultdict(list)
for m in M:
    f=m.get("Fwd")
    if f: src[f.get("from") or ("name:"+f.get("from_name",""))].append(m)
print("\nforward sources:")
for k,v in sorted(src.items(),key=lambda kv:-len(kv[1]))[:12]:
    print(f" {k:22s} n={len(v):4d} {T(v[0]['Date']):%m-%d}..{T(v[-1]['Date']):%m-%d} media={collections.Counter(x.get('MediaType') for x in v).most_common(2)} sample={(v[len(v)//2].get('Text') or '')[:80]!r}")
print("named-user forwards total:",sum(len(v) for k,v in src.items() if k.startswith('name:') or k.startswith('user')))
# views over time
print("\nviews by month (median) and reactions/views:")
bym=collections.defaultdict(list)
for m in M: bym[T(m["Date"]).strftime("%Y-%m")].append(m)
for k in sorted(bym):
    v=sorted(x.get("Views",0) for x in bym[k]); r=sum(sum((x.get("Reactions") or {}).values()) for x in bym[k])
    print(f" {k} n={len(v)} med_views={v[len(v)//2]} max={v[-1]} reactions={r} react/view={r/max(1,sum(v)):.2f}")
top=sorted(M,key=lambda m:-m.get("Views",0))[:5]
print("top viewed:",[(m["ID"],T(m["Date"]).strftime("%m-%d"),m.get("Views"),(m.get("Text") or "")[:50]) for m in top])
hr=sorted(M,key=lambda m:-sum((m.get("Reactions") or {}).values()))[:5]
print("top reacted:",[(m["ID"],m.get("Views"),m.get("Reactions")) for m in hr])
# edits: lag distribution, bulk edit clusters
ed=[m for m in M if m.get("EditDate")]
cl=collections.Counter(T(m["EditDate"]).strftime("%Y-%m-%d %H:%M") for m in ed)
print("\nbiggest edit-minute clusters:",cl.most_common(8))
late=[m for m in ed if m["EditDate"]-m["Date"]>86400]; print("edited >1 day after posting:",len(late))
# local store comparison
c=sqlite3.connect("file:/home/kyle/services/bytrader-go/state/state.sqlite?mode=ro", uri=True)
rows=c.execute("select message_id,body,created_at from documents where collection='telegram_messages' and chat_id='-1003740937489'").fetchall()
local=collections.defaultdict(list)
for mid,b,ca in rows:
    j=json.loads(b); local[int(mid)].append((ca,j.get("text") or "", j.get("edit_date") or j.get("editDate")))
gone=[i for i in local if i not in byid]
print("\nlocal-store ids:",len(local),"now deleted on Telegram:",sorted(gone))
for i in sorted(gone):
    for ca,t,_ in local[i][:1]: print(f"  DELETED {i} captured {ca}: {t[:150]!r}")
chg=[]
for i,revs in local.items():
    if i in byid:
        live=byid[i].get("Text") or ""
        texts={t for _,t,_ in revs}
        if any(t.strip()!=live.strip() for t in texts): chg.append(i)
print("ids whose captured text differs from live final:",len(chg))
for i in sorted(chg)[:25]:
    old=sorted(local[i])[0][1]; new=byid[i].get("Text") or ""
    print(f"  {i}: first={old[:110]!r}\n        live ={new[:110]!r}")

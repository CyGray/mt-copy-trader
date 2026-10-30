import json, sys, collections, datetime as dt
D="/tmp/claude-1001/twochan/gab/live/"
M=json.load(open(D+"messages.json")); full=json.load(open(D+"full_channel.json")); ents=json.load(open(D+"entities.json"))
ts=lambda x: dt.datetime.fromtimestamp(x, dt.timezone.utc)
print("full channel:", {k:full.get(k) for k in ("ParticipantsCount","AdminsCount","KickedCount","LinkedChatID","PinnedMsgID","AvailableMinID","ReadInboxMaxID","Antispam","ViewForumAsMessages","HasScheduled","CanViewStats","BoostsApplied","ReactionsLimit","SlowmodeSeconds","TTLPeriod")})
print("about (len):", len(full.get("About","")))
print("entities:", [(v["Kind"],v["Title"][:30],v["Username"],v["Broadcast"]) for v in ents.values()])
M.sort(key=lambda m:m["ID"])
ids=[m["ID"] for m in M]; print("ids",ids[0],ids[-1],"count",len(ids),"missing ids (deleted)",ids[-1]-ids[0]+1-len(ids))
print("first",ts(M[0]["Date"]),"last",ts(M[-1]["Date"]))
print("kinds",collections.Counter(m["Kind"] for m in M))
print("actions",collections.Counter(m.get("Action") for m in M if m["Kind"]=="service"))
print("media",collections.Counter(m.get("MediaType") for m in M))
ed=[m for m in M if m.get("EditDate")]; print("edited",len(ed))
lags=sorted(m["EditDate"]-m["Date"] for m in ed); 
if lags: print(" edit lag s: median",lags[len(lags)//2],"p90",lags[int(len(lags)*.9)],"max",lags[-1])
fw=[m for m in M if m.get("Fwd")]; print("forwarded",len(fw), collections.Counter(m["Fwd"].get("from") or m["Fwd"].get("from_name") for m in fw).most_common(15))
print("authors",collections.Counter(m.get("PostAuthor") for m in M).most_common(8))
print("pinned",[m["ID"] for m in M if m.get("Pinned")])
print("noforwards",sum(m.get("NoForwards",False) for m in M), "grouped albums",len({m["GroupedID"] for m in M if m.get("GroupedID")}))
urls=collections.Counter()
for m in M:
    for u in m.get("URLs") or []: urls[u.split("?")[0][:60]]+=1
print("top urls",urls.most_common(25))
print("mentions",collections.Counter(x for m in M for x in m.get("Mentions") or []).most_common(15))
print("buttons",collections.Counter(b[:70] for m in M for b in m.get("Buttons") or []).most_common(10))
# per month
mon=collections.Counter(ts(m["Date"]).strftime("%Y-%m") for m in M); print("per month",sorted(mon.items()))
v=[m["Views"] for m in M if m.get("Views")]; v.sort(); print("views median",v[len(v)//2] if v else None,"max",v[-1] if v else None)
print("reactions total",sum(sum((m.get("Reactions") or {}).values()) for m in M),"replies",sum(m.get("Replies",0) for m in M))
# deleted gap blocks
gaps=[]; 
for a,b in zip(M,M[1:]):
    if b["ID"]-a["ID"]>1: gaps.append((a["ID"]+1,b["ID"]-1,ts(a["Date"]).strftime("%Y-%m-%d %H:%M"),ts(b["Date"]).strftime("%Y-%m-%d %H:%M")))
print("gap blocks",len(gaps),"largest",sorted(gaps,key=lambda g:g[0]-g[1])[:8])

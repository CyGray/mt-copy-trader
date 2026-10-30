import json, re, collections, datetime as dt
M=json.load(open("/tmp/claude-1001/twochan/gab/live/messages.json")); M.sort(key=lambda m:m["ID"])
T=lambda x: dt.datetime.fromtimestamp(x, dt.timezone.utc)
bym=collections.defaultdict(list)
for m in M: bym[T(m["Date"]).strftime("%Y-%m")].append(m)
kw={"usdt/wallet":r"usdt|wallet|trc20|bep20","invest/flip":r"invest|flip|account manag|manage your|weekend","circle/vip":r"circle|vip|slots?|intake|join","bot":r"\bbot\b","profit claim":r"\d+\s*pips|\$\s?\d|\d+k profit|usd","refund/guarantee":r"refund|guarantee|no loss|100%","justmarkets":r"justmarkets","dubai":r"dubai","signal":r"\b(stop ?loss|sl)\b.*\b(tp|take profit)"}
for k in sorted(bym):
    ms=bym[k]; texts=[(m.get("Text") or "").lower() for m in ms]
    cnt={n:sum(bool(re.search(r,t,re.S)) for t in texts) for n,r in kw.items()}
    hand=collections.Counter()
    for m in ms:
        for u in (m.get("URLs") or [])+(m.get("Mentions") or []):
            h=re.sub(r"^https?://(t\.me/|www\.)?","",u).split("/")[0].split("?")[0].lower().lstrip("@")
            hand[h]+=1
    print(k,len(ms),cnt,"\n   handles:",hand.most_common(6))
# signal templates
sig=[m for m in M if re.search(r"\b(sl|stop ?loss)\b",(m.get("Text") or "").lower()) and re.search(r"\btp\s*\d?\b|take ?profit",(m.get("Text") or "").lower())]
def tmpl(t):
    t=t.strip().split("\n")[0][:40]
    return re.sub(r"\d+(\.\d+)?","#",t)
tc=collections.Counter(); first={}
for m in sig:
    k=tmpl(m["Text"]); tc[k]+=1; first.setdefault(k,[]).append(T(m["Date"]).strftime("%m-%d"))
print("\nsignal first-line templates:")
for k,n in tc.most_common(30): print(f" {n:4d} {first[k][0]}..{first[k][-1]} {k!r}")

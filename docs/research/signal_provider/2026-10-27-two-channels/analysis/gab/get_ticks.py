import json, sys, datetime as dt
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, "/home/kyle/agent-worktrees/ByTrader/task-20261027-021048-d8322860/docs/research/signal_provider/2026-10-27-two-channels/analysis/a3")
from dukas_lib import fetch_hour
RAW = "/tmp/claude-1001/twochan/gold/raw"
S = [r for r in json.load(open("/tmp/claude-1001/twochan/gab/study/signals.json")) if r["symbol"] == "XAUUSD"]
hours = set()
now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(hours=2)
for r in S:
    t0 = dt.datetime.utcfromtimestamp(r["date"]).replace(minute=0, second=0)
    for h in range(int(sys.argv[1]), int(sys.argv[2])):
        t = t0 + dt.timedelta(hours=h)
        if t < now: hours.add(t)
hours = sorted(hours)
print("hours needed", len(hours), hours[0], hours[-1], flush=True)
cnt = {}
with ThreadPoolExecutor(6) as ex:
    for i, (st, nb, note) in enumerate(ex.map(lambda h: fetch_hour(h, RAW), hours)):
        cnt[st] = cnt.get(st, 0) + 1
        if i % 500 == 0: print(i, cnt, flush=True)
print("done", cnt)

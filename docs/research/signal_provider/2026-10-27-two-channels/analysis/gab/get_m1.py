import os, time, urllib.request, urllib.error, datetime as dt
OUT = "/tmp/claude-1001/twochan/gab/m1"
UA = 'Mozilla/5.0 (X11; Linux x86_64) ByTraderResearch/1.0 (private research)'
d = dt.date(2026, 2, 8); end = dt.date(2026, 10, 28)
cnt = {}
while d < end:
    for side in ('BID', 'ASK'):
        p = f"{OUT}/{d.isoformat()}_{side}.bi5"
        if os.path.exists(p) or os.path.exists(p + '.missing'): cnt['cached'] = cnt.get('cached', 0) + 1; continue
        url = f"http://datafeed.dukascopy.com/datafeed/XAUUSD/{d.year}/{d.month-1:02d}/{d.day:02d}/{side}_candles_min_1.bi5"
        for a in range(5):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=40) as r: body = r.read()
                open(p + '.part', 'wb').write(body); os.replace(p + '.part', p); st = 'ok' if body else 'empty'; break
            except urllib.error.HTTPError as e:
                if e.code == 404: open(p + '.missing', 'w').close(); st = 'missing'; break
                st = f'http{e.code}'; time.sleep(5 * (a + 1))
            except Exception as e:
                st = 'err'; time.sleep(3 * (a + 1))
        cnt[st] = cnt.get(st, 0) + 1
    d += dt.timedelta(days=1)
    if d.day == 1: print(d, cnt, flush=True)
print('done', cnt, flush=True)

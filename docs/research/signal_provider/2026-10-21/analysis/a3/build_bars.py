"""Stream Dukascopy hourly bi5 files -> 1-minute bid/ask OHLC + quality counters.

usage: build_bars.py RAWDIR DERIVED_DIR START_UTC END_UTC_EXCL
Writes (in DERIVED_DIR):
  xauusd_m1_bidask.csv.gz  one row per minute that has >=1 tick (bid/ask O,H,L,C, tick count, spread mean/min/max)
  hourly_quality.csv       one row per hour: status, tick count, gap stats, anomalies, mid range
  spread_hist.json         exact spread counters (raw units = 1/1000 USD) by UTC hour-of-day and by month
  big_moves.csv            consecutive-tick mid jumps >= 1.0 USD
Prices are integers x1000 in the loop; formatted to 3 decimals on output.
"""
import sys, os, gzip, csv, json, datetime as dt, collections, lzma
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import hour_path, REC

RAW, OUT = sys.argv[1], sys.argv[2]
start = dt.datetime.fromisoformat(sys.argv[3]); end = dt.datetime.fromisoformat(sys.argv[4])
os.makedirs(OUT, exist_ok=True)

bars_f = gzip.open(os.path.join(OUT, 'xauusd_m1_bidask.csv.gz'), 'wt', newline='')
bars = csv.writer(bars_f)
bars.writerow(['minute_utc', 'n_ticks', 'bid_open', 'bid_high', 'bid_low', 'bid_close',
               'ask_open', 'ask_high', 'ask_low', 'ask_close', 'spread_mean', 'spread_max', 'spread_min'])
qf = open(os.path.join(OUT, 'hourly_quality.csv'), 'w', newline='')
qw = csv.writer(qf)
qw.writerow(['hour_utc', 'status', 'n_ticks', 'first_ms_in_hour', 'last_ms_in_hour', 'max_gap_s',
             'n_gap_gt5s', 'n_gap_gt60s', 'n_bid_ge_ask', 'n_zero_spread', 'n_nonmono',
             'max_mid_jump_usd', 'n_mid_jump_ge1usd', 'min_mid_usd', 'max_mid_usd'])
bm_f = open(os.path.join(OUT, 'big_moves.csv'), 'w', newline='')
bmw = csv.writer(bm_f); bmw.writerow(['tick_utc', 'mid_prev', 'mid_now', 'jump_usd'])

spread_hod = {h: collections.Counter() for h in range(24)}
spread_mon = collections.defaultdict(collections.Counter)
statuses = collections.Counter()
n_ticks_total = 0; n_bars = 0

def f3(x):
    return f'{x / 1000:.3f}'

def flush(minute_ms, st):
    global n_bars
    bars.writerow([dt.datetime.fromtimestamp(minute_ms / 1000, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:00Z'),
                   st['n'], f3(st['bo']), f3(st['bh']), f3(st['bl']), f3(st['bc']),
                   f3(st['ao']), f3(st['ah']), f3(st['al']), f3(st['ac']),
                   f'{st["ssum"] / st["n"] / 1000:.4f}', f3(st['smax']), f3(st['smin'])])
    n_bars += 1

t = start
while t < end:
    p = hour_path(RAW, t)
    hs = t.strftime('%Y-%m-%dT%H:00:00Z')
    if not os.path.exists(p):
        st_name = 'missing' if os.path.exists(p + '.missing') else ('empty' if os.path.exists(p + '.empty') else 'absent')
        qw.writerow([hs, st_name, 0] + [''] * 12); statuses[st_name] += 1
        t += dt.timedelta(hours=1); continue
    if os.path.getsize(p) == 0:
        qw.writerow([hs, 'empty', 0] + [''] * 12); statuses['empty'] += 1
        t += dt.timedelta(hours=1); continue
    with open(p, 'rb') as f:
        raw = f.read()
    data = lzma.decompress(raw, format=lzma.FORMAT_ALONE)
    base_ms = int(t.replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    hod = t.hour; mon = t.strftime('%Y-%m')
    sh = spread_hod[hod]; sm = spread_mon[mon]
    n = 0; prev_off = -1; nonmono = 0; n_bge = 0; n_zs = 0
    max_gap = 0.0; gap5 = 0; gap60 = 0; prev_off_ms = None
    prev_mid = None; max_jump = 0.0; jump1 = 0; mn = None; mx = None
    first_off = last_off = None
    cur = None  # current minute state dict
    cur_min = None
    for off, ask, bid, av, bv in REC.iter_unpack(data):
        n += 1
        if off < prev_off:
            nonmono += 1
        prev_off = off
        if first_off is None:
            first_off = off
        last_off = off
        if bid >= ask:
            n_bge += 1
        sp = ask - bid
        if sp == 0:
            n_zs += 1
        sh[sp] += 1; sm[sp] += 1
        mid = (ask + bid) / 2
        if mn is None or mid < mn: mn = mid
        if mx is None or mid > mx: mx = mid
        if prev_off_ms is not None:
            g = (off - prev_off_ms) / 1000.0
            if g > max_gap: max_gap = g
            if g > 5: gap5 += 1
            if g > 60: gap60 += 1
        if prev_mid is not None:
            j = abs(mid - prev_mid) / 1000.0
            if j > max_jump: max_jump = j
            if j >= 1.0:
                jump1 += 1
                bmw.writerow([(dt.datetime.fromtimestamp((base_ms + off) / 1000, dt.timezone.utc)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z',
                              f'{prev_mid / 1000:.3f}', f'{mid / 1000:.3f}', f'{j:.3f}'])
        prev_mid = mid; prev_off_ms = off
        m = off // 60000
        if m != cur_min:
            if cur is not None:
                flush(base_ms + cur_min * 60000, cur)
            cur_min = m
            cur = dict(n=0, bo=ask, bh=ask, bl=ask, bc=ask, ao=ask, ah=ask, al=ask, ac=ask,
                       ssum=0, smax=-1, smin=10**9)
        # note: bid/ask OHLC kept separately below
        cur['n'] += 1
        cur['bc'] = bid; cur['ac'] = ask
        if bid > cur['bh']: cur['bh'] = bid
        if bid < cur['bl']: cur['bl'] = bid
        if ask > cur['ah']: cur['ah'] = ask
        if ask < cur['al']: cur['al'] = ask
        cur['ssum'] += sp
        if sp > cur['smax']: cur['smax'] = sp
        if sp < cur['smin']: cur['smin'] = sp
    if cur is not None:
        flush(base_ms + cur_min * 60000, cur)
    n_ticks_total += n
    statuses['ok'] += 1
    qw.writerow([hs, 'ok', n, first_off, last_off, round(max_gap, 3), gap5, gap60,
                 n_bge, n_zs, nonmono, round(max_jump, 4), jump1,
                 f3(mn), f3(mx)])
    t += dt.timedelta(hours=1)

bars_f.close(); qf.close(); bm_f.close()
json.dump({'by_hour_of_day': {str(h): {str(k): v for k, v in sorted(c.items())} for h, c in spread_hod.items()},
           'by_month': {m: {str(k): v for k, v in sorted(c.items())} for m, c in sorted(spread_mon.items())}},
          open(os.path.join(OUT, 'spread_hist.json'), 'w'))
print('ticks', n_ticks_total, 'bars', n_bars, dict(statuses))

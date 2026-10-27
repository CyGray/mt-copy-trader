"""Coverage, ticks per hour, spreads and the XAUUSD level check for the FX tick download.

usage: fx_coverage.py FX_ROOT
  Reads FX_ROOT/manifests/<SYMBOL>_*.csv (written by download_ticks.py) and the raw bi5 files under
  FX_ROOT/raw/<SYMBOL>/. Expected hours: DAYS x 12:00 and 13:00 UTC (the window 12:00-14:00 is half-open,
  as in download_ticks.py), per FX pair; plus XAUUSD 2026-10-26 13:00 UTC for the gold level check.
  Spreads are quoted ask minus bid, in pips from symbols.py. Aggregates are printed; no tick is written out.
"""
import argparse, csv, datetime as dt, glob, os, statistics as st, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import decode_hour_prices, hour_path
from symbols import to_pips
from ecb_check import DAYS, PAIRS

HOURS = (12, 13)
GOLD_DAY = dt.datetime(2026, 10, 26, 13)
GOLD_RANGE = (3980.0, 4030.0)  # approximate level quoted in the brief, not a measured reference


def hour_iso(t):
    return t.strftime('%Y-%m-%dT%H:00:00Z')


def read_manifests(fx_root):
    man = {}
    for path in sorted(glob.glob(os.path.join(fx_root, 'manifests', '*.csv'))):
        sym = os.path.basename(path).split('_')[0]
        with open(path, newline='') as f:
            for r in csv.DictReader(f):
                man[(sym, r['hour_utc'])] = r
    return man


def analyse_file(path, hour_start, pair):
    ticks = decode_hour_prices(path, hour_start, pair)
    spreads = [to_pips(pair, ask - bid) for _, bid, ask, _, _ in ticks]
    return dict(
        ticks=len(ticks),
        spreads=spreads,
        median=st.median(spreads) if spreads else None,
        negative=sum(1 for s in spreads if s < 0),
        zero=sum(1 for s in spreads if s == 0),
        nonmono=sum(1 for i in range(1, len(ticks)) if ticks[i][0] < ticks[i - 1][0]),
        ticks_list=ticks,
    )


def fmt(x, nd=3):
    return '-' if x is None else f'{x:.{nd}f}'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('fx_root')
    args = ap.parse_args()
    root = args.fx_root
    man = read_manifests(root)

    print('## Per-file (pair, day, hour): status, ticks, median spread (pips), negative spreads, out-of-order ts')
    print('| pair | date | hour UTC | status | note | ticks | median spread pips | negative spreads | out-of-order |')
    print('|---|---|---|---|---|---|---|---|---|')
    summary = {}
    for pair in PAIRS:
        rawdir = os.path.join(root, 'raw', pair)
        pooled, per_file_ticks, per_file_med = [], [], []
        counts = dict(ok=0, cached=0, empty=0, missing=0, error=0, absent=0)
        n503 = n_retry = n_neg = n_nonmono = 0
        for day in DAYS:
            for h in HOURS:
                t = dt.datetime(day.year, day.month, day.day, h)
                r = man.get((pair, hour_iso(t)), {})
                status = r.get('status', '')
                note = r.get('note', '')
                n503 += note.count('HTTP 503')
                n_retry += 1 if 'retried after' in note else 0
                p = hour_path(rawdir, t)
                if os.path.exists(p) and os.path.getsize(p) > 0:
                    a = analyse_file(p, t, pair)
                    pooled += a['spreads']
                    per_file_ticks.append(a['ticks'])
                    per_file_med.append(a['median'])
                    n_neg += a['negative']
                    n_nonmono += a['nonmono']
                    counts['cached' if status == 'cached' else 'ok'] += 1
                    print(f"| {pair} | {day} | {h:02d}:00 | {status or 'cached'} | {note} | {a['ticks']} | "
                          f"{fmt(a['median'])} | {a['negative']} | {a['nonmono']} |")
                else:
                    key = status if status in counts else 'absent'
                    counts[key] += 1
                    print(f"| {pair} | {day} | {h:02d}:00 | {status or 'no manifest row'} | {note} | 0 | - | - | - |")
        summary[pair] = dict(counts=counts, n503=n503, n_retry=n_retry, neg=n_neg, nonmono=n_nonmono,
                             tph_med=st.median(per_file_ticks) if per_file_ticks else None,
                             tph_min=min(per_file_ticks, default=None), tph_max=max(per_file_ticks, default=None),
                             spread_med=st.median(pooled) if pooled else None,
                             spread_file_med=(min(per_file_med), max(per_file_med)) if per_file_med else None,
                             n_pooled=len(pooled))

    print()
    print('## Per-symbol summary (expected hours per pair: %d)' % (len(DAYS) * len(HOURS)))
    print('| pair | ok | cached | empty | missing | error | absent | files with 503 | HTTP 503 responses | '
          'ticks/hour median (min-max) | median spread pips (pooled) | per-hour median spread range | negative spreads | out-of-order ts |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for pair in PAIRS:
        s = summary[pair]
        c = s['counts']
        tph = f"{s['tph_med']:.0f} ({s['tph_min']}-{s['tph_max']})" if s['tph_med'] is not None else '-'
        rng = f"{s['spread_file_med'][0]:.3f}-{s['spread_file_med'][1]:.3f}" if s['spread_file_med'] else '-'
        print(f"| {pair} | {c['ok']} | {c['cached']} | {c['empty']} | {c['missing']} | {c['error']} | {c['absent']} | "
              f"{s['n_retry']} | {s['n503']} | {tph} | {fmt(s['spread_med'])} (n={s['n_pooled']}) | {rng} | "
              f"{s['neg']} | {s['nonmono']} |")

    print()
    print('## XAUUSD level check, 2026-10-26 13:00 UTC')
    p = hour_path(os.path.join(root, 'raw', 'XAUUSD'), GOLD_DAY)
    if not (os.path.exists(p) and os.path.getsize(p) > 0):
        print('XAUUSD 13h file absent or empty; status', man.get(('XAUUSD', hour_iso(GOLD_DAY)), {}).get('status'))
    else:
        ticks = decode_hour_prices(p, GOLD_DAY, 'XAUUSD')
        t0 = int(GOLD_DAY.replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
        before = [x for x in ticks if x[0] <= t0]
        after = [x for x in ticks if x[0] >= t0]
        # nearest quote to 13:00:00.000: last tick at or before it, otherwise the first tick after it
        nearest = before[-1] if before else (after[0] if after else None)
        if nearest is not None:
            ts, bid, ask, _, _ = nearest
            mid_last = (bid + ask) / 2
            age_ms = abs(ts - t0)
        else:
            mid_last, age_ms = None, None
        mids = [(b + a) / 2 for _, b, a, _, _ in ticks]
        inside = mid_last is not None and GOLD_RANGE[0] <= mid_last <= GOLD_RANGE[1]
        print(f'ticks in 13h file: {len(ticks)}; nearest quote to 13:00:00.000 UTC: mid {fmt(mid_last, 3)} USD, '
              f'{"before" if before else "after"} the instant by {fmt(None if age_ms is None else age_ms, 0)} ms; '
              f'{"tick at or before 13:00 exists" if before else "no tick at or before 13:00:00.000 in this file"}')
        print(f'hour mid range {min(mids):.3f}-{max(mids):.3f} USD; median spread {st.median([a - b for _, b, a, _, _ in ticks]):.3f} USD '
              f'({fmt(st.median([to_pips("XAUUSD", a - b) for _, b, a, _, _ in ticks]), 2)} pips of 0.10)')
        print(f'within the approximate 3,980-4,030 level: {"yes" if inside else "NO"}')


if __name__ == '__main__':
    main()

"""Independent decode check: Dukascopy mid at the ECB euro reference-rate fixing vs the ECB publication.

Reference (public, no login): ECB euro foreign-exchange reference rates, 90-day history,
  https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml   (units of currency per 1 EUR)
Fixing instant: 14:15 Europe/Berlin (CET/CEST) = 12:15 UTC in summer time, 13:15 UTC after the switch.
Derived pairs: USDJPY = EURJPY / EURUSD ; GBPUSD = EURUSD / EURGBP.
Dukascopy side: mid of the last tick at or before the fixing instant. The 5 minutes before the fixing
are reported as context (tick count, min and max mid, whether the ECB value falls inside that range).
Pass: |difference| < PASS_PIPS for every pair and day. A wrong divisor would be off by 10x or 100x.

usage: ecb_check.py FX_ROOT [--ecb-xml PATH]
  FX_ROOT holds raw/<SYMBOL>/YYYY/MM/DD/HHh_ticks.bi5. Writes FX_ROOT/ecb_check.csv (aggregates only).
  The ECB file is fetched once into FX_ROOT/ecb/ when it is not already there.
Exit status 0 only when all 15 pair-days pass.
"""
import argparse, csv, datetime as dt, hashlib, os, sys, urllib.request
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import decode_hour_prices, hour_path, UA
from symbols import to_pips

ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml'
ECB_TZ = ZoneInfo('Europe/Berlin')
FIX_LOCAL_HHMM = (14, 15)
WINDOW_MIN = 5
PASS_PIPS = 15.0
PAIRS = ('EURUSD', 'USDJPY', 'GBPUSD')
DAYS = [dt.date(2026, 10, 5), dt.date(2026, 10, 9), dt.date(2026, 10, 14), dt.date(2026, 10, 20), dt.date(2026, 10, 23)]
CSV_FIELDS = ['symbol', 'date_utc', 'fix_utc', 'ecb_usd_per_eur', 'ecb_jpy_per_eur', 'ecb_gbp_per_eur',
              'ecb_value', 'ecb_rounding_halfwidth_pips', 'window_ticks', 'dukas_mid_at_fix', 'window_min_mid',
              'window_max_mid', 'ecb_inside_window_range', 'diff_pips', 'abs_diff_pips', 'spread_pips_at_fix',
              'pass']


def fix_utc(day):
    """ECB fixing instant for a calendar date, as naive UTC."""
    local = dt.datetime(day.year, day.month, day.day, *FIX_LOCAL_HHMM, tzinfo=ECB_TZ)
    return local.astimezone(dt.timezone.utc).replace(tzinfo=None)


def fetch_ecb(path):
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(ECB_URL, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    with open(path + '.part', 'wb') as f:
        f.write(body)
    os.replace(path + '.part', path)


def parse_ecb(path):
    """{'YYYY-MM-DD': {ccy: (rate, decimals_published)}} from the ECB XML."""
    out, cur = {}, None
    for el in ET.parse(path).iter():
        if el.get('time'):
            cur = out.setdefault(el.get('time'), {})
        elif el.get('currency') and cur is not None:
            rate = el.get('rate')
            cur[el.get('currency')] = (float(rate), len(rate.split('.')[1]) if '.' in rate else 0)
    return out


def ecb_pair(pair, rates):
    """(value, relative rounding half-width) of a pair from one day's EUR-based ECB rates."""
    def rel(ccy):
        v, d = rates[ccy]
        return v, 0.5 * 10 ** -d / v
    if pair == 'EURUSD':
        return rel('USD')
    if pair == 'USDJPY':
        j, ej = rel('JPY')
        u, eu = rel('USD')
        return j / u, ej + eu
    if pair == 'GBPUSD':
        u, eu = rel('USD')
        g, eg = rel('GBP')
        return u / g, eu + eg
    raise KeyError(pair)


def load_hour(rawdir, pair, hour_start):
    p = hour_path(rawdir, hour_start)
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        return []
    return decode_hour_prices(p, hour_start, pair)


def compare(rawdir, pair, day, rates):
    fix = fix_utc(day)
    fix_ms = int(fix.replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    win0 = fix_ms - WINDOW_MIN * 60000
    row = dict.fromkeys(CSV_FIELDS, '')
    row.update(symbol=pair, date_utc=day.isoformat(), fix_utc=fix.strftime('%H:%M'), **{'pass': False})
    row.update(ecb_usd_per_eur=rates['USD'][0], ecb_jpy_per_eur=rates['JPY'][0], ecb_gbp_per_eur=rates['GBP'][0])
    ecb_v, rel = ecb_pair(pair, rates)
    row['ecb_value'] = ecb_v
    row['ecb_rounding_halfwidth_pips'] = round(to_pips(pair, ecb_v * rel), 3)

    ticks = []
    for h_ms in sorted({win0 - win0 % 3600000, fix_ms - fix_ms % 3600000}):
        h = dt.datetime.fromtimestamp(h_ms / 1000, dt.timezone.utc).replace(tzinfo=None)
        ticks += load_hour(rawdir, pair, h)
    ticks.sort(key=lambda x: x[0])
    win = [x for x in ticks if win0 <= x[0] <= fix_ms]
    row['window_ticks'] = len(win)
    if not win:
        return row
    _, bid, ask, _, _ = win[-1]
    mid = (bid + ask) / 2
    mids = [(b + a) / 2 for _, b, a, _, _ in win]
    row.update(dukas_mid_at_fix=mid, window_min_mid=min(mids), window_max_mid=max(mids),
               ecb_inside_window_range=min(mids) <= ecb_v <= max(mids),
               spread_pips_at_fix=round(to_pips(pair, ask - bid), 3))
    diff = to_pips(pair, mid - ecb_v)
    row.update(diff_pips=round(diff, 3), abs_diff_pips=round(abs(diff), 3))
    row['pass'] = abs(diff) < PASS_PIPS
    return row


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('fx_root')
    ap.add_argument('--ecb-xml', default=None)
    args = ap.parse_args()
    ecb_xml = args.ecb_xml or os.path.join(args.fx_root, 'ecb', 'eurofxref-hist-90d.xml')
    fetch_ecb(ecb_xml)
    rates = parse_ecb(ecb_xml)
    print(f'ECB file {ecb_xml} sha256={sha256(ecb_xml)} dates={min(rates)}..{max(rates)}')

    rows = []
    for pair in PAIRS:
        for day in DAYS:
            if day.isoformat() not in rates:
                rows.append(dict(dict.fromkeys(CSV_FIELDS, ''), symbol=pair, date_utc=day.isoformat(), **{'pass': False}))
                continue
            rows.append(compare(os.path.join(args.fx_root, 'raw', pair), pair, day, rates[day.isoformat()]))

    out_csv = os.path.join(args.fx_root, 'ecb_check.csv')
    with open(out_csv, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, '') for k in CSV_FIELDS})

    print('| pair | date | fix UTC | Dukascopy mid | ECB value | diff pips | window ticks | window min-max mid | ECB in window | pass |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for r in rows:
        if r['dukas_mid_at_fix'] == '':
            print(f"| {r['symbol']} | {r['date_utc']} | - | no data | - | - | {r['window_ticks']} | - | - | FAIL |")
            continue
        print(f"| {r['symbol']} | {r['date_utc']} | {r['fix_utc']} | {r['dukas_mid_at_fix']:.5f} | {r['ecb_value']:.5f} | "
              f"{r['diff_pips']:+.2f} | {r['window_ticks']} | {r['window_min_mid']:.5f}-{r['window_max_mid']:.5f} | "
              f"{r['ecb_inside_window_range']} | {'PASS' if r['pass'] else 'FAIL'} |")
    n_pass = sum(1 for r in rows if r['pass'] is True)
    worst = max((abs(r['diff_pips']) for r in rows if r['diff_pips'] != ''), default=float('nan'))
    print(f'RESULT {n_pass}/{len(rows)} pair-days pass (|diff| < {PASS_PIPS:g} pips); worst |diff| = {worst:.2f} pips')
    print(f'wrote {out_csv}')
    sys.exit(0 if n_pass == len(rows) == len(PAIRS) * len(DAYS) else 1)


if __name__ == '__main__':
    main()

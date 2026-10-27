"""Auditor's independent LUCAS pilot reproduction (written from the spec, not from the study code).

Steps: (1) parse SIGNAL 3 / SIGNAL 4 from the revision text (final and first); compare with the universe CSVs.
(2) entry models E1/E2/E3 x costs BASE/MID/PESS on decoded bi5 ticks; compare with fills CSV and summary 'fills'.
(3) tick-by-tick management for the pre-registered strategies (+ posthoc D13_50_50|M1); compare trades CSV,
    summary 'results' (n, mean_R, per-signal status/exit/total_R), and posthoc trades.

Prices are exact integers in milli-USD. total_R uses exact Fractions. Nothing is written to Firestore,
no network, no broker, no Telegram.
"""
import bisect
import csv
import json
import random
import re
import sys
from fractions import Fraction as Fr

sys.path.insert(0, '/tmp/claude-1001/twochan/audit')
import bi5_audit as B  # noqa: E402

REV = '/tmp/claude-1001/twochan/data/lucas_revisions.json'
UNIV = '/tmp/claude-1001/twochan/universe/lucas'
PILOT = '/tmp/claude-1001/twochan/pilot'
AUD = '/tmp/claude-1001/twochan/audit'
SRC_MSG = '23218'
HORIZON_MS = 72 * 3_600_000
PIP_USD = 0.1          # inferred from the provider's own pips annotations (60pips for 6 USD)

ISO = re.compile(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$')
HDR = re.compile(r'^SIGNAL\s+(\d+)\b')
ZONE = re.compile(r'^(BUY|SELL)\s+ZONE\s*:\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)')
SLRE = re.compile(r'^STOPLOSS\s*:\s*(\d+(?:\.\d+)?)(?:\s*\(\s*(\d+)\s*pips\s*-\s*(\d+)\s*pips\s*\))?')
TPRE = re.compile(r'^TAKE PROFIT\s*:\s*(.+?)\s*$')
NUM = re.compile(r'^\d+(?:\.\d+)?$')


def iso_ms(s):
    m = ISO.match(s)
    y, mo, d, H, M, S, ms = map(int, m.groups())
    return B.ms_utc(y, mo, d, H, M, S, ms)


def to_milli(s):
    """'3992' -> 3992000 (milli-USD); decimals allowed."""
    if '.' in s:
        a, b = s.split('.')
        return int(a) * 1000 + int((b + '000')[:3])
    return int(s) * 1000


# ---------------------------------------------------------------- (1) parser (auditor's own)
def parse_text(text):
    """Return list of signal dicts found in a message text. Only the structured SIGNAL blocks are read;
    parsing stops for a block at its TAKE PROFIT line, so the narrative after the blocks is ignored."""
    sigs = []
    cur = None
    for raw in text.split('\n'):
        line = raw.strip()
        m = HDR.match(line)
        if m:
            cur = {'label': m.group(1), 'zone': None, 'sl': None, 'sl_pips': None, 'tps': None,
                   'open_last': False, 'unparsed': []}
            sigs.append(cur)
            continue
        if cur is None or cur.get('done'):
            continue
        m = ZONE.match(line)
        if m and cur['zone'] is None:
            cur['direction'] = m.group(1).lower()
            cur['zone'] = (to_milli(m.group(2)), to_milli(m.group(3)))
            continue
        m = SLRE.match(line)
        if m and cur['sl'] is None:
            cur['sl'] = to_milli(m.group(1))
            if m.group(2):
                cur['sl_pips'] = (int(m.group(2)), int(m.group(3)))
            continue
        m = TPRE.match(line)
        if m and cur['tps'] is None:
            tps = []
            for tok in m.group(1).split('-'):
                tok = tok.strip()
                if NUM.match(tok):
                    tps.append(to_milli(tok))
                elif tok.lower() == 'open':
                    cur['open_last'] = True
                else:
                    cur['unparsed'].append(tok)
            cur['tps'] = tps
            cur['done'] = True
            continue
    out = []
    for s in sigs:
        if s.get('zone') is None or s.get('sl') is None or s.get('tps') is None:
            continue
        lo, hi = min(s['zone']), max(s['zone'])
        s2 = {'label': s['label'], 'direction': s['direction'], 'lo': lo, 'hi': hi,
              'mid': Fr(lo + hi, 2), 'sl': s['sl'], 'tps': s['tps'], 'open_last': s['open_last'],
              'sl_pips': s['sl_pips'], 'unparsed': s['unparsed']}
        out.append(s2)
    return out


def hard_and_info_flags(s):
    hard, info = [], []
    dist = abs(s['mid'] - s['sl']) / 1000
    if not (2.0 <= dist <= 25.0):
        hard.append('implausible_distance')
    if s['direction'] == 'buy' and not s['sl'] < s['lo']:
        hard.append('wrong_side_stop')
    if s['direction'] == 'sell' and not s['sl'] > s['hi']:
        hard.append('wrong_side_stop')
    tps = s['tps']
    if s['direction'] == 'buy':
        ok = all(tps[i] < tps[i + 1] for i in range(len(tps) - 1)) and (not tps or tps[0] > s['mid'])
    else:
        ok = all(tps[i] > tps[i + 1] for i in range(len(tps) - 1)) and (not tps or tps[0] < s['mid'])
    if not ok:
        hard.append('tp_order')
    if s['unparsed']:
        hard.append('unparsed_tp_token')
    info.append('symbol_inferred')
    if s['open_last']:
        info.append('open_last_tp')
    if s['sl_pips']:
        if s['direction'] == 'buy':
            d = [round((s['lo'] - s['sl']) / 1000 / PIP_USD), round((s['hi'] - s['sl']) / 1000 / PIP_USD)]
        else:
            d = [round((s['sl'] - s['lo']) / 1000 / PIP_USD), round((s['sl'] - s['hi']) / 1000 / PIP_USD)]
        want = sorted(s['sl_pips'])
        if sorted(d) != want:
            lo_p, hi_p = sorted(d)
            info.append(f'sl_annotation_mismatch_{lo_p}-{hi_p}_vs_{want[0]}-{want[1]}')
    return hard, info


def load_signal_revisions():
    data = json.load(open(REV))
    revs = [r for r in data if r['message_id'] == SRC_MSG]
    revs.sort(key=lambda r: r['timestamp'])
    final = max(revs, key=lambda r: r['edit_date'] or '')
    first = None
    for r in revs:                                  # first revision that parses as a signal
        if parse_text(r['text']):
            first = r
            break
    return revs, final, first



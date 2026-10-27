"""Independent Dukascopy bi5 decoder for the LUCAS gold audit (auditor code, written from the spec).

Spec: LZMA 'alone' file of 20-byte big-endian records: uint32 ms offset from hour start, uint32 ask,
uint32 bid, float32 ask volume, float32 bid volume. XAUUSD price = integer / 1000.

Prices are kept as exact integers in units of 0.001 USD ('milli-USD'), so no float rounding can
create or hide a touch. On-disk folders are 1-indexed months (2026/10 = October).
"""
import calendar
import datetime as dt
import lzma
import os
import struct

BASE = '/tmp/claude-1001/twochan/gold/raw'
REC = struct.Struct('>IIIff')
HOUR_MS = 3_600_000


def ms_utc(y, mo, d, h=0, mi=0, s=0, msec=0):
    t = dt.datetime(y, mo, d, h, mi, s, tzinfo=dt.timezone.utc)
    return calendar.timegm(t.timetuple()) * 1000 + msec


def fmt_utc(ms):
    t = dt.datetime.fromtimestamp(ms / 1000.0, tz=dt.timezone.utc)
    return t.strftime('%H:%M:%S.') + f'{ms % 1000:03d}'


def fmt_utc_full(ms):
    t = dt.datetime.fromtimestamp(ms / 1000.0, tz=dt.timezone.utc)
    return t.strftime('%Y-%m-%d %H:%M:%S.') + f'{ms % 1000:03d}'


def hour_path(hour_ms):
    t = dt.datetime.fromtimestamp(hour_ms / 1000.0, tz=dt.timezone.utc)
    return os.path.join(BASE, f'{t.year:04d}', f'{t.month:02d}', f'{t.day:02d}', f'{t.hour:02d}h_ticks.bi5')


def decode_hour(hour_ms):
    """Return ('ok', [(t_ms, ask_milli, bid_milli), ...]) | ('empty', []) | ('missing', [])."""
    p = hour_path(hour_ms)
    if os.path.exists(p + '.empty'):
        return 'empty', []
    if not os.path.exists(p):
        return 'missing', []
    with open(p, 'rb') as fh:
        raw = fh.read()
    if len(raw) == 0:
        return 'empty', []
    dec = lzma.decompress(raw, format=lzma.FORMAT_ALONE)
    if len(dec) % REC.size:
        raise ValueError('bad record alignment in ' + p)
    out = []
    for off in range(0, len(dec), REC.size):
        ms_off, ask, bid, _av, _bv = REC.unpack_from(dec, off)
        out.append((hour_ms + ms_off, ask, bid))
    return 'ok', out


class Ticks:
    """All decoded ticks from start_ms (inclusive) up to known_until (exclusive), in time order."""

    def __init__(self, start_ms, end_ms):
        self.t = []
        self.ask = []
        self.bid = []
        self.hour_status = {}
        h = start_ms - (start_ms % HOUR_MS)
        while h < end_ms:
            status, recs = decode_hour(h)
            self.hour_status[h] = (status, len(recs))
            for (t, a, b) in recs:
                self.t.append(t)
                self.ask.append(a)
                self.bid.append(b)
            h += HOUR_MS
        # first unknown hour bounds what may be used (missing hours are unknown, not "no ticks")
        self.known_until = None
        h = start_ms - (start_ms % HOUR_MS)
        while h < end_ms:
            if self.hour_status[h][0] == 'missing':
                self.known_until = h
                break
            h += HOUR_MS
        if self.known_until is None:
            self.known_until = end_ms

    def check_sorted(self):
        bad = sum(1 for i in range(1, len(self.t)) if self.t[i] <= self.t[i - 1])
        return bad

    def index_at_or_after(self, t_ms):
        """Index of first tick with time >= t_ms (bisect on a sorted list)."""
        import bisect
        return bisect.bisect_left(self.t, t_ms)

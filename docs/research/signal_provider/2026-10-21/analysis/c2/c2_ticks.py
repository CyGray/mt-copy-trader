"""C2 independent tick decoder for the A3 Dukascopy XAUUSD bi5 tree.

Written from the spec: LZMA-alone, 20-byte big-endian records
(uint32 ms offset, uint32 ask, uint32 bid, float32 askvol, float32 bidvol), price = int/1000.
On-disk layout checked in the C2 probe: raw/YYYY/MM/DD/HHh_ticks.bi5 with MM = calendar month (1-indexed).
Run with `python3 -I`; numpy lives in the user site, which -I hides, so it is added explicitly.
"""
import sys
sys.path.append('/home/kyle/.local/lib/python3.12/site-packages')  # numpy (user site hidden by -I)
import os
import lzma
import datetime as dt
from collections import OrderedDict
import numpy as np

SCRATCH = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad'
RAW = os.path.join(SCRATCH, 'a3', 'raw')
REC = np.dtype([('ms', '>u4'), ('ask', '>u4'), ('bid', '>u4'), ('av', '>f4'), ('bv', '>f4')])
HOUR_MS = 3600_000


def hour_start_ms(h_ms):
    return (h_ms // HOUR_MS) * HOUR_MS


def hour_paths(h_ms):
    d = dt.datetime.fromtimestamp(h_ms / 1000, dt.timezone.utc)
    base = os.path.join(RAW, f'{d.year:04d}', f'{d.month:02d}', f'{d.day:02d}', f'{d.hour:02d}h_ticks.bi5')
    return base, base + '.empty'


class HourStore:
    """LRU cache of decoded hours. Each entry: (status, t_ms int64, ask float64, bid float64)."""

    def __init__(self, max_hours=500):
        self.cache = OrderedDict()
        self.max_hours = max_hours
        self.decoded = 0
        self.missing = []  # hours with neither bi5 nor .empty marker

    def get(self, h_ms):
        h_ms = hour_start_ms(h_ms)
        if h_ms in self.cache:
            self.cache.move_to_end(h_ms)
            return self.cache[h_ms]
        bi5, empty = hour_paths(h_ms)
        if os.path.exists(bi5):
            with open(bi5, 'rb') as f:
                raw = lzma.decompress(f.read(), format=lzma.FORMAT_ALONE)
            if len(raw) % 20 != 0:
                raise ValueError(f'bad record length {bi5}')
            rec = np.frombuffer(raw, dtype=REC)
            t = h_ms + rec['ms'].astype(np.int64)
            ask = rec['ask'].astype(np.float64) / 1000.0
            bid = rec['bid'].astype(np.float64) / 1000.0
            val = ('ok', t, ask, bid)
            self.decoded += 1
        elif os.path.exists(empty):
            val = ('empty', np.zeros(0, np.int64), np.zeros(0), np.zeros(0))
        else:
            self.missing.append(h_ms)
            val = ('missing', np.zeros(0, np.int64), np.zeros(0), np.zeros(0))
        self.cache[h_ms] = val
        if len(self.cache) > self.max_hours:
            self.cache.popitem(last=False)
        return val

    def window(self, t0_ms, t1_ms):
        """Ticks with t0 <= t <= t1 (ms epoch), concatenated across hours. Returns t, ask, bid arrays."""
        ts, asks, bids = [], [], []
        h = hour_start_ms(t0_ms)
        while h <= t1_ms:
            st, t, a, b = self.get(h)
            if len(t):
                m0 = np.searchsorted(t, t0_ms, 'left')
                m1 = np.searchsorted(t, t1_ms, 'right')
                ts.append(t[m0:m1]); asks.append(a[m0:m1]); bids.append(b[m0:m1])
            h += HOUR_MS
        if not ts:
            return np.zeros(0, np.int64), np.zeros(0), np.zeros(0)
        return np.concatenate(ts), np.concatenate(asks), np.concatenate(bids)

"""Shared helpers for the Dukascopy XAUUSD tick pipeline (A3 research).

Dukascopy tick file layout (bi5, LZMA-alone): 20-byte big-endian records
  uint32 ms_offset_from_hour_start, uint32 ask_int, uint32 bid_int,
  float32 ask_volume, float32 bid_volume
Price = int / PRICE_DIVISOR. XAUUSD divisor is verified empirically in
verify_decode.py (expected 1000, i.e. three decimals).
"""
import lzma
import os
import struct
import time
import urllib.request
import urllib.error
import datetime as dt

# NOTE: https://datafeed.dukascopy.com/ timed out on TCP 443 from this host;
# plain http on port 80 returns the same files. Content integrity therefore
# relies on plausibility checks (see quality report), not TLS.
BASE = 'http://datafeed.dukascopy.com/datafeed/XAUUSD'
PRICE_DIVISOR = 1000.0
UA = 'Mozilla/5.0 (X11; Linux x86_64) ByTraderResearch/1.0 (private research)'
REC = struct.Struct('>IIIff')


def hour_url(t):
    """t: aware/naive UTC datetime at the top of an hour. Month is 0-indexed."""
    return f'{BASE}/{t.year}/{t.month - 1:02d}/{t.day:02d}/{t.hour:02d}h_ticks.bi5'


def hour_path(rawdir, t):
    return os.path.join(rawdir, f'{t.year}', f'{t.month:02d}', f'{t.day:02d}', f'{t.hour:02d}h_ticks.bi5')


def fetch_hour(t, rawdir, timeout=40, retries=4):
    """Download one hour to rawdir if not cached. Returns (status, nbytes, note).

    status: 'cached' | 'ok' | 'empty' | 'missing' | 'error'
    Resumable: a cached file (even zero-length, marked by .empty) is never refetched.
    """
    path = hour_path(rawdir, t)
    if os.path.exists(path):
        return ('cached', os.path.getsize(path), '')
    if os.path.exists(path + '.empty'):
        return ('empty', 0, 'cached-empty')
    if os.path.exists(path + '.missing'):
        return ('missing', 0, 'cached-missing')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    url = hour_url(t)
    last = ''
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            tmp = path + '.part'
            with open(tmp, 'wb') as f:
                f.write(body)
            if len(body) == 0:
                os.replace(tmp, path + '.empty')
                os.remove(tmp) if os.path.exists(tmp) else None
                return ('empty', 0, 'zero-length')
            os.replace(tmp, path)
            return ('ok', len(body), '')
        except urllib.error.HTTPError as e:
            last = f'HTTP {e.code}'
            if e.code == 404:
                open(path + '.missing', 'w').close()
                return ('missing', 0, last)
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(5 * (attempt + 1) + 2)
                continue
            time.sleep(2)
        except Exception as e:  # network timeouts, resets
            last = type(e).__name__ + ': ' + str(e)[:120]
            time.sleep(3 * (attempt + 1))
    return ('error', 0, last)


def decode_hour(path, hour_start):
    """Return list of (ts_ms_utc, bid, ask, bid_vol, ask_vol) for one bi5 file.

    hour_start: naive UTC datetime of the hour; ts is epoch milliseconds.
    Empty list if the file is empty.
    """
    if os.path.getsize(path) == 0:
        return []
    with open(path, 'rb') as f:
        raw = f.read()
    data = lzma.decompress(raw, format=lzma.FORMAT_ALONE)
    base_ms = int(hour_start.replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    out = []
    for off, ask, bid, av, bv in REC.iter_unpack(data):
        out.append((base_ms + off, bid, ask, bv, av))
    return out


# ---- cached tick-window access (used by alignment and reconstruction scripts) ----
import array as _array
import collections as _collections
import datetime as _dt

_HOUR_CACHE = _collections.OrderedDict()
RAW_DIR_DEFAULT = None


def _floor_hour(ms):
    return ms - (ms % 3600000)


def load_hour_arrays(raw_dir, hour_ms):
    """Return (ts_ms array, bid_int array, ask_int array, bid_vol array, ask_vol array) for the UTC hour starting at hour_ms."""
    key = (raw_dir, hour_ms)
    if key in _HOUR_CACHE:
        _HOUR_CACHE.move_to_end(key)
        return _HOUR_CACHE[key]
    t = _dt.datetime.fromtimestamp(hour_ms / 1000, _dt.timezone.utc).replace(tzinfo=None)
    p = hour_path(raw_dir, t)
    ts = _array.array('q'); bid = _array.array('l'); ask = _array.array('l')
    bv = _array.array('f'); av = _array.array('f')
    if os.path.exists(p) and os.path.getsize(p) > 0:
        with open(p, 'rb') as f:
            data = lzma.decompress(f.read(), format=lzma.FORMAT_ALONE)
        for off, a, b, v_a, v_b in REC.iter_unpack(data):
            ts.append(hour_ms + off); ask.append(a); bid.append(b); av.append(v_a); bv.append(v_b)
    res = (ts, bid, ask, bv, av)
    _HOUR_CACHE[key] = res
    while len(_HOUR_CACHE) > 6:
        _HOUR_CACHE.popitem(last=False)
    return res


def window_ticks(raw_dir, t0_ms, t1_ms):
    """Yield (ts_ms, bid_int, ask_int) for ticks with t0_ms <= ts < t1_ms, in order."""
    import bisect
    h = _floor_hour(t0_ms)
    while h < t1_ms:
        ts, bid, ask, _, _ = load_hour_arrays(raw_dir, h)
        i = bisect.bisect_left(ts, t0_ms)
        j = bisect.bisect_left(ts, t1_ms)
        for k in range(i, j):
            yield ts[k], bid[k], ask[k]
        h += 3600000

"""Tick-level simulation engine for the ByTrader XAUUSD signal study (Agent B1).

Scope: READ-ONLY research. Reconstructs what a trade on a provider signal would
have done on Dukascopy XAUUSD bid/ask ticks (A3's download). Nothing here touches
Telegram, Firestore, the broker or the worker.

Layers
------
1. TickStore      decodes A3's bi5 hours (LZMA, 20-byte big-endian records), caches
                  each decoded hour as .npy, and reports hour status:
                  'ok' (ticks), 'empty' (A3 .empty marker or zero-length file = known
                  no ticks, e.g. weekend closure) or 'unknown' (not downloaded / error).
2. load_window    ticks in [t0, t1) plus `known_until`, the start of the first
                  'unknown' hour. Nothing at or after known_until is ever used.
3. Market         a per-(window, direction, extra_spread) view: exit-side and
                  entry-side executable prices and a cache of first-touch hit indices.
4. decide_entry   P1 / P2 / P3 entry policies -> Fill (or SKIPPED_* / NO_PRICE_DATA).
5. simulate       strategy state machine (TP checkpoints, SL moves, break-even,
                  trailing, runner, horizon / weekend cutoff) -> TradeResult dict.
6. baseline_touch first-touch table for the provider-as-is baseline (original SL and
                  all TPs, no management).

Conventions (all prices USD; see the constants below)
-----------------------------------------------------
* extra_spread E (total widening): ask' = ask + E/2, bid' = bid - E/2.
* BUY  enters at ask' (+slippage adverse), exits at bid'.
  SELL enters at bid' (-slippage adverse), exits at ask'.
* "y-space": y = fav * exit_price, fav = +1 BUY, -1 SELL. In y-space every stop is
  "hit when y <= level" and every TP is "hit when y >= level", and a tighter stop is a
  larger y-level. This removes BUY/SELL branches from the search code.
* SL hit at tick k: fill = min(bid_k, SL) - slip (BUY); max(ask_k, SL) + slip (SELL),
  i.e. the tick price when the market gapped through the stop, otherwise the stop.
* TP hit: fill = TP price exactly (limit semantics, no price improvement on gaps).
* Pending limit fills: fill = limit price, plus adverse slippage (conservative).
* Same-tick SL/TP: SL is processed first (conservative) and `same_tick_ambiguity`
  is set. With a single quote feed and valid geometry this cannot occur for a
  single position (bid cannot be both <= SL and >= TP), so the count is a sanity check.
* Exit checks start at the tick AFTER the fill tick (the fill tick itself is recorded
  in `fill_tick_exit_condition` if an exit condition already holds there).
* Horizon: ticks with time < fill + horizon are inspected. A position still open at
  the horizon is marked to the last tick before it (exit side) and labelled
  UNRESOLVED_MTM.
* Data gaps: ticks after `known_until` are never inspected. If the horizon or a
  needed trigger lies beyond known_until and the trade is not resolved before it, the
  result is NO_PRICE_DATA (partial facts before the gap are kept in the result).

Dependencies: numpy. `python3 -I` hides the user site-packages where numpy lives on
this host, so the module appends that path explicitly (no pip, no cwd imports).
"""
import sys

try:  # numpy may be visible already (plain python3) or only via the user site
    import numpy as np
except ImportError:  # pragma: no cover - environment specific
    sys.path.append('/home/kyle/.local/lib/python3.12/site-packages')
    import numpy as np

import datetime as dt
import lzma
import math
import os
from collections import OrderedDict

# ---------------------------------------------------------------- constants
PRICE_DIVISOR = 1000.0            # XAUUSD: integer price / 1000 (verified vs plausible range)
HOUR_MS = 3_600_000
MIN_MS = 60_000
CONTRACT_OZ = 100.0               # UNVERIFIED for Vantage XAUUSD: USD per 1.00 price move per 1.0 lot
RAW_DTYPE = np.dtype([('ms', '>u4'), ('ask', '>u4'), ('bid', '>u4'), ('askv', '>f4'), ('bidv', '>f4')])
CACHE_DTYPE = np.dtype([('ms', '<u4'), ('ask', '<i4'), ('bid', '<i4')])
ORDER_DIRECTIONS = ('buy', 'sell')
EPS = 1e-9

INF = float('inf')


def floor_hour_ms(ms):
    return ms - (ms % HOUR_MS)


def utc_ms(iso):
    """'2025-10-30T11:36:52Z' or '...000Z' -> epoch ms (UTC)."""
    s = iso.replace('Z', '+00:00')
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(round(d.timestamp() * 1000))


def iso_utc(ms):
    return dt.datetime.fromtimestamp(ms / 1000.0, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')[:-4] + 'Z'


# ---------------------------------------------------------------- tick store
class TickStore:
    """Hourly XAUUSD ticks from A3's Dukascopy download.

    raw layout (A3 convention, month is 1-indexed on disk, 0-indexed only in the URL):
        raw_dir/YYYY/MM/DD/HHh_ticks.bi5   (+ .empty marker for zero-length hours)
    cache layout: cache_dir/YYYYMMDDHH_<rawbytes>.npy  (structured: ms offset, ask, bid as ints)
    """

    def __init__(self, raw_dir, cache_dir, mem_hours=24):
        self.raw_dir = raw_dir
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self._mem = OrderedDict()
        self._mem_max = mem_hours
        self._status = {}

    def hour_path(self, hour_ms):
        t = dt.datetime.fromtimestamp(hour_ms / 1000.0, dt.timezone.utc)
        return os.path.join(self.raw_dir, f'{t.year}', f'{t.month:02d}', f'{t.day:02d}', f'{t.hour:02d}h_ticks.bi5')

    def status(self, hour_ms):
        """'ok' | 'empty' | 'unknown'. 'unknown' includes .missing (404) and .error states."""
        hit = self._status.get(hour_ms)
        if hit is not None:
            return hit
        p = self.hour_path(hour_ms)
        if os.path.exists(p):
            st = 'ok' if os.path.getsize(p) > 0 else 'empty'
        elif os.path.exists(p + '.empty'):
            st = 'empty'
        else:
            st = 'unknown'
        self._status[hour_ms] = st
        return st

    def raw_size(self, hour_ms):
        p = self.hour_path(hour_ms)
        return os.path.getsize(p) if os.path.exists(p) else 0

    def decode_raw(self, hour_ms):
        """Return (ms_offset u4, ask_i i4, bid_i i4) structured array for one hour file."""
        p = self.hour_path(hour_ms)
        with open(p, 'rb') as f:
            data = lzma.decompress(f.read(), format=lzma.FORMAT_ALONE)
        if len(data) % 20 != 0:
            raise ValueError(f'bad bi5 length {len(data)} in {p}')
        a = np.frombuffer(data, dtype=RAW_DTYPE)
        out = np.empty(len(a), dtype=CACHE_DTYPE)
        out['ms'] = a['ms']
        out['ask'] = a['ask'].astype(np.int64)
        out['bid'] = a['bid'].astype(np.int64)
        return out

    def _cache_path(self, hour_ms):
        t = dt.datetime.fromtimestamp(hour_ms / 1000.0, dt.timezone.utc)
        return os.path.join(self.cache_dir, f'{t:%Y%m%d%H}_{self.raw_size(hour_ms)}.npy')

    def raw_arrays(self, hour_ms):
        """Structured cache array for an 'ok' hour (decodes and caches on first use)."""
        cp = self._cache_path(hour_ms)
        if os.path.exists(cp):
            return np.load(cp)
        arr = self.decode_raw(hour_ms)
        tmp = cp + '.tmp.npy'
        np.save(tmp, arr)
        os.replace(tmp, cp)
        return arr

    def load_hour(self, hour_ms):
        """(ms_abs int64, bid float64, ask float64) for one hour; empty arrays if not 'ok'."""
        hit = self._mem.get(hour_ms)
        if hit is not None:
            self._mem.move_to_end(hour_ms)
            return hit
        if self.status(hour_ms) != 'ok':
            res = (np.zeros(0, np.int64), np.zeros(0), np.zeros(0))
        else:
            a = self.raw_arrays(hour_ms)
            ms = hour_ms + a['ms'].astype(np.int64)
            res = (ms, a['bid'].astype(np.float64) / PRICE_DIVISOR, a['ask'].astype(np.float64) / PRICE_DIVISOR)
        self._mem[hour_ms] = res
        while len(self._mem) > self._mem_max:
            self._mem.popitem(last=False)
        return res


class Window:
    """Ticks in [t0, min(t1, known_until)) with coverage metadata."""

    def __init__(self, ms, bid, ask, t0, t1, known_until, hours):
        self.ms, self.bid, self.ask = ms, bid, ask
        self.t0, self.t1 = t0, t1
        self.known_until = known_until      # ms; first unknown hour start within [t0, t1), or t1
        self.truncated = known_until < t1   # True => data missing inside the requested span
        self.hours = hours                  # list of (hour_ms, status)


def load_window(store, t0, t1):
    """Load ticks for [t0, t1) (epoch ms). Stops at the first 'unknown' hour."""
    h = floor_hour_ms(t0)
    known_until = t1
    parts = []
    hours = []
    while h < t1:
        st = store.status(h)
        hours.append((h, st))
        if st == 'unknown':
            known_until = max(t0, h)
            break
        if st == 'ok':
            ms, b, a = store.load_hour(h)
            parts.append((ms, b, a))
        h += HOUR_MS
    if parts:
        ms = np.concatenate([p[0] for p in parts])
        bid = np.concatenate([p[1] for p in parts])
        ask = np.concatenate([p[2] for p in parts])
    else:
        ms = np.zeros(0, np.int64)
        bid = np.zeros(0)
        ask = np.zeros(0)
    m = (ms >= t0) & (ms < min(t1, known_until))
    return Window(ms[m], bid[m], ask[m], t0, t1, known_until, hours)


# ---------------------------------------------------------------- market view
class Market:
    """Executable price view for one direction and one extra-spread scenario.

    exit_px  : price at which the position is closed (BUY: bid', SELL: ask').
    entry_px : price at which the position is opened  (BUY: ask', SELL: bid').
    y        : fav * exit_px (see module docstring).
    """

    def __init__(self, win, direction, extra_spread=0.0):
        if direction not in ORDER_DIRECTIONS:
            raise ValueError(direction)
        self.direction = direction
        self.fav = 1.0 if direction == 'buy' else -1.0
        half = extra_spread / 2.0
        if direction == 'buy':
            self.exit_px = win.bid - half
            self.entry_px = win.ask + half
        else:
            self.exit_px = win.ask + half
            self.entry_px = win.bid - half
        self.y = self.fav * self.exit_px
        self.ms = win.ms
        self.n = len(win.ms)
        self.t0, self.t1 = win.t0, win.t1
        self.known_until = win.known_until
        self.truncated = win.truncated
        self.hours = win.hours
        self._hits = {}

    def _hits_ge(self, level):
        key = (0, level)
        h = self._hits.get(key)
        if h is None:
            h = np.flatnonzero(self.y >= level)
            self._hits[key] = h
        return h

    def _hits_le(self, level):
        key = (1, level)
        h = self._hits.get(key)
        if h is None:
            h = np.flatnonzero(self.y <= level)
            self._hits[key] = h
        return h

    def first_ge(self, level, start, stop):
        """First index in [start, stop) with y >= level, else None."""
        if start >= stop:
            return None
        h = self._hits_ge(level)
        p = int(np.searchsorted(h, start))
        if p < len(h) and h[p] < stop:
            return int(h[p])
        return None

    def first_le(self, level, start, stop):
        if start >= stop:
            return None
        h = self._hits_le(level)
        p = int(np.searchsorted(h, start))
        if p < len(h) and h[p] < stop:
            return int(h[p])
        return None

    def idx_at(self, t_ms):
        """First tick index with ms >= t_ms."""
        return int(np.searchsorted(self.ms, t_ms, 'left'))


# ---------------------------------------------------------------- data classes
class Signal:
    __slots__ = ('message_id', 't_ms', 'direction', 'entry_low', 'entry_high', 'sl', 'tps', 'quality_flag', 'meta')

    def __init__(self, message_id, t_ms, direction, entry_low, entry_high, sl, tps, quality_flag='', meta=None):
        self.message_id = str(message_id)
        self.t_ms = int(t_ms)
        self.direction = direction
        self.entry_low = float(entry_low)
        self.entry_high = float(entry_high)
        self.sl = float(sl)
        self.tps = tuple(None if t is None else float(t) for t in tps)  # index 0 = TP1
        self.quality_flag = quality_flag
        self.meta = meta or {}

    @property
    def fav(self):
        return 1.0 if self.direction == 'buy' else -1.0

    @property
    def entry_mid(self):
        return 0.5 * (self.entry_low + self.entry_high)


class EntryParams:
    """policy: 'P1' market-if-in-range | 'P2' P1 + pending at range edge | 'P3' ideal mid (non-executable)."""

    def __init__(self, policy='P1', latency_s=5.0, tol=0.5, expiry_min=60.0, extra_spread=0.0, slippage=0.0):
        if policy not in ('P1', 'P2', 'P3'):
            raise ValueError(policy)
        self.policy = policy
        self.latency_s = float(latency_s)
        self.tol = float(tol)
        self.expiry_min = float(expiry_min)
        self.extra_spread = float(extra_spread)
        self.slippage = float(slippage)

    def label(self):
        return (f'{self.policy}_lat{self.latency_s:g}s_tol{self.tol:g}_exp{self.expiry_min:g}m'
                f'_spr{self.extra_spread:g}_slip{self.slippage:g}')


class Fill:
    """Result of the entry decision. status is FILLED, SKIPPED_<reason>, or NO_PRICE_DATA."""

    def __init__(self, status, reason='', fill_ms=None, fill_px=None, kind='', start_idx=None,
                 first_tick_ms=None, first_entry_px=None, outside_dist=None, pending_placed_ms=None):
        self.status = status
        self.reason = reason
        self.fill_ms = fill_ms
        self.fill_px = fill_px
        self.kind = kind                     # market | buy_limit | sell_limit | ideal
        self.start_idx = start_idx           # first tick index where exits are inspected
        self.fill_idx = None
        self.first_tick_ms = first_tick_ms
        self.first_entry_px = first_entry_px
        self.outside_dist = outside_dist     # USD, signed: >0 above range+tol, <0 below range-tol
        self.pending_placed_ms = pending_placed_ms

    @property
    def filled(self):
        return self.status == 'FILLED'


def decide_entry(sig, ep, mk):
    """Entry decision for one signal under EntryParams ep, using Market mk (direction must match)."""
    if mk.direction != sig.direction:
        raise ValueError('market direction mismatch')
    fav = sig.fav
    lo, hi = sig.entry_low, sig.entry_high
    tol = ep.tol
    slip = ep.slippage
    t_start = sig.t_ms + int(round(ep.latency_s * 1000))

    def sl_ok(px):
        return (sig.sl < px) if fav > 0 else (sig.sl > px)

    if ep.policy == 'P3':
        i0 = mk.idx_at(sig.t_ms)
        if mk.truncated and sig.t_ms >= mk.known_until:
            return Fill('NO_PRICE_DATA', 'signal_time_in_unknown_hour')
        if i0 >= mk.n:
            return Fill('NO_PRICE_DATA' if mk.truncated else 'SKIPPED_no_tick', 'no_tick_after_signal')
        px = sig.entry_mid
        if not sl_ok(px):
            return Fill('SKIPPED_sl_wrong_side_at_fill', 'sl_wrong_side_at_fill', sig.t_ms, px, 'ideal', i0)
        f = Fill('FILLED', '', sig.t_ms, px, 'ideal', i0, first_tick_ms=int(mk.ms[i0]),
                 first_entry_px=float(mk.entry_px[i0]))
        f.fill_idx = i0
        return f

    if mk.truncated and t_start >= mk.known_until:
        return Fill('NO_PRICE_DATA', 'latency_point_in_unknown_hour')
    i0 = mk.idx_at(t_start)
    if i0 >= mk.n:
        return Fill('NO_PRICE_DATA' if mk.truncated else 'SKIPPED_no_tick', 'no_tick_after_latency')
    p = float(mk.entry_px[i0])
    t_tick = int(mk.ms[i0])
    lo_b, hi_b = lo - tol, hi + tol
    inside = lo_b - EPS <= p <= hi_b + EPS
    if fav > 0:
        outside_dist = (p - hi_b) if p > hi_b else ((p - lo_b) if p < lo_b else 0.0)
        unfavourable = p > hi_b + EPS
    else:
        outside_dist = (p - lo_b) if p < lo_b else ((p - hi_b) if p > hi_b else 0.0)
        unfavourable = p < lo_b - EPS

    if inside:
        fill_px = p + fav * slip
        if not sl_ok(fill_px):
            f = Fill('SKIPPED_sl_wrong_side_at_fill', 'sl_wrong_side_at_fill', t_tick, fill_px, 'market', i0,
                     t_tick, p, outside_dist)
            return f
        f = Fill('FILLED', '', t_tick, fill_px, 'market', i0 + 1, t_tick, p, outside_dist)
        f.fill_idx = i0
        return f

    if ep.policy == 'P1':
        return Fill('SKIPPED_price_outside_range', 'price_outside_range', None, None, '', None,
                    t_tick, p, outside_dist)

    # P2: pending at the range edge only when price is beyond the range in the unfavourable direction
    if not unfavourable:
        return Fill('SKIPPED_price_outside_range', 'price_outside_range_favourable_side', None, None, '', None,
                    t_tick, p, outside_dist)
    limit = hi if fav > 0 else lo
    expiry_ms = t_tick + int(round(ep.expiry_min * MIN_MS))
    stop = mk.idx_at(expiry_ms + 1)
    if fav > 0:
        j = mk.first_le(limit, i0 + 1, min(stop, mk.n))
    else:
        j = mk.first_ge(limit, i0 + 1, min(stop, mk.n))
    if j is None:
        if mk.truncated and expiry_ms >= mk.known_until:
            return Fill('NO_PRICE_DATA', 'pending_expiry_in_unknown_hour', None, None, 'pending', None,
                        t_tick, p, outside_dist, t_tick)
        return Fill('SKIPPED_pending_expired', 'pending_not_filled_before_expiry', None, None, 'pending', None,
                    t_tick, p, outside_dist, t_tick)
    fill_px = limit + fav * slip
    kind = 'buy_limit' if fav > 0 else 'sell_limit'
    if not sl_ok(fill_px):
        return Fill('SKIPPED_sl_wrong_side_at_fill', 'sl_wrong_side_at_fill', int(mk.ms[j]), fill_px, kind,
                    None, t_tick, p, outside_dist, t_tick)
    f = Fill('FILLED', '', int(mk.ms[j]), fill_px, kind, j + 1, t_tick, p, outside_dist, t_tick)
    f.fill_idx = j
    return f


# ---------------------------------------------------------------- conventions and strategy
class Conventions:
    def __init__(self, contract_oz=CONTRACT_OZ, swap_usd_per_lot_per_rollover=0.0, weekend_cutoff_utc=(20, 45)):
        self.contract_oz = float(contract_oz)                 # UNVERIFIED (Vantage XAUUSD)
        self.swap_usd_per_lot_per_rollover = float(swap_usd_per_lot_per_rollover)  # default 0 = Unknown
        self.weekend_cutoff_utc = weekend_cutoff_utc          # Friday cut-off for close-before-weekend


class Strategy:
    """Management specification. All fields are plain data so variants can be generated in bulk.

    checkpoints       : tuple of (tp_index 1-based, close_pct); pcts + runner_pct must sum to 100.
    runner_pct        : share left open with no TP (managed by SL/BE/trail until horizon).
    close_all_at      : optional tp_index; checkpoints after it are dropped and that checkpoint closes the rest.
    missing_tp        : 'merge_into_last_available' | 'skip_trade'       (project schema 3.6)
    infeasible_split  : 'merge_into_next' | 'skip_trade'                 (project schema 3.6)
    units             : 'fraction' (position = 1.0) | 'lots' (total_lots, volume_min, volume_step)
    sl_after          : tuple of (after_tp_index, move_to 'entry'|'previous_tp', buffer_usd)
    break_even        : None | ('after_tp', k, buffer) | ('price', distance, buffer)
    trailing          : None | (('after_tp', k) | ('price', distance), distance, step)
    horizon_h         : hold limit from fill (hours)
    close_before_weekend : forced close at Friday 20:45 UTC (see weekend_cutoff)
    manage_latency_s  : delay before SL moves (BE / sl_after / trail activation) take effect
    broker_tp         : recorded only; the tick model treats broker and managed TP identically
    """

    def __init__(self, name, checkpoints=((1, 100.0),), runner_pct=0.0, close_all_at=None,
                 missing_tp='merge_into_last_available', infeasible_split='merge_into_next',
                 units='fraction', total_lots=0.10, volume_min=0.01, volume_step=0.01,
                 sl_after=(), break_even=None, trailing=None, horizon_h=72.0,
                 close_before_weekend=False, manage_latency_s=0.0, broker_tp='final_checkpoint'):
        self.name = name
        self.checkpoints = tuple((int(k), float(p)) for k, p in checkpoints)
        self.runner_pct = float(runner_pct)
        total = sum(p for _, p in self.checkpoints) + self.runner_pct
        if abs(total - 100.0) > 1e-6:
            raise ValueError(f'{name}: checkpoint pcts + runner must sum to 100 (got {total})')
        if any(p <= 0 for _, p in self.checkpoints):
            raise ValueError(f'{name}: close_percent must be > 0')
        ks = [k for k, _ in self.checkpoints]
        if ks != sorted(ks) or len(set(ks)) != len(ks):
            raise ValueError(f'{name}: tp_index must be strictly ascending')
        self.close_all_at = close_all_at
        self.missing_tp = missing_tp
        self.infeasible_split = infeasible_split
        if units not in ('fraction', 'lots'):
            raise ValueError(units)
        self.units = units
        self.total_lots = float(total_lots)
        self.volume_min = float(volume_min)
        self.volume_step = float(volume_step)
        self.sl_after = tuple(sl_after)
        for k, mv, _buf in self.sl_after:
            if mv not in ('entry', 'previous_tp'):
                raise ValueError(mv)
            if k not in ks:
                raise ValueError(f'{name}: sl_after tp_index {k} must match a checkpoint')
        self.break_even = break_even
        self.trailing = trailing
        if trailing is not None:
            act, dist, step = trailing
            if dist <= 0 or step <= 0:
                raise ValueError('trailing distance and step must be > 0')
        self.horizon_h = float(horizon_h)
        self.close_before_weekend = bool(close_before_weekend)
        self.manage_latency_s = float(manage_latency_s)
        self.broker_tp = broker_tp

    def describe(self):
        cps = '/'.join(f'TP{k}:{p:g}%' for k, p in self.checkpoints)
        extra = []
        if self.runner_pct:
            extra.append(f'runner:{self.runner_pct:g}%')
        if self.sl_after:
            extra.append('sl_after=' + ';'.join(f'TP{k}->{mv}{b:+g}' for k, mv, b in self.sl_after))
        if self.break_even:
            extra.append(f'BE={self.break_even}')
        if self.trailing:
            extra.append(f'trail={self.trailing}')
        if self.close_before_weekend:
            extra.append('close_before_weekend')
        return self.name + ' [' + cps + (' ' + ' '.join(extra) if extra else '') + ']'


class Skip(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _beyond(p, ref, fav):
    return (p - ref) * fav > 0


def plan_legs(sig, fill_px, strat):
    """Checkpoint legs for a fill. Mirrors worker/src/lib/positionSizing.ts planCheckpoints.

    Returns (legs, warnings). legs: list of dict(kind 'tp'|'runner', tp_index, price, frac, lots).
    Raises Skip(reason) when the trade is refused under the strategy's rules.
    """
    fav = sig.fav
    cps = [[k, p] for k, p in strat.checkpoints]
    if strat.close_all_at is not None:
        keep = []
        for k, p in cps:
            if k < strat.close_all_at:
                keep.append([k, p])
            elif k == strat.close_all_at:
                keep.append([k, 100.0 - strat.runner_pct - sum(q for _, q in keep)])
                break
        if not keep or keep[-1][0] != strat.close_all_at:
            raise Skip('close_all_at_not_in_checkpoints')
        cps = keep
    warnings = []
    cands = []
    missing = []
    for k, p in cps:
        price = sig.tps[k - 1] if k - 1 < len(sig.tps) else None
        if price is None:
            missing.append((k, p))
        else:
            cands.append({'kind': 'tp', 'tp_index': k, 'price': price, 'pct': p})
    if missing:
        if strat.missing_tp == 'skip_trade' or not cands:
            raise Skip('tp_missing')
        folded = sum(p for _, p in missing)
        cands[-1]['pct'] += folded
        warnings.append('tp_missing_folded:' + ','.join(str(k) for k, _ in missing))
    prev = None
    for c in cands:
        if not _beyond(c['price'], fill_px, fav):
            raise Skip('tp_order_invalid')
        if prev is not None and not _beyond(c['price'], prev, fav):
            raise Skip('tp_order_invalid')
        prev = c['price']
    if strat.runner_pct > 0:
        cands.append({'kind': 'runner', 'tp_index': None, 'price': None, 'pct': strat.runner_pct})

    if strat.units == 'fraction':
        legs = [dict(c, frac=c['pct'] / 100.0, lots=None) for c in cands]
        return legs, warnings

    # lots mode: integer step units, non-final legs round DOWN, final leg takes the remainder
    step = strat.volume_step
    total_u_f = strat.total_lots / step
    total_u = int(round(total_u_f))
    if abs(total_u - total_u_f) > 1e-7:
        raise Skip('volume_not_step_aligned')
    vmin_u = int(round(strat.volume_min / step))
    if total_u < vmin_u:
        raise Skip('volume_below_min')
    while True:
        n = len(cands)
        closes = []
        alloc = 0
        for j, c in enumerate(cands):
            if j == n - 1:
                cu = total_u - alloc
            else:
                cu = int(math.floor(total_u * c['pct'] / 100.0 + 1e-9))
            closes.append(cu)
            alloc += cu
        remaining = []
        left = total_u
        for cu in closes:
            left -= cu
            remaining.append(left)
        bad = None
        for j in range(n):
            if closes[j] < vmin_u:
                bad = j
                break
            if j < n - 1 and remaining[j] < vmin_u:
                bad = j
                break
        if bad is None:
            break
        if strat.infeasible_split == 'skip_trade' or n == 1:
            raise Skip('tp_split_infeasible')
        target = bad + 1 if bad < n - 1 else bad - 1
        cands[target]['pct'] += cands[bad]['pct']
        warnings.append(f'split_infeasible_merged:{cands[bad]["kind"]}{cands[bad]["tp_index"] or ""}')
        cands.pop(bad)
    legs = []
    for c, cu in zip(cands, closes):
        legs.append(dict(c, frac=cu / total_u, lots=cu * step))
    return legs, warnings


def _cutoff_ms(fill_ms, conv):
    """Friday 20:45 UTC cut-off for close_before_weekend: None if no entry allowed (Fri after cut-off)."""
    d = dt.datetime.fromtimestamp(fill_ms / 1000.0, dt.timezone.utc)
    hh, mm = conv.weekend_cutoff_utc
    wd = d.weekday()  # Mon=0 .. Sun=6
    days_to_fri = (4 - wd) % 7
    fri = (d + dt.timedelta(days=days_to_fri)).replace(hour=hh, minute=mm, second=0, microsecond=0)
    c = int(fri.timestamp() * 1000)
    if wd in (5, 6):
        c = c + 7 * 86_400_000 if c <= fill_ms else c
        return c
    if c <= fill_ms:
        return None
    return c


def _rollovers(a_ms, b_ms):
    """Number of 22:00 UTC rollovers strictly inside (a_ms, b_ms]. Approximate swap count."""
    if b_ms <= a_ms:
        return 0
    first = (a_ms // 86_400_000) * 86_400_000 + 22 * 3_600_000
    if first <= a_ms:
        first += 86_400_000
    if first > b_ms:
        return 0
    return int((b_ms - first) // 86_400_000) + 1


# ---------------------------------------------------------------- simulation core
def _chunk_trail_hit(y, a, b, state, base, dist, step, static_y):
    """First index k in [a, b] with y[k] <= max(static_y, T_k), T_k = trailing stop in effect before tick k.

    state = max of y over trail ticks before a (-inf if none). Read-only: does not update state.
    """
    CH = 4096
    k0 = a
    st = state
    while k0 <= b:
        k1 = min(b, k0 + CH - 1)
        arr = y[k0:k1 + 1]
        cm = np.maximum(np.maximum.accumulate(arr), st)
        prev = np.empty_like(arr)
        prev[0] = st
        prev[1:] = cm[:-1]
        with np.errstate(invalid='ignore', over='ignore'):
            q = np.floor(np.maximum(0.0, prev - dist - base) / step) * step
        T = np.where(np.isneginf(prev), base, base + q)
        hit = arr <= np.maximum(static_y, T)
        if hit.any():
            return k0 + int(np.argmax(hit))
        st = float(cm[-1])
        k0 = k1 + 1
    return None


def _trail_stop_y(y, start, idx, base, dist, step, static_y):
    """Effective y-level of the stop in effect at tick idx (trail started at `start`)."""
    if idx <= start:
        return max(static_y, base)
    M = float(np.max(y[start:idx]))
    q = math.floor(max(0.0, M - dist - base) / step) * step
    return max(static_y, base + q)


def simulate(sig, fill, strat, mk, conv=None, slip=0.0):
    """Simulate one signal under one strategy on Market mk. Returns a TradeResult dict.

    `fill` must come from decide_entry on the same Market. `slip` is the adverse stop-exit slippage
    (USD); entry slippage is already inside fill.fill_px. Results are deterministic.
    """
    conv = conv or Conventions()
    fav = sig.fav
    res = {'message_id': sig.message_id, 'direction': sig.direction, 'strategy': strat.name,
           'status': fill.status, 'reason': fill.reason, 'outcome': '', 'exit_seq': '', 'final_exit': '',
           'flags': []}
    if fill.status != 'FILLED':
        return res
    fill_px = fill.fill_px
    R = abs(fill_px - sig.sl)
    res.update(fill_ms=fill.fill_ms, fill_px=fill_px, R=R, fill_kind=fill.kind)
    if R <= 0:
        res['status'] = 'SKIPPED_zero_risk'
        res['reason'] = 'zero_risk'
        return res
    try:
        legs, warns = plan_legs(sig, fill_px, strat)
    except Skip as e:
        res['status'] = 'SKIPPED_' + e.reason
        res['reason'] = e.reason
        return res
    res['flags'].extend(warns)

    horizon_ms = fill.fill_ms + int(round(strat.horizon_h * HOUR_MS))
    hz_reason = '%gh' % strat.horizon_h
    if strat.close_before_weekend:
        cut = _cutoff_ms(fill.fill_ms, conv)
        if cut is None:
            res['status'] = 'SKIPPED_after_weekend_cutoff'
            res['reason'] = 'after_weekend_cutoff'
            return res
        if cut < horizon_ms:
            horizon_ms = cut
            hz_reason = 'weekend_cutoff'
    n = mk.n
    hz_idx = min(mk.idx_at(horizon_ms), n)
    data_limited = mk.truncated and horizon_ms > mk.known_until
    start = fill.start_idx if fill.start_idx is not None else min(mk.idx_at(fill.fill_ms), n)
    if fill.fill_idx is not None and 0 <= fill.fill_idx < n and fill.kind != 'ideal':
        yf = mk.y[fill.fill_idx]
        if yf <= fav * sig.sl or any(t is not None and yf >= fav * t for t in sig.tps):
            res['flags'].append('fill_tick_exit_condition')
    lat_ms = int(round(strat.manage_latency_s * 1000))

    static_y = fav * sig.sl
    sl_kind = 'SL'
    trail = None                     # dict(start, base, dist, step, state)
    pending = []                     # list of (eff_idx, action)
    price_acts = []                  # (y_level, action) price-distance activations not fired yet
    if strat.break_even and strat.break_even[0] == 'price':
        price_acts.append((fav * fill_px + strat.break_even[1], ('be', strat.break_even[2])))
    if strat.trailing and strat.trailing[0][0] == 'price':
        _, dist, step = strat.trailing
        price_acts.append((fav * fill_px + strat.trailing[0][1], ('trail', dist, step)))

    open_legs = list(legs)
    exits = []
    state = dict(remaining=sum(l['frac'] for l in legs))
    final = None
    done = False
    same_tick = False
    i = start

    def next_tp(i_, stop):
        best = None
        for leg in open_legs:
            if leg['kind'] != 'tp':
                continue
            j = mk.first_ge(fav * leg['price'], i_, stop)
            if j is not None and (best is None or j < best[0]):
                best = (j, leg)
        return best

    def close_leg(leg, idx, px, kind):
        exits.append(dict(kind=kind, idx=idx, ms=(int(mk.ms[idx]) if idx is not None and idx < n else None),
                          px=float(px), frac=leg['frac'], lots=leg['lots'], tp_index=leg.get('tp_index')))
        open_legs.remove(leg)
        state['remaining'] -= leg['frac']

    def queue(idx_tick, action):
        if lat_ms <= 0:
            eff = idx_tick
        else:
            eff = int(np.searchsorted(mk.ms, mk.ms[idx_tick] + lat_ms, 'left'))
        pending.append((eff, action))

    while True:
        if pending:
            due = [p for p in pending if p[0] <= i]
            if due:
                pending[:] = [p for p in pending if p[0] > i]
                for _, act in due:
                    if act[0] == 'set_static':
                        if act[1] > static_y:
                            static_y = act[1]
                            sl_kind = act[2]
                    elif act[0] == 'trail':
                        trail = dict(start=i, base=static_y, dist=act[1], step=act[2], state=-INF)
        if i >= n:
            break
        nt = next_tp(i, hz_idx)
        bp = hz_idx
        if nt is not None and nt[0] < bp:
            bp = nt[0]
        for lvl, _ in price_acts:
            j = mk.first_ge(lvl, i, bp)
            if j is not None and j < bp:
                bp = j
        for eff, _ in pending:
            # a pending SL change must be applied before the stop check on tick `eff`: end the segment at eff-1
            if eff > i and eff - 1 < bp:
                bp = eff - 1
        # --- stop check over [i, hi]; hi includes the event tick bp (SL is checked first on it)
        hi = min(bp, hz_idx - 1, n - 1)
        hit = None
        if hi >= i:
            hit = mk.first_le(static_y, i, hi + 1)
            if trail is not None:
                a = max(i, trail['start'])
                if a <= hi:
                    ht = _chunk_trail_hit(mk.y, a, hi, trail['state'], trail['base'], trail['dist'],
                                          trail['step'], static_y)
                    if ht is not None and (hit is None or ht < hit):
                        hit = ht
        if hit is not None:
            if nt is not None and hit == nt[0] and hit < hz_idx:
                same_tick = True
            ylev = _trail_stop_y(mk.y, trail['start'], hit, trail['base'], trail['dist'], trail['step'], static_y) \
                if trail is not None and hit >= trail['start'] else static_y
            kind_lbl = 'TRAIL' if (trail is not None and hit >= trail['start'] and ylev > static_y + EPS) else sl_kind
            px = fav * (min(mk.y[hit], ylev) - slip)
            for leg in list(open_legs):
                close_leg(leg, hit, px, kind_lbl)
            final = kind_lbl
            done = True
            break
        # no stop hit in [i, hi]: advance trailing running max through hi
        if trail is not None:
            a = max(i, trail['start'])
            if a <= hi:
                trail['state'] = max(trail['state'], float(np.max(mk.y[a:hi + 1])))
        if bp >= hz_idx:
            if data_limited and hz_idx >= n:
                final = 'NO_PRICE_DATA'
                break
            mtm_idx = hz_idx - 1 if (hz_idx - 1 >= start and hz_idx - 1 < n) else None
            mtm_px = float(mk.exit_px[mtm_idx]) if mtm_idx is not None else float(fill_px)
            if mtm_idx is None:
                res['flags'].append('mtm_at_fill_no_tick')
            for leg in list(open_legs):
                close_leg(leg, mtm_idx, mtm_px, 'MTM')
            final = 'MTM'
            done = True
            break
        i = bp
        # --- events at bp (bp < hz_idx)
        while True:
            nt = next_tp(bp, hz_idx)
            if nt is None or nt[0] != bp:
                break
            leg = nt[1]
            tp_k = leg['tp_index']
            close_leg(leg, bp, leg['price'], 'TP%d' % tp_k)
            if strat.break_even and strat.break_even[0] == 'after_tp' and strat.break_even[1] == tp_k:
                queue(bp, ('set_static', fav * (fill_px + fav * strat.break_even[2]), 'BE'))
            for after_k, mv, buf in strat.sl_after:
                if after_k != tp_k:
                    continue
                if mv == 'previous_tp':
                    prev_price = sig.tps[tp_k - 2] if (tp_k >= 2 and tp_k - 2 < len(sig.tps)) else None
                    if prev_price is None:
                        res['flags'].append('sl_prev_tp_unavailable_TP%d' % tp_k)
                        queue(bp, ('set_static', fav * (fill_px + fav * buf), 'BE'))
                    else:
                        queue(bp, ('set_static', fav * (prev_price + fav * buf), 'SL_PREV_TP'))
                else:
                    queue(bp, ('set_static', fav * (fill_px + fav * buf), 'BE'))
            if strat.trailing and strat.trailing[0][0] == 'after_tp' and strat.trailing[0][1] == tp_k:
                _, dist, step = strat.trailing
                queue(bp, ('trail', dist, step))
            if not open_legs:
                break
        # --- price-distance activations that fire at bp (y[bp] >= level implies first hit <= bp)
        keep = []
        for lvl, act in price_acts:
            if mk.y[bp] >= lvl:
                if act[0] == 'be':
                    queue(bp, ('set_static', fav * (fill_px + fav * act[1]), 'BE'))
                else:
                    queue(bp, ('trail', act[1], act[2]))
            else:
                keep.append((lvl, act))
        price_acts = keep
        if not open_legs:
            final = 'TP_COMPLETE'
            done = True
            break
        i = bp + 1

    # ----- finalise
    if not done and not data_limited and n > 0:
        # data ends at the horizon (no ticks left in the window): mark open legs to the last tick
        mtm_idx = n - 1 if n - 1 >= start else None
        mtm_px = float(mk.exit_px[mtm_idx]) if mtm_idx is not None else float(fill_px)
        for leg in list(open_legs):
            close_leg(leg, mtm_idx, mtm_px, 'MTM')
        final = 'MTM'
        done = True
        res['flags'].append('mtm_on_window_end')
    if not done:
        res['status'] = 'NO_PRICE_DATA'
        res['reason'] = 'data_missing_before_resolution'
        res['flags'].append('partial_exits_only' if exits else 'no_exit_before_data_end')
    res['final_exit'] = final or ''
    if exits:
        total = sum(e['frac'] * (e['px'] - fill_px) * fav for e in exits)
        res['total_R'] = total / R
        res['usd_per_1lot'] = total * conv.contract_oz
        res['exits'] = [(e['kind'], e['ms'], e['px'], e['frac']) for e in exits]
        seq = []
        for e in exits:
            if not seq or seq[-1] != e['kind']:
                seq.append(e['kind'])
        res['exit_seq'] = '>'.join(seq)
        idxs = [e['idx'] for e in exits if e['idx'] is not None]
        first_idx = min(idxs) if idxs else None
        last_idx = max(idxs) if idxs else None
        base_idx = fill.fill_idx if fill.fill_idx is not None else start
        base_idx = max(0, min(base_idx, n - 1)) if n else base_idx
        tp_ms = [e['ms'] for e in exits if e['kind'].startswith('TP') and e['ms']]
        sl_ms = [e['ms'] for e in exits if e['kind'] not in ('MTM',) and not e['kind'].startswith('TP') and e['ms']]
        res['min_to_first_tp'] = (min(tp_ms) - fill.fill_ms) / MIN_MS if tp_ms else None
        res['min_to_stop'] = (min(sl_ms) - fill.fill_ms) / MIN_MS if sl_ms else None
        if last_idx is not None and base_idx is not None and n:
            res['bars_to_resolution'] = last_idx - base_idx
            seg_end = last_idx
            res['max_tick_gap_min'] = float(np.max(np.diff(mk.ms[base_idx:seg_end + 1]))) / MIN_MS \
                if seg_end > base_idx else 0.0
            _mae_mfe(res, mk, base_idx, first_idx, seg_end, fav, fill_px, R)
        if final == 'MTM':
            res['status'] = 'UNRESOLVED_MTM' if res['status'] == 'FILLED' else res['status']
            res['horizon_reason'] = hz_reason
        if res['status'] == 'FILLED':
            tr = res['total_R']
            res['outcome'] = 'WIN' if tr > 1e-9 else ('LOSS' if tr < -1e-9 else 'FLAT')
        elif res['status'] == 'UNRESOLVED_MTM':
            res['outcome'] = 'UNRESOLVED_MTM'
        if conv.swap_usd_per_lot_per_rollover and exits[-1]['ms']:
            res['swap_usd_per_1lot'] = -conv.swap_usd_per_lot_per_rollover * _rollovers(fill.fill_ms, exits[-1]['ms'])
    res['same_tick_ambiguity'] = bool(same_tick)
    if same_tick:
        res['flags'].append('same_tick_ambiguity')
    return res


def _mae_mfe(res, mk, base_idx, first_idx, last_idx, fav, fill_px, R):
    """MAE/MFE in USD and R (exit-side prices): before the first exit, and over the whole trade."""
    fav_fill = fav * fill_px
    seg_pre_end = first_idx if first_idx is not None else base_idx
    for tag, b in (('pre', seg_pre_end), ('all', last_idx)):
        seg = mk.y[base_idx:b + 1]
        if len(seg) == 0:
            continue
        mfe = max(0.0, float(seg.max()) - fav_fill)
        mae = min(0.0, float(seg.min()) - fav_fill)
        res['mae_%s_usd' % tag] = mae
        res['mfe_%s_usd' % tag] = mfe
        res['mae_%s_R' % tag] = mae / R
        res['mfe_%s_R' % tag] = mfe / R


# ---------------------------------------------------------------- baseline first-touch table
def baseline_touch(sig, fill, mk, horizon_h=72.0):
    """Provider-as-is first touches: original SL and every TP level, no management, within the horizon.

    Inspects ticks in [fill.start_idx, horizon). Returns a dict; sl_idx/tp_idx hold the tick index of
    the first touch (None = not touched before horizon). Status:
      NO_PRICE_DATA   horizon beyond known data and neither SL nor all TPs were resolved before the gap
      UNRESOLVED_MTM  not stopped out and at least one TP still untouched at horizon (position open)
      FILLED          otherwise (stopped out, or every TP touched)
    """
    out = {'message_id': sig.message_id}
    fav = sig.fav
    horizon_ms = fill.fill_ms + int(round(horizon_h * HOUR_MS))
    hz = min(mk.idx_at(horizon_ms), mk.n)
    start = fill.start_idx
    out['truncated'] = bool(mk.truncated and horizon_ms > mk.known_until)
    if start is None or start >= hz:
        out['status'] = 'NO_PRICE_DATA' if out['truncated'] else 'UNRESOLVED_MTM'
        out['sl_idx'] = None
        out['tp_idx'] = {}
        out['sequence'] = ''
        return out
    sl_i = mk.first_le(fav * sig.sl, start, hz)
    tp_i = {}
    flags = []
    for k, tp in enumerate(sig.tps, start=1):
        if tp is None:
            continue
        if not _beyond(tp, fill.fill_px, fav):
            flags.append('TP%d_not_beyond_fill' % k)
        tp_i[k] = mk.first_ge(fav * tp, start, hz)
    out['flags'] = flags
    out['sl_idx'] = sl_i
    out['tp_idx'] = tp_i
    events = []
    if sl_i is not None:
        events.append((sl_i, 0, 'SL'))
    for k, j in tp_i.items():
        if j is not None:
            events.append((j, 1, 'TP%d' % k))
    events.sort()
    out['sequence'] = '>'.join(e[2] for e in events)
    out['same_tick_ambiguity'] = bool(sl_i is not None and any(j == sl_i for j in tp_i.values() if j is not None))
    all_tp_found = all(v is not None for v in tp_i.values())
    first_ev = events[0][0] if events else None
    if sl_i is not None:
        end_all = sl_i
    elif all_tp_found and tp_i:
        end_all = max(v for v in tp_i.values())
    else:
        end_all = hz - 1
    seg_pre = first_ev if first_ev is not None else hz - 1
    _mae_mfe_baseline(out, mk, fill, start, seg_pre, end_all, fav, hz)
    out['sl_found'] = sl_i is not None
    if out['truncated'] and not (out['sl_found'] or all_tp_found):
        out['status'] = 'NO_PRICE_DATA'
    elif sl_i is None and not all_tp_found:
        out['status'] = 'UNRESOLVED_MTM'
    else:
        out['status'] = 'FILLED'
    return out


def _mae_mfe_baseline(out, mk, fill, start, pre_end, all_end, fav, hz):
    base = fill.fill_idx if fill.fill_idx is not None else start
    fav_fill = fav * fill.fill_px
    for tag, b in (('pre', min(pre_end, hz - 1)), ('all', min(all_end, hz - 1))):
        if b < base:
            out['mae_%s_usd' % tag] = out['mfe_%s_usd' % tag] = None
            continue
        seg = mk.y[base:b + 1]
        out['mae_%s_usd' % tag] = min(0.0, float(seg.min()) - fav_fill)
        out['mfe_%s_usd' % tag] = max(0.0, float(seg.max()) - fav_fill)


# ---------------------------------------------------------------- statistics helpers
def wilson(k, n, z=1.959963984540054):
    """Wilson 95% CI for a proportion k/n. Returns (p, lo, hi); (None, None, None) if n == 0."""
    if n == 0:
        return (None, None, None)
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (p, max(0.0, centre - half), min(1.0, centre + half))


def max_drawdown(xs):
    """Max peak-to-trough drawdown of cumulative sum of xs (returned as a non-negative number)."""
    peak = 0.0
    cum = 0.0
    mdd = 0.0
    for x in xs:
        cum += x
        peak = max(peak, cum)
        mdd = max(mdd, peak - cum)
    return mdd


def loss_streaks(xs):
    """Histogram {streak_length: count} of consecutive negative results in order."""
    hist = {}
    cur = 0
    for x in xs:
        if x < -1e-9:
            cur += 1
        else:
            if cur:
                hist[cur] = hist.get(cur, 0) + 1
            cur = 0
    if cur:
        hist[cur] = hist.get(cur, 0) + 1
    return hist

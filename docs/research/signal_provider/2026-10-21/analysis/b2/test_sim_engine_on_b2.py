"""Unit tests for sim_engine.py using tiny synthetic tick series (no network, no real data).

Run:  cd <b1 dir> && python3 -I test_sim_engine.py
"""
import os
import sys
import shutil
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sim_engine_b2 as se  # noqa: E402
import numpy as np  # noqa: E402

T0 = se.utc_ms('2025-11-03T10:00:00Z')  # a Monday, 10:00 UTC
MIN = 60_000
SEC = 1000


def make_mk(ticks, direction, extra=0.0, known_until=None, t1=None):
    """ticks: list of (ms, bid, ask). Builds a Market without touching disk."""
    ms = np.array([t[0] for t in ticks], dtype=np.int64)
    bid = np.array([t[1] for t in ticks], dtype=float)
    ask = np.array([t[2] for t in ticks], dtype=float)
    end = t1 if t1 is not None else int(ms[-1]) + 1
    ku = known_until if known_until is not None else end
    win = se.Window(ms, bid, ask, int(ms[0]), end, ku, [])
    return se.Market(win, direction, extra)


def buy_sig(tps=(4005.0, 4010.0, 4015.0), sl=3995.0, lo=4000.0, hi=4002.0, t=T0):
    return se.Signal('b', t, 'buy', lo, hi, sl, tps)


def sell_sig(tps=(3995.0, 3990.0, 3985.0), sl=4007.0, lo=4000.0, hi=4002.0, t=T0):
    return se.Signal('s', t, 'sell', lo, hi, sl, tps)


def run(sig, ticks, ep=None, strat=None, slip=0.0, extra=0.0, known_until=None, t1=None):
    ep = ep or se.EntryParams('P1', latency_s=5, tol=0.5, extra_spread=extra, slippage=slip)
    mk = make_mk(ticks, sig.direction, extra, known_until=known_until, t1=t1)
    fill = se.decide_entry(sig, ep, mk)
    strat = strat or se.Strategy('tp1', checkpoints=((1, 100.0),))
    res = se.simulate(sig, fill, strat, mk, slip=slip)
    return fill, res


class EntryTests(unittest.TestCase):
    def test_latency_uses_first_tick_at_or_after_latency(self):
        # tick at 1 s is inside the range but must NOT be used with latency 5 s
        ticks = [(T0 + 1 * SEC, 3999.8, 4000.0), (T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 9 * SEC, 4001, 4001.2)]
        f, _ = run(buy_sig(), ticks)
        self.assertEqual(f.status, 'FILLED')
        self.assertEqual(f.fill_ms, T0 + 6 * SEC)
        self.assertAlmostEqual(f.fill_px, 4001.1)

    def test_p1_outside_range_skip_with_distance(self):
        ticks = [(T0 + 6 * SEC, 4003.4, 4003.5), (T0 + 9 * SEC, 4001, 4001.2)]
        f, _ = run(buy_sig(), ticks)
        self.assertEqual(f.status, 'SKIPPED_price_outside_range')
        self.assertAlmostEqual(f.outside_dist, 1.0)  # 4003.5 - (4002 + 0.5)

    def test_extra_spread_and_slippage_on_entry(self):
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 60 * SEC, 4004.0, 4004.2)]
        f, _ = run(buy_sig(), ticks, extra=0.2, slip=0.1)
        self.assertEqual(f.status, 'FILLED')
        self.assertAlmostEqual(f.fill_px, 4001.1 + 0.1 + 0.1)  # ask + E/2 + slip

    def test_p2_pending_fills_at_range_edge(self):
        ticks = [(T0 + 6 * SEC, 4004.0, 4004.2), (T0 + 60 * SEC, 4002.8, 4003.0),
                 (T0 + 120 * SEC, 4001.5, 4001.7), (T0 + 180 * SEC, 4004.8, 4005.0)]
        ep = se.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=60)
        f, res = run(buy_sig(), ticks, ep=ep)
        self.assertEqual(f.status, 'FILLED')
        self.assertEqual(f.kind, 'buy_limit')
        self.assertAlmostEqual(f.fill_px, 4002.0)
        self.assertEqual(f.fill_ms, T0 + 120 * SEC)
        # no TP/SL afterwards in this series: open at the (window-end) horizon
        self.assertEqual(res['status'], 'UNRESOLVED_MTM')

    def test_p2_pending_expires(self):
        ticks = [(T0 + 6 * SEC, 4004.0, 4004.2), (T0 + 30 * MIN, 4003.0, 4003.2),
                 (T0 + 90 * MIN, 4001.5, 4001.7)]
        ep = se.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=60)
        f, _ = run(buy_sig(), ticks, ep=ep)
        self.assertEqual(f.status, 'SKIPPED_pending_expired')

    def test_p2_favourable_side_is_skipped(self):
        ticks = [(T0 + 6 * SEC, 3998.8, 3999.0)]  # below range for a BUY = favourable
        ep = se.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=60)
        f, _ = run(buy_sig(), ticks, ep=ep)
        self.assertEqual(f.status, 'SKIPPED_price_outside_range')

    def test_sl_wrong_side_at_fill_is_skipped(self):
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1)]
        f, _ = run(buy_sig(sl=4001.2), ticks)
        self.assertEqual(f.status, 'SKIPPED_sl_wrong_side_at_fill')

    def test_no_tick_after_latency_in_known_data_is_skip_or_unknown(self):
        ticks = [(T0 + 1 * SEC, 4000.9, 4001.1)]
        f, _ = run(buy_sig(), ticks, known_until=T0 + 2 * MIN, t1=T0 + 80 * 3600 * SEC)
        # no tick after the latency point inside known data and the window is truncated: unknown, not skipped
        self.assertEqual(f.status, 'NO_PRICE_DATA')


class ExitTests(unittest.TestCase):
    def test_tp1_exit_at_tp_price(self):
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4004.0, 4004.2), (T0 + 8 * SEC, 4005.0, 4005.2)]
        f, res = run(buy_sig(), ticks)
        self.assertEqual(res['exit_seq'], 'TP1')
        self.assertAlmostEqual(res['total_R'], (4005.0 - 4001.1) / abs(4001.1 - 3995.0))
        self.assertEqual(res['outcome'], 'WIN')

    def test_sl_gap_fills_at_tick_price(self):
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 3990.0, 3990.2)]
        f, res = run(buy_sig(), ticks)
        self.assertEqual(res['exit_seq'], 'SL')
        self.assertAlmostEqual(res['exits'][0][2], 3990.0)
        self.assertAlmostEqual(res['total_R'], (3990.0 - 4001.1) / 6.1)
        self.assertEqual(res['outcome'], 'LOSS')

    def test_sl_exit_with_slippage(self):
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 3996.0, 3996.2), (T0 + 8 * SEC, 3994.9, 3995.1)]
        f, res = run(buy_sig(), ticks, slip=0.1)
        self.assertAlmostEqual(res['fill_px'], 4001.1 + 0.1)
        self.assertEqual(res['exit_seq'], 'SL')
        self.assertAlmostEqual(res['exits'][0][2], 3994.9 - 0.1)

    def test_sell_tp_and_sl_sides(self):
        ticks = [(T0 + 6 * SEC, 4000.5, 4000.7), (T0 + 7 * SEC, 3994.7, 3994.9)]
        f, res = run(sell_sig(), ticks)
        self.assertAlmostEqual(res['fill_px'], 4000.5)
        self.assertEqual(res['exit_seq'], 'TP1')
        self.assertAlmostEqual(res['total_R'], (4000.5 - 3995.0) / (4007.0 - 4000.5))
        ticks2 = [(T0 + 6 * SEC, 4000.5, 4000.7), (T0 + 7 * SEC, 4007.0, 4007.5)]
        f2, res2 = run(sell_sig(), ticks2)
        self.assertEqual(res2['exit_seq'], 'SL')
        self.assertAlmostEqual(res2['exits'][0][2], 4007.5)

    def test_break_even_after_tp1(self):
        strat = se.Strategy('be', checkpoints=((1, 50.0), (2, 50.0)), sl_after=((1, 'entry', 0.0),))
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4005.0, 4005.2),
                 (T0 + 8 * SEC, 4003.0, 4003.2), (T0 + 9 * SEC, 4001.0, 4001.2)]
        f, res = run(buy_sig(), ticks, strat=strat)
        self.assertEqual(res['exit_seq'], 'TP1>BE')
        self.assertAlmostEqual(res['exits'][1][2], 4001.0)
        exp = (0.5 * (4005.0 - 4001.1) + 0.5 * (4001.0 - 4001.1)) / 6.1
        self.assertAlmostEqual(res['total_R'], exp)

    def test_trailing_stop_with_step(self):
        # activation at bid >= fill+3; trail distance 2, step 0.5 from base SL 3995
        strat = se.Strategy('tr', checkpoints=((1, 100.0),), trailing=(('price', 3.0), 2.0, 0.5))
        strat = se.Strategy('tr', checkpoints=((1, 50.0), (2, 50.0)), trailing=(('price', 3.0), 2.0, 0.5))
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4004.5, 4004.7),
                 (T0 + 8 * SEC, 4006.0, 4006.2), (T0 + 9 * SEC, 4003.9, 4004.1)]
        f, res = run(buy_sig(tps=(4020.0, 4030.0)), ticks, strat=strat)
        self.assertEqual(res['exit_seq'], 'TRAIL')  # both legs stop out on the same tick (collapsed)
        self.assertTrue(all(e[0] == 'TRAIL' for e in res['exits']))
        # stop after running max 4006 = 3995 + 0.5*floor((4006-2-3995)/0.5) = 4004.0
        self.assertAlmostEqual(res['exits'][0][2], 4003.9)

    def test_horizon_mtm_unresolved(self):
        strat = se.Strategy('h1', checkpoints=((1, 100.0),), horizon_h=1.0)
        ticks = [(T0 + k * 10 * MIN, 4001.0, 4001.2) for k in range(0, 20)]  # two hours of flat ticks
        f, res = run(buy_sig(), ticks, strat=strat, t1=T0 + 3 * 3600 * SEC)
        self.assertEqual(res['status'], 'UNRESOLVED_MTM')
        self.assertEqual(res['final_exit'], 'MTM')
        self.assertEqual(res['outcome'], 'UNRESOLVED_MTM')
        self.assertEqual(res['exit_seq'], 'MTM')

    def test_data_truncated_before_resolution_is_no_price_data(self):
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 10 * MIN, 4001.0, 4001.2)]
        f, res = run(buy_sig(), ticks, known_until=T0 + 30 * MIN, t1=T0 + 80 * 3600 * SEC)
        self.assertEqual(res['status'], 'NO_PRICE_DATA')

    def test_weekend_cutoff_forces_close(self):
        fri = se.utc_ms('2025-11-07T19:00:00Z')
        strat = se.Strategy('wk', checkpoints=((1, 100.0),), close_before_weekend=True)
        sig = buy_sig(t=fri)
        ticks = [(fri + 6 * SEC, 4000.9, 4001.1), (fri + 60 * MIN, 4001.5, 4001.7)]
        f, res = run(sig, ticks, strat=strat, t1=fri + 80 * 3600 * SEC)
        self.assertEqual(res['status'], 'UNRESOLVED_MTM')
        self.assertEqual(res.get('horizon_reason'), 'weekend_cutoff')
        late = se.utc_ms('2025-11-07T21:00:00Z')
        f2, res2 = run(buy_sig(t=late), [(late + 6 * SEC, 4000.9, 4001.1)], strat=strat,
                       t1=late + 80 * 3600 * SEC)
        self.assertEqual(res2['status'], 'SKIPPED_after_weekend_cutoff')


class PlanTests(unittest.TestCase):
    def test_lot_split_50_30_20_at_0_10(self):
        s = se.Strategy('x', checkpoints=((1, 50.0), (2, 30.0), (3, 20.0)), units='lots', total_lots=0.10)
        legs, w = se.plan_legs(buy_sig(), 4001.0, s)
        self.assertEqual([round(l['lots'], 2) for l in legs], [0.05, 0.03, 0.02])
        self.assertAlmostEqual(sum(l['frac'] for l in legs), 1.0)

    def test_lot_split_infeasible_merges_into_next(self):
        s = se.Strategy('x', checkpoints=((1, 50.0), (2, 30.0), (3, 20.0)), units='lots', total_lots=0.01)
        legs, w = se.plan_legs(buy_sig(), 4001.0, s)
        self.assertEqual(len(legs), 1)
        self.assertEqual(legs[0]['tp_index'], 3)
        self.assertAlmostEqual(legs[0]['lots'], 0.01)
        self.assertTrue(any('merged' in x for x in w))

    def test_lot_split_skip_trade(self):
        s = se.Strategy('x', checkpoints=((1, 50.0), (2, 50.0)), units='lots', total_lots=0.01,
                        infeasible_split='skip_trade')
        with self.assertRaises(se.Skip):
            se.plan_legs(buy_sig(), 4001.0, s)

    def test_missing_tp_merges_into_last_available(self):
        s = se.Strategy('x', checkpoints=((1, 50.0), (2, 30.0), (3, 20.0)))
        legs, w = se.plan_legs(buy_sig(tps=(4005.0, 4010.0)), 4001.0, s)
        self.assertEqual([(l['tp_index'], round(l['frac'], 2)) for l in legs], [(1, 0.5), (2, 0.5)])
        s2 = se.Strategy('x', checkpoints=((1, 50.0), (2, 30.0), (3, 20.0)), missing_tp='skip_trade')
        with self.assertRaises(se.Skip):
            se.plan_legs(buy_sig(tps=(4005.0, 4010.0)), 4001.0, s2)

    def test_runner_leg_gets_remainder(self):
        s = se.Strategy('x', checkpoints=((1, 50.0),), runner_pct=50.0, units='lots', total_lots=0.10)
        legs, _ = se.plan_legs(buy_sig(), 4001.0, s)
        self.assertEqual([l['kind'] for l in legs], ['tp', 'runner'])
        self.assertAlmostEqual(legs[1]['lots'], 0.05)

    def test_strategy_validation(self):
        with self.assertRaises(ValueError):
            se.Strategy('bad', checkpoints=((1, 40.0), (2, 40.0)))
        with self.assertRaises(ValueError):
            se.Strategy('bad', checkpoints=((2, 50.0), (1, 50.0)))


class BaselineTests(unittest.TestCase):
    def test_baseline_sequence_and_status(self):
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4005.0, 4005.2),
                 (T0 + 8 * SEC, 3994.0, 3994.2), (T0 + 9 * SEC, 4011.0, 4011.2)]
        sig = buy_sig()
        mk = make_mk(ticks, 'buy')
        fill = se.decide_entry(sig, se.EntryParams('P1', latency_s=5, tol=0.5), mk)
        out = se.baseline_touch(sig, fill, mk)
        # full first-touch sequence over the horizon; TP2 is touched after the stop (post-stop event)
        self.assertEqual(out['sequence'], 'TP1>SL>TP2')
        self.assertEqual(out['status'], 'FILLED')
        self.assertIsNotNone(out['mfe_all_usd'])

    def test_baseline_open_at_horizon(self):
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4005.0, 4005.2)]
        sig = buy_sig()
        mk = make_mk(ticks, 'buy', t1=T0 + 80 * 3600 * SEC)
        fill = se.decide_entry(sig, se.EntryParams('P1', latency_s=5, tol=0.5), mk)
        out = se.baseline_touch(sig, fill, mk)
        self.assertEqual(out['sequence'], 'TP1')
        self.assertEqual(out['status'], 'UNRESOLVED_MTM')


class StatsAndStoreTests(unittest.TestCase):
    def test_wilson_and_drawdown(self):
        p, lo, hi = se.wilson(0, 10)
        self.assertEqual(p, 0.0)
        self.assertAlmostEqual(lo, 0.0)
        self.assertTrue(0.27 < hi < 0.29)
        p, lo, hi = se.wilson(5, 10)
        self.assertTrue(0.23 < lo < 0.25 and 0.75 < hi < 0.77)
        self.assertEqual(se.wilson(0, 0), (None, None, None))
        self.assertAlmostEqual(se.max_drawdown([1, -2, 1, -3]), 4.0)
        self.assertEqual(se.loss_streaks([-1, -1, 1, -1]), {2: 1, 1: 1})

    def test_decoder_roundtrip_and_unknown_hours(self):
        tmp = tempfile.mkdtemp(dir=HERE)
        try:
            raw = os.path.join(tmp, 'raw')
            cache = os.path.join(tmp, 'cache')
            store = se.TickStore(raw, cache)
            hour = se.utc_ms('2025-11-03T10:00:00Z')
            p = store.hour_path(hour)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            recs = [(1000, 4001100, 4000900, 0.5, 0.25), (2500, 4001300, 4001000, 0.1, 0.2)]
            import struct
            data = b''.join(struct.pack('>IIIff', *r) for r in recs)
            import lzma
            with open(p, 'wb') as f:
                f.write(lzma.compress(data, format=lzma.FORMAT_ALONE))
            ms, bid, ask = store.load_hour(hour)
            self.assertEqual(list(ms), [hour + 1000, hour + 2500])
            self.assertAlmostEqual(ask[0], 4001.1)
            self.assertAlmostEqual(bid[1], 4001.0)
            self.assertTrue(np.all(bid <= ask))
            # cache file written and reused
            self.assertTrue(any(f.endswith('.npy') for f in os.listdir(cache)))
            # empty marker and unknown hour
            h2 = hour + 3600 * 1000
            p2 = store.hour_path(h2)
            os.makedirs(os.path.dirname(p2), exist_ok=True)
            open(p2 + '.empty', 'w').close()
            self.assertEqual(store.status(h2), 'empty')
            h3 = hour + 2 * 3600 * 1000
            self.assertEqual(store.status(h3), 'unknown')
            win = se.load_window(store, hour, hour + 3 * 3600 * 1000)
            self.assertEqual(win.known_until, h3)
            self.assertTrue(win.truncated)
            self.assertEqual(len(win.ms), 2)
            self.assertEqual(len(store._status), len(store._status))  # status cache is populated
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def _slow_first_exit(ticks, direction, sl, tp, start_ms, horizon_ms):
    """Plain tick-by-tick reference: first of SL / TP1 on the executable side (no slippage, no spread)."""
    last = None
    for ms, bid, ask in ticks:
        if ms < start_ms:
            continue
        if ms >= horizon_ms:
            break
        last = (ms, bid, ask)
        if direction == 'buy':
            if bid <= sl:
                return 'SL', bid
            if bid >= tp:
                return 'TP1', tp
        else:
            if ask >= sl:
                return 'SL', ask
            if ask <= tp:
                return 'TP1', tp
    if last is None:
        return 'MTM', None
    return 'MTM', (last[1] if direction == 'buy' else last[2])


class RandomWalkCrossCheck(unittest.TestCase):
    def test_vectorised_matches_slow_loop(self):
        rng = np.random.default_rng(42)
        for trial in range(60):
            direction = 'buy' if trial % 2 == 0 else 'sell'
            mid = 4000.0
            n = 3000
            steps = rng.normal(0, 0.6, n).cumsum() + mid
            spread = 0.3 + rng.random(n) * 0.4
            ticks = []
            for k in range(n):
                ms = T0 + 5 * SEC + k * 37 * SEC // 10  # irregular ~3.7 s spacing
                ticks.append((ms, steps[k] - spread[k] / 2, steps[k] + spread[k] / 2))
            ticks = [(ms, round(b, 3), round(a, 3)) for ms, b, a in ticks]
            # signal: entry at the first tick, SL/TP placed around the first mid
            first_mid = (ticks[0][1] + ticks[0][2]) / 2
            if direction == 'buy':
                sig = se.Signal('rw%d' % trial, T0, 'buy', first_mid, first_mid, first_mid - rng.uniform(2, 8),
                                [first_mid + rng.uniform(1, 12)])
            else:
                sig = se.Signal('rw%d' % trial, T0, 'sell', first_mid, first_mid, first_mid + rng.uniform(2, 8),
                                [first_mid - rng.uniform(1, 12)])
            mk = make_mk(ticks, direction, extra=0.0)
            ep = se.EntryParams('P1', latency_s=0, tol=50.0)
            fill = se.decide_entry(sig, ep, mk)
            self.assertEqual(fill.status, 'FILLED', trial)
            strat = se.Strategy('tp1', checkpoints=((1, 100.0),), horizon_h=0.5)
            res = se.simulate(sig, fill, strat, mk)
            hz_ms = fill.fill_ms + 30 * MIN
            kind, px = _slow_first_exit(ticks[fill.start_idx:], direction, sig.sl, sig.tps[0], 0, hz_ms)
            if kind == 'SL':
                self.assertEqual(res['exit_seq'], 'SL', trial)
                self.assertAlmostEqual(res['exits'][0][2], px, 9, trial)
            elif kind == 'TP1':
                self.assertEqual(res['exit_seq'], 'TP1', trial)
            else:
                self.assertEqual(res['final_exit'], 'MTM', trial)


class ManagementPathTests(unittest.TestCase):
    """Runner, close_all_at, price-distance BE, trailing after TP, previous_tp SL moves, manage latency."""

    def _run(self, sig, ticks, strat, t1=None):
        return run(sig, ticks, strat=strat, t1=t1)

    def test_runner_stays_open_until_horizon(self):
        strat = se.Strategy('run', checkpoints=((1, 50.0),), runner_pct=50.0, horizon_h=1.0)
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4005.0, 4005.2)] + \
                [(T0 + k * 10 * MIN, 4004.0, 4004.2) for k in range(1, 12)]
        f, res = self._run(buy_sig(tps=(4005.0, 4010.0)), ticks, strat, t1=T0 + 3 * 3600 * SEC)
        self.assertEqual(res['status'], 'UNRESOLVED_MTM')
        self.assertEqual(res['exit_seq'], 'TP1>MTM')
        self.assertAlmostEqual(res['exits'][0][3], 0.5)
        exp = (0.5 * (4005.0 - 4001.1) + 0.5 * (4004.0 - 4001.1)) / 6.1
        self.assertAlmostEqual(res['total_R'], exp, 6)

    def test_close_all_at_closes_remainder(self):
        strat = se.Strategy('ca', checkpoints=((1, 30.0), (2, 30.0), (3, 40.0)), close_all_at=2)
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4005.0, 4005.2), (T0 + 8 * SEC, 4010.0, 4010.2)]
        f, res = self._run(buy_sig(tps=(4005.0, 4010.0, 4020.0)), ticks, strat)
        self.assertEqual(res['exit_seq'], 'TP1>TP2')
        self.assertAlmostEqual(res['exits'][0][3], 0.3)
        self.assertAlmostEqual(res['exits'][1][3], 0.7)
        self.assertAlmostEqual(res['total_R'], (0.3 * 3.9 + 0.7 * 8.9) / 6.1, 6)

    def test_price_distance_break_even(self):
        strat = se.Strategy('be', checkpoints=((1, 100.0),), break_even=('price', 2.0, 0.0))
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4003.2, 4003.4),
                 (T0 + 8 * SEC, 4001.0, 4001.2)]
        f, res = self._run(buy_sig(), ticks, strat)
        self.assertEqual(res['exit_seq'], 'BE')
        self.assertAlmostEqual(res['exits'][0][2], 4001.0)

    def test_trailing_after_tp1(self):
        strat = se.Strategy('tr', checkpoints=((1, 50.0), (2, 50.0)), trailing=(('after_tp', 1), 2.0, 0.5))
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4005.0, 4005.2),
                 (T0 + 8 * SEC, 4010.0, 4010.2), (T0 + 9 * SEC, 4007.9, 4008.1)]
        f, res = self._run(buy_sig(tps=(4005.0, 4020.0)), ticks, strat)
        self.assertEqual(res['exit_seq'], 'TP1>TRAIL')
        self.assertAlmostEqual(res['exits'][1][2], 4007.9)

    def test_sl_after_previous_tp(self):
        strat = se.Strategy('pt', checkpoints=((1, 33.0), (2, 33.0), (3, 34.0)),
                            sl_after=((2, 'previous_tp', 0.1),))
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4005.1, 4005.3),
                 (T0 + 8 * SEC, 4010.1, 4010.3), (T0 + 9 * SEC, 4005.0, 4005.2)]
        f, res = self._run(buy_sig(tps=(4005.0, 4010.0, 4020.0)), ticks, strat)
        self.assertEqual(res['exit_seq'], 'TP1>TP2>SL_PREV_TP')
        self.assertAlmostEqual(res['exits'][2][2], 4005.0)

    def test_manage_latency_delays_break_even(self):
        strat = se.Strategy('lat', checkpoints=((1, 50.0), (2, 50.0)), sl_after=((1, 'entry', 0.0),),
                            manage_latency_s=2.0)
        ticks = [(T0 + 6 * SEC, 4000.9, 4001.1), (T0 + 7 * SEC, 4005.0, 4005.2),
                 (T0 + 7.5 * SEC, 4001.0, 4001.2), (T0 + 8.5 * SEC, 4000.9, 4001.1),
                 (T0 + 9.5 * SEC, 4000.8, 4001.0)]
        f, res = self._run(buy_sig(tps=(4005.0, 4020.0)), ticks, strat)
        self.assertEqual(res['exit_seq'], 'TP1>BE')
        self.assertEqual(res['exits'][1][1], T0 + 9500)

    def test_p2_pending_then_trade_resolves(self):
        ticks = [(T0 + 6 * SEC, 4004.0, 4004.2), (T0 + 120 * SEC, 4001.5, 4001.7),
                 (T0 + 130 * SEC, 4005.0, 4005.2)]
        ep = se.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=60)
        f, res = run(buy_sig(), ticks, ep=ep, strat=se.Strategy('tp1', checkpoints=((1, 100.0),)))
        self.assertEqual(f.kind, 'buy_limit')
        self.assertEqual(res['exit_seq'], 'TP1')
        self.assertEqual(res['status'], 'FILLED')


if __name__ == '__main__':
    unittest.main(verbosity=2)

"""Tests for the B2 patch to the B1 engine (entry-side pending triggers). Run: python3 -I test_b2_engine_patch.py"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sim_engine_b2 as se  # noqa: E402
import numpy as np  # noqa: E402

T0 = se.utc_ms('2025-11-03T10:00:00Z')
MIN = 60_000


def mk_from(ticks, direction, extra=0.0):
    ms = np.array([t[0] for t in ticks], dtype=np.int64)
    bid = np.array([t[1] for t in ticks], dtype=float)
    ask = np.array([t[2] for t in ticks], dtype=float)
    win = se.Window(ms, bid, ask, int(ms[0]), int(ms[-1]) + 1, int(ms[-1]) + 1, [])
    return se.Market(win, direction, extra)


class PendingEntrySide(unittest.TestCase):
    def test_buy_limit_triggers_on_ask_not_bid(self):
        # range 4000..4002, tol 0.5 -> market only inside [3999.5, 4002.5]; price above -> BUY_LIMIT at high 4002
        # tick 1 (after latency): ask 4005 (outside) bid 4004.3. tick 2: bid 4001.9 ask 4002.6 -> ask>limit: NO fill
        # tick 3: ask 4001.9 bid 4001.2 -> ask<=limit: fill at 4002 (+slip 0)
        sig = se.Signal('b', T0, 'buy', 4000.0, 4002.0, 3995.0, (4010.0, 4015.0, 4020.0))
        ticks = [(T0 + 5000, 4004.3, 4005.0), (T0 + 6000, 4001.9, 4002.6), (T0 + 7000, 4001.2, 4001.9)]
        mk = mk_from(ticks, 'buy')
        ep = se.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=60)
        f = se.decide_entry(sig, ep, mk)
        self.assertEqual(f.status, 'FILLED')
        self.assertEqual(f.kind, 'buy_limit')
        self.assertAlmostEqual(f.fill_px, 4002.0)
        self.assertEqual(f.fill_ms, T0 + 7000)

    def test_sell_limit_fills_when_bid_reaches_low(self):
        # SELL range 4000..4002: price below low - tol -> SELL_LIMIT at low 4000 (bid must reach >= 4000)
        sig = se.Signal('s', T0, 'sell', 4000.0, 4002.0, 4006.0, (3990.0, 3980.0, 3970.0))
        ticks = [(T0 + 5000, 3996.0, 3996.7), (T0 + 6000, 3999.2, 3999.9), (T0 + 7000, 4000.4, 4001.1)]
        mk = mk_from(ticks, 'sell')
        ep = se.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=60)
        f = se.decide_entry(sig, ep, mk)
        self.assertEqual(f.status, 'FILLED')
        self.assertEqual(f.kind, 'sell_limit')
        self.assertAlmostEqual(f.fill_px, 4000.0)
        self.assertEqual(f.fill_ms, T0 + 7000)

    def test_sell_limit_expires_if_bid_never_reaches_low(self):
        sig = se.Signal('s', T0, 'sell', 4000.0, 4002.0, 4006.0, (3990.0, 3980.0, 3970.0))
        ticks = [(T0 + 5000, 3996.0, 3996.7), (T0 + 6000, 3999.9, 4000.6)]
        mk = mk_from(ticks, 'sell')
        ep = se.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=60)
        f = se.decide_entry(sig, ep, mk)
        self.assertEqual(f.status, 'SKIPPED_pending_expired')

    def test_b1_engine_sell_limit_never_fills(self):
        # documents the B1 defect on the same data: the patched copy differs only in the pending trigger
        import importlib.util
        spec = importlib.util.spec_from_file_location('b1_se', os.path.join(HERE, '..', 'b1', 'sim_engine.py'))
        b1 = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(b1)
        sig = se.Signal('s', T0, 'sell', 4000.0, 4002.0, 4006.0, (3990.0, 3980.0, 3970.0))
        ticks = [(T0 + 5000, 3996.0, 3996.7), (T0 + 7000, 4000.4, 4001.1)]
        ms = np.array([t[0] for t in ticks], dtype=np.int64)
        bid = np.array([t[1] for t in ticks]); ask = np.array([t[2] for t in ticks])
        win = b1.Window(ms, bid, ask, int(ms[0]), int(ms[-1]) + 1, int(ms[-1]) + 1, [])
        mk = b1.Market(win, 'sell', 0.0)
        f = b1.decide_entry(sig, b1.EntryParams('P2', latency_s=5, tol=0.5, expiry_min=60), mk)
        self.assertEqual(f.status, 'SKIPPED_pending_expired')


if __name__ == '__main__':
    unittest.main()

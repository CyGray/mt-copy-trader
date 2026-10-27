#!/usr/bin/env python3
"""Unit tests for risk_model.py. Mirrors the vectors in worker/src/lib/positionSizing.test.ts
(repo, vitest: 46 tests, passing) plus margin and path-simulator checks.
Run: nice -n 10 python3 -I test_risk_model.py"""
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import risk_model as rm

SPEC = dict(rm.SPEC_UNVERIFIED)
LIM = {'maxRiskMoney': 5000, 'maxRiskPercent': 5, 'maxLots': 20}
DEF_LIM = rm.effective_limits(rm.DEFAULT_SAFETY)

class VolumeTests(unittest.TestCase):
    def test_decimals_and_round_down(self):  # positionSizing.test.ts 'volumeDecimals and roundVolumeDown'
        self.assertEqual([rm.volume_decimals(s) for s in (0.01, 0.1, 1, 0.001)], [2, 1, 0, 3])
        self.assertEqual(rm.round_volume_down(0.07, 0.01), 0.07)
        self.assertEqual(rm.round_volume_down(0.1 + 0.2, 0.1), 0.3)
        self.assertEqual(rm.round_volume_down(0.29999, 0.1), 0.2)
        self.assertEqual(rm.round_volume_down(0.1549, 0.01), 0.15)
        self.assertEqual(rm.round_volume_down(0.004, 0.01), 0.0)
        self.assertEqual(rm.round_volume_down(7.9, 1), 7.0)

    def test_risk_percent_buy_sell(self):  # 0.5% of 10000 over $5 = 0.10 lots, 50 USD
        for entry, sl in ((2000, 1995), (2000, 2005)):
            r = rm.compute_volume(rm.sizing_policy('pct', 0.5), entry, sl, 10000, SPEC, LIM)
            self.assertTrue(r['ok']); self.assertEqual(r['volume'], 0.1); self.assertAlmostEqual(r['riskMoney'], 50)

    def test_fixed_risk_money_and_rounding(self):  # 49.9 over $500/lot -> 0.09 not 0.10
        r = rm.compute_volume(rm.sizing_policy('money', 49.9), 2000, 1995, 10000, SPEC, LIM)
        self.assertEqual(r['volume'], 0.09)

    def test_cap_and_percent_cap(self):  # cap = min(maxRiskMoney, equity*maxRiskPercent/100)
        r = rm.compute_volume(rm.sizing_policy('pct', 2), 2000, 1995, 10000, SPEC, dict(LIM, maxRiskMoney=50))
        self.assertEqual((r['volume'], r['riskMoney']), (0.1, 50))
        r = rm.compute_volume(rm.sizing_policy('money', 500), 2000, 1995, 1000, SPEC, LIM)
        self.assertEqual((r['volume'], r['riskMoney']), (0.1, 50))

    def test_clamp_to_max_lots(self):  # 5000 money over $500/lot -> 10 lots, clamped to maxLots 1
        r = rm.compute_volume(rm.sizing_policy('money', 5000), 2000, 1995, 1e6, SPEC, dict(LIM, maxLots=1))
        self.assertEqual((r['volume'], r['clampedBy']), (1, 'max_lots'))

    def test_fixed_lots_never_resized(self):
        self.assertEqual(rm.compute_volume({'mode': 'fixed_lots', 'fixed_lots': 25, 'below_min_volume': 'skip'},
                                           2000, 1995, 1e6, SPEC, dict(LIM, maxLots=20))['reason'], 'volume_exceeds_max')
        self.assertEqual(rm.compute_volume({'mode': 'fixed_lots', 'fixed_lots': 0.2, 'below_min_volume': 'skip'},
                                           2000, 1995, 1000, SPEC, LIM)['reason'], 'risk_exceeds_limit')
        for lots in (0.105, 0.005, 0.015):
            self.assertEqual(rm.compute_volume({'mode': 'fixed_lots', 'fixed_lots': lots, 'below_min_volume': 'skip'},
                                               2000, 1995, 1e4, SPEC, LIM)['reason'], 'volume_not_step_aligned')

    def test_below_min_policies(self):  # equity 500 -> cap 25; 0.5% = 2.5 -> 0
        s = rm.sizing_policy('pct', 0.5)
        self.assertEqual(rm.compute_volume(s, 2000, 1995, 500, SPEC, LIM)['reason'], 'volume_below_min')
        s['below_min_volume'] = 'use_min_if_within_cap'
        r = rm.compute_volume(s, 2000, 1995, 500, SPEC, LIM)
        self.assertEqual((r['volume'], r['riskMoney']), (0.01, 5))
        r = rm.compute_volume(s, 2000, 1995, 500, SPEC, dict(LIM, maxRiskMoney=1))
        self.assertEqual(r['reason'], 'volume_below_min')

    def test_invalid_inputs(self):
        self.assertEqual(rm.compute_volume(rm.sizing_policy('pct', 0.5), 2000, 2000, 1e4, SPEC, LIM)['reason'],
                         'invalid_stop_distance')
        self.assertEqual(rm.compute_volume(rm.sizing_policy('pct', 0.5), 2000, 1995, 0, SPEC, LIM)['reason'],
                         'invalid_equity')
        self.assertEqual(rm.compute_volume(rm.sizing_policy('pct', 0.0), 2000, 1995, 1e4, SPEC, LIM)['reason'],
                         'missing_sizing_value')
        self.assertEqual(rm.compute_volume(rm.sizing_policy('pct', 0.5), 2000, 1995, 1e4, dict(SPEC, volumeMax=0.001), LIM)['reason'],
                         'invalid_symbol_spec')

class SplitTests(unittest.TestCase):
    def test_50_30_20_at_0_10(self):  # planCheckpoints vector: 0.05 / 0.03 / 0.02, remaining 0.05 / 0.02 / 0
        self.assertEqual(rm.plan_volume_split(0.10, [50, 30, 20], SPEC, 'merge_into_next'),
                         ('exact', [(1, 0.05), (2, 0.03), (3, 0.02)]))

    def test_infeasible_at_0_01(self):  # skip_trade fails; merge_into_next leaves one 100% checkpoint at TP3
        self.assertEqual(rm.plan_volume_split(0.01, [50, 30, 20], SPEC, 'skip_trade')[0], 'skipped')
        self.assertEqual(rm.plan_volume_split(0.01, [50, 30, 20], SPEC, 'merge_into_next'), ('merged', [(3, 0.01)]))

    def test_0_02_keeps_tp1_and_tp3(self):
        self.assertEqual(rm.plan_volume_split(0.02, [50, 30, 20], SPEC, 'merge_into_next'), ('merged', [(1, 0.01), (3, 0.01)]))

    def test_total_below_min_is_infeasible(self):
        self.assertEqual(rm.plan_volume_split(0.005, [50, 30, 20], SPEC, 'merge_into_next')[0], 'skipped')

    def test_sell_prices_and_broker_tp(self):
        tp_cfg = {'checkpoints': [{'tp_index': i + 1, 'close_percent': p} for i, p in enumerate([50, 30, 20])],
                  'missing_tp': 'skip_trade', 'infeasible_split': 'skip_trade', 'broker_tp': 'final_checkpoint'}
        r = rm.plan_checkpoints(0.1, 'sell', 2000, [1995, 1990, 1985], tp_cfg, SPEC)
        self.assertEqual([c['closeVolume'] for c in r['checkpoints']], [0.05, 0.03, 0.02])
        self.assertEqual(r['brokerTp'], 1985)
        bad = rm.plan_checkpoints(0.1, 'sell', 2000, [1995, 2010, 1985], tp_cfg, SPEC)
        self.assertEqual(bad['reason'], 'tp_order_invalid')

    def test_runner_variant_feasibility_threshold(self):
        # 30/30/30 + 10% runner (broker_tp none): smallest total with every piece >= 0.01
        feas = [v for v in [round(0.01 * i, 2) for i in range(1, 21)]
                if rm.plan_volume_split(v, [30, 30, 30, 10], SPEC, 'skip_trade')[0] == 'exact']
        self.assertEqual(feas[0], 0.04)

class MarginAndPathTests(unittest.TestCase):
    def test_margin_per_lot(self):
        self.assertAlmostEqual(rm.margin_per_lot(5000, 100), 5000)
        self.assertAlmostEqual(rm.margin_per_lot(4500, 500), 900)

    def test_path_skips_on_concurrency_and_loss(self):
        cfg = rm.make_cfg(rm.DEFAULT_SAFETY)
        tr = [{'id': i, 'open_ms': i * 1000, 'close_ms': 10 ** 9 + i, 'sd': 5.0, 'entry_px': 4000.0,
               'legs': [(100.0, -5.0)]} for i in range(5)]
        out = rm.run_path(tr, rm.sizing_policy('pct', 0.25), 10000, cfg)
        self.assertEqual(len(out['taken']), 1)  # maxPerSymbol 1 under DEFAULT_SAFETY
        self.assertEqual(out['skips'].get('max_positions_per_symbol'), 4)

    def test_path_loss_and_daily_gate(self):
        cfg = rm.make_cfg(rm.DEFAULT_SAFETY, max_positions_per_symbol=3)
        day = 86400000 * 10
        tr = [{'id': i, 'open_ms': day + i * 1000, 'close_ms': day + i * 1000 + 500, 'sd': 5.0, 'entry_px': 4000.0,
               'legs': [(100.0, -5.0)]} for i in range(4)]
        out = rm.run_path(tr, rm.sizing_policy('money', 50), 5000, cfg)
        # Trade 1: cap min(50, 1% of 5000) = 50 -> 0.10 lot, full loss 50 USD. Trade 2 sized on equity 4950:
        # cap 49.5 -> 0.09 lot, loss 45 (realised -95). Trade 3 still allowed (95 < 100) -> realised -140.
        # Trade 4 is blocked: realised loss on the UTC day is at or above the 100 USD daily limit.
        self.assertEqual(len(out['taken']), 3)
        self.assertEqual(out['skips'].get('daily_loss_limit'), 1)
        self.assertAlmostEqual(out['final_equity'], 5000 - 50 - 45 - 45)

if __name__ == '__main__':
    unittest.main(verbosity=1)

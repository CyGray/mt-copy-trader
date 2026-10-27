"""Symbol generalisation of the B2 engine (rule: a3/symbols.py). Offline, synthetic data only.

(a) configure_symbol('XAUUSD') leaves every parameter exactly as the gold study had it.
(b) Scale invariance. A synthetic gold case and the same case with every price times k (EURUSD k=1e-4,
    USDJPY k=0.01) give the same fill status and skip reason, exit sequence, final exit and total_R (to 1e-9),
    for the frozen finalists and benchmark, every entry model and every cost scenario. Under an exact power-of-two
    scale (2**-13) the whole grid must match bit for bit, which shows no USD parameter was left unscaled.
    Decimal scales can round an exact decimal tie on the trailing grid differently (see ENGINE_REPORT.md), so the
    full grid is not asserted under 1e-4 / 0.01.
(c) TickStore decodes a synthetic bi5 at price divisor 100000, and caches of different divisors never share a file.
(d) usd_per_1lot uses the symbol's contract.

Run: cd <this dir> && python3 -I test_symbols.py
"""
import copy
import json
import lzma
import os
import shutil
import struct
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'a3'))
import sim_engine_b2 as se  # noqa: E402  (also makes numpy importable under python3 -I)
import numpy as np  # noqa: E402
import b2_core as c  # noqa: E402
import symbols as sy  # noqa: E402

T0 = se.utc_ms('2025-11-03T10:00:00Z')
HOUR = 3_600_000
FROZEN = json.load(open(os.path.join(HERE, 'out', 'finalists.json')))
FROZEN_NAMES = [d['variant'] for d in FROZEN['finalists']] + [FROZEN['benchmark']]

GOLD = dict(PROJ_MIN_DIST=2.0, PROJ_MAX_DIST=25.0, TRAIL_DISTS=(1.5, 2.5, 4.0, 6.0), TRAIL_STEP=0.5,
            BE_PRICE_USD=4.0, UNIT=1.0, OUT_DP=4, SYMBOL='XAUUSD', CONTRACT=100.0,
            TOL={'E1': 2.0, 'E2': 0.5, 'E3': 0.5},
            COSTS={'BASE': dict(spread=0.0, slip=0.0, latency=5.0),
                   'MID': dict(spread=0.10, slip=0.05, latency=10.0),
                   'PESS': dict(spread=0.20, slip=0.10, latency=15.0)},
            GRID_SIZE=196)


def snapshot():
    """Every parameter that a symbol configuration can touch, including the full grid kwargs."""
    return dict(PROJ_MIN_DIST=c.PROJ_MIN_DIST, PROJ_MAX_DIST=c.PROJ_MAX_DIST, TRAIL_DISTS=c.TRAIL_DISTS,
                TRAIL_STEP=c.TRAIL_STEP, BE_PRICE_USD=c.BE_PRICE_USD, UNIT=c.UNIT, OUT_DP=c.OUT_DP,
                SYMBOL=c.SYMBOL, CONTRACT=se.CONTRACT_OZ, TOL={k: v['tol'] for k, v in c.ENTRIES.items()},
                COSTS=copy.deepcopy(c.COSTS), NOMINAL={k: v['nominal_guard'] for k, v in c.ENTRIES.items()},
                GRID=[(v['name'], repr(v['kw']), v['missing_tp']) for v in c.build_grid()])


class FakeStore:
    """Duck-typed TickStore: every hour is 'ok' and served from in-memory arrays."""

    def __init__(self, ms, bid, ask):
        self.ms, self.bid, self.ask = ms, bid, ask

    def status(self, hour_ms):
        return 'ok'

    def load_hour(self, hour_ms):
        m = (self.ms >= hour_ms) & (self.ms < hour_ms + HOUR)
        return self.ms[m], self.bid[m], self.ask[m]


def synthetic_gold_case(seed, direction, sd=0.15, n=4800):
    """Gold random walk on a 0.001 grid over 80 h, a signal at T0 with 7 TPs. Deterministic per seed."""
    rng = np.random.default_rng(seed)
    ms = np.sort(T0 + rng.integers(0, 80 * HOUR, size=n)).astype(np.int64)
    p0 = 2000.0 + rng.uniform(-0.5, 0.5)
    mid = p0 + np.cumsum(rng.normal(0, sd, n))
    spr = rng.choice([0.10, 0.20, 0.30], size=n)
    bid = np.round(mid - spr / 2, 3)
    ask = np.round(mid + spr / 2, 3)
    sgn = 1 if direction == 'buy' else -1
    m0 = round(p0 + rng.uniform(-3, 3), 3)
    sl = round(m0 - sgn * rng.uniform(3, 8), 3)
    tps = [round(m0 + sgn * (2.5 + 1.5 * k) + sgn * rng.uniform(-0.3, 0.3), 3) for k in range(7)]
    sig = dict(direction=direction, lo=round(m0 - 0.5, 3), hi=round(m0 + 0.5, 3), sl=sl, tps=tps)
    return ms, bid, ask, sig


def scaled_case(ms, bid, ask, sig, k):
    return ms, bid * k, ask * k, dict(direction=sig['direction'], lo=sig['lo'] * k, hi=sig['hi'] * k,
                                      sl=sig['sl'] * k, tps=[t * k for t in sig['tps']])


def evaluate(symbol, ms, bid, ask, sig, names=None):
    """Run b2_core.evaluate_signal under `symbol`. Returns (fills, trades) with unrounded total_R taken from the
    simulate result (the trade rows round it to 6 dp), keyed by (entry, cost) and (entry, cost, variant)."""
    c.configure_symbol(symbol)
    V = [dict(v, strategy=c.make_strategy(v)) for v in c.build_grid() if names is None or v['name'] in names]
    store = FakeStore(ms, bid, ask)
    sig_obj = se.Signal('m1', int(T0), sig['direction'], sig['lo'], sig['hi'], sig['sl'], sig['tps'],
                        meta=dict(split='oos2', in_clean=1, sl_dist=abs(sig['hi'] - sig['sl'])))
    raw, orig = {}, c.trade_row

    def spy(base, v, res, fill, cost, mk):
        raw[(base['entry'], base['cost'], v['name'])] = res
        return orig(base, v, res, fill, cost, mk)
    c.trade_row = spy
    try:
        fills, trades = c.evaluate_signal(store, sig_obj, V)
    finally:
        c.trade_row = orig
    fill_map = {(f['entry'], f['cost']): (f['status'], f['reason']) for f in fills}
    trade_map = {}
    for key, res in raw.items():
        trade_map[key] = (res['status'], res.get('reason', ''), res.get('exit_seq', ''), res.get('final_exit', ''),
                          res.get('total_R'), res)
    return fill_map, trade_map, trades


class IdentityTests(unittest.TestCase):
    def setUp(self):
        c.configure_symbol('XAUUSD')

    def tearDown(self):
        c.configure_symbol('XAUUSD')

    def test_gold_values_match_the_study(self):
        s = snapshot()
        for k in ('PROJ_MIN_DIST', 'PROJ_MAX_DIST', 'TRAIL_DISTS', 'TRAIL_STEP', 'BE_PRICE_USD', 'UNIT', 'OUT_DP',
                  'SYMBOL', 'CONTRACT', 'TOL', 'COSTS'):
            self.assertEqual(s[k], GOLD[k], k)
        self.assertEqual(len(c.build_grid()), GOLD['GRID_SIZE'])
        self.assertEqual(se.Conventions().contract_oz, 100.0)
        self.assertEqual(se.TickStore('/nonexistent', HERE).price_divisor, 1000.0)

    def test_configure_gold_is_identity_on_every_parameter(self):
        before = snapshot()
        c.configure_symbol('XAUUSD')
        self.assertEqual(snapshot(), before)
        c.configure_symbol('EURUSD')
        c.configure_symbol('XAUUSD')            # no residue after another symbol
        self.assertEqual(snapshot(), before)


class ScalingTests(unittest.TestCase):
    def tearDown(self):
        c.configure_symbol('XAUUSD')

    def test_eurusd_parameters_are_pip_scaled(self):
        sp = c.configure_symbol('EURUSD')
        self.assertEqual(sp['symbol'], 'EURUSD')
        self.assertAlmostEqual(c.UNIT, 1e-4)
        self.assertAlmostEqual(c.PROJ_MIN_DIST, 2e-4)
        self.assertAlmostEqual(c.PROJ_MAX_DIST, 0.01)
        self.assertEqual(c.OUT_DP, 8)
        self.assertEqual(se.CONTRACT_OZ, 100000.0)
        self.assertAlmostEqual(c.ENTRIES['E1']['tol'], 2e-4)
        self.assertAlmostEqual(c.ENTRIES['E2']['tol'], 5e-5)
        self.assertAlmostEqual(c.COSTS['MID']['spread'], 1e-5)
        self.assertAlmostEqual(c.COSTS['MID']['slip'], 5e-6)
        self.assertEqual(c.COSTS['MID']['latency'], 10.0)            # seconds are not scaled
        self.assertAlmostEqual(c.TRAIL_STEP, 5e-5)
        self.assertAlmostEqual(c.BE_PRICE_USD, 4e-4)
        self.assertAlmostEqual(c.TRAIL_DISTS[0], 1.5e-4)

    def test_usdjpy_parameters_use_the_symbol_spec(self):
        sp = c.configure_symbol('USDJPY')
        self.assertEqual(sp['quote_ccy'], 'JPY')
        self.assertAlmostEqual(c.UNIT, 0.01)
        self.assertAlmostEqual(c.PROJ_MIN_DIST, 0.02)
        self.assertAlmostEqual(c.PROJ_MAX_DIST, 1.00)
        self.assertEqual(se.CONTRACT_OZ, 100000.0)
        self.assertEqual(c.OUT_DP, 6)

    def test_variant_names_are_labels_so_they_match_across_symbols(self):
        gold = [v['name'] for v in c.build_grid()]
        c.configure_symbol('EURUSD')
        self.assertEqual([v['name'] for v in c.build_grid()], gold)
        c.configure_symbol('USDJPY')
        self.assertEqual([v['name'] for v in c.build_grid()], gold)
        self.assertTrue(set(FROZEN_NAMES) <= set(gold))

    def test_grid_built_for_one_unit_is_refused_under_another(self):
        c.configure_symbol('EURUSD')
        V = c.build_grid()
        c.configure_symbol('XAUUSD')
        with self.assertRaises(ValueError):
            c.make_strategy(V[0])


class ScaleInvarianceTests(unittest.TestCase):
    N_SEEDS = 12

    def setUp(self):
        c.configure_symbol('XAUUSD')
        self._added = []

    def tearDown(self):
        for name in self._added:
            sy.SPECS.pop(name, None)
        c.configure_symbol('XAUUSD')

    def _compare(self, symbol, k, names, seeds, directions=('buy', 'sell')):
        n_trades = n_filled = 0
        for seed in seeds:
            for direction in directions:
                ms, bid, ask, sig = synthetic_gold_case(seed, direction)
                g_fills, g_trades, _ = evaluate('XAUUSD', ms, bid, ask, sig, names)
                ms2, bid2, ask2, sig2 = scaled_case(ms, bid, ask, sig, k)
                s_fills, s_trades, s_rows = evaluate(symbol, ms2, bid2, ask2, sig2, names)
                tag = (symbol, seed, direction)
                self.assertEqual(set(g_fills), set(s_fills), tag)
                for key in g_fills:
                    self.assertEqual(g_fills[key], s_fills[key], (tag, key))
                n_filled += sum(1 for v in g_fills.values() if v[0] == 'FILLED')
                self.assertEqual(set(g_trades), set(s_trades), tag)
                for key, (st, rs, es, fe, tr, _) in g_trades.items():
                    st2, rs2, es2, fe2, tr2, res2 = s_trades[key]
                    self.assertEqual((st, rs, es, fe), (st2, rs2, es2, fe2), (tag, key))
                    if tr is None or tr2 is None:
                        self.assertEqual((tr is None), (tr2 is None), (tag, key))
                    else:
                        self.assertLessEqual(abs(tr - tr2), 1e-9, (tag, key))
                        # contract: usd_per_1lot = total_R * R * contract (unrounded simulate values)
                        usd = res2['usd_per_1lot']
                        self.assertLessEqual(abs(usd - tr2 * res2['R'] * se.CONTRACT_OZ), 1e-9 * max(1.0, abs(usd)),
                                             (tag, key))
                    n_trades += 1
                for row in s_rows:      # rows are written at OUT_DP decimals
                    if row['status'] == 'FILLED':
                        res2 = s_trades[(row['entry'], row['cost'], row['variant'])][5]
                        self.assertEqual(row['R_usd'], round(res2['R'], c.OUT_DP), (tag, row['variant']))
        self.assertGreater(n_filled, 0)
        self.assertGreater(n_trades, 0)

    def test_frozen_set_identical_on_eurusd(self):
        self._compare('EURUSD', 1e-4, FROZEN_NAMES, range(self.N_SEEDS))

    def test_frozen_set_identical_on_usdjpy(self):
        self._compare('USDJPY', 0.01, FROZEN_NAMES, range(self.N_SEEDS))

    def test_full_grid_identical_under_exact_power_of_two_scale(self):
        k = 2.0 ** -13
        name = 'EXACT_2POW13'
        sy.SPECS[name] = dict(price_divisor=1000.0, pip=k, unit=k, contract=100.0, quote_ccy='USD',
                              min_sl=2.0 * k, max_sl=25.0 * k)
        self._added.append(name)
        n_trades = 0
        for seed in range(4):
            for direction in ('buy', 'sell'):
                ms, bid, ask, sig = synthetic_gold_case(seed, direction)
                g_fills, g_trades, _ = evaluate('XAUUSD', ms, bid, ask, sig)
                ms2, bid2, ask2, sig2 = scaled_case(ms, bid, ask, sig, k)
                s_fills, s_trades, _ = evaluate(name, ms2, bid2, ask2, sig2)
                self.assertEqual(g_fills, s_fills, (seed, direction))
                self.assertEqual(set(g_trades), set(s_trades))
                for key, (st, rs, es, fe, tr, _) in g_trades.items():
                    st2, rs2, es2, fe2, tr2, _ = s_trades[key]
                    self.assertEqual((st, rs, es, fe, tr), (st2, rs2, es2, fe2, tr2), (seed, direction, key))
                    n_trades += 1
        self.assertGreater(n_trades, 1000)


class TickStoreDivisorTests(unittest.TestCase):
    def _write_hour(self, store, hour, recs):
        p = store.hour_path(hour)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        data = b''.join(struct.pack('>IIIff', *r) for r in recs)
        with open(p, 'wb') as f:
            f.write(lzma.compress(data, format=lzma.FORMAT_ALONE))

    def test_divisor_100000_decodes_bi5_to_fx_prices(self):
        tmp = tempfile.mkdtemp(dir=HERE)
        try:
            raw, cache = os.path.join(tmp, 'raw'), os.path.join(tmp, 'cache')
            hour = se.utc_ms('2025-11-03T10:00:00Z')
            fx = se.TickStore(raw, cache, price_divisor=100000)
            recs = [(1000, 108123, 108101, 0.5, 0.25), (2500, 108150, 108140, 0.1, 0.2)]
            self._write_hour(fx, hour, recs)
            ms, bid, ask = fx.load_hour(hour)
            self.assertEqual(list(ms), [hour + 1000, hour + 2500])
            np.testing.assert_allclose(ask, [1.08123, 1.08150], rtol=0, atol=1e-12)
            np.testing.assert_allclose(bid, [1.08101, 1.08140], rtol=0, atol=1e-12)
            self.assertEqual(fx.price_divisor, 100000.0)
            self.assertTrue(any(n.endswith('_d100000.npy') for n in os.listdir(cache)), os.listdir(cache))

            gold = se.TickStore(raw, cache)                       # default divisor, same raw file, same cache dir
            self.assertEqual(gold.price_divisor, 1000.0)
            g_ms, g_bid, g_ask = gold.load_hour(hour)
            np.testing.assert_allclose(g_ask[:1], [108.123], rtol=0, atol=1e-9)
            self.assertNotEqual(gold._cache_path(hour), fx._cache_path(hour))   # divisors never share a cache file
            self.assertEqual(len([n for n in os.listdir(cache) if n.endswith('.npy')]), 2)
            self.assertTrue(os.path.basename(fx._cache_path(hour)).endswith('_d100000.npy'))
            self.assertNotIn('_d', os.path.basename(gold._cache_path(hour)))   # gold cache names are unchanged
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ContractTests(unittest.TestCase):
    def tearDown(self):
        c.configure_symbol('XAUUSD')

    def _one_tp_trade(self, symbol, entry, tp, sl):
        c.configure_symbol(symbol)
        T1 = T0
        ticks = [(T1 + 1 * 1000, entry, entry), (T1 + 20 * 1000, tp, tp)]   # (ms, bid, ask), zero spread
        ms = np.array([t[0] for t in ticks], dtype=np.int64)
        bid = np.array([t[1] for t in ticks], dtype=float)
        ask = np.array([t[2] for t in ticks], dtype=float)
        win = se.Window(ms, bid, ask, int(ms[0]), int(ms[-1]) + 1, int(ms[-1]) + 1, [])
        mk = se.Market(win, 'buy', 0.0)
        sig = se.Signal('x', T1, 'buy', entry - c.PROJ_MIN_DIST, entry + c.PROJ_MIN_DIST, sl, (tp,))
        ep = se.EntryParams('P1', latency_s=0.0, tol=c.ENTRIES['E3']['tol'])
        fill = se.decide_entry(sig, ep, mk)
        return se.simulate(sig, fill, se.Strategy('tp1', checkpoints=((1, 100.0),)), mk)

    def test_usd_per_1lot_uses_the_symbol_contract(self):
        res = self._one_tp_trade('XAUUSD', 2000.0, 2001.0, 1995.0)
        self.assertEqual(res['status'], 'FILLED')
        self.assertAlmostEqual(res['usd_per_1lot'], 100.0, places=9)     # 1.00 USD x 100 oz
        res = self._one_tp_trade('EURUSD', 1.10000, 1.10100, 1.09900)
        self.assertEqual(res['status'], 'FILLED')
        self.assertAlmostEqual(res['usd_per_1lot'], 100.0, places=6)     # 10 pips x 100,000 = 100 USD per lot
        res = self._one_tp_trade('USDJPY', 150.000, 150.100, 149.900)
        self.assertEqual(res['status'], 'FILLED')
        self.assertAlmostEqual(res['usd_per_1lot'], 10000.0, places=4)   # 10 pips x 100,000 = 10,000 JPY per lot


if __name__ == '__main__':
    unittest.main(verbosity=2)

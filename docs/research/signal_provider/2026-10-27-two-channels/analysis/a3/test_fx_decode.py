"""Unit tests for the symbol-aware Dukascopy decoder, URL/path layout and the ECB comparison logic.

Run, from the a3/ folder:
  python3 -I -m unittest discover -s . -p 'test_fx_decode.py' -v
  (-I drops the working directory from sys.path, so discover is given the folder explicitly)

No test opens a socket: urlopen is mocked wherever a download path is exercised, and the CLI tests
either hit a cached file or exit before any network call.
"""
import datetime as dt
import io
import lzma
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dukas_lib as dl  # noqa: E402
import ecb_check as ec  # noqa: E402
from symbols import spec  # noqa: E402

REC = struct.Struct('>IIIff')
UTC = dt.timezone.utc
GOLD_PREFIX = 'http://datafeed.dukascopy.com/datafeed/XAUUSD'


def bi5_bytes(records):
    """records: (ms_offset, ask_int, bid_int, ask_vol, bid_vol) -> LZMA-alone bytes, as Dukascopy serves them."""
    return lzma.compress(b''.join(REC.pack(*r) for r in records), format=lzma.FORMAT_ALONE)


def epoch_ms(t):
    return int(t.replace(tzinfo=UTC).timestamp() * 1000)


class TmpCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='fxtest_')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_hour(self, rawdir, t, records):
        p = dl.hour_path(rawdir, t)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(bi5_bytes(records))
        return p


class SyntheticDecodeTests(TmpCase):
    T = dt.datetime(2026, 10, 5, 12)
    # (ask_int, bid_int) written at each divisor's scale; expected prices follow from the divisor alone
    CASES = {
        'EURUSD': (116543, 116530),      # 5 decimals -> 1.16543 / 1.16530
        'GBPUSD': (134712, 134700),      # 5 decimals -> 1.34712 / 1.34700
        'USDJPY': (151234, 151220),      # 3 decimals -> 151.234 / 151.220
        'XAUUSD': (4001234, 4001000),    # 3 decimals -> 4001.234 / 4001.000
    }

    def test_decode_per_divisor(self):
        for sym, (ask_i, bid_i) in self.CASES.items():
            with self.subTest(symbol=sym):
                div = spec(sym)['price_divisor']
                recs = [(0, ask_i, bid_i, 1.5, 2.5), (1500, ask_i + 1, bid_i, 3.0, 4.0)]
                p = self.write_hour(os.path.join(self.tmp, sym), self.T, recs)
                rows = dl.decode_hour_prices(p, self.T, sym)
                self.assertEqual(len(rows), 2)
                ts, bid, ask, bvol, avol = rows[0]
                self.assertEqual(ts, epoch_ms(self.T))
                self.assertAlmostEqual(ask, ask_i / div, places=9)
                self.assertAlmostEqual(bid, bid_i / div, places=9)
                self.assertGreater(ask, bid)
                self.assertEqual((bvol, avol), (2.5, 1.5))      # bid volume is the 5th field
                self.assertEqual(rows[1][0], ts + 1500)          # ms offset applied to the hour start
                self.assertAlmostEqual(rows[1][2], (ask_i + 1) / div, places=9)
                raw = dl.decode_hour(p, self.T)                  # integer decoder unchanged
                self.assertEqual(raw[0][1:3], (bid_i, ask_i))

    def test_wrong_divisor_is_off_by_a_power_of_ten(self):
        # EURUSD bi5 read with the USDJPY divisor (1000) gives 100x the price: the failure the ECB check catches
        p = self.write_hour(os.path.join(self.tmp, 'EURUSD'), self.T, [(0, 116543, 116530, 1.0, 1.0)])
        right = dl.decode_hour_prices(p, self.T, 'EURUSD')[0][2]
        wrong = dl.decode_hour_prices(p, self.T, 'USDJPY')[0][2]
        self.assertAlmostEqual(wrong / right, 100.0, places=6)

    def test_empty_file_decodes_to_nothing(self):
        p = os.path.join(self.tmp, 'EURUSD', '2026', '10', '05', '12h_ticks.bi5')
        os.makedirs(os.path.dirname(p))
        open(p, 'wb').close()
        self.assertEqual(dl.decode_hour_prices(p, self.T, 'EURUSD'), [])

    def test_spread_in_pips_from_symbol_spec(self):
        p = self.write_hour(os.path.join(self.tmp, 'EURUSD'), self.T, [(0, 116543, 116530, 1.0, 1.0)])
        ts, bid, ask, _, _ = dl.decode_hour_prices(p, self.T, 'EURUSD')[0]
        self.assertAlmostEqual((ask - bid) / spec('EURUSD')['pip'], 1.3, places=6)   # 0.00013 = 1.3 pips


class UrlAndPathTests(TmpCase):
    def test_eurusd_url_zero_indexed_month(self):
        self.assertEqual(dl.hour_url(dt.datetime(2026, 10, 5, 12), 'EURUSD'),
                         'http://datafeed.dukascopy.com/datafeed/EURUSD/2026/09/05/12h_ticks.bi5')

    def test_alias_gives_same_url(self):
        self.assertEqual(dl.hour_url(dt.datetime(2026, 10, 5, 12), 'eu'),
                         dl.hour_url(dt.datetime(2026, 10, 5, 12), 'EURUSD'))

    def test_xauusd_url_zero_indexed_month(self):
        self.assertEqual(dl.hour_url(dt.datetime(2026, 10, 26, 13), 'XAUUSD'),
                         f'{GOLD_PREFIX}/2026/09/26/13h_ticks.bi5')

    def test_default_is_xauusd_and_unchanged(self):
        t = dt.datetime(2026, 10, 26, 13)
        self.assertEqual(dl.hour_url(t), f'{GOLD_PREFIX}/2026/09/26/13h_ticks.bi5')
        self.assertEqual(dl.hour_url(t), dl.hour_url(t, 'XAUUSD'))
        self.assertEqual(dl.BASE, GOLD_PREFIX)
        self.assertEqual(dl.PRICE_DIVISOR, 1000.0)
        self.assertEqual(dl.DEFAULT_SYMBOL, 'XAUUSD')
        self.assertEqual(dl.hour_path('/r', t), os.path.join('/r', '2026', '10', '26', '13h_ticks.bi5'))

    def test_default_fetch_requests_gold_url_and_writes_gold_path(self):
        t = dt.datetime(2026, 10, 26, 13)
        requested = []
        body = bi5_bytes([(0, 4001234, 4001000, 1.0, 1.0)])

        def fake_urlopen(req, timeout=None):
            requested.append(req.full_url)
            return io.BytesIO(body)

        raw = os.path.join(self.tmp, 'gold_raw')
        with mock.patch.object(dl.urllib.request, 'urlopen', side_effect=fake_urlopen):
            status, n, note = dl.fetch_hour(t, raw)
        self.assertEqual((status, n, note), ('ok', len(body), ''))
        self.assertEqual(requested, [f'{GOLD_PREFIX}/2026/09/26/13h_ticks.bi5'])
        self.assertTrue(os.path.exists(os.path.join(raw, '2026', '10', '26', '13h_ticks.bi5')))

    def test_per_symbol_paths_are_separate(self):
        t = dt.datetime(2026, 10, 26, 13)
        self.assertNotEqual(dl.hour_url(t, 'EURUSD'), dl.hour_url(t, 'XAUUSD'))
        self.assertNotEqual(dl.hour_path(os.path.join(self.tmp, 'fx', 'raw', 'EURUSD'), t),
                            dl.hour_path(os.path.join(self.tmp, 'fx', 'raw', 'XAUUSD'), t))

    def test_check_rawdir_refuses_mixing(self):
        ok = [(os.path.join(self.tmp, 'EURUSD'), 'EURUSD'), (os.path.join(self.tmp, 'eurusd/'), 'EURUSD'),
              (os.path.join(self.tmp, 'raw_gold'), 'XAUUSD'), (os.path.join(self.tmp, 'XAUUSD'), 'XAUUSD')]
        bad = [(os.path.join(self.tmp, 'XAUUSD'), 'EURUSD'),      # FX into the gold directory
               (os.path.join(self.tmp, 'EURUSD'), 'XAUUSD'),      # gold into the EURUSD directory
               (os.path.join(self.tmp, 'GBPUSD'), 'USDJPY'),      # two FX symbols in one directory
               (os.path.join(self.tmp, 'fx'), 'EURUSD')]          # FX without a symbol-named directory
        for rawdir, sym in ok:
            with self.subTest(ok=rawdir, symbol=sym):
                dl.check_rawdir(rawdir, sym)
        for rawdir, sym in bad:
            with self.subTest(bad=rawdir, symbol=sym):
                with self.assertRaises(ValueError):
                    dl.check_rawdir(rawdir, sym)

    def test_symbol_base_and_divisor(self):
        self.assertEqual(dl.symbol_base('gold'), GOLD_PREFIX)
        self.assertEqual(dl.price_divisor('EURUSD'), 100000.0)
        self.assertEqual(dl.price_divisor('USDJPY'), 1000.0)
        self.assertEqual(dl.price_divisor('GBPUSD'), 100000.0)
        self.assertEqual(dl.price_divisor(), 1000.0)


class FetchRetryTests(TmpCase):
    T = dt.datetime(2026, 10, 5, 12)

    def fetch(self, side_effect, symbol='EURUSD'):
        raw = os.path.join(self.tmp, symbol)
        with mock.patch.object(dl.urllib.request, 'urlopen', side_effect=side_effect) as uo, \
                mock.patch.object(dl.time, 'sleep'):
            res = dl.fetch_hour(self.T, raw, symbol=symbol)
        return res, uo, raw

    def test_503_then_ok_is_recorded(self):
        body = bi5_bytes([(0, 116543, 116530, 1.0, 1.0)])
        err = urllib.error.HTTPError('u', 503, 'Service Unavailable', None, None)
        (status, n, note), uo, raw = self.fetch([err, io.BytesIO(body)])
        self.assertEqual((status, n, note), ('ok', len(body), 'retried after HTTP 503'))
        self.assertEqual(uo.call_count, 2)
        self.assertTrue(os.path.exists(dl.hour_path(raw, self.T)))
        self.assertEqual(uo.call_args.args[0].full_url, dl.hour_url(self.T, 'EURUSD'))

    def test_persistent_503_is_error_with_all_attempts(self):
        err = urllib.error.HTTPError('u', 503, 'Service Unavailable', None, None)
        (status, n, note), uo, raw = self.fetch([err] * 4)
        self.assertEqual((status, n), ('error', 0))
        self.assertEqual(note, 'HTTP 503 | HTTP 503 | HTTP 503 | HTTP 503')
        self.assertFalse(os.path.exists(dl.hour_path(raw, self.T)))   # errors are not cached: a rerun retries

    def test_404_is_missing_and_cached_as_marker(self):
        err = urllib.error.HTTPError('u', 404, 'Not Found', None, None)
        (status, n, note), uo, raw = self.fetch([err])
        self.assertEqual((status, note), ('missing', 'HTTP 404'))
        self.assertTrue(os.path.exists(dl.hour_path(raw, self.T) + '.missing'))

    def test_zero_length_is_empty(self):
        (status, n, note), uo, raw = self.fetch([io.BytesIO(b'')])
        self.assertEqual((status, n, note), ('empty', 0, 'zero-length'))
        self.assertTrue(os.path.exists(dl.hour_path(raw, self.T) + '.empty'))


class EcbCheckTests(TmpCase):
    XML = """<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<Cube><Cube time="2026-10-05"><Cube currency="USD" rate="1.1650"/><Cube currency="JPY" rate="180.50"/><Cube currency="GBP" rate="0.8700"/></Cube></Cube>
</gesmes:Envelope>"""

    def rates(self):
        p = os.path.join(self.tmp, 'eurofxref.xml')
        with open(p, 'w') as f:
            f.write(self.XML)
        return ec.parse_ecb(p)['2026-10-05']

    def test_parse_and_decimals(self):
        r = self.rates()
        self.assertEqual(r['USD'], (1.165, 4))
        self.assertEqual(r['JPY'], (180.5, 2))
        self.assertEqual(r['GBP'], (0.87, 4))

    def test_derived_pairs(self):
        r = self.rates()
        self.assertAlmostEqual(ec.ecb_pair('EURUSD', r)[0], 1.165)
        self.assertAlmostEqual(ec.ecb_pair('USDJPY', r)[0], 180.5 / 1.165)
        self.assertAlmostEqual(ec.ecb_pair('GBPUSD', r)[0], 1.165 / 0.87)
        rel_usdjpy = ec.ecb_pair('USDJPY', r)[1]
        self.assertAlmostEqual(rel_usdjpy, 0.5 * 0.01 / 180.5 + 0.5 * 1e-4 / 1.165)

    def test_fix_instant_follows_cet_cest(self):
        self.assertEqual(ec.fix_utc(dt.date(2026, 10, 5)), dt.datetime(2026, 10, 5, 12, 15))
        self.assertEqual(ec.fix_utc(dt.date(2026, 10, 23)), dt.datetime(2026, 10, 23, 12, 15))
        self.assertEqual(ec.fix_utc(dt.date(2026, 10, 26)), dt.datetime(2026, 10, 26, 13, 15))

    def _raw_with_ticks(self, sym, mids, ts_offsets_ms):
        raw = os.path.join(self.tmp, 'raw', sym)
        div = spec(sym)['price_divisor']
        pip = spec(sym)['pip']
        recs = []
        for off, mid in zip(ts_offsets_ms, mids):
            half = int(round(0.5 * pip * div))   # 1 pip quoted spread: half a pip each side of the mid
            m = int(round(mid * div))
            recs.append((off, m + half, m - half, 1.0, 1.0))
        self.write_hour(raw, dt.datetime(2026, 10, 5, 12), recs)
        return raw

    def test_compare_passes_within_15_pips(self):
        # fix 12:15:00.000 UTC; the tick exactly at the fix has mid 1.16565; ECB 1.1656 -> 0.5 pip
        offs = [14 * 60000 + 30000, 15 * 60000]   # 12:14:30 and 12:15:00.000, ms from the 12:00 hour start
        raw = self._raw_with_ticks('EURUSD', [1.16550, 1.16565], offs)
        row = ec.compare(raw, 'EURUSD', dt.date(2026, 10, 5), self.rates_for_eurusd(1.1656))
        self.assertEqual(row['window_ticks'], 2)
        self.assertAlmostEqual(row['dukas_mid_at_fix'], 1.16565, places=7)
        self.assertAlmostEqual(row['diff_pips'], 0.5, places=2)
        self.assertTrue(row['pass'])

    def test_compare_fails_when_far_off(self):
        raw = self._raw_with_ticks('EURUSD', [1.16565], [15 * 60000])
        row = ec.compare(raw, 'EURUSD', dt.date(2026, 10, 5), self.rates_for_eurusd(1.1700))
        self.assertFalse(row['pass'])
        self.assertAlmostEqual(row['diff_pips'], (1.16565 - 1.1700) / 0.0001, places=1)

    def test_tick_after_the_fix_is_excluded(self):
        raw = self._raw_with_ticks('EURUSD', [1.16500, 1.17000], [15 * 60000 - 1, 15 * 60000 + 1])
        row = ec.compare(raw, 'EURUSD', dt.date(2026, 10, 5), self.rates_for_eurusd(1.1650))
        self.assertEqual(row['window_ticks'], 1)
        self.assertTrue(row['pass'])

    def test_no_ticks_gives_no_pass(self):
        row = ec.compare(os.path.join(self.tmp, 'none', 'EURUSD'), 'EURUSD', dt.date(2026, 10, 5),
                         self.rates_for_eurusd(1.1650))
        self.assertEqual(row['window_ticks'], 0)
        self.assertFalse(row['pass'])

    def rates_for_eurusd(self, usd):
        return {'USD': (usd, 4), 'JPY': (180.5, 2), 'GBP': (0.87, 4)}


class DownloadCliTests(TmpCase):
    def run_cli(self, *args):
        cmd = [sys.executable, '-I', os.path.join(HERE, 'download_ticks.py')] + list(args)
        return subprocess.run(cmd, capture_output=True, text=True, timeout=60)

    def test_cli_refuses_symbol_in_wrong_directory_before_any_network(self):
        r = self.run_cli(os.path.join(self.tmp, 'XAUUSD'), os.path.join(self.tmp, 'm.csv'),
                         '2026-10-05T12', '2026-10-05T13', '1', '--symbol', 'EURUSD')
        self.assertEqual(r.returncode, 1)
        self.assertIn('error:', r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'm.csv')))

    def test_cli_default_is_xauusd_and_uses_cached_file(self):
        raw = os.path.join(self.tmp, 'gold')
        t = dt.datetime(2026, 10, 26, 13)
        p = self.write_hour(raw, t, [(0, 4001234, 4001000, 1.0, 1.0)])
        man = os.path.join(self.tmp, 'm.csv')
        r = self.run_cli(raw, man, '2026-10-26T13', '2026-10-26T14')
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(man) as f:
            rows = f.read().splitlines()
        self.assertEqual(rows[1].split(',')[:4], ['2026-10-26T13:00:00Z', 'cached', str(os.path.getsize(p)), ''])


if __name__ == '__main__':
    unittest.main()

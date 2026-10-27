import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parser_multi as pm

# Synthetic fixture in the zone layout (invented levels, not a real message)
ZONE2 = ("SIGNAL 1 (date: Jan 5 , 2026)\n\nBUY ZONE:   2652 - 2650\nSTOPLOSS:          2644 (60pips - 80pips)\n"
         "TAKE PROFIT:  2658 - 2666 - 2674 - open\n\nSIGNAL 2 (date: Jan 5 , 2026)\n\nSELL ZONE :     2671 - 2673 (retest)\n"
         "STOPLOSS:            {sl} (50pips - 70pips)\nTAKE PROFIT:  2666 - 2659 - 2650\n\nComment with a range 2680 - 2682.")

class T(unittest.TestCase):
    def test_two_zone_signals(self):
        s, e = pm.parse_message(ZONE2.format(sl=2678))
        self.assertIsNone(e); self.assertEqual(len(s), 2)
        self.assertEqual((s[0]['direction'], s[0]['entryLow'], s[0]['entryHigh'], s[0]['stopLoss'], s[0]['takeProfits'], s[0]['open_tp']),
                         ('buy', 2650.0, 2652.0, 2644.0, [2658.0, 2666.0, 2674.0], True))
        self.assertEqual((s[1]['direction'], s[1]['stopLoss'], s[1]['takeProfits']), ('sell', 2678.0, [2666.0, 2659.0, 2650.0]))
        self.assertEqual(s[0]['symbol'], 'XAUUSD'); self.assertIn('symbol_inferred', s[0]['info'])
        self.assertFalse([i for i in s[1]['info'] if i.startswith('sl_annotation_mismatch')])
    def test_annotation_mismatch_flags_typo(self):
        s, _ = pm.parse_message(ZONE2.format(sl=2688))
        self.assertTrue([i for i in s[1]['info'] if i.startswith('sl_annotation_mismatch')])
    def test_vip_format_unchanged(self):
        t = 'BUY XAUUSD\nENTRY: 2348 - 2350\nSL: 2340\nTP1: 2355\nTP2: 2360'
        s, e = pm.parse_message(t)
        self.assertEqual(len(s), 1); self.assertEqual(s[0]['format'], 'vip'); self.assertEqual(s[0]['stopLoss'], 2340.0)
    def test_zone_map_without_sl_is_not_signal(self):
        s, e = pm.parse_message('SELL ZONE: 2690 TO 2694\nBUY ZONE: 2640 TO 2636\nmap only')
        self.assertEqual(s, []); self.assertEqual(e, 'missing_sl')
    def test_management_not_signal(self):
        t = 'SIGNAL  1 MANAGEMENT\n\nREACHED TP1\nmove stoploss 2650\nEntry 2650 → 2660 = +100 Pips'
        self.assertEqual(pm.parse_message(t)[0], []); self.assertEqual(pm.classify_message(t, False, True), 'management')
    def test_fx_pair_numbered_tps(self):
        s, e = pm.parse_message('EURUSD SELL 1.0852 - 1.0857\nSL 1.0880\nTP1 1.0830\nTP2 1.0805')
        self.assertEqual(len(s), 1); self.assertEqual(s[0]['symbol'], 'EURUSD'); self.assertEqual(s[0]['takeProfits'], [1.083, 1.0805])
    def test_jpy_pair(self):
        s, _ = pm.parse_message('GBPJPY BUY ZONE 195.20 - 195.00\nSTOPLOSS 194.60 (40pips - 60pips)\nTAKE PROFIT 195.60 - 196.00')
        self.assertEqual(s[0]['symbol'], 'GBPJPY'); self.assertFalse([i for i in s[0]['info'] if 'mismatch' in i])
    def test_wrong_side_rejected(self):
        self.assertEqual(pm.parse_message('BUY ZONE 2652 - 2650\nSTOPLOSS 2655\nTAKE PROFIT 2660')[1], 'invalid_sl_side')
    def test_tp_order_rejected(self):
        self.assertEqual(pm.parse_message('SELL ZONE 2671 - 2673\nSTOPLOSS 2678\nTAKE PROFIT 2659 - 2666')[1], 'invalid_tp_order')
    def test_unknown_low_level_symbol(self):
        self.assertEqual(pm.parse_message('BUY ZONE 1.10 - 1.09\nSTOPLOSS 1.08\nTAKE PROFIT 1.12')[1], 'unknown_symbol')

if __name__ == '__main__':
    unittest.main()

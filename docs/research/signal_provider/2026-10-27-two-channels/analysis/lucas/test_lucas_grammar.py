import os, sys, unittest
sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'other')]
import lucas_grammar as g, parse_other as po
# Synthetic texts in the channels' layouts (invented levels; not real messages)
SIG = ("SIGNAL 1 (date: Jan 5 , 2026)\n\nBUY ZONE:   2652 - 2650\nSTOPLOSS:          2644 (60pips - 80pips)\n"
       "TAKE PROFIT:  2658 - 2666 - 2674 - open\n\nSIGNAL 2 (date: Jan 5 , 2026)\n\nSELL ZONE :     2671 - 2673 (retest)\n"
       "STOPLOSS:            2678 (50pips - 70pips)\nTAKE PROFIT:  2666 - 2659 - 2650\n\nOne more paragraph.")
MG = ("SIGNAL  1 MANAGEMENT\n\nREACHED TP1\nclose bad entries 2652 -2651\nmove stoploss 2650\nKeep the remaining 2650 position running\n\n"
      "Entry 2650 → 2660 = +100 Pips\nEntry 2651 → 2660 = +90 Pips")
class T(unittest.TestCase):
    def test_signals(self):
        s = g.parse(SIG)
        self.assertEqual([(x['label'], x['direction'], x['lo'], x['hi'], x['sl'], x['tps'], x['open_tp']) for x in s],
                         [(1, 'buy', 2650.0, 2652.0, 2644.0, [2658.0, 2666.0, 2674.0], True), (2, 'sell', 2671.0, 2673.0, 2678.0, [2666.0, 2659.0, 2650.0], False)])
    def test_management(self):
        e = g.parse(MG)[0]
        self.assertEqual((e['type'], e['label'], e['status'], e['close_levels'], e['move_sl'], e['keep_level']), ('management', 1, 'tp1', [2652.0, 2651.0], 2650.0, 2650.0))
        self.assertEqual(e['perf'], [(2650.0, 2660.0, 100), (2651.0, 2660.0, 90)])
    def test_hit_and_other(self):
        self.assertEqual(g.parse('HIT ENTRY SELL')[0], dict(type='entry_hit', direction='sell'))
        self.assertEqual(g.parse('Good morning everyone, ready for London?')[0]['type'], 'other')
        self.assertEqual(g.parse('This signal has returned to breakeven, guys.')[0]['type'], 'breakeven')
    def test_recap(self):
        e = g.parse('BUY 2650 → 2686: +360 pips at the time of this update! The SELL at 2673 also saw a gain of +60 pips')[0]
        self.assertEqual(e['claims'], [('buy', 2650.0, 2686.0, 360), ('sell', 2673.0, None, 60)])
    def test_other_typo_rule(self):
        s, err = po.parse('XAUUSD BUY NOW 2652 4650\nTP¹ 2656\nTP² 2660\nTP.  Open\n\nSL 2644')
        self.assertIsNone(err); self.assertEqual((s['lo'], s['hi']), (2650.0, 2652.0)); self.assertTrue(any('typo' in i for i in s['info']))
        self.assertEqual(po.parse('XAUUSD BUY NOW 2652 4750\nTP¹ 2656\nSL 2644')[1], 'zone_typo_unresolved')
    def test_other_entry_format(self):
        s, err = po.parse('SELL GOLD NOW!!!\n\nENTRY: 2655\nTP1: 2651\nTP2: 2647\nSL: 2665')
        self.assertEqual((s['direction'], s['lo'], s['sl'], s['tps']), ('sell', 2655.0, 2665.0, [2651.0, 2647.0]))
        self.assertIsNone(po.parse('#XAUUSD SELL\n\nTP3 HIT 150+PIPS PROFIT')[0])
if __name__ == '__main__':
    unittest.main()

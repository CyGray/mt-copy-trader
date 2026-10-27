import json, os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import load_tdesktop_export as L

def fixture(**over):
    d = dict(name='X', type='private_channel', id=2371904451, messages=[
        dict(id=1, type='service', date='2026-10-26T14:00:00', date_unixtime='1793023200', action='pin_message'),
        dict(id=2, type='message', date='2026-10-26T14:53:08', date_unixtime='1793022788', edited='x',
             edited_unixtime='1793024403', text=['SIGNAL 2\nSELL ZONE: 2671 - 2673\nSTOPLOSS: ', dict(type='bold', text='2678'),
                                                 '\nTAKE PROFIT: 2666 - 2659']),
        dict(id=4, type='message', date_unixtime='1793030000', text='hello', photo='(File not included)')])
    d.update(over); return d

class T(unittest.TestCase):
    def run_load(self, d, peer='-1002371904451'):
        p = tempfile.mktemp(suffix='.json'); json.dump(d, open(p, 'w')); return L.load(p, peer)
    def test_ok(self):
        rows, errs, st = self.run_load(fixture())
        self.assertEqual(errs, []); self.assertEqual(st['messages'], 2); self.assertEqual(st['id_gaps'], 1)
        r = rows[0]; self.assertEqual(r['date'], '2026-10-26T13:53:08.000Z'); self.assertEqual(r['type'], 'edit')
        self.assertIn('STOPLOSS: 2678', r['text']); self.assertTrue(rows[1]['has_media'])
    def test_wrong_channel(self):
        self.assertTrue(self.run_load(fixture(id=3740937489))[1])
    def test_local_time_only_rejected(self):
        d = fixture(); del d['messages'][1]['date_unixtime']
        self.assertTrue(any('date_unixtime' in e for e in self.run_load(d)[1]))
    def test_feeds_parser(self):
        import parser_multi as pm
        rows, _, _ = self.run_load(fixture())
        s, e = pm.parse_message(rows[0]['text']); self.assertEqual(len(s), 1); self.assertEqual(s[0]['stopLoss'], 2678.0)

if __name__ == '__main__':
    unittest.main()

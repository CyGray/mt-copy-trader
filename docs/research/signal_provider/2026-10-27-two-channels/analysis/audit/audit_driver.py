"""Driver: parse, simulate, and compare the auditor's results with the pilot and universe outputs.

Only the auditor's own modules are imported (bi5_audit, audit_sim, the parser in audit_parse). The pilot
and universe files are read as results to compare against; their code is not read.
"""
import csv
import json
import sys
from fractions import Fraction as Fr

sys.path.insert(0, '/tmp/claude-1001/twochan/audit')
import bi5_audit as B  # noqa: E402
import audit_parse as P  # noqa: E402
import audit_sim as S  # noqa: E402

AUD = '/tmp/claude-1001/twochan/audit'
UNIV = '/tmp/claude-1001/twochan/universe/lucas'
PILOT = '/tmp/claude-1001/twochan/pilot'

TOL_R = 1e-6
results_log = {}


def fnum(x):
    if x is None or x == '':
        return None
    return float(x)


class Cmp:
    """Collects every comparison so the report can state counts and list mismatches."""

    def __init__(self, name):
        self.name = name
        self.rows = []          # (key, field, pilot, auditor, ok)

    def add(self, key, field, pilot, auditor, ok):
        self.rows.append((key, field, pilot, auditor, bool(ok)))

    def eq(self, key, field, pilot, auditor):
        self.add(key, field, pilot, auditor, str(pilot) == str(auditor))

    def num(self, key, field, pilot, auditor, tol):
        if pilot in (None, '') and auditor in (None, ''):
            self.add(key, field, pilot, auditor, True)
            return
        if pilot in (None, '') or auditor in (None, ''):
            self.add(key, field, pilot, auditor, False)
            return
        self.add(key, field, pilot, auditor, abs(float(pilot) - float(auditor)) <= tol)

    def summary(self):
        n = len(self.rows)
        bad = [r for r in self.rows if not r[4]]
        return n, len(bad), bad

    def write(self, path):
        with open(path, 'w', newline='') as fh:
            w = csv.writer(fh)
            w.writerow(['key', 'field', 'pilot_or_universe', 'auditor', 'match'])
            for r in self.rows:
                w.writerow([r[0], r[1], r[2], r[3], 'Y' if r[4] else 'N'])


def msg_id(label):
    # universe / pilot message_id = source message id * 100 + signal label (23218 * 100 + 3 = 2321803)
    return str(int(P.SRC_MSG) * 100 + int(label))


def load_csv(path):
    with open(path, newline='') as fh:
        return list(csv.DictReader(fh))


def main():
    ticks = B.Ticks(B.ms_utc(2026, 10, 26, 0), B.ms_utc(2026, 10, 27, 2, 0))
    results_log['tick_count'] = len(ticks.t)
    results_log['known_until'] = B.fmt_utc_full(ticks.known_until)
    results_log['sorted_violations'] = ticks.check_sorted()
    results_log['hour_status'] = {B.fmt_utc_full(h)[:13]: v[0] for h, v in ticks.hour_status.items()
                                  if v[0] != 'ok'}
    sim = S.Sim(ticks)

    revs, final_rev, first_rev = P.load_signal_revisions()
    results_log['n_revisions'] = len(revs)
    results_log['final_edit_date'] = final_rev['edit_date']
    results_log['first_revision_timestamp'] = first_rev['timestamp']
    sig_final = {s['label']: s for s in P.parse_text(final_rev['text'])}
    sig_first = {s['label']: s for s in P.parse_text(first_rev['text'])}
    t_final = P.iso_ms(final_rev['date'])
    t_first = P.iso_ms(first_rev['timestamp'])
    # the same message parsed both ways: hard/info flags per universe
    flags = {}
    for uni, sigs in (('final', sig_final), ('first', sig_first)):
        for lbl, s in sigs.items():
            flags[(uni, lbl)] = P.hard_and_info_flags(s)

    out = {}

    # ------------------------------------------------------------ (1) universe comparison
    for uni, sigs, tsig in (('final', sig_final, t_final), ('first', sig_first, t_first)):
        cmp = Cmp(f'universe_{uni}')
        rows = load_csv(f'{UNIV}/universe_{uni}.csv')
        cmp.eq('count', 'rows', len(rows), len(sigs))
        for r in rows:
            lbl = r['signal_label']
            s = sigs[lbl]
            k = r['message_id']
            hard, info = flags[(uni, lbl)]
            cmp.eq(k, 'signal_label', r['signal_label'], lbl)
            cmp.eq(k, 'direction', r['direction'], s['direction'])
            cmp.eq(k, 't_ms', r['t_ms'], tsig)
            cmp.num(k, 'entry_low', r['entry_low'], s['lo'] / 1000, 1e-9)
            cmp.num(k, 'entry_high', r['entry_high'], s['hi'] / 1000, 1e-9)
            cmp.num(k, 'entry_mid', r['entry_mid'], float(s['mid']) / 1000, 1e-9)
            cmp.num(k, 'sl', r['sl'], s['sl'] / 1000, 1e-9)
            for i in range(1, 4):
                tp = s['tps'][i - 1] / 1000 if i <= len(s['tps']) else None
                cmp.num(k, f'tp{i}', r[f'tp{i}'] or None, tp, 1e-9)
            cmp.num(k, 'num_tps', r['num_tps'], len(s['tps']), 0)
            cmp.num(k, 'sl_dist', r['sl_dist'], abs(float(s['mid']) - s['sl']) / 1000, 1e-9)
            cmp.eq(k, 'hard_flags', r['hard_flags'], ';'.join(hard))
            cmp.eq(k, 'info_flags', r['info_flags'], ';'.join(info))
            cmp.num(k, 'in_clean', r['in_clean'], 1 if not hard else 0, 0)
        out[f'universe_{uni}'] = cmp
    # message-level facts used by the universe rows
    dt_edit = P.iso_ms(final_rev['edit_date']) - t_final
    lag = (t_first - t_final) / 1000
    results_log['edit_delay_s'] = dt_edit / 1000
    results_log['first_obs_lag_s'] = round(lag, 1)
    results_log['levels_changed_first_vs_final'] = {
        lbl: sum(1 for a, b in [(sig_first[lbl]['lo'], sig_final[lbl]['lo']), (sig_first[lbl]['hi'], sig_final[lbl]['hi']),
                                (sig_first[lbl]['sl'], sig_final[lbl]['sl'])] if a != b) +
        sum(1 for a, b in zip(sig_first[lbl]['tps'], sig_final[lbl]['tps']) if a != b)
        for lbl in sig_final}

    # ------------------------------------------------------------ (2) fills and (3) trades
    fills_all = {}
    trades_all = {}
    for uni, sigs, tsig in (('final', sig_final, t_final), ('first', sig_first, t_first)):
        for lbl, s in sigs.items():
            f, tr = S.run_signal(sim, s, tsig)
            fills_all[(uni, lbl)] = f
            trades_all[(uni, lbl)] = tr

    # pilot fill comparisons
    for uni in ('final', 'first'):
        cmp = Cmp(f'fills_{uni}')
        sigs = sig_final if uni == 'final' else sig_first
        rows = load_csv(f'{PILOT}/out_{uni}/lucas_fills.csv')
        cmp.eq('count', 'rows', len(rows), 18)
        for r in rows:
            lbl = r['message_id'][-1]
            k = (uni, lbl)
            key = f"{r['message_id']}|{r['entry']}|{r['cost']}"
            a = fills_all[k][(r['entry'], r['cost'])]
            cmp.eq(key, 'status', r['status'], a['status'])
            cmp.eq(key, 'reason', r['reason'], a['reason'])
            cmp.eq(key, 'kind', r['kind'], a['kind'])
            cmp.eq(key, 'fill_ms', r['fill_ms'], '' if a['fill_ms'] is None else a['fill_ms'])
            cmp.num(key, 'fill_px', r['fill_px'], None if a['fill_px'] is None else a['fill_px'] / 1000, 1e-9)
            cmp.num(key, 'R_usd', r['R_usd'], None if a['fill_px'] is None else abs(a['fill_px'] - sigs[lbl]['sl']) / 1000, 1e-9)
            cmp.num(key, 'nominal_R', r['nominal_R'], abs(float(sigs[lbl]['mid']) - sigs[lbl]['sl']) / 1000, 1e-9)
            cmp.num(key, 'sl_dist_signal', r['sl_dist_signal'], abs(float(sigs[lbl]['mid']) - sigs[lbl]['sl']) / 1000, 1e-9)
        out[f'fills_{uni}'] = cmp

    # pilot trade comparisons (final, first, posthoc)
    def trade_cmp(name, path, uni):
        cmp = Cmp(name)
        rows = load_csv(path)
        seen = set()
        for r in rows:
            lbl = r['message_id'][-1]
            k = (uni, lbl)
            key = f"{r['message_id']}|{r['entry']}|{r['cost']}|{r['variant']}"
            seen.add((r['entry'], r['cost'], r['variant'], lbl))
            a = trades_all[k].get((r['entry'], r['cost'], r['variant']))
            if a is None:
                cmp.add(key, 'row_present_in_auditor', 'present', 'absent', False)
                continue
            cmp.eq(key, 'status', r['status'], a['status'])
            cmp.eq(key, 'reason', r['reason'], a['reason'])
            cmp.num(key, 'fill_px', r['fill_px'], a['fill_px'] / 1000, 1e-9)
            cmp.num(key, 'R_usd', r['R_usd'], a['R_usd'], 1e-9)
            cmp.eq(key, 'kind', r['kind'], fills_all[k][(r['entry'], r['cost'])]['kind'])
            cmp.eq(key, 'fill_ms', r['fill_ms'], a['fill_ms'])
            cmp.eq(key, 'tp_ks(executed)', r['tp_ks'], a['tp_exec'])
            cmp.eq(key, 'flags', r['flags'], a['flags'])
            cmp.num(key, 'total_R', r['total_R'], a['total_R'], TOL_R)
            cmp.num(key, 'usd_per_1lot', r['usd_per_1lot'], a['usd_per_1lot'], 1e-6)
            cmp.eq(key, 'last_exit_ms', r['last_exit_ms'], '' if a['last_exit_ms'] is None else a['last_exit_ms'])
            cmp.eq(key, 'final_exit', r['final_exit'], a['final_exit'] or '')
            cmp.eq(key, 'exit_seq', r['exit_seq'], a['exit_seq'] or '')
        # auditor FILLED rows that the pilot does not list
        allowed = {n for n, _, _ in S.STRATS} if 'posthoc' in path else {n for n, _, _ in S.STRATS if not n.startswith('D13')}
        for lbl2 in sigs_for(uni):
            for (ent, cost, name), a in trades_all[(uni, lbl2)].items():
                if name not in allowed:
                    continue
                if (ent, cost, name, lbl2) not in seen and a['status'] != 'NO_PRICE_DATA':
                    cmp.add(f'{msg_id(lbl2)}|{ent}|{cost}|{name}', 'row_missing_in_pilot', 'absent', a['status'], False)
        return cmp

    def sigs_for(uni):
        return sig_final.keys() if uni == 'final' else sig_first.keys()

    out['trades_final'] = trade_cmp('trades_final', f'{PILOT}/out_final/lucas_trades.csv', 'final')
    out['trades_first'] = trade_cmp('trades_first', f'{PILOT}/out_first/lucas_trades.csv', 'first')
    out['trades_posthoc'] = trade_cmp('trades_posthoc', f'{PILOT}/posthoc/lucas_trades.csv', 'final')

    # summary JSON: fills, results, touch
    for uni in ('final', 'first'):
        cmp = Cmp(f'summary_{uni}')
        summ = json.load(open(f'{PILOT}/out_{uni}/lucas_summary.json'))
        sigs = sig_final if uni == 'final' else sig_first
        tsig = t_final if uni == 'final' else t_first
        cmp.eq('summary', 'n_signals', summ['n_signals'], len(sigs))
        for key, val in summ['fills'].items():
            msg, ent, cost = key.split('|')
            a = fills_all[(uni, msg[-1])][(ent, cost)]
            cmp.eq(key, 'fills.status', val[0], a['status'])
            cmp.eq(key, 'fills.reason', val[1], a['reason'])
            cmp.num(key, 'fills.fill_px', val[2] if val[2] != '' else None,
                    None if a['fill_px'] is None else a['fill_px'] / 1000, 1e-9)
            cmp.eq(key, 'fills.kind', val[3], a['kind'])
        # results: n, mean_R (3 dp), per-signal status/exit/total_R, bootstrap CI (3 dp, seed 12345)
        for r in summ['results']:
            key = f"{r['entry']}|{r['cost']}|{r['variant']}"
            rows_ok = []
            ps = {}
            for lbl, s in sigs.items():
                a = trades_all[(uni, lbl)].get((r['entry'], r['cost'], r['variant']))
                if a is not None:
                    if a['status'] == 'FILLED':
                        rows_ok.append(a['total_R'])
                    ps[msg_id(lbl)] = [a['status'], a['final_exit'] or '', a['total_R'] if a['total_R'] is not None else '']
            n = len(rows_ok)
            cmp.eq(key, 'results.n', r['n'], n)
            mean = (sum(rows_ok) / n) if n else None
            cmp.num(key, 'results.mean_R(3dp)', r['mean_R'], None if mean is None else round(mean, 3), 0.0006)
            lo, hi = S_boot(rows_ok)
            cmp.num(key, 'results.ci_lo(3dp)', r['ci_lo'], None if lo is None else round(lo, 3), 0.0015)
            cmp.num(key, 'results.ci_hi(3dp)', r['ci_hi'], None if hi is None else round(hi, 3), 0.0015)
            for msg, v in r['per_signal'].items():
                if msg not in ps:
                    cmp.add(key, f'per_signal.{msg}', v, 'absent', False)
                    continue
                cmp.eq(key, f'per_signal.{msg}.status', v[0], ps[msg][0])
                cmp.eq(key, f'per_signal.{msg}.final_exit', v[1], ps[msg][1])
                cmp.num(key, f'per_signal.{msg}.total_R', v[2], ps[msg][2], TOL_R)
        # touch table (min / minutes from each universe's own signal time)
        for tch in summ['touch']:
            lbl = tch['message_id'][-1]
            s = sigs[lbl]
            key = f"touch|{tch['message_id']}"
            tuni = touch_facts(ticks, s, tsig)
            cmp.num(key, 'known_until_h', tch['known_until_h'], tuni['known_until_h'], 0.006)
            cmp.eq(key, 'n_ticks', tch['n_ticks'], tuni['n_ticks'])
            cmp.num(key, 'min_bid_6h', tch['min_bid_6h'], tuni['min_bid_6h'], 1e-9)
            cmp.num(key, 'max_ask_6h', tch['max_ask_6h'], tuni['max_ask_6h'], 1e-9)
            cmp.num(key, 'entry_zone_min', tch['entry_zone_min'], tuni['entry_zone_min'], 1e-4)
            cmp.num(key, 'stop_min', tch['stop_min'], tuni['stop_min'], 1e-4)
            cmp.num(key, 'tp1_min', tch['tp1_min'], tuni['tp1_min'], 1e-4)
            cmp.num(key, 'tp2_min', tch['tp2_min'], tuni['tp2_min'], 1e-4)
            cmp.num(key, 'tp3_min', tch['tp3_min'], tuni['tp3_min'], 1e-4)
        out[f'summary_{uni}'] = cmp

    # write per-row comparison CSVs and the aggregate counts
    counts = {}
    for name, cmp in out.items():
        if cmp is None:
            continue
        cmp.write(f'{AUD}/cmp_{name}.csv')
        n, bad, _ = cmp.summary()
        counts[name] = {'rows_compared': n, 'mismatches': bad}
    # the universe comparison and the rest
    results_log['counts'] = counts
    results_log['touch_facts'] = {k: touch_facts(ticks, sig_final[k], t_final) for k in sig_final}
    results_log['first_touch_facts'] = {k: touch_facts(ticks, sig_first[k], t_first) for k in sig_first}
    json.dump(results_log, open(f'{AUD}/audit_counts.json', 'w'), indent=1, default=str)
    print(json.dumps({k: v for k, v in results_log.items() if k in ('tick_count', 'known_until', 'sorted_violations',
                                                                 'hour_status', 'edit_delay_s', 'first_obs_lag_s',
                                                                 'levels_changed_first_vs_final')},
                     indent=1, default=str))
    print(json.dumps(counts, indent=1))
    return out, fills_all, trades_all


def S_boot(vals):
    """Percentile bootstrap, 10,000 resamples, seed 12345 (as in the pilot spec). n<2: no CI."""
    import random
    if len(vals) < 2:
        return None, None
    rng = random.Random(12345)
    means = []
    for _ in range(10000):
        samp = [vals[rng.randrange(len(vals))] for _ in vals]
        means.append(sum(samp) / len(samp))
    means.sort()
    return means[249], means[9749]


def touch_facts(ticks, s, tsig):
    """Touch table as the pilot defines it (checked against the pilot values): first tick at or after the
    signal time meeting the level, in minutes from that signal time; 6 h window for the min/max."""
    import bisect
    n = len(ticks.t)
    i0 = bisect.bisect_left(ticks.t, tsig)
    buy = s['direction'] == 'buy'
    lo, hi, sl = s['lo'], s['hi'], s['sl']
    tps = s['tps']

    def first(pred):
        for j in range(i0, n):
            if ticks.t[j] >= ticks.known_until:
                return None
            if pred(j):
                return (ticks.t[j] - tsig) / 60000
        return None

    if buy:
        entry_zone = first(lambda j: ticks.ask[j] <= hi)
        stop = first(lambda j: ticks.bid[j] <= sl)
        tp = [first(lambda j, x=x: ticks.bid[j] >= x) for x in tps[:3]]
    else:
        entry_zone = first(lambda j: ticks.bid[j] >= lo)
        stop = first(lambda j: ticks.ask[j] >= sl)
        tp = [first(lambda j, x=x: ticks.ask[j] <= x) for x in tps[:3]]
    j6 = bisect.bisect_left(ticks.t, tsig + 6 * 3600000 + 1)
    win = range(i0, min(j6, n))
    res = {'known_until_h': (ticks.known_until - tsig) / 3600000,
           'n_ticks': sum(1 for j in range(i0, n) if ticks.t[j] < ticks.known_until),
           'min_bid_6h': min(ticks.bid[j] for j in win) / 1000,
           'max_ask_6h': max(ticks.ask[j] for j in win) / 1000,
           'entry_zone_min': entry_zone, 'stop_min': stop,
           'tp1_min': tp[0] if len(tp) > 0 else None, 'tp2_min': tp[1] if len(tp) > 1 else None,
           'tp3_min': tp[2] if len(tp) > 2 else None}
    return res


if __name__ == '__main__':
    main()

"""Message inventory and edit-revision statistics (aggregates only, no text).
usage: inventory_multi.py REVISIONS_JSON CHANNEL OUT_JSON"""
import collections, datetime as dt, json, os, statistics as st, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labels as L
rows = json.load(open(sys.argv[1])); ch = sys.argv[2].upper(); lab = getattr(L, ch)
ms = lambda s: dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()  # noqa: E731
by = collections.defaultdict(list)
for r in rows: by[int(r['message_id'])].append(r)
ids = sorted(by)
lags = [ms(r['edit_date']) - ms(r['date']) for r in rows if r.get('edit_date') and r['type'] == 'edit']
obs = [ms(r['timestamp']) - ms(r.get('edit_date') or r['date']) for r in rows if r.get('timestamp')]
out = dict(channel=ch, revisions=len(rows), messages=len(ids), first_id=ids[0], last_id=ids[-1],
           missing_ids_in_range=ids[-1] - ids[0] + 1 - len(ids),
           first_date=min(r['date'] for r in rows), last_date=max(r['date'] for r in rows),
           by_class=dict(collections.Counter(lab[i] for i in ids)),
           messages_with_edits=sum(1 for i in ids if len(by[i]) > 1),
           first_seen_as_edit=sum(1 for i in ids if sorted(by[i], key=lambda r: r.get('timestamp') or '')[0]['type'] == 'edit'),
           edit_lag_s_median=round(st.median(lags), 1) if lags else None, edit_lag_s_max=round(max(lags), 1) if lags else None,
           observe_delay_s_median=round(st.median(obs), 1) if obs else None, observe_delay_s_p90=round(sorted(obs)[int(0.9 * (len(obs) - 1))], 1) if obs else None,
           with_media=sum(1 for i in ids if any(r.get('has_media') for r in by[i])), replies=sum(1 for i in ids if by[i][0].get('reply_to')),
           forwards=sum(1 for i in ids if any(r.get('is_forward') or (r.get('text') or '').startswith('Forwarded from') for r in by[i])))
json.dump(out, open(sys.argv[3], 'w'), indent=1); print(json.dumps(out))

"""Validate and convert a Telegram Desktop "Export chat history" JSON (result.json) into the revisions format.
usage: load_tdesktop_export.py RESULT_JSON EXPECTED_PEER_ID OUT_JSON
Telegram Desktop -> channel -> ... -> Export chat history -> format "Machine-readable JSON", media unticked.
Required per message: id, type, date_unixtime (UTC epoch; the plain "date" field is in the exporting PC's
local time and is NOT used), text (string or list of strings / {type,text} entities). Optional: edited_unixtime,
reply_to_message_id, photo/file/media_type, forwarded_from.
Limits (stated in every report that uses it): an export holds only the FINAL text of each message, so first-seen
levels and the edit history are Unknown; edited_unixtime gives only the last edit time.
Exit 2 on a validation failure (wrong channel, missing fields, local-time-only dates)."""
import datetime as dt, json, sys

def iso(sec):
    return dt.datetime.fromtimestamp(int(sec), dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

def flat(t):
    if isinstance(t, str): return t
    return ''.join(x if isinstance(x, str) else str(x.get('text', '')) for x in (t or []))

def load(path, peer):
    d = json.load(open(path, encoding='utf-8'))
    errs = []
    if str(d.get('id')) not in (str(peer), str(peer).replace('-100', '', 1)):
        errs.append(f"export id {d.get('id')!r} does not match expected peer {peer}")
    msgs = d.get('messages')
    if not isinstance(msgs, list) or not msgs:
        errs.append('no messages array'); return None, errs, {}
    rows, svc, no_utc = [], 0, 0
    for m in msgs:
        if m.get('type') != 'message':
            svc += 1; continue
        if 'date_unixtime' not in m:
            no_utc += 1; continue
        ed = m.get('edited_unixtime')
        rows.append(dict(doc_id=f"export_{m['id']}", chat_id=f"-100{str(peer).replace('-100', '', 1)}",
                         message_id=str(m['id']), hash=None, type='edit' if ed else 'new', text=flat(m.get('text')),
                         date=iso(m['date_unixtime']), edit_date=iso(ed) if ed else None, timestamp=None,
                         reply_to=m.get('reply_to_message_id'),
                         has_media=bool(m.get('photo') or m.get('file') or m.get('media_type')),
                         is_forward=bool(m.get('forwarded_from')), grouped_id=None, source='tdesktop_export'))
    if no_utc:
        errs.append(f'{no_utc} messages lack date_unixtime (update Telegram Desktop; local-time dates are not used)')
    ids = sorted(int(r['message_id']) for r in rows)
    stats = dict(messages=len(rows), service_messages=svc, first_id=ids[0] if ids else None,
                 last_id=ids[-1] if ids else None, id_gaps=(ids[-1] - ids[0] + 1 - len(ids)) if ids else 0,
                 first_date=min((r['date'] for r in rows), default=None), last_date=max((r['date'] for r in rows), default=None),
                 edited=sum(1 for r in rows if r['edit_date']), with_text=sum(1 for r in rows if r['text'].strip()))
    return rows, errs, stats

if __name__ == '__main__':
    rows, errs, stats = load(sys.argv[1], sys.argv[2])
    print(json.dumps(dict(stats, errors=errs), indent=1))
    if errs: sys.exit(2)
    json.dump(rows, open(sys.argv[3], 'w'))

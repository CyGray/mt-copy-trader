"""Export one chat's telegram_messages revisions from the Go forwarder's SQLite store, READ-ONLY.
usage: export_go_store.py CHAT_ID_BOTAPI OUT_JSON [--db /home/kyle/services/bytrader-go/state/state.sqlite]
Opens the database with mode=ro (no writes, no locks taken for writing). Output: the revisions format read by
oos2/build_multi.py (doc_id, chat_id, message_id, hash, type, text, date, edit_date, timestamp, reply_to,
has_media, is_forward, grouped_id). The output holds raw message text: keep it outside the repo."""
import json, sqlite3, sys
chat, out = sys.argv[1], sys.argv[2]
db = sys.argv[sys.argv.index('--db') + 1] if '--db' in sys.argv else '/home/kyle/services/bytrader-go/state/state.sqlite'
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
rows = []
for did, body in c.execute("select id, body from documents where collection='telegram_messages' and chat_id=?", (chat,)):
    r = json.loads(body); dbg = r.get('debug') or {}
    rows.append(dict(doc_id=did, chat_id=r['chat_id'], message_id=str(r['message_id']), hash=r.get('hash'),
                     type=r.get('type'), text=r.get('text') or '', date=r.get('date'), edit_date=r.get('edit_date'),
                     timestamp=r.get('timestamp'), reply_to=dbg.get('reply_to_msg_id'), has_media=dbg.get('has_media'),
                     is_forward=dbg.get('is_forward'), grouped_id=dbg.get('grouped_id')))
json.dump(rows, open(out, 'w'))
ids = sorted({int(r['message_id']) for r in rows})
print(json.dumps(dict(chat=chat, revisions=len(rows), messages=len(ids), first_id=ids[0] if ids else None,
                      last_id=ids[-1] if ids else None, first_date=min((r['date'] for r in rows), default=None),
                      last_date=max((r['date'] for r in rows), default=None))))

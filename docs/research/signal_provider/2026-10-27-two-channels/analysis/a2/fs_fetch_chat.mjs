// READ ONLY: fetch up to LIMIT telegram_messages docs of one chat by document-id prefix (budgeted).
// usage: node fs_fetch_chat.mjs CHAT LIMIT OUT_JSON [START_AFTER_DOC_ID]
import { writeFileSync } from 'node:fs';
import { db, FieldPath } from './fs_init.mjs';
import { reserve, settle, fail, totals } from './budget.mjs';
const [chat, lim, out, after] = process.argv.slice(2);
const limit = Number(lim);
const L = `fetch ${chat} limit ${limit}`;
const r = reserve(L, limit, 'prefix range read');
try {
  let q = db.collection('telegram_messages').orderBy(FieldPath.documentId()).startAt(after ?? `${chat}_`).endBefore(`${chat}_`);
  if (after) q = db.collection('telegram_messages').orderBy(FieldPath.documentId()).startAfter(after).endBefore(`${chat}_`);
  const snap = await q.select('chat_id', 'message_id', 'hash', 'type', 'text', 'date', 'edit_date', 'timestamp').limit(limit).get();
  settle(L, r, Math.max(1, snap.size), `docs=${snap.size}`);
  writeFileSync(out, JSON.stringify(snap.docs.map((d) => ({ doc_id: d.id, ...d.data() }))));
  console.log(chat, 'docs', snap.size, 'budget', JSON.stringify(totals()));
} catch (e) { fail(L, r, e); console.log('FAILED', e.code, String(e.details ?? e.message).slice(0, 120)); }
process.exit(0);

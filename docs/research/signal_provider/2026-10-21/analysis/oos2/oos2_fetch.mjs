// Revision fetch: telegram_messages revisions for the provider channel by document-id range.
// usage: node oos2_fetch.mjs FIRST_ID LAST_ID_EXCL OUT_JSON   (OOS2 used 3660 4100)
// READ ONLY (count + one ordered range query). Uses the read-budget ledger (a2/budget.mjs).
// Doc ids are `${chatId}_${messageId}_${hash}`; the lexical range is exact only if every id in it has the same
// number of digits (true for 3660..4099). Split the range at a digit boundary otherwise.
import { writeFileSync } from 'node:fs';
import { db, CHANNEL_BOT, FieldPath } from '../a2/fs_init.mjs';
import { reserve, settle, fail, totals } from '../a2/budget.mjs';
const [FIRST, LAST_EXCL, OUT] = process.argv.slice(2);
if (!FIRST || !LAST_EXCL || !OUT || FIRST.length !== LAST_EXCL.length) {
  console.error('usage: node oos2_fetch.mjs FIRST_ID LAST_ID_EXCL OUT_JSON (same digit count)');
  process.exit(64);
}
const START = `${CHANNEL_BOT}_${FIRST}`;
const END = `${CHANNEL_BOT}_${LAST_EXCL}`;
const MAX_DOCS = 1500;
const col = db.collection('telegram_messages');
const range = () => col.orderBy(FieldPath.documentId()).startAt(START).endBefore(END);

let L = 'oos2 count doc-id range';
let r = reserve(L, 2, 'count()');
let n;
try { n = (await range().count().get()).data().count; settle(L, r, Math.max(1, Math.ceil(n / 1000)), `count=${n}`); }
catch (e) { fail(L, r, e); console.log('COUNT FAILED', e.code, String(e.details ?? e.message).slice(0, 120)); process.exit(1); }
console.log('docs in range:', n);
if (n > MAX_DOCS) { console.log('too many docs, abort'); process.exit(2); }

L = 'oos2 read doc-id range';
r = reserve(L, n, `range read ${n} docs`);
let snap;
try {
  snap = await range().select('chat_id', 'message_id', 'hash', 'type', 'text', 'date', 'edit_date', 'parsed_ok', 'parsed', 'parse_error', 'timestamp').limit(MAX_DOCS).get();
  settle(L, r, snap.size, `docs=${snap.size}`);
} catch (e) { fail(L, r, e); console.log('READ FAILED', e.code, String(e.details ?? e.message).slice(0, 120)); process.exit(1); }
const rows = snap.docs.map((d) => ({ doc_id: d.id, ...d.data() }));
writeFileSync(OUT, JSON.stringify(rows));
console.log('revisions saved:', rows.length, 'budget:', JSON.stringify(totals()));
process.exit(0);

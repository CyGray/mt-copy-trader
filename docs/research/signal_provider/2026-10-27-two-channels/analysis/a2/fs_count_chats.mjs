// READ ONLY: count telegram_messages docs per chat by document-id prefix range (count() only).
import { db, FieldPath } from './fs_init.mjs';
import { reserve, settle, fail, totals } from './budget.mjs';
const col = db.collection('telegram_messages');
for (const chat of process.argv.slice(2)) {
  const L = `count ${chat}`;
  const r = reserve(L, 2, 'count() prefix');
  try {
    const n = (await col.orderBy(FieldPath.documentId()).startAt(`${chat}_`).endBefore(`${chat}_`).count().get()).data().count;
    settle(L, r, Math.max(1, Math.ceil(n / 1000)), `count=${n}`);
    console.log(chat, n);
  } catch (e) { fail(L, r, e); console.log(chat, 'FAILED', e.code, String(e.details ?? e.message).slice(0, 120)); }
}
console.log('budget', JSON.stringify(totals()));
process.exit(0);

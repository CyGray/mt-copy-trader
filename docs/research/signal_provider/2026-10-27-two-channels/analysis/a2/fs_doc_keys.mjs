// READ ONLY: print field names (and post/from flags only) of the first doc of each chat. 1 read per chat.
import { db, FieldPath } from './fs_init.mjs';
import { reserve, settle } from './budget.mjs';
for (const chat of process.argv.slice(2)) {
  const r = reserve(`keys ${chat}`, 1, 'limit 1');
  const s = await db.collection('telegram_messages').orderBy(FieldPath.documentId()).startAt(`${chat}_`).endBefore(`${chat}_`).limit(1).get();
  settle(`keys ${chat}`, r, 1);
  const d = s.docs[0]?.data() ?? {}; const raw = typeof d.raw_message === 'string' ? JSON.parse(d.raw_message) : (d.raw_message ?? {});
  const dbg = d.debug ?? {};
  console.log(chat, Object.keys(d).sort().join(','), '| raw post', raw.post ?? raw.Post, 'fromId', JSON.stringify(raw.fromId ?? raw.FromID ?? raw.from_id ?? null)?.slice(0, 40), '| debug', JSON.stringify({ is_post: dbg.is_post, post_author: dbg.post_author }));
}
process.exit(0);

require('dotenv').config({ path: '../.env.local' });
require('dotenv').config({ path: '../web/.env.local' });
require('dotenv').config();
const admin = require('firebase-admin');

function initAdmin() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firestore admin credentials in environment.');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }

  return admin.firestore();
}

function classifyId(id) {
  if (/^-100\d+$/.test(id)) return 'channel/supergroup (-100...)';
  if (/^-\d+$/.test(id)) return 'group (-...)';
  if (/^\d+$/.test(id)) return 'user (+...)';
  return 'unknown';
}

function expandVariants(id) {
  const variants = new Set([id]);
  if (/^\d+$/.test(id)) {
    variants.add(`-100${id}`);
    variants.add(`-${id}`);
  }
  return Array.from(variants);
}

async function run() {
  const db = initAdmin();
  const snap = await db.collection('settings').doc('default').get();
  const data = snap.data() || {};
  const telegram = data.telegram || {};
  const allowed = Array.isArray(telegram.allowed_chat_ids) ? telegram.allowed_chat_ids : [];
  const blocked = Array.isArray(telegram.blocked_chat_ids) ? telegram.blocked_chat_ids : [];
  const labels = telegram.chat_id_labels || {};

  console.log('settings/default.telegram.allowed_chat_ids:', allowed);
  console.log('settings/default.telegram.blocked_chat_ids:', blocked);
  console.log('settings/default.telegram.chat_id_labels:', labels);
  console.log('classification:');
  for (const id of allowed) {
    const asString = String(id).trim();
    console.log(`  ${asString} (type: ${typeof id}) -> ${classifyId(asString)}`);
    console.log(`    variants: ${expandVariants(asString).join(', ')}`);
  }

  if (blocked.length) {
    console.log('blocked classification:');
    for (const id of blocked) {
      const asString = String(id).trim();
      console.log(`  ${asString} (type: ${typeof id}) -> ${classifyId(asString)}`);
      console.log(`    variants: ${expandVariants(asString).join(', ')}`);
    }
  }
}

run().catch((err) => {
  console.error('Failed to inspect settings:', err.message);
  process.exit(1);
});

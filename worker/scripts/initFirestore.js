require('dotenv').config({ path: '../.env.local' });
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

async function ensureBaseCollections() {
  const db = initAdmin();
  const settingsRef = db.collection('settings').doc('default');
  const settingsSnap = await settingsRef.get();

  if (!settingsSnap.exists) {
    await settingsRef.set({
      created_at: new Date().toISOString(),
      trading: {},
      notifications: {},
      telegram: {},
    });
  }

  await db.collection('system_logs').add({
    timestamp: new Date().toISOString(),
    level: 'info',
    component: 'worker',
    message: 'firestore_initialized',
    details: { settings_created: !settingsSnap.exists },
  });
}

ensureBaseCollections()
  .then(() => {
    console.log('Firestore base collections initialized.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Failed to initialize Firestore:', err.message);
    process.exit(1);
  });

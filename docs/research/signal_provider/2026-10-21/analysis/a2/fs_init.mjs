// Shared read-only bootstrap for research scripts. Loads ONLY .env.local (as the forwarder does when cwd=worker/)
// and reuses the repo's initFirestore(). Never prints env values. Scripts built on it must only read.
// Run with Node 24 (TypeScript type stripping) so firestoreAdmin.ts can be imported without compiling worker/dist.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.BYTRADER_REPO ?? resolve(HERE, '../../../../../..');
const require = createRequire(REPO + '/package.json');
const dotenv = require('dotenv');
dotenv.config({ path: REPO + '/.env.local', quiet: true });
const mod = await import(pathToFileURL(REPO + '/worker/src/lib/firestoreAdmin.ts').href);
export const db = mod.initFirestore();
if (!db) {
  console.error('initFirestore returned null');
  process.exit(3);
}
// Provider channel ids (Bot-API form and peer form). Change for another provider.
export const CHANNEL_BOT = process.env.SP_CHANNEL_BOT ?? '-1003271337051';
export const CHANNEL_PEER = process.env.SP_CHANNEL_PEER ?? '3271337051';
export const FieldPath = require('firebase-admin/firestore').FieldPath;

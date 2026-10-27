/**
 * Firestore security rules (../../firestore.rules) against the local emulator.
 * Run with ./run.sh (starts the emulator for project demo-bytrader).
 *
 * Access model under test:
 *  - every client write is denied, for every collection, for every user
 *  - reads need a verified email AND users/{uid} with role 'admin' or 'viewer'
 *  - a user may read only their own users/{uid}
 *  - anything not listed (for example autotrader_state) is denied
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const DATA_COLLECTIONS = [
  'settings',
  'trade_sets',
  'trade_events',
  'signal_events',
  'system_logs',
  'telegram_messages',
  'signal_forwards',
  'execution_profiles',
  'execution_profile_audit',
  'admin_commands',
  'admin_audit',
  'paper_broker',
  'alerts',
  'service_status',
];

let env: RulesTestEnvironment;


const users = {
  admin: { uid: 'u-admin', token: { email: 'admin@example.com', email_verified: true } },
  viewer: { uid: 'u-viewer', token: { email: 'viewer@example.com', email_verified: true } },
  revoked: { uid: 'u-revoked', token: { email: 'gone@example.com', email_verified: true } },
  noDoc: { uid: 'u-nodoc', token: { email: 'random@gmail.example', email_verified: true } },
  unverified: { uid: 'u-unverified', token: { email: 'viewer2@example.com', email_verified: false } },
};

function db(who: keyof typeof users) {
  const u = users[who];
  return env.authenticatedContext(u.uid, u.token).firestore();
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-bytrader',
    firestore: {
      rules: readFileSync(path.resolve(__dirname, '../../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore();
    await setDoc(doc(admin, 'users/u-admin'), { role: 'admin', email: 'admin@example.com' });
    await setDoc(doc(admin, 'users/u-viewer'), { role: 'viewer', email: 'viewer@example.com' });
    await setDoc(doc(admin, 'users/u-revoked'), { role: 'revoked', email: 'gone@example.com' });
    await setDoc(doc(admin, 'users/u-unverified'), { role: 'viewer', email: 'viewer2@example.com' });
    for (const name of DATA_COLLECTIONS) {
      await setDoc(doc(admin, `${name}/seed`), { ok: true });
    }
    await setDoc(doc(admin, 'autotrader_state/signal_feed'), { cursor: '2026-10-18T00:00:00.000Z' });
  });
});

describe('reads', () => {
  it('admins and viewers can read every dashboard collection', async () => {
    for (const who of ['admin', 'viewer'] as const) {
      for (const name of DATA_COLLECTIONS) {
        await assertSucceeds(getDoc(doc(db(who), `${name}/seed`)));
        await assertSucceeds(getDocs(collection(db(who), name)));
      }
    }
  });

  it('a signed-in account without a users document cannot read anything', async () => {
    for (const name of DATA_COLLECTIONS) {
      await assertFails(getDoc(doc(db('noDoc'), `${name}/seed`)));
    }
  });

  it('a revoked role cannot read anything', async () => {
    for (const name of DATA_COLLECTIONS) {
      await assertFails(getDoc(doc(db('revoked'), `${name}/seed`)));
    }
  });

  it('an unverified email cannot read, even with a users document', async () => {
    await assertFails(getDoc(doc(db('unverified'), 'trade_sets/seed')));
    await assertFails(getDoc(doc(db('unverified'), 'users/u-unverified')));
  });

  it('unauthenticated clients cannot read anything', async () => {
    const anon = env.unauthenticatedContext().firestore();
    for (const name of [...DATA_COLLECTIONS, 'users']) {
      await assertFails(getDoc(doc(anon, `${name}/seed`)));
    }
  });

  it('users can read only their own users document', async () => {
    await assertSucceeds(getDoc(doc(db('viewer'), 'users/u-viewer')));
    await assertFails(getDoc(doc(db('viewer'), 'users/u-admin')));
    await assertFails(getDocs(collection(db('admin'), 'users')));
  });

  it('worker-internal state is not readable by anyone', async () => {
    await assertFails(getDoc(doc(db('admin'), 'autotrader_state/signal_feed')));
    await assertFails(getDoc(doc(db('admin'), 'some_future_collection/x')));
  });
});

describe('writes', () => {
  it('no client may write any collection, not even an admin', async () => {
    for (const name of [...DATA_COLLECTIONS, 'autotrader_state']) {
      const d = db('admin');
      await assertFails(setDoc(doc(d, `${name}/new`), { x: 1 }));
      await assertFails(updateDoc(doc(d, `${name}/seed`), { x: 2 }));
      await assertFails(deleteDoc(doc(d, `${name}/seed`)));
    }
  });

  it('a user cannot create or promote their own users document', async () => {
    await assertFails(setDoc(doc(db('noDoc'), 'users/u-nodoc'), { role: 'viewer' }));
    await assertFails(updateDoc(doc(db('viewer'), 'users/u-viewer'), { role: 'admin' }));
  });

  it('the kill switch, mode and profiles cannot be changed from the client', async () => {
    await assertFails(setDoc(doc(db('admin'), 'settings/default'), { trading: { kill_switch: false } }, { merge: true }));
    await assertFails(setDoc(doc(db('admin'), 'admin_commands/x'), { type: 'close_all', confirm: 'CLOSE ALL' }));
    await assertFails(setDoc(doc(db('admin'), 'execution_profiles/x__v1'), { status: 'active' }));
    await assertFails(updateDoc(doc(db('admin'), 'alerts/seed'), { status: 'resolved' }));
  });
});

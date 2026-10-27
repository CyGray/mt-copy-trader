/**
 * Test harness for web API routes. Production routes call getAdminApp() from
 * '@/lib/firebaseAdmin'; each test file mocks that module to return
 * `harness.app`, an object with auth().verifyIdToken (backed by a token table)
 * and firestore() (the worker's in-memory fake). Nothing touches Firebase.
 */

import { NextRequest } from 'next/server';
import { createFakeFirestore, type FakeFirestore } from '@shared/testing/fakeFirestore';

export interface Claims {
  uid: string;
  email?: string;
  email_verified?: boolean;
}

/** Token → claims. 'revoked' and 'malformed' reject like Firebase; 'infra' rejects without an auth/ code. */
export const TOKENS: Record<string, Claims> = {
  admin: { uid: 'u-admin', email: 'admin@example.com', email_verified: true },
  viewer: { uid: 'u-viewer', email: 'viewer@example.com', email_verified: true },
  outsider: { uid: 'u-outsider', email: 'someone@elsewhere.example', email_verified: true },
  unverified: { uid: 'u-unverified', email: 'admin2@example.com', email_verified: false },
  noemail: { uid: 'u-noemail', email_verified: true },
  // Allow-listed, but no users/{uid} document.
  newcomer: { uid: 'u-newcomer', email: 'newcomer@example.com', email_verified: true },
};

export const ALLOWED = 'admin@example.com, Viewer@example.com,newcomer@example.com,admin2@example.com';

export interface Harness {
  fs: FakeFirestore;
  verifyCalls: Array<{ token: string; checkRevoked: unknown }>;
  app: {
    auth(): { verifyIdToken(token: string, checkRevoked?: boolean): Promise<Claims> };
    firestore(): unknown;
  };
}

export function createHarness(): Harness {
  const fs = createFakeFirestore();
  const verifyCalls: Harness['verifyCalls'] = [];
  const app = {
    auth: () => ({
      verifyIdToken: async (token: string, checkRevoked?: boolean) => {
        verifyCalls.push({ token, checkRevoked });
        if (token === 'revoked') throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' });
        if (token === 'infra') throw new Error('network down');
        const claims = TOKENS[token];
        if (!claims) throw Object.assign(new Error('bad token'), { code: 'auth/argument-error' });
        return { ...claims };
      },
    }),
    firestore: () => fs,
  };
  fs.seed('users/u-admin', { uid: 'u-admin', email: 'admin@example.com', role: 'admin' });
  fs.seed('users/u-viewer', { uid: 'u-viewer', email: 'viewer@example.com', role: 'viewer' });
  fs.seed('users/u-unverified', { uid: 'u-unverified', email: 'admin2@example.com', role: 'admin' });
  return { fs, verifyCalls, app };
}

export function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; cookie?: string; rawBody?: string; authorization?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (opts.authorization !== undefined) headers.set('authorization', opts.authorization);
  else if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(new URL(path, 'http://localhost'), { method, headers, body });
}

export async function json(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminApp } from './firebaseAdmin';
import { getAdminDb } from './adminControl';

/** Cookie set by /api/session; holds the Firebase ID token. */
export const SESSION_COOKIE = 'bytrader_session';

export type AuthenticatedUser = { uid: string; email: string };

/**
 * Lower-cased ALLOWED_EMAILS entries. Null means the variable is unset or empty;
 * every route then refuses access (fail closed), because without an allow-list
 * any Google account could sign in.
 */
export function getAllowedEmails(): string[] | null {
  const raw = process.env.ALLOWED_EMAILS ?? '';
  if (!raw.trim()) return null;
  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Bearer header first, then the session cookie. */
function readToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization');
  if (header !== null) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    return match ? match[1] : null;
  }
  return req.cookies.get(SESSION_COOKIE)?.value ?? null;
}

async function verifyRequestUser(req: NextRequest): Promise<AuthenticatedUser | NextResponse> {
  const token = readToken(req);
  if (!token) return errorResponse('Not signed in', 401);

  const adminApp = getAdminApp();
  if (!adminApp) return errorResponse('Admin not configured', 503);

  let decoded;
  try {
    decoded = await adminApp.auth().verifyIdToken(token, true);
  } catch (err) {
    // Firebase auth rejections carry an auth/* code; anything else is an infrastructure problem.
    const code = (err as { code?: unknown })?.code;
    if (typeof code === 'string' && code.startsWith('auth/')) {
      return errorResponse('Invalid or expired token', 401);
    }
    return errorResponse('Token verification unavailable', 503);
  }

  const refusal = emailRefusal(decoded);
  if (refusal) return errorResponse(refusal, 403);

  return { uid: decoded.uid, email: decoded.email?.toLowerCase() ?? '' };
}

/**
 * Why a verified token's email may not use the dashboard, or null when it may.
 * Shared by every route and by /api/session, so all of them fail closed alike.
 */
export function emailRefusal(decoded: { email?: string; email_verified?: boolean }): string | null {
  const allowed = getAllowedEmails();
  if (allowed === null) return 'Access allow-list (ALLOWED_EMAILS) is not configured';
  const email = decoded.email?.toLowerCase() ?? '';
  if (decoded.email_verified !== true) return 'Email not verified';
  if (!email || !allowed.includes(email)) return 'Email not allowed';
  return null;
}

/** Verified token + verified, allow-listed email, any role. For read-only routes and first sign-in. */
export async function requireUser(req: NextRequest): Promise<AuthenticatedUser | NextResponse> {
  return verifyRequestUser(req);
}

/**
 * Verified token + verified, allow-listed email + users/{uid}.role === 'admin'.
 * Every check fails closed (missing allow-list, missing user, unreadable role).
 */
export async function requireAdmin(req: NextRequest): Promise<AuthenticatedUser | NextResponse> {
  const user = await verifyRequestUser(req);
  if (isResponse(user)) return user;

  const db = getAdminDb();
  if (!db) return errorResponse('Admin not configured', 503);

  try {
    const snap = await db.collection('users').doc(user.uid).get();
    if (snap.data()?.role !== 'admin') return errorResponse('Admin role required', 403);
  } catch {
    return errorResponse('Role lookup unavailable', 503);
  }

  return user;
}

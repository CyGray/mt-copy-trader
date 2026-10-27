import { firebaseAuth } from './firebaseClient';

/** Non-2xx response from a web API route. `body` is the parsed JSON error payload, if any. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as { error?: unknown; lastError?: unknown };
    if (typeof record.error === 'string' && record.error) return record.error;
    if (typeof record.lastError === 'string' && record.lastError) return record.lastError;
  }
  return fallback;
}

/**
 * Calls a web API route with a fresh Firebase ID token. Resolves with the parsed
 * JSON body; throws ApiError (message = the server's `error`) on non-2xx.
 */
export async function authedFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const user = firebaseAuth?.currentUser;
  if (!user) {
    throw new ApiError('Not signed in', 401, null);
  }

  const token = await user.getIdToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');

  const response = await fetch(path, { ...init, headers, cache: 'no-store' });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      messageFrom(body, `Request failed (${response.status})`),
      response.status,
      body,
    );
  }

  return body as T;
}

/** Validation issue as returned by the safety and settings routes. */
export type ApiIssue = { path: string; message: string; value?: unknown; limit?: unknown };

/** Readable message for any error thrown by authedFetch or a network call. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Field-level issues from a 400 response body, or an empty list. */
export function apiIssues(err: unknown): ApiIssue[] {
  if (!(err instanceof ApiError) || !err.body || typeof err.body !== 'object') return [];
  const issues = (err.body as { issues?: unknown }).issues;
  return Array.isArray(issues) ? (issues as ApiIssue[]) : [];
}

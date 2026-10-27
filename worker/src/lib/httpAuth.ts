/**
 * httpAuth.ts — shared HTTP access control for the worker services.
 *
 * - `requireBearerToken(envVar)` gates an Express route group. When the env var
 *   is set, callers must present `Authorization: Bearer <token>` (constant-time
 *   compare). When it is unset, only loopback callers are allowed; anything
 *   else is refused (fail closed).
 * - `resolveListenHost(envVar)` returns the bind address for `app.listen`,
 *   defaulting to loopback so the services are not exposed on every interface.
 */
import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEFAULT_LISTEN_HOST = '127.0.0.1';

export function resolveListenHost(envVar: string): string {
  const value = process.env[envVar]?.trim();
  return value ? value : DEFAULT_LISTEN_HOST;
}

export function requireBearerToken(envVar = 'WORKER_API_TOKEN'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env[envVar]?.trim();

    if (!expected) {
      if (isLoopback(req.socket?.remoteAddress)) {
        next();
        return;
      }
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const presented = parseBearerToken(req.headers?.authorization);
    if (presented !== null && tokensMatch(presented, expected)) {
      next();
      return;
    }

    res.status(401).json({ error: 'Unauthorized' });
  };
}

function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

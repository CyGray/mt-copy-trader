import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireBearerToken, resolveListenHost } from './httpAuth.js';

const ENV = 'TEST_WORKER_API_TOKEN';

function fakeReq(options: { remoteAddress?: string; authorization?: string } = {}) {
  return {
    socket: { remoteAddress: options.remoteAddress },
    headers: options.authorization === undefined ? {} : { authorization: options.authorization },
  } as unknown as Request;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function run(req: Request) {
  const middleware = requireBearerToken(ENV);
  const res = fakeRes();
  const next = vi.fn();
  middleware(req, res as unknown as Response, next);
  return { res, next };
}

describe('requireBearerToken with token configured', () => {
  beforeEach(() => {
    process.env[ENV] = 'correct-horse-battery';
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  it('allows a matching bearer token', () => {
    const { res, next } = run(fakeReq({ authorization: 'Bearer correct-horse-battery' }));
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it('accepts a lowercase bearer scheme', () => {
    const { next } = run(fakeReq({ authorization: 'bearer correct-horse-battery' }));
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a wrong token of the same length', () => {
    const { res, next } = run(fakeReq({ authorization: 'Bearer correct-horse-batter!' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a token of a different length', () => {
    const { res, next } = run(fakeReq({ authorization: 'Bearer short' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing Authorization header even from loopback', () => {
    const { res, next } = run(fakeReq({ remoteAddress: '127.0.0.1' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-bearer scheme', () => {
    const { res, next } = run(fakeReq({ authorization: 'Basic Y29ycmVjdC1ob3JzZS1iYXR0ZXJ5' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects an empty bearer value', () => {
    const { res, next } = run(fakeReq({ authorization: 'Bearer ' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('requireBearerToken without token configured', () => {
  beforeEach(() => {
    delete process.env[ENV];
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('allows loopback address %s', (address) => {
    const { res, next } = run(fakeReq({ remoteAddress: address }));
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it('refuses a non-loopback caller with 403', () => {
    const { res, next } = run(fakeReq({ remoteAddress: '10.0.0.5' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('refuses when the remote address is unknown (fail closed)', () => {
    const { res, next } = run(fakeReq({}));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('treats an empty env value as unset', () => {
    process.env[ENV] = '   ';
    const { res, next } = run(fakeReq({ remoteAddress: '192.168.1.10' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('ignores a bearer header when no token is configured', () => {
    const { res, next } = run(fakeReq({ remoteAddress: '10.0.0.5', authorization: 'Bearer anything' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('resolveListenHost', () => {
  const HOST_ENV = 'TEST_WORKER_HOST';

  afterEach(() => {
    delete process.env[HOST_ENV];
  });

  it('defaults to loopback when unset', () => {
    delete process.env[HOST_ENV];
    expect(resolveListenHost(HOST_ENV)).toBe('127.0.0.1');
  });

  it('defaults to loopback when empty or whitespace', () => {
    process.env[HOST_ENV] = '  ';
    expect(resolveListenHost(HOST_ENV)).toBe('127.0.0.1');
  });

  it('returns the configured value', () => {
    process.env[HOST_ENV] = '0.0.0.0';
    expect(resolveListenHost(HOST_ENV)).toBe('0.0.0.0');
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TRADE_STATES,
  IN_FLIGHT_TRADE_STATES,
  TERMINAL_TRADE_STATES,
  correlationComment,
  tradeSetIdFor,
} from './tradeSetTypes.js';

describe('tradeSetIdFor', () => {
  it('joins chat and message ids with an underscore', () => {
    expect(tradeSetIdFor('-1003271337051', '3664')).toBe('-1003271337051_3664');
  });
});

describe('correlationComment', () => {
  it('is BT- followed by the first 12 hex chars of sha256(tradeSetId)', () => {
    const id = '-1003271337051_3664';
    const expected = 'BT-' + createHash('sha256').update(id).digest('hex').slice(0, 12);
    expect(correlationComment(id)).toBe(expected);
    expect(correlationComment(id)).toMatch(/^BT-[0-9a-f]{12}$/);
  });

  it('is deterministic and differs per trade set', () => {
    expect(correlationComment('a_1')).toBe(correlationComment('a_1'));
    expect(correlationComment('a_1')).not.toBe(correlationComment('a_2'));
  });
});

describe('trade state groups', () => {
  it('lists the active, in-flight and terminal states', () => {
    expect([...ACTIVE_TRADE_STATES]).toEqual(['OPEN', 'PARTIALLY_CLOSED', 'PENDING_ORDER']);
    expect([...IN_FLIGHT_TRADE_STATES]).toEqual(['CLAIMED', 'SUBMITTING', 'SUBMIT_UNKNOWN']);
    expect([...TERMINAL_TRADE_STATES]).toEqual(['SKIPPED', 'CLOSED', 'CANCELLED', 'REJECTED', 'ERROR']);
  });

  it('keeps the groups disjoint', () => {
    const all = [...ACTIVE_TRADE_STATES, ...IN_FLIGHT_TRADE_STATES, ...TERMINAL_TRADE_STATES];
    expect(new Set(all).size).toBe(all.length);
  });
});

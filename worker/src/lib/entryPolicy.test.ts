import { describe, expect, it } from 'vitest';
import { decideEntry, validateStopLoss } from './entryPolicy.js';
import type { ExecutionProfile, GoldSignalLike } from './executionProfile.js';

type Entry = ExecutionProfile['entry'];

function entryCfg(overrides: Partial<Entry> = {}): Entry {
  return {
    policy: 'market_only',
    market_tolerance_price: 0,
    pending_expiry_minutes: 60,
    allow_market_fallback: false,
    ...overrides,
  };
}

function signal(overrides: Partial<GoldSignalLike> = {}): GoldSignalLike {
  return {
    symbol: 'XAUUSD',
    direction: 'buy',
    orderType: 'market',
    entryLow: 2000,
    entryHigh: 2002,
    stopLoss: 1995,
    takeProfits: [2005, 2010, 2015],
    ...overrides,
  };
}

describe('decideEntry: invalid quote', () => {
  it('rejects zero, non-finite, and crossed quotes', () => {
    const cfg = entryCfg();
    for (const quote of [
      { bid: 0, ask: 2001 },
      { bid: 2001, ask: 0 },
      { bid: Number.NaN, ask: 2001 },
      { bid: 2001, ask: 2000 },
    ]) {
      expect(decideEntry(signal(), quote, cfg)).toMatchObject({ ok: false, reason: 'invalid_quote' });
    }
  });
});

describe('decideEntry: market signals', () => {
  it('BUY inside range fills at market using Ask', () => {
    const r = decideEntry(signal(), { bid: 2000.8, ask: 2001 }, entryCfg());
    expect(r).toEqual({ ok: true, orderType: 'BUY', orderPrice: 0, entryRefPrice: 2001, isPending: false });
  });

  it('SELL inside range fills at market using Bid', () => {
    const r = decideEntry(signal({ direction: 'sell' }), { bid: 2001, ask: 2001.2 }, entryCfg());
    expect(r).toEqual({ ok: true, orderType: 'SELL', orderPrice: 0, entryRefPrice: 2001, isPending: false });
  });

  it('a price exactly on the range edge is inside', () => {
    expect(decideEntry(signal(), { bid: 1999.9, ask: 2000 }, entryCfg())).toMatchObject({ ok: true, orderType: 'BUY' });
    expect(decideEntry(signal(), { bid: 2001.9, ask: 2002 }, entryCfg())).toMatchObject({ ok: true, orderType: 'BUY' });
  });

  it('tolerance widens the range on both sides', () => {
    const cfg = entryCfg({ market_tolerance_price: 0.5 });
    expect(decideEntry(signal(), { bid: 2002.2, ask: 2002.4 }, cfg)).toMatchObject({ ok: true, orderType: 'BUY' });
    expect(decideEntry(signal(), { bid: 2002.5, ask: 2002.6 }, cfg)).toMatchObject({
      ok: false,
      reason: 'price_outside_entry_range',
    });
    expect(decideEntry(signal({ direction: 'sell' }), { bid: 1999.6, ask: 1999.8 }, cfg)).toMatchObject({
      ok: true,
      orderType: 'SELL',
    });
  });

  it('market_only and follow_signal skip when the price is outside the range', () => {
    for (const policy of ['market_only', 'follow_signal'] as const) {
      const r = decideEntry(signal(), { bid: 2002.9, ask: 2003 }, entryCfg({ policy }));
      expect(r).toMatchObject({ ok: false, reason: 'price_outside_entry_range' });
    }
  });

  describe('pending_at_range', () => {
    const cfg = entryCfg({ policy: 'pending_at_range' });

    it('BUY above the range places BUY_LIMIT at entryHigh', () => {
      const r = decideEntry(signal(), { bid: 2002.9, ask: 2003 }, cfg);
      expect(r).toEqual({ ok: true, orderType: 'BUY_LIMIT', orderPrice: 2002, entryRefPrice: 2002, isPending: true });
    });

    it('SELL below the range places SELL_LIMIT at entryLow', () => {
      const r = decideEntry(signal({ direction: 'sell' }), { bid: 1997, ask: 1997.2 }, cfg);
      expect(r).toEqual({ ok: true, orderType: 'SELL_LIMIT', orderPrice: 2000, entryRefPrice: 2000, isPending: true });
    });

    it('BUY below the range (toward SL) is skipped', () => {
      const r = decideEntry(signal(), { bid: 1997.8, ask: 1998 }, cfg);
      expect(r).toMatchObject({ ok: false, reason: 'price_outside_entry_range' });
    });

    it('SELL above the range (toward SL) is skipped', () => {
      const r = decideEntry(signal({ direction: 'sell' }), { bid: 2003, ask: 2003.2 }, cfg);
      expect(r).toMatchObject({ ok: false, reason: 'price_outside_entry_range' });
    });

    it('a price inside tolerance still fills at market', () => {
      const r = decideEntry(signal(), { bid: 2002.2, ask: 2002.4 }, entryCfg({ policy: 'pending_at_range', market_tolerance_price: 0.5 }));
      expect(r).toMatchObject({ ok: true, orderType: 'BUY', isPending: false });
    });

    it('a price just above the tolerance band places a limit', () => {
      const r = decideEntry(signal(), { bid: 2002.6, ask: 2002.7 }, entryCfg({ policy: 'pending_at_range', market_tolerance_price: 0.5 }));
      expect(r).toMatchObject({ ok: true, orderType: 'BUY_LIMIT', orderPrice: 2002, isPending: true });
    });
  });
});

describe('decideEntry: pending signals', () => {
  it('market_only skips pending orders unless the market fallback applies', () => {
    const pending = signal({ orderType: 'buy_limit' });
    expect(decideEntry(pending, { bid: 2000.8, ask: 2001 }, entryCfg())).toMatchObject({
      ok: false,
      reason: 'pending_not_allowed',
    });
    expect(
      decideEntry(pending, { bid: 2000.8, ask: 2001 }, entryCfg({ allow_market_fallback: true })),
    ).toEqual({ ok: true, orderType: 'BUY', orderPrice: 0, entryRefPrice: 2001, isPending: false });
    expect(
      decideEntry(pending, { bid: 2003.8, ask: 2004 }, entryCfg({ allow_market_fallback: true })),
    ).toMatchObject({ ok: false, reason: 'pending_not_allowed' });
  });

  describe('follow_signal', () => {
    const cfg = entryCfg({ policy: 'follow_signal' });

    it('BUY_LIMIT at entryHigh when the price is above it', () => {
      const r = decideEntry(signal({ orderType: 'buy_limit' }), { bid: 2002.9, ask: 2003 }, cfg);
      expect(r).toEqual({ ok: true, orderType: 'BUY_LIMIT', orderPrice: 2002, entryRefPrice: 2002, isPending: true });
    });

    it('SELL_LIMIT at entryLow when the price is below it', () => {
      const r = decideEntry(signal({ direction: 'sell', orderType: 'sell_limit' }), { bid: 1999, ask: 1999.2 }, cfg);
      expect(r).toEqual({ ok: true, orderType: 'SELL_LIMIT', orderPrice: 2000, entryRefPrice: 2000, isPending: true });
    });

    it('BUY_STOP at entryLow when the price is below it', () => {
      const r = decideEntry(signal({ orderType: 'buy_stop' }), { bid: 1999, ask: 1999.2 }, cfg);
      expect(r).toEqual({ ok: true, orderType: 'BUY_STOP', orderPrice: 2000, entryRefPrice: 2000, isPending: true });
    });

    it('SELL_STOP at entryHigh when the price is above it', () => {
      const r = decideEntry(signal({ direction: 'sell', orderType: 'sell_stop' }), { bid: 2003, ask: 2003.2 }, cfg);
      expect(r).toEqual({ ok: true, orderType: 'SELL_STOP', orderPrice: 2002, entryRefPrice: 2002, isPending: true });
    });

    it('an invalid pending price is skipped without fallback', () => {
      // BUY_LIMIT at 2002 needs Ask above it; Ask 2001 fails.
      const r = decideEntry(signal({ orderType: 'buy_limit' }), { bid: 2000.8, ask: 2001 }, cfg);
      expect(r).toMatchObject({ ok: false, reason: 'invalid_pending_price' });
    });

    it('an invalid pending price falls back to market when allowed and inside range', () => {
      const r = decideEntry(
        signal({ orderType: 'buy_limit' }),
        { bid: 2000.8, ask: 2001 },
        entryCfg({ policy: 'follow_signal', allow_market_fallback: true }),
      );
      expect(r).toEqual({ ok: true, orderType: 'BUY', orderPrice: 0, entryRefPrice: 2001, isPending: false });
    });

    it('an invalid pending price with fallback still skips when the price is outside range', () => {
      // SELL_STOP at 2002 needs Bid above it; Bid 1999 is below the range, so no market fallback either.
      const r = decideEntry(
        signal({ orderType: 'sell_stop', direction: 'sell' }),
        { bid: 1999, ask: 1999.2 },
        entryCfg({ policy: 'follow_signal', allow_market_fallback: true }),
      );
      expect(r).toMatchObject({ ok: false, reason: 'invalid_pending_price' });
    });

    it('a valid pending price is used even when the fallback is allowed', () => {
      const r = decideEntry(
        signal({ orderType: 'buy_limit' }),
        { bid: 2002.9, ask: 2003 },
        entryCfg({ policy: 'follow_signal', allow_market_fallback: true }),
      );
      expect(r).toMatchObject({ ok: true, orderType: 'BUY_LIMIT', orderPrice: 2002, isPending: true });
    });

    it('pending_at_range treats pending signals the same as follow_signal', () => {
      const r = decideEntry(
        signal({ orderType: 'sell_stop', direction: 'sell' }),
        { bid: 2003, ask: 2003.2 },
        entryCfg({ policy: 'pending_at_range' }),
      );
      expect(r).toEqual({ ok: true, orderType: 'SELL_STOP', orderPrice: 2002, entryRefPrice: 2002, isPending: true });
    });

    it('rejects an order type that disagrees with the direction', () => {
      const r = decideEntry(signal({ direction: 'sell', orderType: 'buy_limit' }), { bid: 2003, ask: 2003.2 }, cfg);
      expect(r).toMatchObject({ ok: false, reason: 'invalid_pending_price' });
    });
  });
});

describe('validateStopLoss', () => {
  const cfg: ExecutionProfile['stop_loss'] = {
    min_distance_price: 2,
    max_distance_price: 25,
    after_checkpoint: [],
  };

  it('accepts a BUY stop below entry within distance bounds', () => {
    expect(validateStopLoss('buy', 2000, 1995, cfg)).toEqual({ ok: true });
  });

  it('accepts a SELL stop above entry within distance bounds', () => {
    expect(validateStopLoss('sell', 2000, 2005, cfg)).toEqual({ ok: true });
  });

  it('rejects a BUY stop on the wrong side or at entry', () => {
    expect(validateStopLoss('buy', 2000, 2005, cfg)).toMatchObject({ ok: false, reason: 'sl_wrong_side' });
    expect(validateStopLoss('buy', 2000, 2000, cfg)).toMatchObject({ ok: false, reason: 'sl_wrong_side' });
  });

  it('rejects a SELL stop on the wrong side or at entry', () => {
    expect(validateStopLoss('sell', 2000, 1995, cfg)).toMatchObject({ ok: false, reason: 'sl_wrong_side' });
    expect(validateStopLoss('sell', 2000, 2000, cfg)).toMatchObject({ ok: false, reason: 'sl_wrong_side' });
  });

  it('rejects a stop closer than the minimum distance', () => {
    expect(validateStopLoss('buy', 2000, 1999.5, cfg)).toMatchObject({ ok: false, reason: 'sl_too_close' });
    expect(validateStopLoss('sell', 2000, 2000.5, cfg)).toMatchObject({ ok: false, reason: 'sl_too_close' });
  });

  it('rejects a stop farther than the maximum distance', () => {
    expect(validateStopLoss('buy', 2000, 1970, cfg)).toMatchObject({ ok: false, reason: 'sl_too_far' });
    expect(validateStopLoss('sell', 2000, 2030, cfg)).toMatchObject({ ok: false, reason: 'sl_too_far' });
  });

  it('accepts distances exactly at the bounds', () => {
    expect(validateStopLoss('buy', 2000, 1998, cfg)).toEqual({ ok: true });
    expect(validateStopLoss('buy', 2000, 1975, cfg)).toEqual({ ok: true });
  });

  it('rejects non-finite prices', () => {
    expect(validateStopLoss('buy', Number.NaN, 1995, cfg)).toMatchObject({ ok: false, reason: 'sl_wrong_side' });
  });
});

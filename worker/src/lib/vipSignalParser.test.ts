import { describe, expect, it } from 'vitest';
import { parseGoldSignal } from './vipSignalParser';

describe('parseGoldSignal', () => {
  it('parses a POSITION sell signal with OPEN range', () => {
    const text = `SELL POSITION XAUUSD🚨

OPEN : 4028-4032
SL : 4040
TP1 : 4020
TP2 : 4013
TP3 : 4005
TP4 : 3987`;

    const result = parseGoldSignal(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal).toEqual({
        symbol: 'XAUUSD',
        direction: 'sell',
        entryLow: 4028,
        entryHigh: 4032,
        stopLoss: 4040,
        takeProfits: [4020, 4013, 4005, 3987],
      });
    }
  });

  it('parses a GOLD NOW buy signal with ENTRY and Stop loss keys', () => {
    const text = `BUY GOLD NOW🚨

Entry zone : 4334-4335
Stop loss : 4331
TP1 : 4339
TP2 : 4348
TP3 : 4356
TP4 : 4470`;

    const result = parseGoldSignal(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal.direction).toBe('buy');
      expect(result.signal.entryLow).toBe(4334);
      expect(result.signal.entryHigh).toBe(4335);
      expect(result.signal.stopLoss).toBe(4331);
      expect(result.signal.takeProfits).toEqual([4339, 4348, 4356, 4470]);
    }
  });

  it('normalizes a decimals range and single price entry', () => {
    const ranged = parseGoldSignal(`SELL GOLD NOW

Entry : 4134.5-4136
SL : 4139
TP1 : 4128
TP2 : 4120`);
    expect(ranged.ok).toBe(true);
    if (ranged.ok) {
      expect(ranged.signal.entryLow).toBe(4134.5);
      expect(ranged.signal.entryHigh).toBe(4136);
    }

    const single = parseGoldSignal(`BUY POSITION XAUUSD

OPEN :4026
SL : 4020
TP1 : 4033
TP2 : 4041`);
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(single.signal.entryLow).toBe(4026);
      expect(single.signal.entryHigh).toBe(4026);
    }
  });

  it('expands a truncated entry range such as 4415-17', () => {
    const result = parseGoldSignal(`BUY POSITION XAUUSD🚨

OPEN : 4415-17
SL : 4411
TP1 : 4422
TP2 : 4429
TP3 : 4445
TP4 : 4460`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal.entryLow).toBe(4415);
      expect(result.signal.entryHigh).toBe(4417);
      expect(result.signal.stopLoss).toBe(4411);
    }
  });

  it('parses lowercase keys and up to seven take profits', () => {
    const text = `SELL GOLD NOW🚨

entry : 4498-4500
Sl : 4504
TP1 : 4492
TP2 : 4485
TP3 : 4478
TP4 : 4470
TP5 : 4460
TP6 : 4450
TP7 : 4440`;

    const result = parseGoldSignal(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal.takeProfits).toHaveLength(7);
      expect(result.signal.stopLoss).toBe(4504);
    }
  });

  it('resolves GOLD to the default symbol', () => {
    const result = parseGoldSignal(`SELLING GOLD NOW🚨

Entry zone : 4478-4480
SL : 4483
TP1 : 4473
TP2 : 4465`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal.symbol).toBe('XAUUSD');
      expect(result.signal.direction).toBe('sell');
    }
  });

  it('rejects result announcements', () => {
    expect(parseGoldSignal('TP3 HIT + 351 PIPS✅').ok).toBe(false);
    expect(parseGoldSignal('SL at break even team🎯').ok).toBe(false);
  });

  it('rejects signals missing an entry, SL, or TPs', () => {
    expect(parseGoldSignal('SELL GOLD NOW🚨').ok).toBe(false);
    expect(parseGoldSignal('SELL GOLD NOW\nOPEN : 4028-4032\nTP1 : 4020').ok).toBe(false);
    expect(parseGoldSignal('SELL GOLD NOW\nOPEN : 4028-4032\nSL : 4040').ok).toBe(false);
  });

  it('rejects take profits that are out of order', () => {
    const result = parseGoldSignal(`SELL GOLD NOW

OPEN : 4028-4032
SL : 4040
TP1 : 4005
TP2 : 4020`);
    expect(result.ok).toBe(false);
    if (result.ok === true) throw new Error('expected parse to fail');
    expect(result.error).toBe('invalid_tp_order');
  });

  it('rejects a stop loss on the wrong side of the entry', () => {
    const result = parseGoldSignal(`BUY GOLD NOW

OPEN : 4083-4085
SL : 4090
TP1 : 4090
TP2 : 4100`);
    expect(result.ok).toBe(false);
    if (result.ok === true) throw new Error('expected parse to fail');
    expect(result.error).toBe('invalid_sl_side');
  });
});

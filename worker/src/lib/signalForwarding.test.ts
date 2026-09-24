import { describe, expect, it } from 'vitest';
import { formatSignalMessage } from './signalForwarding';

describe('formatSignalMessage', () => {
  it('formats a sell signal with a range entry', () => {
    const text = formatSignalMessage({
      symbol: 'XAUUSD',
      direction: 'sell',
      orderType: 'market',
      entryLow: 4028,
      entryHigh: 4032,
      stopLoss: 4040,
      takeProfits: [4020, 4013, 4005, 3987],
    });

    expect(text).toBe(
      ['🔴 SELL XAUUSD', '', 'Entry: 4028 - 4032', 'SL: 4040', 'TP1: 4020', 'TP2: 4013', 'TP3: 4005', 'TP4: 3987'].join(
        '\n',
      ),
    );
  });

  it('prefixes a correction marker when requested', () => {
    const text = formatSignalMessage(
      {
        symbol: 'XAUUSD',
        direction: 'buy',
        orderType: 'market',
        entryLow: 4026,
        entryHigh: 4026,
        stopLoss: 4020,
        takeProfits: [4033, 4041],
      },
      { correction: true },
    );

    expect(text).toBe(
      ['♻️ CORRECTION', '', '🟢 BUY XAUUSD', '', 'Entry: 4026', 'SL: 4020', 'TP1: 4033', 'TP2: 4041'].join(
        '\n',
      ),
    );
  });

  it('formats a buy signal with a single-price entry', () => {
    const text = formatSignalMessage({
      symbol: 'XAUUSD',
      direction: 'buy',
      orderType: 'market',
      entryLow: 4026,
      entryHigh: 4026,
      stopLoss: 4020,
      takeProfits: [4033, 4041],
    });

    expect(text).toBe(
      ['🟢 BUY XAUUSD', '', 'Entry: 4026', 'SL: 4020', 'TP1: 4033', 'TP2: 4041'].join('\n'),
    );
  });
});

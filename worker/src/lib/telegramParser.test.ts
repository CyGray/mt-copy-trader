import { describe, expect, it } from 'vitest';
import { parseTelegramSignal } from './telegramParser';

describe('parseTelegramSignal', () => {
  it('parses a valid long signal', () => {
    const text = `ADAUSDT (4H) (futures)
⬆️ LONG NOW (20X)
⭕️SL @ 0.3796
🔵TP @ 0.3886
🔵TP @ 0.3988
🔵TP @ 0.4235
#cryptosignal #Crypto`;

    const result = parseTelegramSignal(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal.symbol).toBe('ADAUSDT');
      expect(result.signal.direction).toBe('long');
      expect(result.signal.stopLoss).toBeCloseTo(0.3796, 6);
      expect(result.signal.takeProfits).toEqual([0.3886, 0.3988, 0.4235]);
    }
  });

  it('parses a valid short signal', () => {
    const text = `SUIUSDT (4H) (futures)
⬇️ SHORT NOW (20X)
⭕️SL @ 1.4516
🔵TP @ 1.3773
🔵TP @ 1.3359
🔵TP @ 1.1810`;

    const result = parseTelegramSignal(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal.symbol).toBe('SUIUSDT');
      expect(result.signal.direction).toBe('short');
      expect(result.signal.takeProfits).toEqual([1.3773, 1.3359, 1.181]);
    }
  });

  it('rejects missing fields', () => {
    const result = parseTelegramSignal('ADAUSDT LONG');
    expect(result.ok).toBe(false);
  });

  it('rejects invalid TP order', () => {
    const text = `ADAUSDT
LONG NOW
SL 1.0
TP 2.0
TP 1.5
TP 3.0`;
    const result = parseTelegramSignal(text);
    expect(result.ok).toBe(false);
  });
});

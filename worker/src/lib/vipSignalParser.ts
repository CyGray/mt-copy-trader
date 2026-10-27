export type GoldSignalDirection = 'buy' | 'sell';

export type GoldOrderType =
  | 'market'
  | 'buy_limit'
  | 'sell_limit'
  | 'buy_stop'
  | 'sell_stop';

export type GoldSignal = {
  symbol: string;
  direction: GoldSignalDirection;
  orderType: GoldOrderType;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfits: number[];
};

export type GoldSignalParseResult =
  | { ok: true; signal: GoldSignal }
  | { ok: false; error: string };

const DEFAULT_SYMBOL = 'XAUUSD';

const ORDER_TYPE_REGEX =
  /\b(BUY\s*LIMIT|SELL\s*LIMIT|BUY\s*STOP|SELL\s*STOP)\b/i;
const DIRECTION_REGEX = /^[ \t>]*(BUY(?:ING)?|SELL(?:ING)?)\b/im;
const ENTRY_REGEX =
  /\b(?:OPEN|ENTRY(?:\s*ZONE)?)\s*:?\s*(-?\d+(?:\.\d+)?)(?:\s*[-–]\s*(-?\d+(?:\.\d+)?))?/i;
const STOP_LOSS_REGEX = /\b(?:SL|STOP\s*LOSS)\s*:?\s*(-?\d+(?:\.\d+)?)/i;
const TAKE_PROFIT_REGEX = /\bTP\s*(\d+)\s*:?\s*(-?\d+(?:\.\d+)?)/gi;
const SYMBOL_REGEX = /\b([A-Z]{2,6}(?:USD|USDT))\b/;
const GOLD_REGEX = /\bGOLD\b/i;

function expandShortRange(firstRaw: string, secondRaw: string): number {
  const first = Number(firstRaw);
  const second = Number(secondRaw);
  if (!Number.isFinite(second)) return NaN;
  if (second >= first) return second;

  const firstDigits = firstRaw.replace(/[-+.]/g, '');
  const secondDigits = secondRaw.replace(/[-+.]/g, '');
  if (secondDigits.length >= firstDigits.length) return second;

  const prefix = firstDigits.slice(0, firstDigits.length - secondDigits.length);
  return Number(`${prefix}${secondDigits}`);
}

function normalizeSymbol(text: string): string {
  const match = text.toUpperCase().match(SYMBOL_REGEX);
  if (match) return match[1];
  if (GOLD_REGEX.test(text)) return DEFAULT_SYMBOL;
  return DEFAULT_SYMBOL;
}

export function parseGoldSignal(text: string): GoldSignalParseResult {
  const normalized = (text ?? '').trim();
  if (!normalized) {
    return { ok: false, error: 'empty_message' };
  }

  // Detect pending order type first (before stripping direction keywords)
  let orderType: GoldOrderType = 'market';
  const orderTypeMatch = normalized.match(ORDER_TYPE_REGEX);
  if (orderTypeMatch) {
    const raw = orderTypeMatch[1].toUpperCase().replace(/\s+/g, '_');
    if (raw === 'BUY_LIMIT') orderType = 'buy_limit';
    else if (raw === 'SELL_LIMIT') orderType = 'sell_limit';
    else if (raw === 'BUY_STOP') orderType = 'buy_stop';
    else if (raw === 'SELL_STOP') orderType = 'sell_stop';
  }

  const directionMatch = normalized.match(DIRECTION_REGEX);
  if (!directionMatch) {
    return { ok: false, error: 'missing_direction' };
  }
  const direction: GoldSignalDirection = directionMatch[1].toUpperCase().startsWith('B')
    ? 'buy'
    : 'sell';

  const entryMatch = normalized.match(ENTRY_REGEX);
  if (!entryMatch) {
    return { ok: false, error: 'missing_entry' };
  }
  const entryFirst = Number(entryMatch[1]);
  const entrySecond = entryMatch[2]
    ? expandShortRange(entryMatch[1], entryMatch[2])
    : entryFirst;
  if (!Number.isFinite(entryFirst) || !Number.isFinite(entrySecond)) {
    return { ok: false, error: 'invalid_entry' };
  }
  const entryLow = Math.min(entryFirst, entrySecond);
  const entryHigh = Math.max(entryFirst, entrySecond);

  const stopLossMatch = normalized.match(STOP_LOSS_REGEX);
  if (!stopLossMatch) {
    return { ok: false, error: 'missing_sl' };
  }
  const stopLoss = Number(stopLossMatch[1]);
  if (!Number.isFinite(stopLoss)) {
    return { ok: false, error: 'invalid_sl' };
  }

  const takeProfits: Array<{ index: number; value: number }> = [];
  for (const match of normalized.matchAll(TAKE_PROFIT_REGEX)) {
    const index = Number(match[1]);
    const value = Number(match[2]);
    if (!Number.isFinite(index) || !Number.isFinite(value)) continue;
    takeProfits.push({ index, value });
  }

  if (takeProfits.length === 0) {
    return { ok: false, error: 'missing_tp' };
  }

  takeProfits.sort((a, b) => a.index - b.index);
  const values = takeProfits.map((entry) => entry.value);

  for (let i = 1; i < values.length; i += 1) {
    const ordered = direction === 'buy' ? values[i] > values[i - 1] : values[i] < values[i - 1];
    if (!ordered) {
      return { ok: false, error: 'invalid_tp_order' };
    }
  }

  if (direction === 'buy') {
    if (stopLoss >= entryLow) return { ok: false, error: 'invalid_sl_side' };
    if (values[0] <= entryHigh) return { ok: false, error: 'invalid_tp_side' };
  } else {
    if (stopLoss <= entryHigh) return { ok: false, error: 'invalid_sl_side' };
    if (values[0] >= entryLow) return { ok: false, error: 'invalid_tp_side' };
  }

  return {
    ok: true,
    signal: {
      symbol: normalizeSymbol(normalized),
      direction,
      orderType,
      entryLow,
      entryHigh,
      stopLoss,
      takeProfits: values,
    },
  };
}

const CANCEL_MAX_LENGTH = 120;

// Whole-word cancel words ("cancel", "cancelled", "canceled") also cover
// "cancel signal" and "signal cancelled". "close now" is deliberately absent:
// it is a close instruction, not a cancellation.
const CANCEL_PHRASES: RegExp[] = [
  /\bcancel(?:l?ed)?\b/gi,
  /\bdelete\s+this\s+signal\b/gi,
  /\bignore\s+this\s+signal\b/gi,
  /\binvalid\s+signal\b/gi,
];

// A cancel phrase directly preceded by a negation ("don't cancel", "do not
// cancel") is not a cancellation.
const NEGATION_BEFORE_PHRASE = /\b(?:not|never|no|don['’]?t|do\s+not|won['’]?t)\s+$/i;

/**
 * Conservative cancel detection for Telegram messages.
 *
 * Rule: cancel intent is true only when the trimmed text is at most 120
 * characters, contains a cancel phrase that is not negated, and does not parse
 * as a gold signal (a valid signal is never a cancel). Longer messages are
 * treated as commentary, so a long update that mentions "cancel" is ignored.
 * "Don't cancel your plans, TP1 hit" is not a cancel because the phrase is
 * negated.
 */
export function detectCancelIntent(text: string): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed || trimmed.length > CANCEL_MAX_LENGTH) return false;
  if (parseGoldSignal(trimmed).ok) return false;

  for (const pattern of CANCEL_PHRASES) {
    for (const match of trimmed.matchAll(pattern)) {
      const before = trimmed.slice(0, match.index ?? 0);
      if (!NEGATION_BEFORE_PHRASE.test(before)) return true;
    }
  }
  return false;
}

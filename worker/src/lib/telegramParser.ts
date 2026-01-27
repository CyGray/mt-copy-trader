export type TelegramSignalDirection = 'long' | 'short';

export type TelegramSignal = {
  symbol: string;
  direction: TelegramSignalDirection;
  stopLoss: number;
  takeProfits: [number, number, number];
};

export type TelegramSignalParseResult =
  | { ok: true; signal: TelegramSignal }
  | { ok: false; error: string };

const NUMBER_REGEX = /(-?\d+(?:\.\d+)?)/;

function parseNumberFromLine(line: string): number | null {
  const match = line.match(NUMBER_REGEX);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function parseTelegramSignal(text: string): TelegramSignalParseResult {
  const normalized = text.trim();
  if (!normalized) {
    return { ok: false, error: 'empty_message' };
  }

  const upper = normalized.toUpperCase();
  if (!upper.includes('NOW')) {
    return { ok: false, error: 'missing_now' };
  }

  const symbolMatch = upper.split(/\s+/).find((token) => token.endsWith('USDT'));
  if (!symbolMatch) {
    return { ok: false, error: 'missing_symbol' };
  }
  const symbol = symbolMatch.replace(/[^A-Z0-9]/g, '');

  let direction: TelegramSignalDirection | null = null;
  if (upper.includes('LONG')) direction = 'long';
  if (upper.includes('SHORT')) direction = direction ? null : 'short';
  if (!direction) {
    return { ok: false, error: 'missing_direction' };
  }

  const lines = normalized.split(/\r?\n/).map((line) => line.trim());
  const slLine = lines.find((line) => /\bSL\b/i.test(line));
  const stopLoss = slLine ? parseNumberFromLine(slLine) : null;
  if (!stopLoss) {
    return { ok: false, error: 'missing_sl' };
  }

  const tpValues: number[] = [];
  for (const line of lines) {
    if (/\bTP\b/i.test(line)) {
      const value = parseNumberFromLine(line);
      if (value !== null) tpValues.push(value);
    }
  }

  if (tpValues.length < 3) {
    return { ok: false, error: 'missing_tp' };
  }

  const [tp1, tp2, tp3] = tpValues.slice(0, 3);

  if (direction === 'long') {
    if (!(tp1 < tp2 && tp2 < tp3)) {
      return { ok: false, error: 'invalid_tp_order' };
    }
  } else {
    if (!(tp1 > tp2 && tp2 > tp3)) {
      return { ok: false, error: 'invalid_tp_order' };
    }
  }

  return {
    ok: true,
    signal: {
      symbol,
      direction,
      stopLoss,
      takeProfits: [tp1, tp2, tp3],
    },
  };
}

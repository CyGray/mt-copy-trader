/**
 * mt5Secrets.ts
 *
 * Loads MT5 broker configuration from Firestore settings/default
 * (under the `mt5` key) with in-memory caching.
 *
 * Firestore path: settings/default → mt5
 * Fields:
 *   symbol_base    – base symbol to use, e.g. "XAUUSD"   (default "XAUUSD")
 *   symbol_suffix  – broker suffix, e.g. "+", ".raw", "" (default "")
 *   magic          – EA magic number                      (default 98801)
 *   deviation      – max slippage in points               (default 20)
 *   volume         – fixed lot size                       (default 0.05)
 */

import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';

export type Mt5Config = {
  symbolBase: string;
  symbolSuffix: string;
  /** Fully resolved symbol, e.g. "XAUUSD+" */
  symbol: string;
  magic: number;
  deviation: number;
  volume: number;
};

const DEFAULT_CONFIG: Mt5Config = {
  symbolBase: 'XAUUSD',
  symbolSuffix: '',
  symbol: 'XAUUSD',
  magic: 98801,
  deviation: 20,
  volume: 0.05,
};

const CONFIG_TTL_MS = 30_000;
let cachedConfig: Mt5Config | null = null;
let lastFetch = 0;

function toStr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function toNum(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function getMt5Config(): Promise<Mt5Config> {
  const now = Date.now();
  if (cachedConfig && now - lastFetch < CONFIG_TTL_MS) return cachedConfig;

  const firestore = initFirestore();
  if (!firestore) {
    cachedConfig = DEFAULT_CONFIG;
    lastFetch = now;
    return cachedConfig;
  }

  try {
    const snap = await firestore.collection('settings').doc('default').get();
    const raw = (snap.data()?.mt5 ?? {}) as Record<string, unknown>;

    const symbolBase = toStr(raw.symbol_base, DEFAULT_CONFIG.symbolBase);
    const symbolSuffix = typeof raw.symbol_suffix === 'string' ? raw.symbol_suffix : DEFAULT_CONFIG.symbolSuffix;

    cachedConfig = {
      symbolBase,
      symbolSuffix,
      symbol: `${symbolBase}${symbolSuffix}`,
      magic: toNum(raw.magic, DEFAULT_CONFIG.magic),
      deviation: toNum(raw.deviation, DEFAULT_CONFIG.deviation),
      volume: toNum(raw.volume, DEFAULT_CONFIG.volume),
    };
    lastFetch = now;
    return cachedConfig;
  } catch (err) {
    logger.warn('mt5_config_load_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    cachedConfig = DEFAULT_CONFIG;
    lastFetch = now;
    return cachedConfig;
  }
}

/** Invalidate cache (e.g. after a settings update from the dashboard) */
export function invalidateMt5Config(): void {
  cachedConfig = null;
  lastFetch = 0;
}

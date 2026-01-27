import { initFirestore } from './firestoreAdmin';

export type RiskMode = 'PERCENT_AVAILABLE_MARGIN' | 'FIXED_USDT';

export type TradingSettings = {
  riskMode: RiskMode;
  riskValue: number;
  maxSignalDelaySec: number;
  slippageTol: number;
  tp1SkipBuffer: number;
  maxOpenPositions: number;
  maxPositionsPerSymbol: number;
  bybitOptional: boolean;
};

const DEFAULT_SETTINGS: TradingSettings = {
  riskMode: 'FIXED_USDT',
  riskValue: 20,
  maxSignalDelaySec: 120,
  slippageTol: 0.001,
  tp1SkipBuffer: 0.0015,
  maxOpenPositions: 3,
  maxPositionsPerSymbol: 1,
  bybitOptional: false,
};

function toNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toRiskMode(value: unknown): RiskMode {
  return value === 'PERCENT_AVAILABLE_MARGIN' ? 'PERCENT_AVAILABLE_MARGIN' : 'FIXED_USDT';
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  if (typeof value === 'number') return value === 1;
  return fallback;
}

export async function getTradingSettings(): Promise<TradingSettings> {
  const firestore = initFirestore();
  if (!firestore) return DEFAULT_SETTINGS;

  try {
    const snap = await firestore.collection('settings').doc('default').get();
    const data = snap.data() as
      | {
          trading?: {
            risk_mode?: RiskMode;
            risk_value?: number;
            max_signal_delay_sec?: number;
            slippage_tol?: number;
            tp1_skip_buffer?: number;
            max_open_positions?: number;
            max_positions_per_symbol?: number;
            bybit_optional?: boolean;
          };
        }
      | undefined;

    const trading = data?.trading ?? {};

    return {
      riskMode: toRiskMode(trading.risk_mode),
      riskValue: toNumber(trading.risk_value, DEFAULT_SETTINGS.riskValue),
      maxSignalDelaySec: toNumber(
        trading.max_signal_delay_sec,
        DEFAULT_SETTINGS.maxSignalDelaySec,
      ),
      slippageTol: toNumber(trading.slippage_tol, DEFAULT_SETTINGS.slippageTol),
      tp1SkipBuffer: toNumber(trading.tp1_skip_buffer, DEFAULT_SETTINGS.tp1SkipBuffer),
      maxOpenPositions: toNumber(
        trading.max_open_positions,
        DEFAULT_SETTINGS.maxOpenPositions,
      ),
      maxPositionsPerSymbol: toNumber(
        trading.max_positions_per_symbol,
        DEFAULT_SETTINGS.maxPositionsPerSymbol,
      ),
      bybitOptional: toBoolean(
        trading.bybit_optional,
        DEFAULT_SETTINGS.bybitOptional,
      ),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

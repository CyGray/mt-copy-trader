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
  /** Legacy Bybit optional flag — kept for backward compat */
  bybitOptional: boolean;
  /** If true, the worker runs in signal-forward-only mode without MT5 execution */
  mt5Optional: boolean;
  // ------------------------------------------------------------------
  // MT5 Lifecycle Manager settings (XAUUSD, 1 pip = $0.10)
  // ------------------------------------------------------------------
  /** Pips price must move in favour before break-even is triggered (default 20) */
  beTriggerPips: number;
  /** Pips above/below entry the SL is placed on break-even (default 2) */
  beBufferPips: number;
  /** Trailing stop step in pips — SL moves this many pips per tick (default 15) */
  trailStepPips: number;
  /** Extra buffer pips added to trailing stop (default 3) */
  stopBufferPips: number;
  /** Lifecycle poll interval in ms (default 2000) */
  lifecycleIntervalMs: number;
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
  mt5Optional: false,
  beTriggerPips: 20,
  beBufferPips: 2,
  trailStepPips: 15,
  stopBufferPips: 3,
  lifecycleIntervalMs: 2000,
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
            mt5_optional?: boolean;
            be_trigger_pips?: number;
            be_buffer_pips?: number;
            trail_step_pips?: number;
            stop_buffer_pips?: number;
            lifecycle_interval_ms?: number;
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
      bybitOptional: toBoolean(trading.bybit_optional, DEFAULT_SETTINGS.bybitOptional),
      mt5Optional: toBoolean(trading.mt5_optional, DEFAULT_SETTINGS.mt5Optional),
      beTriggerPips: toNumber(trading.be_trigger_pips, DEFAULT_SETTINGS.beTriggerPips),
      beBufferPips: toNumber(trading.be_buffer_pips, DEFAULT_SETTINGS.beBufferPips),
      trailStepPips: toNumber(trading.trail_step_pips, DEFAULT_SETTINGS.trailStepPips),
      stopBufferPips: toNumber(trading.stop_buffer_pips, DEFAULT_SETTINGS.stopBufferPips),
      lifecycleIntervalMs: toNumber(
        trading.lifecycle_interval_ms,
        DEFAULT_SETTINGS.lifecycleIntervalMs,
      ),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

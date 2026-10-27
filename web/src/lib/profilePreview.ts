/**
 * Execution preview for an execution profile: runs the same entry, stop-loss,
 * sizing and checkpoint steps the AutoTrader runs, against a sample signal and
 * quote. Pure (no I/O), so the validate route and the Profiles page share it.
 * Worker modules are imported through the @shared alias; see
 * docs/project_memory/OPTIMAL_REPORT_SCHEMA.md sections 4 to 6.
 */
import {
  effectiveLimits,
  resolveBrokerSymbol,
  type EffectiveLimits,
  type ExecutionProfile,
  type GoldSignalLike,
  type SafetyLimits,
} from '@shared/executionProfile';
import { decideEntry, validateStopLoss, type EntryDecision, type StopLossCheck } from '@shared/entryPolicy';
import {
  computeVolume,
  planCheckpoints,
  type CheckpointPlanResult,
  type SizingResult,
  type SizingSpec,
} from '@shared/positionSizing';

export type PreviewStage = 'symbol' | 'entry' | 'stop_loss' | 'sizing' | 'checkpoints';

export type PreviewSignal = GoldSignalLike;

export interface PreviewInput {
  signal: PreviewSignal;
  quote: { bid: number; ask: number };
  equity: number;
  spec: SizingSpec;
}

export interface ProfilePreview {
  /** True when every stage passed. */
  ok: boolean;
  /** First stage that refused the sample signal, or null. Later stages are null. */
  failedAt: PreviewStage | null;
  symbolMapped: boolean;
  brokerSymbol: string | null;
  limits: EffectiveLimits;
  entry: EntryDecision | null;
  stopLoss: StopLossCheck | null;
  sizing: SizingResult | null;
  checkpoints: CheckpointPlanResult | null;
}

/** Runs the profile against one sample signal. The stored safety limits cap every axis. */
export function buildProfilePreview(
  profile: ExecutionProfile,
  safety: SafetyLimits,
  input: PreviewInput,
): ProfilePreview {
  const { signal } = input;
  const limits = effectiveLimits(profile, safety);
  const brokerSymbol = resolveBrokerSymbol(profile, signal.symbol);
  const result: ProfilePreview = {
    ok: false,
    failedAt: null,
    symbolMapped: brokerSymbol !== null,
    brokerSymbol,
    limits,
    entry: null,
    stopLoss: null,
    sizing: null,
    checkpoints: null,
  };

  if (brokerSymbol === null) {
    result.failedAt = 'symbol';
    return result;
  }

  const entry = decideEntry(signal, input.quote, profile.entry);
  result.entry = entry;
  if (!entry.ok) {
    result.failedAt = 'entry';
    return result;
  }

  // Pending orders are sized and checked against their order price, as in the engine.
  const stopLoss = validateStopLoss(signal.direction, entry.entryRefPrice, signal.stopLoss, profile.stop_loss);
  result.stopLoss = stopLoss;
  if (!stopLoss.ok) {
    result.failedAt = 'stop_loss';
    return result;
  }

  const sizing = computeVolume({
    sizing: profile.sizing,
    entryPrice: entry.entryRefPrice,
    stopLoss: signal.stopLoss,
    equity: input.equity,
    spec: input.spec,
    limits,
  });
  result.sizing = sizing;
  if (!sizing.ok) {
    result.failedAt = 'sizing';
    return result;
  }

  const checkpoints = planCheckpoints({
    totalVolume: sizing.volume,
    direction: signal.direction,
    entryPrice: entry.entryRefPrice,
    takeProfits: signal.takeProfits,
    takeProfit: profile.take_profit,
    spec: input.spec,
  });
  result.checkpoints = checkpoints;
  if (!checkpoints.ok) {
    result.failedAt = 'checkpoints';
    return result;
  }

  result.ok = true;
  return result;
}

export type ParsedPreviewInput = { ok: true; value: PreviewInput } | { ok: false; error: string };

const DIRECTIONS = ['buy', 'sell'];
const ORDER_TYPES = ['market', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fail(error: string): ParsedPreviewInput {
  return { ok: false, error };
}

/**
 * Validates the untrusted preview payload from the client. Every number must be
 * finite; the symbol, direction and order type must be known values.
 */
export function parsePreviewInput(raw: unknown): ParsedPreviewInput {
  if (!isObject(raw)) return fail('preview must be an object');

  const sig = raw.signal;
  if (!isObject(sig)) return fail('preview.signal must be an object');

  const symbol = typeof sig.symbol === 'string' ? sig.symbol.trim().toUpperCase() : '';
  if (!symbol) return fail('preview.signal.symbol is required');
  if (typeof sig.direction !== 'string' || !DIRECTIONS.includes(sig.direction)) {
    return fail('preview.signal.direction must be buy or sell');
  }
  if (typeof sig.orderType !== 'string' || !ORDER_TYPES.includes(sig.orderType)) {
    return fail('preview.signal.orderType must be market, buy_limit, sell_limit, buy_stop or sell_stop');
  }

  const numbers: [string, number | null][] = [
    ['preview.signal.entryLow', finite(sig.entryLow)],
    ['preview.signal.entryHigh', finite(sig.entryHigh)],
    ['preview.signal.stopLoss', finite(sig.stopLoss)],
  ];
  const quote = isObject(raw.quote) ? raw.quote : {};
  numbers.push(['preview.quote.bid', finite(quote.bid)], ['preview.quote.ask', finite(quote.ask)]);
  numbers.push(['preview.equity', finite(raw.equity)]);
  const spec = isObject(raw.spec) ? raw.spec : {};
  numbers.push(
    ['preview.spec.tickSize', finite(spec.tickSize)],
    ['preview.spec.tickValueLoss', finite(spec.tickValueLoss)],
    ['preview.spec.volumeMin', finite(spec.volumeMin)],
    ['preview.spec.volumeMax', finite(spec.volumeMax)],
    ['preview.spec.volumeStep', finite(spec.volumeStep)],
  );
  const missing = numbers.find(([, value]) => value === null);
  if (missing) return fail(`${missing[0]} must be a number`);

  const takeProfits: number[] = [];
  if (!Array.isArray(sig.takeProfits)) return fail('preview.signal.takeProfits must be a list of numbers');
  for (const item of sig.takeProfits) {
    const value = finite(item);
    if (value === null) return fail('preview.signal.takeProfits must be a list of numbers');
    takeProfits.push(value);
  }

  return {
    ok: true,
    value: {
      signal: {
        symbol,
        direction: sig.direction as GoldSignalLike['direction'],
        orderType: sig.orderType as GoldSignalLike['orderType'],
        entryLow: finite(sig.entryLow) as number,
        entryHigh: finite(sig.entryHigh) as number,
        stopLoss: finite(sig.stopLoss) as number,
        takeProfits,
      },
      quote: { bid: finite(quote.bid) as number, ask: finite(quote.ask) as number },
      equity: finite(raw.equity) as number,
      spec: {
        tickSize: finite(spec.tickSize) as number,
        tickValueLoss: finite(spec.tickValueLoss) as number,
        volumeMin: finite(spec.volumeMin) as number,
        volumeMax: finite(spec.volumeMax) as number,
        volumeStep: finite(spec.volumeStep) as number,
      },
    },
  };
}

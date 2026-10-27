/**
 * Volume sizing and take-profit checkpoint planning. Pure functions; imports
 * types only. Volumes are computed in integer step units to avoid float drift.
 * See docs/project_memory/VANTAGE_DESIGN_CONTRACTS.md section 3.
 */
import type { EffectiveLimits, ExecutionProfile } from './executionProfile.js';

export interface SizingSpec {
  tickSize: number;
  tickValueLoss: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
}

const EPS = 1e-9;

/** Decimal places needed to render volumes in steps of `step` (e.g. 0.01 -> 2). */
export function volumeDecimals(step: number): number {
  for (let d = 0; d <= 8; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d;
  }
  return 8;
}

/** Rounds a volume down to a whole number of steps. */
export function roundVolumeDown(volume: number, step: number): number {
  const units = Math.floor(volume / step + EPS);
  return Number((units * step).toFixed(volumeDecimals(step)));
}

/** Money lost per lot when price moves from entry to stop loss. */
export function riskPerLot(entry: number, stopLoss: number, spec: SizingSpec): number {
  return (Math.abs(entry - stopLoss) / spec.tickSize) * spec.tickValueLoss;
}

export type SizingFailure =
  | 'invalid_stop_distance'
  | 'invalid_symbol_spec'
  | 'missing_sizing_value'
  | 'volume_below_min'
  | 'volume_exceeds_max'
  | 'volume_not_step_aligned'
  | 'risk_exceeds_limit'
  | 'invalid_equity';

export type SizingResult =
  | { ok: true; volume: number; riskMoney: number; riskPercent: number; clampedBy?: 'volume_max' | 'max_lots' }
  | { ok: false; reason: SizingFailure; detail: string };

function fail(reason: SizingFailure, detail: string): SizingResult {
  return { ok: false, reason, detail };
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validSpec(spec: SizingSpec): boolean {
  return (
    isPositive(spec.tickSize) &&
    isPositive(spec.tickValueLoss) &&
    isPositive(spec.volumeMin) &&
    isPositive(spec.volumeMax) &&
    isPositive(spec.volumeStep) &&
    spec.volumeMax >= spec.volumeMin
  );
}

export function computeVolume(i: {
  sizing: ExecutionProfile['sizing'];
  entryPrice: number;
  stopLoss: number;
  equity: number;
  spec: SizingSpec;
  limits: Pick<EffectiveLimits, 'maxRiskMoney' | 'maxRiskPercent' | 'maxLots'>;
}): SizingResult {
  const { sizing, entryPrice, stopLoss, equity, spec, limits } = i;
  if (!validSpec(spec)) {
    return fail('invalid_symbol_spec', 'symbol spec has non-positive or inconsistent volume/tick values');
  }
  const distance = Math.abs(entryPrice - stopLoss);
  if (!Number.isFinite(distance) || distance <= 0) {
    return fail('invalid_stop_distance', `entry ${entryPrice} and stop ${stopLoss} must differ`);
  }
  if (!isPositive(equity)) {
    return fail('invalid_equity', `equity must be > 0 (got ${equity})`);
  }

  const perLot = riskPerLot(entryPrice, stopLoss, spec);
  const cap = Math.min(limits.maxRiskMoney, (equity * limits.maxRiskPercent) / 100);
  const maxVolume = Math.min(spec.volumeMax, limits.maxLots);
  const step = spec.volumeStep;

  let volume: number;
  let clampedBy: 'volume_max' | 'max_lots' | undefined;
  if (sizing.mode === 'fixed_lots') {
    if (!isPositive(sizing.fixed_lots ?? NaN)) {
      return fail('missing_sizing_value', 'sizing.fixed_lots must be > 0 for mode fixed_lots');
    }
    const lots = sizing.fixed_lots as number;
    const units = lots / step;
    if (Math.abs(units - Math.round(units)) > EPS) {
      return fail(
        'volume_not_step_aligned',
        `fixed_lots ${lots} is not a multiple of volume step ${step}`,
      );
    }
    volume = roundVolumeDown(lots, step);
    // Never clamped: an oversized fixed lot size is refused, not resized.
    if (volume > maxVolume + EPS) {
      return fail(
        'volume_exceeds_max',
        `fixed_lots ${lots} exceeds max ${maxVolume} (min of volumeMax ${spec.volumeMax} and maxLots ${limits.maxLots})`,
      );
    }
  } else {
    let target: number;
    if (sizing.mode === 'fixed_risk_money') {
      if (!isPositive(sizing.risk_money ?? NaN)) {
        return fail('missing_sizing_value', 'sizing.risk_money must be > 0 for mode fixed_risk_money');
      }
      target = sizing.risk_money as number;
    } else {
      if (!isPositive(sizing.risk_percent ?? NaN)) {
        return fail('missing_sizing_value', 'sizing.risk_percent must be > 0 for mode equity_risk_percent');
      }
      target = (equity * (sizing.risk_percent as number)) / 100;
    }
    volume = roundVolumeDown(Math.min(target, cap) / perLot, step);
    // Risk-derived sizes may clamp down: that only reduces risk, and it is reported.
    if (volume > maxVolume + EPS) {
      volume = roundVolumeDown(maxVolume, step);
      clampedBy = spec.volumeMax <= limits.maxLots ? 'volume_max' : 'max_lots';
    }
  }

  if (volume + EPS < spec.volumeMin) {
    const canUseMin =
      sizing.below_min_volume === 'use_min_if_within_cap' &&
      spec.volumeMin <= maxVolume + EPS &&
      perLot * spec.volumeMin <= cap + EPS;
    if (!canUseMin) {
      return fail(
        'volume_below_min',
        `volume ${volume} below min ${spec.volumeMin} (policy ${sizing.below_min_volume})`,
      );
    }
    volume = spec.volumeMin;
    clampedBy = undefined;
  }

  const riskMoney = volume * perLot;
  if (riskMoney > cap + EPS) {
    return fail('risk_exceeds_limit', `risk ${riskMoney.toFixed(2)} exceeds cap ${cap.toFixed(2)}`);
  }

  const result: SizingResult = {
    ok: true,
    volume,
    riskMoney,
    riskPercent: (riskMoney / equity) * 100,
  };
  if (clampedBy) result.clampedBy = clampedBy;
  return result;
}

export interface PlannedCheckpoint {
  tpIndex: number;
  price: number;
  closePercent: number;
  closeVolume: number;
  targetRemainingVolume: number;
}

export type CheckpointPlanResult =
  | { ok: true; checkpoints: PlannedCheckpoint[]; brokerTp: number; warnings: string[] }
  | { ok: false; reason: 'tp_missing' | 'tp_order_invalid' | 'tp_split_infeasible'; detail: string };

interface Candidate {
  tpIndex: number;
  price: number;
  percent: number;
}

function planFailure(reason: 'tp_missing' | 'tp_order_invalid' | 'tp_split_infeasible', detail: string): CheckpointPlanResult {
  return { ok: false, reason, detail };
}

/** Volumes for a candidate list: non-final rounded down, final takes the remainder. */
function splitVolumes(total: number, candidates: Candidate[], step: number): { closes: number[]; remaining: number[] } {
  const closes: number[] = [];
  let allocated = 0;
  candidates.forEach((c, k) => {
    const close =
      k === candidates.length - 1
        ? Number((total - allocated).toFixed(volumeDecimals(step)))
        : roundVolumeDown((total * c.percent) / 100, step);
    closes.push(close);
    allocated += close;
  });
  const remaining: number[] = [];
  let left = total;
  closes.forEach((close) => {
    left = Number((left - close).toFixed(volumeDecimals(step)));
    remaining.push(left);
  });
  return { closes, remaining };
}

/**
 * Finds the first checkpoint that makes the split infeasible: a close below
 * volumeMin, or a non-final remainder below volumeMin.
 */
function firstUndersized(
  closes: number[],
  remaining: number[],
  volumeMin: number,
): number {
  for (let k = 0; k < closes.length; k++) {
    if (closes[k] + EPS < volumeMin) return k;
    if (k < closes.length - 1 && remaining[k] + EPS < volumeMin) return k;
  }
  return -1;
}

export function planCheckpoints(i: {
  totalVolume: number;
  direction: 'buy' | 'sell';
  entryPrice: number;
  takeProfits: number[];
  takeProfit: ExecutionProfile['take_profit'];
  spec: Pick<SizingSpec, 'volumeMin' | 'volumeStep'>;
}): CheckpointPlanResult {
  const { totalVolume, direction, entryPrice, takeProfits, takeProfit, spec } = i;
  const warnings: string[] = [];

  let candidates: Candidate[] = [];
  const missing: number[] = [];
  for (const cp of takeProfit.checkpoints) {
    const price = takeProfits[cp.tp_index - 1];
    if (price === undefined || !Number.isFinite(price)) {
      missing.push(cp.tp_index);
    } else {
      candidates.push({ tpIndex: cp.tp_index, price, percent: cp.close_percent });
    }
  }

  if (missing.length > 0) {
    if (takeProfit.missing_tp === 'skip_trade' || candidates.length === 0) {
      return planFailure('tp_missing', `missing take profit(s): TP${missing.join(', TP')}`);
    }
    // Fold each missing checkpoint's percent into the highest existing one.
    const folded = takeProfit.checkpoints
      .filter((cp) => missing.includes(cp.tp_index))
      .reduce((sum, cp) => sum + cp.close_percent, 0);
    const last = candidates[candidates.length - 1];
    last.percent += folded;
    warnings.push(`TP${missing.join(', TP')} missing; ${folded}% merged into TP${last.tpIndex}`);
  }

  // Strictly beyond entry and monotonic in trade direction.
  for (let k = 0; k < candidates.length; k++) {
    const c = candidates[k];
    const beyondEntry = direction === 'buy' ? c.price > entryPrice : c.price < entryPrice;
    if (!beyondEntry) {
      return planFailure('tp_order_invalid', `TP${c.tpIndex} ${c.price} is not beyond entry ${entryPrice} for ${direction}`);
    }
    if (k > 0) {
      const prev = candidates[k - 1].price;
      const monotonic = direction === 'buy' ? c.price > prev : c.price < prev;
      if (!monotonic) {
        return planFailure('tp_order_invalid', `TP${c.tpIndex} ${c.price} is not beyond TP${candidates[k - 1].tpIndex} ${prev}`);
      }
    }
  }

  if (!isPositiveVolume(totalVolume) || totalVolume + EPS < spec.volumeMin) {
    return planFailure('tp_split_infeasible', `total volume ${totalVolume} below min ${spec.volumeMin}`);
  }

  // Merge undersized checkpoints until every split is feasible. A single
  // checkpoint closing 100% always is.
  for (;;) {
    const { closes, remaining } = splitVolumes(totalVolume, candidates, spec.volumeStep);
    const bad = firstUndersized(closes, remaining, spec.volumeMin);
    if (bad === -1) {
      const decimals = volumeDecimals(spec.volumeStep);
      const checkpoints: PlannedCheckpoint[] = candidates.map((c, k) => ({
        tpIndex: c.tpIndex,
        price: c.price,
        closePercent: c.percent,
        closeVolume: closes[k],
        targetRemainingVolume: k === candidates.length - 1 ? 0 : Number(remaining[k].toFixed(decimals)),
      }));
      const final = candidates[candidates.length - 1];
      return {
        ok: true,
        checkpoints,
        brokerTp: takeProfit.broker_tp === 'final_checkpoint' ? final.price : 0,
        warnings,
      };
    }
    if (takeProfit.infeasible_split === 'skip_trade' || candidates.length === 1) {
      return planFailure(
        'tp_split_infeasible',
        `TP${candidates[bad].tpIndex} split below volume min ${spec.volumeMin} for total ${totalVolume}`,
      );
    }
    // Fold into the next checkpoint, or into the previous one when the bad one is last.
    const target = bad < candidates.length - 1 ? bad + 1 : bad - 1;
    const removed = candidates[bad];
    const receiver = candidates[target];
    receiver.percent += removed.percent;
    candidates = candidates.filter((_, k) => k !== bad);
    warnings.push(`TP${removed.tpIndex} split infeasible; merged ${removed.percent}% into TP${receiver.tpIndex}`);
  }
}

function isPositiveVolume(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

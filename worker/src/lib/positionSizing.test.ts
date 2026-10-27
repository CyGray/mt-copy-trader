import { describe, expect, it } from 'vitest';
import {
  computeVolume,
  planCheckpoints,
  riskPerLot,
  roundVolumeDown,
  volumeDecimals,
} from './positionSizing.js';
import type { SizingSpec } from './positionSizing.js';
import type { ExecutionProfile } from './executionProfile.js';

/** XAUUSD-like: 1 lot loses $100 per $1 move (tick 0.01, tick value 1.0). */
const SPEC: SizingSpec = {
  tickSize: 0.01,
  tickValueLoss: 1.0,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
};

const LIMITS = { maxRiskMoney: 5000, maxRiskPercent: 5, maxLots: 20 };

type Sizing = ExecutionProfile['sizing'];

function sizing(overrides: Partial<Sizing>): Sizing {
  return { mode: 'equity_risk_percent', risk_percent: 0.5, below_min_volume: 'skip', ...overrides };
}

function size(
  s: Sizing,
  opts: { entry?: number; sl?: number; equity?: number; spec?: SizingSpec; limits?: typeof LIMITS } = {},
) {
  return computeVolume({
    sizing: s,
    entryPrice: opts.entry ?? 2000,
    stopLoss: opts.sl ?? 1995,
    equity: opts.equity ?? 10000,
    spec: opts.spec ?? SPEC,
    limits: opts.limits ?? LIMITS,
  });
}

function takeProfit(
  checkpoints: { tp_index: number; close_percent: number }[],
  overrides: Partial<ExecutionProfile['take_profit']> = {},
): ExecutionProfile['take_profit'] {
  return {
    checkpoints,
    missing_tp: 'skip_trade',
    infeasible_split: 'skip_trade',
    broker_tp: 'final_checkpoint',
    ...overrides,
  };
}

const CHECKPOINTS_50_30_20 = [
  { tp_index: 1, close_percent: 50 },
  { tp_index: 2, close_percent: 30 },
  { tp_index: 3, close_percent: 20 },
];

describe('volumeDecimals and roundVolumeDown', () => {
  it('derives the decimal count from the step', () => {
    expect(volumeDecimals(0.01)).toBe(2);
    expect(volumeDecimals(0.1)).toBe(1);
    expect(volumeDecimals(1)).toBe(0);
    expect(volumeDecimals(0.001)).toBe(3);
  });

  it('rounds down to whole steps without float drift', () => {
    expect(roundVolumeDown(0.07, 0.01)).toBe(0.07);
    expect(roundVolumeDown(0.3, 0.1)).toBe(0.3);
    expect(roundVolumeDown(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(roundVolumeDown(0.29999, 0.1)).toBe(0.2);
    expect(roundVolumeDown(0.1549, 0.01)).toBe(0.15);
    expect(roundVolumeDown(0.004, 0.01)).toBe(0);
    expect(roundVolumeDown(7.9, 1)).toBe(7);
  });
});

describe('riskPerLot', () => {
  it('is ticks moved times tick value loss', () => {
    expect(riskPerLot(2000, 1995, SPEC)).toBeCloseTo(500);
    expect(riskPerLot(1995, 2000, SPEC)).toBeCloseTo(500);
  });
});

describe('computeVolume', () => {
  describe('risk modes', () => {
    it('sizes a BUY from equity_risk_percent: 0.5% of 10000 over a $5 stop = 0.10 lots', () => {
      const r = size(sizing({}), { entry: 2000, sl: 1995 });
      expect(r).toMatchObject({ ok: true, volume: 0.1, riskMoney: 50 });
      expect(r.ok && r.riskPercent).toBeCloseTo(0.5);
    });

    it('sizes a SELL the same way', () => {
      const r = size(sizing({}), { entry: 2000, sl: 2005 });
      expect(r).toMatchObject({ ok: true, volume: 0.1, riskMoney: 50 });
    });

    it('sizes from fixed_risk_money for BUY and SELL', () => {
      const buy = size(sizing({ mode: 'fixed_risk_money', risk_money: 50, risk_percent: undefined }));
      expect(buy.ok && buy.volume).toBe(0.1);
      const sell = size(sizing({ mode: 'fixed_risk_money', risk_money: 50, risk_percent: undefined }), { entry: 2000, sl: 2005 });
      expect(sell.ok && sell.volume).toBe(0.1);
    });

    it('caps the target at the risk cap instead of failing', () => {
      // 2% of 10000 = 200 target, cap = min(maxRiskMoney 50, 10000 * 5%) = 50.
      const r = size(sizing({ risk_percent: 2 }), { limits: { ...LIMITS, maxRiskMoney: 50 } });
      expect(r).toMatchObject({ ok: true, volume: 0.1, riskMoney: 50 });
    });

    it('caps by maxRiskPercent of equity when smaller than maxRiskMoney', () => {
      // equity 1000 -> percent cap 50; risk_money 500 target capped to 50.
      const r = size(sizing({ mode: 'fixed_risk_money', risk_money: 500, risk_percent: undefined }), { equity: 1000 });
      expect(r.ok && r.volume).toBe(0.1);
      expect(r.ok && r.riskMoney).toBe(50);
    });

    it('rounds the volume down to the step', () => {
      // risk 49.9 over $500 per lot = 0.0998 lots, rounded down to 0.09 (not 0.1).
      const r = size(sizing({ mode: 'fixed_risk_money', risk_money: 49.9, risk_percent: undefined }));
      expect(r.ok && r.volume).toBe(0.09);
    });

    it('fails missing_sizing_value when the matching field is absent or non-positive', () => {
      const missing = size(sizing({ mode: 'fixed_risk_money', risk_money: undefined, risk_percent: undefined }));
      expect(missing).toMatchObject({ ok: false, reason: 'missing_sizing_value' });
      const zero = size(sizing({ mode: 'equity_risk_percent', risk_percent: 0 }));
      expect(zero).toMatchObject({ ok: false, reason: 'missing_sizing_value' });
    });
  });

  describe('fixed_lots', () => {
    it('uses the fixed lot size when it fits the risk cap', () => {
      const r = size({ mode: 'fixed_lots', fixed_lots: 0.1, below_min_volume: 'skip' });
      expect(r).toMatchObject({ ok: true, volume: 0.1, riskMoney: 50 });
    });

    it('fails risk_exceeds_limit and does not resize when risk is above the cap', () => {
      const r = size({ mode: 'fixed_lots', fixed_lots: 1, below_min_volume: 'skip' }, { limits: { ...LIMITS, maxRiskMoney: 50 } });
      expect(r).toMatchObject({ ok: false, reason: 'risk_exceeds_limit' });
    });

    it('fails risk_exceeds_limit when the percent cap is the binding one', () => {
      // equity 1000 -> percent cap 50; 0.2 lots risks 100.
      const r = size({ mode: 'fixed_lots', fixed_lots: 0.2, below_min_volume: 'skip' }, { equity: 1000 });
      expect(r).toMatchObject({ ok: false, reason: 'risk_exceeds_limit' });
    });

    it('fails missing_sizing_value when fixed_lots is absent', () => {
      const r = size({ mode: 'fixed_lots', below_min_volume: 'skip' });
      expect(r).toMatchObject({ ok: false, reason: 'missing_sizing_value' });
    });
  });

  describe('fixed_lots strictness', () => {
    it('accepts fixed_lots exactly at min(volumeMax, maxLots)', () => {
      // 20 lots over a $5 stop risks $10,000: needs a $20,000 cap.
      const r = size(
        { mode: 'fixed_lots', fixed_lots: 20, below_min_volume: 'skip' },
        { equity: 1000000, limits: { maxRiskMoney: 20000, maxRiskPercent: 5, maxLots: 20 } },
      );
      expect(r).toMatchObject({ ok: true, volume: 20, riskMoney: 10000 });
      expect(r.ok && r.clampedBy).toBeUndefined();
    });

    it('fails volume_exceeds_max when fixed_lots is above volumeMax', () => {
      const r = size(
        { mode: 'fixed_lots', fixed_lots: 25, below_min_volume: 'skip' },
        { equity: 1000000, spec: { ...SPEC, volumeMax: 20 }, limits: { ...LIMITS, maxRiskMoney: 1000000 } },
      );
      expect(r).toMatchObject({ ok: false, reason: 'volume_exceeds_max' });
    });

    it('fails volume_exceeds_max for fixed_lots 25 against maxLots 20, without clamping', () => {
      const r = size(
        { mode: 'fixed_lots', fixed_lots: 25, below_min_volume: 'skip' },
        { equity: 1000000, limits: { maxRiskMoney: 1000000, maxRiskPercent: 100, maxLots: 20 } },
      );
      expect(r).toMatchObject({ ok: false, reason: 'volume_exceeds_max' });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.detail).toContain('25');
    });

    it('fails volume_not_step_aligned instead of rounding', () => {
      for (const lots of [0.105, 0.005, 0.015]) {
        const r = size({ mode: 'fixed_lots', fixed_lots: lots, below_min_volume: 'skip' });
        expect(r).toMatchObject({ ok: false, reason: 'volume_not_step_aligned' });
      }
    });

    it('accepts step-aligned fixed_lots with float representation noise', () => {
      const r = size({ mode: 'fixed_lots', fixed_lots: 0.07, below_min_volume: 'skip' });
      expect(r).toMatchObject({ ok: true, volume: 0.07 });
      const tenth = size(
        { mode: 'fixed_lots', fixed_lots: 0.3, below_min_volume: 'skip' },
        { spec: { ...SPEC, volumeStep: 0.1 } },
      );
      expect(tenth).toMatchObject({ ok: true, volume: 0.3 });
    });

    it('still clamps risk-derived volumes down and sets clampedBy', () => {
      const r = size(sizing({ mode: 'fixed_risk_money', risk_money: 5000, risk_percent: undefined }), {
        equity: 1000000,
        limits: { ...LIMITS, maxLots: 1 },
      });
      expect(r).toMatchObject({ ok: true, volume: 1, clampedBy: 'max_lots' });
    });
  });

  describe('clamping', () => {
    it('clamps to maxLots and reports clampedBy max_lots', () => {
      const r = size(sizing({ mode: 'fixed_risk_money', risk_money: 5000, risk_percent: undefined }), {
        equity: 1000000,
        limits: { ...LIMITS, maxLots: 1 },
      });
      expect(r).toMatchObject({ ok: true, volume: 1, riskMoney: 500, clampedBy: 'max_lots' });
    });

    it('clamps to the symbol volumeMax and reports clampedBy volume_max', () => {
      const r = size(sizing({ mode: 'fixed_risk_money', risk_money: 5000, risk_percent: undefined }), {
        equity: 1000000,
        spec: { ...SPEC, volumeMax: 2 },
      });
      expect(r).toMatchObject({ ok: true, volume: 2, clampedBy: 'volume_max' });
    });

    it('does not clamp fixed_lots above maxLots: fails volume_exceeds_max', () => {
      const r = size(
        { mode: 'fixed_lots', fixed_lots: 3, below_min_volume: 'skip' },
        { equity: 1000000, limits: { ...LIMITS, maxLots: 2 } },
      );
      expect(r).toMatchObject({ ok: false, reason: 'volume_exceeds_max' });
      expect(r.ok).toBe(false);
    });
  });

  describe('below minimum volume', () => {
    // equity 500 -> percent cap 25; 0.5% of 500 = 2.5 risk -> 0.005 lot rounds to 0.
    const tiny = sizing({ risk_percent: 0.5 });

    it('skip fails volume_below_min', () => {
      const r = size({ ...tiny, below_min_volume: 'skip' }, { equity: 500 });
      expect(r).toMatchObject({ ok: false, reason: 'volume_below_min' });
    });

    it('use_min_if_within_cap uses volumeMin when its risk fits the cap', () => {
      // 0.01 lot over a $5 stop costs $5, which is within the $25 cap.
      const r = size({ ...tiny, below_min_volume: 'use_min_if_within_cap' }, { equity: 500 });
      expect(r).toMatchObject({ ok: true, volume: 0.01, riskMoney: 5 });
    });

    it('use_min_if_within_cap still fails when volumeMin risk exceeds the cap', () => {
      const r = size(
        { ...tiny, below_min_volume: 'use_min_if_within_cap' },
        { equity: 500, limits: { ...LIMITS, maxRiskMoney: 1 } },
      );
      expect(r).toMatchObject({ ok: false, reason: 'volume_below_min' });
    });

    it('fixed_lots below min follows the same policy', () => {
      // 0.01 is step-aligned but below a 0.05 minimum.
      const spec = { ...SPEC, volumeMin: 0.05 };
      const skip = size({ mode: 'fixed_lots', fixed_lots: 0.01, below_min_volume: 'skip' }, { spec });
      expect(skip).toMatchObject({ ok: false, reason: 'volume_below_min' });
      const useMin = size(
        { mode: 'fixed_lots', fixed_lots: 0.01, below_min_volume: 'use_min_if_within_cap' },
        { spec },
      );
      expect(useMin).toMatchObject({ ok: true, volume: 0.05, riskMoney: 25 });
    });

    it('fails when maxLots is below volumeMin even with use_min', () => {
      const r = size(
        { ...tiny, below_min_volume: 'use_min_if_within_cap' },
        { equity: 500, spec: { ...SPEC, volumeMin: 0.5 }, limits: { ...LIMITS, maxLots: 0.2 } },
      );
      expect(r).toMatchObject({ ok: false, reason: 'volume_below_min' });
    });
  });

  describe('invalid inputs', () => {
    it('rejects zero or inverted symbol specs', () => {
      expect(size(sizing({}), { spec: { ...SPEC, tickSize: 0 } })).toMatchObject({ reason: 'invalid_symbol_spec' });
      expect(size(sizing({}), { spec: { ...SPEC, tickValueLoss: -1 } })).toMatchObject({ reason: 'invalid_symbol_spec' });
      expect(size(sizing({}), { spec: { ...SPEC, volumeStep: 0 } })).toMatchObject({ reason: 'invalid_symbol_spec' });
      expect(size(sizing({}), { spec: { ...SPEC, volumeMax: 0.001 } })).toMatchObject({ reason: 'invalid_symbol_spec' });
    });

    it('rejects a zero stop distance', () => {
      expect(size(sizing({}), { entry: 2000, sl: 2000 })).toMatchObject({ ok: false, reason: 'invalid_stop_distance' });
    });

    it('rejects non-positive equity for every mode', () => {
      expect(size(sizing({}), { equity: 0 })).toMatchObject({ ok: false, reason: 'invalid_equity' });
      expect(
        size({ mode: 'fixed_lots', fixed_lots: 0.1, below_min_volume: 'skip' }, { equity: -5 }),
      ).toMatchObject({ ok: false, reason: 'invalid_equity' });
    });
  });
});

describe('planCheckpoints', () => {
  const base = {
    totalVolume: 0.1,
    direction: 'buy' as const,
    entryPrice: 2000,
    takeProfits: [2005, 2010, 2015],
    spec: { volumeMin: 0.01, volumeStep: 0.01 },
  };

  it('splits 0.10 lots 50/30/20 into 0.05/0.03/0.02 summing exactly to total', () => {
    const r = planCheckpoints({ ...base, takeProfit: takeProfit(CHECKPOINTS_50_30_20) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checkpoints.map((c) => c.closeVolume)).toEqual([0.05, 0.03, 0.02]);
    expect(r.checkpoints.map((c) => c.targetRemainingVolume)).toEqual([0.05, 0.02, 0]);
    expect(r.checkpoints.map((c) => c.price)).toEqual([2005, 2010, 2015]);
    expect(r.checkpoints.map((c) => c.tpIndex)).toEqual([1, 2, 3]);
    const sum = r.checkpoints.reduce((acc, c) => acc + c.closeVolume, 0);
    expect(Math.abs(sum - 0.1)).toBeLessThan(1e-9);
    expect(r.brokerTp).toBe(2015);
    expect(r.warnings).toEqual([]);
  });

  it('plans SELL with descending TP prices', () => {
    const r = planCheckpoints({
      ...base,
      direction: 'sell',
      takeProfits: [1995, 1990, 1985],
      takeProfit: takeProfit(CHECKPOINTS_50_30_20),
    });
    expect(r.ok && r.checkpoints.map((c) => c.closeVolume)).toEqual([0.05, 0.03, 0.02]);
    expect(r.ok && r.brokerTp).toBe(1985);
  });

  it('brokerTp is 0 when broker_tp is none', () => {
    const r = planCheckpoints({ ...base, takeProfit: takeProfit(CHECKPOINTS_50_30_20, { broker_tp: 'none' }) });
    expect(r.ok && r.brokerTp).toBe(0);
  });

  it('fails tp_order_invalid when a BUY TP is not beyond entry', () => {
    const r = planCheckpoints({
      ...base,
      takeProfits: [2000, 2010, 2015],
      takeProfit: takeProfit(CHECKPOINTS_50_30_20),
    });
    expect(r).toMatchObject({ ok: false, reason: 'tp_order_invalid' });
  });

  it('fails tp_order_invalid when a SELL TP is above entry', () => {
    const r = planCheckpoints({
      ...base,
      direction: 'sell',
      takeProfits: [1995, 2010, 1985],
      takeProfit: takeProfit(CHECKPOINTS_50_30_20),
    });
    expect(r).toMatchObject({ ok: false, reason: 'tp_order_invalid' });
  });

  it('fails tp_order_invalid when BUY TPs are not ascending', () => {
    const r = planCheckpoints({
      ...base,
      takeProfits: [2005, 2003, 2010],
      takeProfit: takeProfit(CHECKPOINTS_50_30_20),
    });
    expect(r).toMatchObject({ ok: false, reason: 'tp_order_invalid' });
  });

  it('fails tp_order_invalid when SELL TPs are ascending', () => {
    const r = planCheckpoints({
      ...base,
      direction: 'sell',
      takeProfits: [1995, 1990, 1992],
      takeProfit: takeProfit(CHECKPOINTS_50_30_20),
    });
    expect(r).toMatchObject({ ok: false, reason: 'tp_order_invalid' });
  });

  describe('missing TP', () => {
    const takeProfitsWithoutTp3 = [2005, 2010];

    it('skip_trade fails tp_missing', () => {
      const r = planCheckpoints({
        ...base,
        takeProfits: takeProfitsWithoutTp3,
        takeProfit: takeProfit(CHECKPOINTS_50_30_20, { missing_tp: 'skip_trade' }),
      });
      expect(r).toMatchObject({ ok: false, reason: 'tp_missing' });
    });

    it('merge_into_last_available folds the missing percent into the highest existing checkpoint', () => {
      const r = planCheckpoints({
        ...base,
        takeProfits: takeProfitsWithoutTp3,
        takeProfit: takeProfit(CHECKPOINTS_50_30_20, { missing_tp: 'merge_into_last_available' }),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.checkpoints.map((c) => [c.tpIndex, c.closePercent, c.closeVolume])).toEqual([
        [1, 50, 0.05],
        [2, 50, 0.05],
      ]);
      expect(r.brokerTp).toBe(2010);
      expect(r.warnings).toHaveLength(1);
    });

    it('merge_into_last_available with only TP1 present closes 100% at TP1', () => {
      const r = planCheckpoints({
        ...base,
        takeProfits: [2005],
        takeProfit: takeProfit(CHECKPOINTS_50_30_20, { missing_tp: 'merge_into_last_available' }),
      });
      expect(r.ok && r.checkpoints).toEqual([
        { tpIndex: 1, price: 2005, closePercent: 100, closeVolume: 0.1, targetRemainingVolume: 0 },
      ]);
    });

    it('fails tp_missing when no selected TP exists, even with merge', () => {
      const r = planCheckpoints({
        ...base,
        takeProfits: [],
        takeProfit: takeProfit(CHECKPOINTS_50_30_20, { missing_tp: 'merge_into_last_available' }),
      });
      expect(r).toMatchObject({ ok: false, reason: 'tp_missing' });
    });
  });

  describe('infeasible split (0.01 lot)', () => {
    it('skip_trade fails tp_split_infeasible', () => {
      const r = planCheckpoints({
        ...base,
        totalVolume: 0.01,
        takeProfit: takeProfit(CHECKPOINTS_50_30_20, { infeasible_split: 'skip_trade' }),
      });
      expect(r).toMatchObject({ ok: false, reason: 'tp_split_infeasible' });
    });

    it('merge_into_next folds undersized checkpoints until one checkpoint closes 100%', () => {
      const r = planCheckpoints({
        ...base,
        totalVolume: 0.01,
        takeProfit: takeProfit(CHECKPOINTS_50_30_20, { infeasible_split: 'merge_into_next' }),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.checkpoints).toEqual([
        { tpIndex: 3, price: 2015, closePercent: 100, closeVolume: 0.01, targetRemainingVolume: 0 },
      ]);
      expect(r.brokerTp).toBe(2015);
      expect(r.warnings).toHaveLength(2);
    });

    it('merge_into_next keeps feasible checkpoints when only one is undersized', () => {
      // 0.02 lots: TP1 closes 0.01, TP2 rounds to 0 (undersized) and folds into TP3.
      const r = planCheckpoints({
        ...base,
        totalVolume: 0.02,
        takeProfit: takeProfit(CHECKPOINTS_50_30_20, { infeasible_split: 'merge_into_next' }),
      });
      expect(r.ok && r.checkpoints.map((c) => [c.tpIndex, c.closeVolume])).toEqual([
        [1, 0.01],
        [3, 0.01],
      ]);
    });

    it('fails tp_split_infeasible when the total is below volumeMin', () => {
      const r = planCheckpoints({
        ...base,
        totalVolume: 0.005,
        takeProfit: takeProfit(CHECKPOINTS_50_30_20, { infeasible_split: 'merge_into_next' }),
      });
      expect(r).toMatchObject({ ok: false, reason: 'tp_split_infeasible' });
    });
  });
});

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_LIMITS,
  HARD_CEILINGS,
  effectiveLimits,
  profileDocId,
  resolveBrokerSymbol,
  validateProfile,
  validateProfileAgainstSafety,
  validateSafetyLimits,
} from './executionProfile.js';
import type { ExecutionProfile, SafetyLimits } from './executionProfile.js';

type Node = Record<string, unknown>;

const BASE: Node = {
  schema_version: 1,
  profile_id: 'xauusd-test-profile',
  version: 1,
  name: 'XAUUSD test profile',
  source: { type: 'optimal_report', report_id: 'R-1', report_date: '2026-01-01' },
  broker: 'vantage_mt5',
  symbols: [{ signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD+' }],
  entry: {
    policy: 'pending_at_range',
    market_tolerance_price: 0.5,
    pending_expiry_minutes: 60,
    allow_market_fallback: false,
  },
  sizing: { mode: 'equity_risk_percent', risk_percent: 0.5, below_min_volume: 'skip' },
  take_profit: {
    checkpoints: [
      { tp_index: 1, close_percent: 50 },
      { tp_index: 2, close_percent: 30 },
      { tp_index: 3, close_percent: 20 },
    ],
    missing_tp: 'skip_trade',
    infeasible_split: 'merge_into_next',
    broker_tp: 'final_checkpoint',
  },
  stop_loss: {
    min_distance_price: 2,
    max_distance_price: 25,
    after_checkpoint: [
      { after_tp_index: 1, move_to: 'entry', buffer_price: 0.2 },
      { after_tp_index: 2, move_to: 'previous_tp', buffer_price: 0 },
    ],
  },
  break_even: { enabled: false, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 },
  trailing: {
    enabled: false,
    activation: 'after_tp_index',
    activation_value: 2,
    distance_price: 3,
    step_price: 0.5,
  },
  limits: {
    max_concurrent_positions: 3,
    max_positions_per_symbol: 1,
    max_spread_price: 0.5,
    max_deviation_points: 30,
    signal_max_age_sec: 120,
    daily_loss_limit_money: 100,
    max_total_risk_percent: 3,
  },
  edits: {
    before_fill: 'apply_sl_tp',
    after_fill: 'apply_tighten_only',
    unparseable_edit: 'cancel_pending_only',
    explicit_cancel: 'cancel_pending_only',
  },
};

/** Fresh deep copy of the base profile so each test can mutate it freely. */
function profile(): Node {
  return JSON.parse(JSON.stringify(BASE)) as Node;
}

function node(value: unknown): Node {
  return value as Node;
}

function errorPaths(input: unknown): string[] {
  return validateProfile(input).errors.map((e) => e.path);
}

function expectError(input: unknown, path: string): void {
  const result = validateProfile(input);
  expect(result.ok).toBe(false);
  expect(result.errors.map((e) => e.path)).toContain(path);
}

describe('validateProfile', () => {
  it('accepts a valid profile and returns a deep copy', () => {
    const input = profile();
    const result = validateProfile(input);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.value).toEqual(input);
    expect(result.value).not.toBe(input);
    node(result.value!.sizing).risk_percent = 9;
    expect(node(input.sizing).risk_percent).toBe(0.5);
  });

  it('accepts optional fields when present and absent', () => {
    const withOptionals = profile();
    withOptionals.description = 'text';
    withOptionals.recommendations = { anything: { goes: true } };
    expect(validateProfile(withOptionals).ok).toBe(true);
    expect(validateProfile(profile()).value).not.toHaveProperty('description');
  });

  it('rejects non-object input', () => {
    expect(errorPaths(null)).toEqual(['$']);
    expect(errorPaths([])).toEqual(['$']);
    expect(errorPaths('profile')).toEqual(['$']);
  });

  it('rejects unknown keys at the top level and inside nested objects', () => {
    const top = profile();
    top.fixedlots = 1;
    expectError(top, 'fixedlots');

    const nested = profile();
    node(nested.sizing).fixedlots = 0.1;
    expectError(nested, 'sizing.fixedlots');

    const deep = profile();
    node((node(deep.take_profit).checkpoints as Node[])[0]).extra = 1;
    expectError(deep, 'take_profit.checkpoints.0.extra');

    const symbol = profile();
    node((symbol.symbols as Node[])[0]).extra = 'x';
    expectError(symbol, 'symbols.0.extra');
  });

  it('reports missing required fields', () => {
    const noPolicy = profile();
    delete node(noPolicy.entry).policy;
    expectError(noPolicy, 'entry.policy');

    const noVersion = profile();
    delete noVersion.version;
    expectError(noVersion, 'version');

    const noStopLoss = profile();
    delete noStopLoss.stop_loss;
    expectError(noStopLoss, 'stop_loss');

    const noAfter = profile();
    delete node(noAfter.stop_loss).after_checkpoint;
    expectError(noAfter, 'stop_loss.after_checkpoint');
  });

  it('rejects wrong types', () => {
    const str = profile();
    str.version = '1';
    expectError(str, 'version');

    const bool = profile();
    node(bool.entry).allow_market_fallback = 'yes';
    expectError(bool, 'entry.allow_market_fallback');

    const nan = profile();
    node(nan.entry).market_tolerance_price = Number.NaN;
    expectError(nan, 'entry.market_tolerance_price');
  });

  it('checks enums', () => {
    const policy = profile();
    node(policy.entry).policy = 'always_market';
    expectError(policy, 'entry.policy');

    const mode = profile();
    node(mode.sizing).mode = 'percent';
    expectError(mode, 'sizing.mode');

    const source = profile();
    node(source.source).type = 'telegram';
    expectError(source, 'source.type');

    const missingTp = profile();
    node(missingTp.take_profit).missing_tp = 'ignore';
    expectError(missingTp, 'take_profit.missing_tp');

    const brokerTp = profile();
    node(brokerTp.take_profit).broker_tp = 'all';
    expectError(brokerTp, 'take_profit.broker_tp');

    const edit = profile();
    node(edit.edits).explicit_cancel = 'close_all';
    expectError(edit, 'edits.explicit_cancel');
  });

  it('requires schema_version 1 and broker vantage_mt5', () => {
    const schema = profile();
    schema.schema_version = 2;
    expectError(schema, 'schema_version');

    const broker = profile();
    broker.broker = 'mt5';
    expectError(broker, 'broker');
  });

  it('validates profile_id and name', () => {
    for (const id of ['AB', 'Upper-case', '-leading', 'x'.repeat(49), 'has space']) {
      const p = profile();
      p.profile_id = id;
      expectError(p, 'profile_id');
    }
    const ok = profile();
    ok.profile_id = 'abc';
    expect(validateProfile(ok).ok).toBe(true);

    const empty = profile();
    empty.name = '';
    expectError(empty, 'name');

    const long = profile();
    long.name = 'n'.repeat(81);
    expectError(long, 'name');
  });

  it('validates version as an integer >= 1', () => {
    for (const version of [0, -1, 1.5]) {
      const p = profile();
      p.version = version;
      expectError(p, 'version');
    }
  });

  it('validates symbols: non-empty, uppercase signal symbols, unique', () => {
    const empty = profile();
    empty.symbols = [];
    expectError(empty, 'symbols');

    const lower = profile();
    lower.symbols = [{ signal_symbol: 'xauusd', broker_symbol: 'XAUUSD' }];
    expectError(lower, 'symbols.0.signal_symbol');

    const dupes = profile();
    dupes.symbols = [
      { signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD' },
      { signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD+' },
    ];
    expectError(dupes, 'symbols.1.signal_symbol');

    const missingBroker = profile();
    missingBroker.symbols = [{ signal_symbol: 'XAUUSD' }];
    expectError(missingBroker, 'symbols.0.broker_symbol');
  });

  it('validates entry ranges', () => {
    const tol = profile();
    node(tol.entry).market_tolerance_price = -0.1;
    expectError(tol, 'entry.market_tolerance_price');

    for (const minutes of [0, 10081, 1.5]) {
      const p = profile();
      node(p.entry).pending_expiry_minutes = minutes;
      expectError(p, 'entry.pending_expiry_minutes');
    }
  });

  it('validates sizing values for the active mode', () => {
    const lots = profile();
    lots.sizing = { mode: 'fixed_lots', below_min_volume: 'skip' };
    expectError(lots, 'sizing.fixed_lots');

    const lotsZero = profile();
    lotsZero.sizing = { mode: 'fixed_lots', fixed_lots: 0, below_min_volume: 'skip' };
    expectError(lotsZero, 'sizing.fixed_lots');

    const money = profile();
    money.sizing = { mode: 'fixed_risk_money', below_min_volume: 'skip' };
    expectError(money, 'sizing.risk_money');

    const percentMissing = profile();
    percentMissing.sizing = { mode: 'equity_risk_percent', below_min_volume: 'skip' };
    expectError(percentMissing, 'sizing.risk_percent');

    for (const pct of [0, -1, 10.01, 11]) {
      const p = profile();
      node(p.sizing).risk_percent = pct;
      expectError(p, 'sizing.risk_percent');
    }

    // The schema range allows up to 10, but the hard ceiling is 5.
    const boundary = profile();
    node(boundary.sizing).risk_percent = 5;
    expect(validateProfile(boundary).ok).toBe(true);
    const aboveCeiling = profile();
    node(aboveCeiling.sizing).risk_percent = 10;
    expect(validateProfile(aboveCeiling).errors.map((e) => e.path)).toContain('sizing.risk_percent');

    const below = profile();
    node(below.sizing).below_min_volume = 'round_up';
    expectError(below, 'sizing.below_min_volume');
  });

  it('warns, not errors, on sizing values for other modes', () => {
    const p = profile();
    p.sizing = {
      mode: 'fixed_lots',
      fixed_lots: 0.1,
      risk_money: 50,
      risk_percent: 0.5,
      below_min_volume: 'skip',
    };
    const result = validateProfile(p);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.path)).toEqual(['sizing.risk_money', 'sizing.risk_percent']);
  });

  it('rejects profile values above hard ceilings (see the hard ceilings suite)', () => {
    const p = profile();
    node(p.sizing).risk_percent = 6;
    const result = validateProfile(p);
    expect(result.ok).toBe(false);
    expect(result.warnings.map((w) => w.path)).not.toContain('sizing.risk_percent');
  });

  it('validates take profit checkpoints: sum to 100 and tp_index 1..10 ascending', () => {
    const sum = profile();
    node(sum.take_profit).checkpoints = [
      { tp_index: 1, close_percent: 50 },
      { tp_index: 2, close_percent: 30 },
    ];
    expectError(sum, 'take_profit.checkpoints');

    const overSum = profile();
    node(overSum.take_profit).checkpoints = [
      { tp_index: 1, close_percent: 60 },
      { tp_index: 2, close_percent: 60 },
    ];
    expectError(overSum, 'take_profit.checkpoints');

    const descending = profile();
    node(descending.take_profit).checkpoints = [
      { tp_index: 2, close_percent: 50 },
      { tp_index: 1, close_percent: 50 },
    ];
    expectError(descending, 'take_profit.checkpoints.1.tp_index');

    const duplicate = profile();
    node(duplicate.take_profit).checkpoints = [
      { tp_index: 1, close_percent: 50 },
      { tp_index: 1, close_percent: 50 },
    ];
    expectError(duplicate, 'take_profit.checkpoints.1.tp_index');

    for (const idx of [0, 11, 1.5]) {
      const p = profile();
      node(p.take_profit).checkpoints = [{ tp_index: idx, close_percent: 100 }];
      expectError(p, 'take_profit.checkpoints.0.tp_index');
    }

    for (const pct of [0, -5, 100.5]) {
      const p = profile();
      node(p.take_profit).checkpoints = [{ tp_index: 1, close_percent: pct }];
      expectError(p, 'take_profit.checkpoints.0.close_percent');
    }

    const empty = profile();
    node(empty.take_profit).checkpoints = [];
    expectError(empty, 'take_profit.checkpoints');

    const single = profile();
    node(single.take_profit).checkpoints = [{ tp_index: 3, close_percent: 100 }];
    node(single.stop_loss).after_checkpoint = [];
    node(single.break_even).trigger = 'price_distance';
    node(single.trailing).activation = 'price_distance';
    expect(validateProfile(single).ok).toBe(true);

    const danglingRef = profile();
    node(danglingRef.take_profit).checkpoints = [{ tp_index: 3, close_percent: 100 }];
    expectError(danglingRef, 'stop_loss.after_checkpoint.0.after_tp_index');
  });

  it('checks stop loss distances and after_checkpoint cross-references', () => {
    const order = profile();
    node(order.stop_loss).max_distance_price = 2;
    expectError(order, 'stop_loss.max_distance_price');

    const negative = profile();
    node(negative.stop_loss).min_distance_price = -1;
    expectError(negative, 'stop_loss.min_distance_price');

    const badRef = profile();
    node((node(badRef.stop_loss).after_checkpoint as Node[])[0]).after_tp_index = 4;
    expectError(badRef, 'stop_loss.after_checkpoint.0.after_tp_index');

    const dupRef = profile();
    node(dupRef.stop_loss).after_checkpoint = [
      { after_tp_index: 1, move_to: 'entry', buffer_price: 0 },
      { after_tp_index: 1, move_to: 'entry', buffer_price: 0 },
    ];
    expectError(dupRef, 'stop_loss.after_checkpoint.1.after_tp_index');

    const badMove = profile();
    node((node(badMove.stop_loss).after_checkpoint as Node[])[0]).move_to = 'market';
    expectError(badMove, 'stop_loss.after_checkpoint.0.move_to');
  });

  it('checks break_even and trailing triggers against checkpoints', () => {
    const beRef = profile();
    node(beRef.break_even).enabled = true;
    node(beRef.break_even).trigger = 'after_tp_index';
    node(beRef.break_even).trigger_value = 7;
    expectError(beRef, 'break_even.trigger_value');

    const beValid = profile();
    node(beValid.break_even).trigger = 'after_tp_index';
    node(beValid.break_even).trigger_value = 1;
    expect(validateProfile(beValid).ok).toBe(true);

    const trailRef = profile();
    node(trailRef.trailing).activation = 'after_tp_index';
    node(trailRef.trailing).activation_value = 5;
    expectError(trailRef, 'trailing.activation_value');

    const beZeroEnabled = profile();
    node(beZeroEnabled.break_even).enabled = true;
    node(beZeroEnabled.break_even).trigger_value = 0;
    expectError(beZeroEnabled, 'break_even.trigger_value');

    const trailDistance = profile();
    node(trailDistance.trailing).enabled = true;
    node(trailDistance.trailing).distance_price = 0;
    expectError(trailDistance, 'trailing.distance_price');

    const trailStep = profile();
    node(trailStep.trailing).enabled = true;
    node(trailStep.trailing).step_price = 0;
    expectError(trailStep, 'trailing.step_price');
  });

  it('checks limits: per-symbol cap, ranges, and integer counts', () => {
    const perSymbol = profile();
    node(perSymbol.limits).max_positions_per_symbol = 4;
    node(perSymbol.limits).max_concurrent_positions = 3;
    expectError(perSymbol, 'limits.max_positions_per_symbol');

    const concurrent = profile();
    node(concurrent.limits).max_concurrent_positions = 0;
    expectError(concurrent, 'limits.max_concurrent_positions');

    const deviation = profile();
    node(deviation.limits).max_deviation_points = 1.5;
    expectError(deviation, 'limits.max_deviation_points');

    for (const age of [4, 3601]) {
      const p = profile();
      node(p.limits).signal_max_age_sec = age;
      expectError(p, 'limits.signal_max_age_sec');
    }

    const totalRisk = profile();
    node(totalRisk.limits).max_total_risk_percent = 51;
    expectError(totalRisk, 'limits.max_total_risk_percent');

    const loss = profile();
    node(loss.limits).daily_loss_limit_money = 0;
    expectError(loss, 'limits.daily_loss_limit_money');

    const spread = profile();
    node(spread.limits).max_spread_price = 0;
    expectError(spread, 'limits.max_spread_price');
  });

  it('stores recommendations as an object and never interprets it', () => {
    const notObject = profile();
    notObject.recommendations = ['not', 'an', 'object'];
    expectError(notObject, 'recommendations');

    const anything = profile();
    anything.recommendations = { risk_percent: 999, nonsense: [1, 2] };
    const result = validateProfile(anything);
    expect(result.ok).toBe(true);
    expect(result.value?.recommendations).toEqual({ risk_percent: 999, nonsense: [1, 2] });
  });

  it('reports every error class without stopping at the first one', () => {
    const p = profile();
    p.fixedlots = 1;
    node(p.entry).policy = 'bogus';
    node(p.take_profit).checkpoints = [{ tp_index: 1, close_percent: 40 }];
    const paths = errorPaths(p);
    expect(paths).toEqual(expect.arrayContaining(['fixedlots', 'entry.policy', 'take_profit.checkpoints']));
  });

  it('example profile in docs validates', () => {
    const raw = readFileSync(
      resolve(__dirname, '../../../docs/project_memory/examples/optimal_report_profile.example.json'),
      'utf8',
    );
    const result = validateProfile(JSON.parse(raw));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.value?.symbols[0].broker_symbol).toBe('XAUUSD');
  });
});

describe('validateSafetyLimits', () => {
  it('accepts DEFAULT_SAFETY_LIMITS', () => {
    const result = validateSafetyLimits(DEFAULT_SAFETY_LIMITS);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(DEFAULT_SAFETY_LIMITS);
  });

  it('accepts HARD_CEILINGS once a signal symbol is allowed', () => {
    const ceilings = { ...HARD_CEILINGS, allowed_signal_symbols: ['XAUUSD'] };
    expect(validateSafetyLimits(ceilings).ok).toBe(true);
  });

  it('requires every field and rejects unknown keys', () => {
    const missing: Record<string, unknown> = { ...DEFAULT_SAFETY_LIMITS };
    delete missing.max_lots_per_trade;
    const result = validateSafetyLimits(missing);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.path)).toContain('max_lots_per_trade');

    const extra = { ...DEFAULT_SAFETY_LIMITS, surprise: true };
    expect(validateSafetyLimits(extra).errors.map((e) => e.path)).toContain('surprise');
  });

  it('requires numeric fields > 0 and at most the hard ceiling', () => {
    const zero = { ...DEFAULT_SAFETY_LIMITS, max_risk_percent_per_trade: 0 };
    expect(validateSafetyLimits(zero).errors.map((e) => e.path)).toContain('max_risk_percent_per_trade');

    const above: SafetyLimits = {
      ...DEFAULT_SAFETY_LIMITS,
      max_risk_percent_per_trade: HARD_CEILINGS.max_risk_percent_per_trade + 0.1,
      max_risk_money_per_trade: HARD_CEILINGS.max_risk_money_per_trade + 1,
      max_lots_per_trade: HARD_CEILINGS.max_lots_per_trade + 1,
      max_concurrent_positions: HARD_CEILINGS.max_concurrent_positions + 1,
      max_positions_per_symbol: HARD_CEILINGS.max_positions_per_symbol + 1,
      daily_loss_limit_money: HARD_CEILINGS.daily_loss_limit_money + 1,
      max_total_risk_percent: HARD_CEILINGS.max_total_risk_percent + 1,
      max_spread_price: HARD_CEILINGS.max_spread_price + 1,
      max_deviation_points: HARD_CEILINGS.max_deviation_points + 1,
      max_signal_age_sec: HARD_CEILINGS.max_signal_age_sec + 1,
      min_margin_level_percent: HARD_CEILINGS.min_margin_level_percent + 1,
    };
    const paths = validateSafetyLimits(above).errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'max_risk_percent_per_trade',
        'max_risk_money_per_trade',
        'max_lots_per_trade',
        'max_concurrent_positions',
        'max_positions_per_symbol',
        'daily_loss_limit_money',
        'max_total_risk_percent',
        'max_spread_price',
        'max_deviation_points',
        'max_signal_age_sec',
        'min_margin_level_percent',
      ]),
    );
  });

  it('allows min_margin_level_percent of 0 (disabled)', () => {
    const disabled = { ...DEFAULT_SAFETY_LIMITS, min_margin_level_percent: 0 };
    expect(validateSafetyLimits(disabled).ok).toBe(true);
    const negative = { ...DEFAULT_SAFETY_LIMITS, min_margin_level_percent: -1 };
    expect(validateSafetyLimits(negative).ok).toBe(false);
  });

  it('requires a non-empty list of uppercase allowed symbols', () => {
    const empty = { ...DEFAULT_SAFETY_LIMITS, allowed_signal_symbols: [] };
    expect(validateSafetyLimits(empty).errors.map((e) => e.path)).toContain('allowed_signal_symbols');

    const lower = { ...DEFAULT_SAFETY_LIMITS, allowed_signal_symbols: ['xauusd'] };
    expect(validateSafetyLimits(lower).errors.map((e) => e.path)).toContain('allowed_signal_symbols.0');
  });

  it('rejects non-object input', () => {
    expect(validateSafetyLimits(null).ok).toBe(false);
  });
});

describe('effectiveLimits', () => {
  function parsed(): ExecutionProfile {
    const result = validateProfile(profile());
    if (!result.value) throw new Error('base profile must validate');
    return result.value;
  }

  it('takes the minimum of profile and safety on every axis', () => {
    const p = parsed();
    p.limits.max_concurrent_positions = 5;
    p.limits.max_positions_per_symbol = 2;
    p.limits.daily_loss_limit_money = 500;
    p.limits.max_total_risk_percent = 2;
    p.limits.max_spread_price = 1;
    p.limits.max_deviation_points = 100;
    p.limits.signal_max_age_sec = 60;
    const safety: SafetyLimits = {
      ...DEFAULT_SAFETY_LIMITS,
      max_concurrent_positions: 3,
      max_positions_per_symbol: 1,
      daily_loss_limit_money: 100,
      max_total_risk_percent: 3,
      max_spread_price: 0.5,
      max_deviation_points: 30,
      max_signal_age_sec: 120,
    };
    expect(effectiveLimits(p, safety)).toEqual({
      maxRiskPercent: 1,
      maxRiskMoney: 50,
      maxLots: 1,
      maxConcurrent: 3,
      maxPerSymbol: 1,
      dailyLossLimit: 100,
      maxTotalRiskPercent: 2,
      maxSpreadPrice: 0.5,
      maxDeviationPoints: 30,
      maxSignalAgeSec: 60,
      minMarginLevelPercent: 200,
    });
  });

  it('takes the profile value when it is stricter than safety', () => {
    const p = parsed();
    p.limits.max_concurrent_positions = 1;
    p.limits.daily_loss_limit_money = 10;
    const limits = effectiveLimits(p, DEFAULT_SAFETY_LIMITS);
    expect(limits.maxConcurrent).toBe(1);
    expect(limits.dailyLossLimit).toBe(10);
    expect(limits.maxRiskPercent).toBe(DEFAULT_SAFETY_LIMITS.max_risk_percent_per_trade);
  });
});

describe('profileDocId', () => {
  it('builds the versioned document id', () => {
    expect(profileDocId('xauusd-test-profile', 3)).toBe('xauusd-test-profile__v3');
  });
});

describe('resolveBrokerSymbol', () => {
  function parsed(): ExecutionProfile {
    const result = validateProfile(profile());
    if (!result.value) throw new Error('base profile must validate');
    return result.value;
  }

  it('maps the signal symbol case-insensitively to the broker symbol', () => {
    const p = parsed();
    expect(resolveBrokerSymbol(p, 'XAUUSD')).toBe('XAUUSD+');
    expect(resolveBrokerSymbol(p, 'xauusd')).toBe('XAUUSD+');
  });

  it('returns null for an unmapped symbol', () => {
    expect(resolveBrokerSymbol(parsed(), 'EURUSD')).toBeNull();
  });
});

describe('hard ceilings are errors with value and limit', () => {
  type Case = { path: string; set: (p: Node) => void; value: number; limit: number };
  const CASES: Case[] = [
    {
      path: 'sizing.fixed_lots',
      set: (p) => {
        p.sizing = { mode: 'fixed_lots', fixed_lots: 25, below_min_volume: 'skip' };
      },
      value: 25,
      limit: 20,
    },
    {
      path: 'sizing.risk_money',
      set: (p) => {
        p.sizing = { mode: 'fixed_risk_money', risk_money: 5001, below_min_volume: 'skip' };
      },
      value: 5001,
      limit: 5000,
    },
    {
      path: 'sizing.risk_percent',
      set: (p) => {
        node(p.sizing).risk_percent = 6;
      },
      value: 6,
      limit: 5,
    },
    {
      path: 'limits.max_concurrent_positions',
      set: (p) => {
        node(p.limits).max_concurrent_positions = 21;
      },
      value: 21,
      limit: 20,
    },
    {
      path: 'limits.max_positions_per_symbol',
      set: (p) => {
        node(p.limits).max_positions_per_symbol = 11;
        node(p.limits).max_concurrent_positions = 20;
      },
      value: 11,
      limit: 10,
    },
    {
      path: 'limits.max_spread_price',
      set: (p) => {
        node(p.limits).max_spread_price = 10.5;
      },
      value: 10.5,
      limit: 10,
    },
    {
      path: 'limits.max_deviation_points',
      set: (p) => {
        node(p.limits).max_deviation_points = 501;
      },
      value: 501,
      limit: 500,
    },
    {
      path: 'limits.signal_max_age_sec',
      set: (p) => {
        node(p.limits).signal_max_age_sec = 3601;
      },
      value: 3601,
      limit: 3600,
    },
    {
      path: 'limits.daily_loss_limit_money',
      set: (p) => {
        node(p.limits).daily_loss_limit_money = 20001;
      },
      value: 20001,
      limit: 20000,
    },
    {
      path: 'limits.max_total_risk_percent',
      set: (p) => {
        node(p.limits).max_total_risk_percent = 21;
      },
      value: 21,
      limit: 20,
    },
  ];

  for (const c of CASES) {
    it(`${c.path} above its ceiling is an error with value and limit`, () => {
      const p = profile();
      c.set(p);
      const result = validateProfile(p);
      expect(result.ok).toBe(false);
      expect(result.value).toBeUndefined();
      const issue = result.errors.find((e) => e.path === c.path);
      expect(issue).toBeDefined();
      expect(issue?.value).toBe(c.value);
      expect(issue?.limit).toBe(c.limit);
      expect(issue?.message).toContain(String(c.value));
      expect(issue?.message).toContain(String(c.limit));
      expect(result.warnings.map((w) => w.path)).not.toContain(c.path);
    });
  }

  it('gives the actionable message from the spec', () => {
    const p = profile();
    p.sizing = { mode: 'fixed_lots', fixed_lots: 25, below_min_volume: 'skip' };
    const issue = validateProfile(p).errors.find((e) => e.path === 'sizing.fixed_lots');
    expect(issue?.message).toBe('fixed_lots 25 exceeds hard ceiling max_lots_per_trade 20');
  });

  it('applies the ceiling to a sizing value even when its mode is inactive', () => {
    const p = profile();
    p.sizing = { mode: 'equity_risk_percent', risk_percent: 0.5, fixed_lots: 25, below_min_volume: 'skip' };
    const result = validateProfile(p);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: 'sizing.fixed_lots', value: 25, limit: 20 }),
    );
  });

  it('accepts every value exactly at its ceiling', () => {
    const p = profile();
    p.sizing = { mode: 'fixed_lots', fixed_lots: 20, risk_money: 5000, risk_percent: 5, below_min_volume: 'skip' };
    p.limits = {
      max_concurrent_positions: 20,
      max_positions_per_symbol: 10,
      max_spread_price: 10,
      max_deviation_points: 500,
      signal_max_age_sec: 3600,
      daily_loss_limit_money: 20000,
      max_total_risk_percent: 20,
    };
    const result = validateProfile(p);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports the submitted value for type and enum errors', () => {
    const p = profile();
    node(p.entry).policy = 'always';
    const issue = validateProfile(p).errors.find((e) => e.path === 'entry.policy');
    expect(issue?.value).toBe('always');
    expect(issue?.message).toContain('"always"');
  });
});

describe('validateProfileAgainstSafety', () => {
  function validated(): ExecutionProfile {
    const result = validateProfile(profile());
    if (!result.value) throw new Error('base profile must validate');
    return result.value;
  }

  it('returns no issues for the base profile against DEFAULT_SAFETY_LIMITS', () => {
    expect(validateProfileAgainstSafety(validated(), DEFAULT_SAFETY_LIMITS)).toEqual([]);
  });

  it('accepts a profile value exactly at the safety limit', () => {
    const p = validated();
    p.limits.max_spread_price = DEFAULT_SAFETY_LIMITS.max_spread_price;
    expect(validateProfileAgainstSafety(p, DEFAULT_SAFETY_LIMITS)).toEqual([]);
  });

  type Case = { path: string; mutate: (p: ExecutionProfile) => void; value: number; limit: number };
  const CASES: Case[] = [
    {
      path: 'sizing.fixed_lots',
      mutate: (p) => {
        p.sizing = { mode: 'fixed_lots', fixed_lots: 2, below_min_volume: 'skip' };
      },
      value: 2,
      limit: DEFAULT_SAFETY_LIMITS.max_lots_per_trade,
    },
    {
      path: 'sizing.risk_money',
      mutate: (p) => {
        p.sizing = { mode: 'fixed_risk_money', risk_money: 51, below_min_volume: 'skip' };
      },
      value: 51,
      limit: DEFAULT_SAFETY_LIMITS.max_risk_money_per_trade,
    },
    {
      path: 'sizing.risk_percent',
      mutate: (p) => {
        p.sizing.risk_percent = 1.5;
      },
      value: 1.5,
      limit: DEFAULT_SAFETY_LIMITS.max_risk_percent_per_trade,
    },
    {
      path: 'limits.max_concurrent_positions',
      mutate: (p) => {
        p.limits.max_concurrent_positions = 4;
      },
      value: 4,
      limit: DEFAULT_SAFETY_LIMITS.max_concurrent_positions,
    },
    {
      path: 'limits.max_positions_per_symbol',
      mutate: (p) => {
        p.limits.max_concurrent_positions = 5;
        p.limits.max_positions_per_symbol = 2;
      },
      value: 2,
      limit: DEFAULT_SAFETY_LIMITS.max_positions_per_symbol,
    },
    {
      path: 'limits.max_spread_price',
      mutate: (p) => {
        p.limits.max_spread_price = 0.6;
      },
      value: 0.6,
      limit: DEFAULT_SAFETY_LIMITS.max_spread_price,
    },
    {
      path: 'limits.max_deviation_points',
      mutate: (p) => {
        p.limits.max_deviation_points = 31;
      },
      value: 31,
      limit: DEFAULT_SAFETY_LIMITS.max_deviation_points,
    },
    {
      path: 'limits.signal_max_age_sec',
      mutate: (p) => {
        p.limits.signal_max_age_sec = 121;
      },
      value: 121,
      limit: DEFAULT_SAFETY_LIMITS.max_signal_age_sec,
    },
    {
      path: 'limits.daily_loss_limit_money',
      mutate: (p) => {
        p.limits.daily_loss_limit_money = 101;
      },
      value: 101,
      limit: DEFAULT_SAFETY_LIMITS.daily_loss_limit_money,
    },
    {
      path: 'limits.max_total_risk_percent',
      mutate: (p) => {
        p.limits.max_total_risk_percent = 3.5;
      },
      value: 3.5,
      limit: DEFAULT_SAFETY_LIMITS.max_total_risk_percent,
    },
  ];

  for (const c of CASES) {
    it(`${c.path} above the safety limit is rejected with value and limit`, () => {
      const p = validated();
      c.mutate(p);
      const issues = validateProfileAgainstSafety(p, DEFAULT_SAFETY_LIMITS);
      const issue = issues.find((e) => e.path === c.path);
      expect(issue).toBeDefined();
      expect(issue?.value).toBe(c.value);
      expect(issue?.limit).toBe(c.limit);
      expect(issue?.message).toContain('exceeds safety limit');
    });
  }

  it('rejects a profile that is valid against the hard ceilings but exceeds stricter safety', () => {
    const raw = profile();
    node(raw.limits).max_spread_price = 2;
    expect(validateProfile(raw).ok).toBe(true);
    const issues = validateProfileAgainstSafety(validateProfile(raw).value!, DEFAULT_SAFETY_LIMITS);
    expect(issues).toEqual([
      expect.objectContaining({
        path: 'limits.max_spread_price',
        message: 'max_spread_price 2 exceeds safety limit max_spread_price 0.5',
        value: 2,
        limit: 0.5,
      }),
    ]);
  });

  it('rejects a signal symbol that is not on the allow-list', () => {
    const p = validated();
    const issues = validateProfileAgainstSafety(p, { ...DEFAULT_SAFETY_LIMITS, allowed_signal_symbols: ['EURUSD'] });
    expect(issues).toEqual([
      expect.objectContaining({
        path: 'symbols.0.signal_symbol',
        value: 'XAUUSD',
        limit: ['EURUSD'],
      }),
    ]);
  });

  it('accepts a symbol that is on the allow-list', () => {
    const issues = validateProfileAgainstSafety(validated(), {
      ...DEFAULT_SAFETY_LIMITS,
      allowed_signal_symbols: ['EURUSD', 'XAUUSD'],
    });
    expect(issues).toEqual([]);
  });

  it('reports only the disallowed symbol in a multi-symbol profile', () => {
    const p = validated();
    p.symbols = [
      { signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD' },
      { signal_symbol: 'EURUSD', broker_symbol: 'EURUSD' },
    ];
    const issues = validateProfileAgainstSafety(p, DEFAULT_SAFETY_LIMITS);
    expect(issues.map((i) => i.path)).toEqual(['symbols.1.signal_symbol']);
  });
});

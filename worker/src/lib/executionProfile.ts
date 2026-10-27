/**
 * Execution profile schema for the Optimal Report target: types, strict
 * validation, non-overridable safety limits and effective-limit resolution.
 *
 * Pure module with zero imports so the Next.js web app can import it for
 * validation and preview. Specified in docs/project_memory/VANTAGE_DESIGN_CONTRACTS.md
 * section 3. All distances are price units (not pips). Unknown keys are errors;
 * nothing is defaulted silently.
 */

export const PROFILE_SCHEMA_VERSION = 1;
export type SizingMode = 'fixed_lots' | 'fixed_risk_money' | 'equity_risk_percent';
export type EntryPolicy = 'market_only' | 'follow_signal' | 'pending_at_range';

export interface ExecutionProfile {
  schema_version: 1;
  profile_id: string; // /^[a-z0-9][a-z0-9-]{2,47}$/
  version: number; // integer >= 1 (assigned by server)
  name: string; // 1..80 chars
  description?: string;
  source: {
    type: 'optimal_report' | 'manual';
    report_id?: string;
    report_date?: string;
    author?: string;
    notes?: string;
  };
  broker: 'vantage_mt5';
  symbols: { signal_symbol: string; broker_symbol: string }[]; // >=1, signal_symbol unique
  entry: {
    policy: EntryPolicy;
    market_tolerance_price: number; // >=0; market entry only if price within [low - tol, high + tol]
    pending_expiry_minutes: number; // 1..10080
    allow_market_fallback: boolean; // pending signal may fill at market ONLY if true and price inside range
  };
  sizing: {
    mode: SizingMode;
    fixed_lots?: number; // required iff mode fixed_lots (> 0)
    risk_money?: number; // required iff mode fixed_risk_money (> 0)
    risk_percent?: number; // required iff mode equity_risk_percent (0 < x <= 10)
    below_min_volume: 'skip' | 'use_min_if_within_cap';
  };
  take_profit: {
    checkpoints: { tp_index: number; close_percent: number }[]; // tp_index 1..10 strictly ascending; 0 < pct <= 100; sum 100
    missing_tp: 'skip_trade' | 'merge_into_last_available';
    infeasible_split: 'skip_trade' | 'merge_into_next';
    broker_tp: 'final_checkpoint' | 'none';
  };
  stop_loss: {
    min_distance_price: number; // >=0
    max_distance_price: number; // > min
    after_checkpoint: {
      after_tp_index: number;
      move_to: 'entry' | 'previous_tp';
      buffer_price: number;
    }[];
  };
  break_even: {
    enabled: boolean;
    trigger: 'price_distance' | 'after_tp_index';
    trigger_value: number;
    buffer_price: number;
  };
  trailing: {
    enabled: boolean;
    activation: 'price_distance' | 'after_tp_index';
    activation_value: number;
    distance_price: number;
    step_price: number;
  };
  limits: {
    max_concurrent_positions: number; // int >= 1
    max_positions_per_symbol: number; // int >= 1, <= max_concurrent_positions
    max_spread_price: number; // > 0
    max_deviation_points: number; // int >= 0
    signal_max_age_sec: number; // int 5..3600
    daily_loss_limit_money: number; // > 0
    max_total_risk_percent: number; // 0 < x <= 50
  };
  edits: {
    before_fill: 'ignore' | 'apply_sl_tp';
    after_fill: 'ignore' | 'apply_tighten_only' | 'apply';
    unparseable_edit: 'ignore' | 'cancel_pending_only';
    explicit_cancel: 'ignore' | 'cancel_pending_only' | 'close_position';
  };
  recommendations?: Record<string, unknown>; // informational only, never executed
}

/** Mirrors settings/default.safety (snake_case on disk). */
export interface SafetyLimits {
  max_risk_percent_per_trade: number;
  max_risk_money_per_trade: number;
  max_lots_per_trade: number;
  max_concurrent_positions: number;
  max_positions_per_symbol: number;
  daily_loss_limit_money: number;
  max_total_risk_percent: number;
  max_spread_price: number;
  max_deviation_points: number;
  max_signal_age_sec: number;
  min_margin_level_percent: number; // post-trade margin level floor (0 disables)
  allowed_signal_symbols: string[];
}

/**
 * Code-level maxima. Safety values above these are invalid. The profile may
 * exceed them (it is min()-ed at execution), but validation warns.
 * `allowed_signal_symbols` has no ceiling; it is an empty placeholder.
 */
export const HARD_CEILINGS: SafetyLimits = {
  max_risk_percent_per_trade: 5,
  max_risk_money_per_trade: 5000,
  max_lots_per_trade: 20,
  max_concurrent_positions: 20,
  max_positions_per_symbol: 10,
  daily_loss_limit_money: 20000,
  max_total_risk_percent: 20,
  max_spread_price: 10,
  max_deviation_points: 500,
  max_signal_age_sec: 3600,
  min_margin_level_percent: 10000,
  allowed_signal_symbols: [],
};

/** Conservative defaults, used only when settings.safety is ABSENT. */
export const DEFAULT_SAFETY_LIMITS: SafetyLimits = {
  max_risk_percent_per_trade: 1,
  max_risk_money_per_trade: 50,
  max_lots_per_trade: 1,
  max_concurrent_positions: 3,
  max_positions_per_symbol: 1,
  daily_loss_limit_money: 100,
  max_total_risk_percent: 3,
  max_spread_price: 0.5,
  max_deviation_points: 30,
  max_signal_age_sec: 120,
  min_margin_level_percent: 200,
  allowed_signal_symbols: ['XAUUSD'],
};

export interface ValidationIssue {
  path: string;
  message: string;
  /** Submitted value, populated for range, ceiling and enum errors. */
  value?: unknown;
  /** Applicable limit (ceiling, safety value, or range bound), when there is one. */
  limit?: unknown;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface EffectiveLimits {
  maxRiskPercent: number;
  maxRiskMoney: number;
  maxLots: number;
  maxConcurrent: number;
  maxPerSymbol: number;
  dailyLossLimit: number;
  maxTotalRiskPercent: number;
  maxSpreadPrice: number;
  maxDeviationPoints: number;
  maxSignalAgeSec: number;
  minMarginLevelPercent: number;
}

/** Structurally identical to GoldSignal in vipSignalParser.ts (kept here to stay import-free). */
export interface GoldSignalLike {
  symbol: string;
  direction: 'buy' | 'sell';
  orderType: 'market' | 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop';
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfits: number[];
}

type Obj = Record<string, unknown>;

interface Ctx {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

interface NumberRule {
  integer?: boolean;
  min?: number;
  minExclusive?: boolean;
  max?: number;
  /** Hard ceiling: a value above it is an error (see HARD_CEILINGS). */
  ceiling?: CeilingRef;
}

/** Numeric SafetyLimits key used as a ceiling or as a runtime safety limit. */
type NumericSafetyKey = Exclude<keyof SafetyLimits, 'allowed_signal_symbols'>;

interface CeilingRef {
  key: NumericSafetyKey;
  limit: number;
}

function ceilingFor(key: NumericSafetyKey): CeilingRef {
  return { key, limit: HARD_CEILINGS[key] };
}

const PROFILE_KEYS = [
  'schema_version',
  'profile_id',
  'version',
  'name',
  'description',
  'source',
  'broker',
  'symbols',
  'entry',
  'sizing',
  'take_profit',
  'stop_loss',
  'break_even',
  'trailing',
  'limits',
  'edits',
  'recommendations',
] as const;
const SOURCE_KEYS = ['type', 'report_id', 'report_date', 'author', 'notes'] as const;
const SYMBOL_KEYS = ['signal_symbol', 'broker_symbol'] as const;
const ENTRY_KEYS = [
  'policy',
  'market_tolerance_price',
  'pending_expiry_minutes',
  'allow_market_fallback',
] as const;
const SIZING_KEYS = ['mode', 'fixed_lots', 'risk_money', 'risk_percent', 'below_min_volume'] as const;
const TAKE_PROFIT_KEYS = ['checkpoints', 'missing_tp', 'infeasible_split', 'broker_tp'] as const;
const CHECKPOINT_KEYS = ['tp_index', 'close_percent'] as const;
const STOP_LOSS_KEYS = ['min_distance_price', 'max_distance_price', 'after_checkpoint'] as const;
const AFTER_CHECKPOINT_KEYS = ['after_tp_index', 'move_to', 'buffer_price'] as const;
const BREAK_EVEN_KEYS = ['enabled', 'trigger', 'trigger_value', 'buffer_price'] as const;
const TRAILING_KEYS = [
  'enabled',
  'activation',
  'activation_value',
  'distance_price',
  'step_price',
] as const;
const LIMIT_KEYS = [
  'max_concurrent_positions',
  'max_positions_per_symbol',
  'max_spread_price',
  'max_deviation_points',
  'signal_max_age_sec',
  'daily_loss_limit_money',
  'max_total_risk_percent',
] as const;
const EDIT_KEYS = ['before_fill', 'after_fill', 'unparseable_edit', 'explicit_cancel'] as const;
const SAFETY_KEYS = [
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
  'allowed_signal_symbols',
] as const;

const SIZING_MODES: readonly SizingMode[] = ['fixed_lots', 'fixed_risk_money', 'equity_risk_percent'];
const ENTRY_POLICIES: readonly EntryPolicy[] = ['market_only', 'follow_signal', 'pending_at_range'];
const ACTIVATIONS = ['price_distance', 'after_tp_index'] as const;
const SIGNAL_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const BROKER_SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/;

function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Obj = {};
    for (const key of Object.keys(value)) out[key] = deepCopy(value[key]);
    return out as T;
  }
  return value;
}

function join(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

function fail(
  ctx: Ctx,
  path: string,
  message: string,
  extra: { value?: unknown; limit?: unknown } = {},
): void {
  ctx.errors.push({ path: path === '' ? '$' : path, message, ...extra });
}

function note(ctx: Ctx, path: string, message: string): void {
  ctx.warnings.push({ path: path === '' ? '$' : path, message });
}

/** Short rendering of a submitted value for messages. */
function show(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

/** Validates an object shape and rejects unknown keys. */
function asObject(
  ctx: Ctx,
  value: unknown,
  path: string,
  allowed: readonly string[],
): Obj | undefined {
  if (!isPlainObject(value)) {
    fail(ctx, path, `must be an object (got ${show(value)})`, { value });
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(ctx, join(path, key), `unknown key (allowed: ${allowed.join(', ')})`, { value: value[key] });
    }
  }
  return value;
}

function readSection(
  ctx: Ctx,
  obj: Obj,
  key: string,
  base: string,
  allowed: readonly string[],
): Obj | undefined {
  const path = join(base, key);
  if (obj[key] === undefined) {
    fail(ctx, path, 'is required');
    return undefined;
  }
  return asObject(ctx, obj[key], path, allowed);
}

function readArray(ctx: Ctx, obj: Obj, key: string, base: string): unknown[] | undefined {
  const path = join(base, key);
  if (obj[key] === undefined) {
    fail(ctx, path, 'is required');
    return undefined;
  }
  if (!Array.isArray(obj[key])) {
    fail(ctx, path, 'must be an array');
    return undefined;
  }
  return obj[key] as unknown[];
}

function readNumber(
  ctx: Ctx,
  obj: Obj,
  key: string,
  base: string,
  required: boolean,
  rule: NumberRule = {},
): number | undefined {
  const path = join(base, key);
  const value = obj[key];
  if (value === undefined) {
    if (required) fail(ctx, path, 'is required');
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ctx, path, `must be a finite number (got ${show(value)})`, { value });
    return undefined;
  }
  if (rule.integer && !Number.isInteger(value)) {
    fail(ctx, path, `must be an integer (got ${value})`, { value });
    return undefined;
  }
  if (rule.min !== undefined) {
    const belowMin = rule.minExclusive ? value <= rule.min : value < rule.min;
    if (belowMin) {
      const op = rule.minExclusive ? '>' : '>=';
      fail(ctx, path, `must be ${op} ${rule.min} (got ${value})`, { value, limit: rule.min });
      return undefined;
    }
  }
  if (rule.max !== undefined && value > rule.max) {
    fail(ctx, path, `must be <= ${rule.max} (got ${value})`, { value, limit: rule.max });
    return undefined;
  }
  if (rule.ceiling && value > rule.ceiling.limit) {
    fail(
      ctx,
      path,
      `${key} ${value} exceeds hard ceiling ${rule.ceiling.key} ${rule.ceiling.limit}`,
      { value, limit: rule.ceiling.limit },
    );
    return undefined;
  }
  return value;
}

function readString(
  ctx: Ctx,
  obj: Obj,
  key: string,
  base: string,
  required: boolean,
  rule: { pattern?: RegExp; patternMessage?: string; minLen?: number; maxLen?: number } = {},
): string | undefined {
  const path = join(base, key);
  const value = obj[key];
  if (value === undefined) {
    if (required) fail(ctx, path, 'is required');
    return undefined;
  }
  if (typeof value !== 'string') {
    fail(ctx, path, `must be a string (got ${show(value)})`, { value });
    return undefined;
  }
  if (rule.minLen !== undefined && rule.maxLen !== undefined) {
    if (value.length < rule.minLen || value.length > rule.maxLen) {
      fail(ctx, path, `must be ${rule.minLen}..${rule.maxLen} characters (got ${value.length})`, {
        value,
        limit: rule.maxLen,
      });
      return undefined;
    }
  }
  if (rule.pattern && !rule.pattern.test(value)) {
    fail(ctx, path, `${rule.patternMessage ?? `must match ${rule.pattern}`} (got ${show(value)})`, { value });
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(
  ctx: Ctx,
  obj: Obj,
  key: string,
  base: string,
  required: boolean,
  values: readonly T[],
): T | undefined {
  const path = join(base, key);
  const value = obj[key];
  if (value === undefined) {
    if (required) fail(ctx, path, 'is required');
    return undefined;
  }
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    fail(ctx, path, `must be one of: ${values.join(', ')} (got ${show(value)})`, { value });
    return undefined;
  }
  return value as T;
}

function readBoolean(ctx: Ctx, obj: Obj, key: string, base: string, required: boolean): boolean | undefined {
  const path = join(base, key);
  const value = obj[key];
  if (value === undefined) {
    if (required) fail(ctx, path, 'is required');
    return undefined;
  }
  if (typeof value !== 'boolean') {
    fail(ctx, path, `must be a boolean (got ${show(value)})`, { value });
    return undefined;
  }
  return value;
}

function readLiteral<T extends string | number>(
  ctx: Ctx,
  obj: Obj,
  key: string,
  base: string,
  expected: T,
): void {
  const path = join(base, key);
  if (obj[key] === undefined) {
    fail(ctx, path, 'is required');
    return;
  }
  if (obj[key] !== expected) {
    fail(ctx, path, `must equal ${JSON.stringify(expected)} (got ${show(obj[key])})`, { value: obj[key] });
  }
}

function checkProfileHeader(ctx: Ctx, root: Obj): void {
  readLiteral(ctx, root, 'schema_version', '', PROFILE_SCHEMA_VERSION);
  readString(ctx, root, 'profile_id', '', true, {
    pattern: PROFILE_ID_PATTERN,
    patternMessage: 'must match /^[a-z0-9][a-z0-9-]{2,47}$/',
  });
  readNumber(ctx, root, 'version', '', true, { integer: true, min: 1 });
  readString(ctx, root, 'name', '', true, { minLen: 1, maxLen: 80 });
  readString(ctx, root, 'description', '', false);
  readLiteral(ctx, root, 'broker', '', 'vantage_mt5');
}

function checkSource(ctx: Ctx, root: Obj): void {
  const source = readSection(ctx, root, 'source', '', SOURCE_KEYS);
  if (!source) return;
  readEnum(ctx, source, 'type', 'source', true, ['optimal_report', 'manual'] as const);
  readString(ctx, source, 'report_id', 'source', false);
  readString(ctx, source, 'report_date', 'source', false);
  readString(ctx, source, 'author', 'source', false);
  readString(ctx, source, 'notes', 'source', false);
}

function checkSymbols(ctx: Ctx, root: Obj): void {
  const symbols = readArray(ctx, root, 'symbols', '');
  if (!symbols) return;
  if (symbols.length === 0) {
    fail(ctx, 'symbols', 'must contain at least one symbol');
    return;
  }
  const seen = new Set<string>();
  symbols.forEach((item, i) => {
    const base = `symbols.${i}`;
    const row = asObject(ctx, item, base, SYMBOL_KEYS);
    if (!row) return;
    const signal = readString(ctx, row, 'signal_symbol', base, true, {
      pattern: SIGNAL_SYMBOL_PATTERN,
      patternMessage: 'must be uppercase (A-Z, 0-9, ., _, -)',
    });
    readString(ctx, row, 'broker_symbol', base, true, {
      pattern: BROKER_SYMBOL_PATTERN,
      patternMessage: 'must be a broker symbol (letters, digits, . _ + -)',
    });
    if (signal !== undefined) {
      if (seen.has(signal)) fail(ctx, `${base}.signal_symbol`, 'duplicate signal_symbol');
      seen.add(signal);
    }
  });
}

function checkEntry(ctx: Ctx, root: Obj): void {
  const entry = readSection(ctx, root, 'entry', '', ENTRY_KEYS);
  if (!entry) return;
  readEnum(ctx, entry, 'policy', 'entry', true, ENTRY_POLICIES);
  readNumber(ctx, entry, 'market_tolerance_price', 'entry', true, { min: 0 });
  readNumber(ctx, entry, 'pending_expiry_minutes', 'entry', true, {
    integer: true,
    min: 1,
    max: 10080,
  });
  readBoolean(ctx, entry, 'allow_market_fallback', 'entry', true);
}

function checkSizing(ctx: Ctx, root: Obj): void {
  const sizing = readSection(ctx, root, 'sizing', '', SIZING_KEYS);
  if (!sizing) return;
  const mode = readEnum(ctx, sizing, 'mode', 'sizing', true, SIZING_MODES);
  readEnum(ctx, sizing, 'below_min_volume', 'sizing', true, [
    'skip',
    'use_min_if_within_cap',
  ] as const);

  // The value matching `mode` is required and must be > 0. Values for other
  // modes are ignored (warning). Every present value is checked against its
  // hard ceiling, active or not.
  const fields: {
    key: 'fixed_lots' | 'risk_money' | 'risk_percent';
    active: SizingMode;
    rule: NumberRule;
  }[] = [
    { key: 'fixed_lots', active: 'fixed_lots', rule: { min: 0, minExclusive: true, ceiling: ceilingFor('max_lots_per_trade') } },
    {
      key: 'risk_money',
      active: 'fixed_risk_money',
      rule: { min: 0, minExclusive: true, ceiling: ceilingFor('max_risk_money_per_trade') },
    },
    {
      key: 'risk_percent',
      active: 'equity_risk_percent',
      rule: { min: 0, minExclusive: true, max: 10, ceiling: ceilingFor('max_risk_percent_per_trade') },
    },
  ];
  for (const field of fields) {
    if (mode === field.active) {
      readNumber(ctx, sizing, field.key, 'sizing', true, field.rule);
    } else {
      const value = readNumber(ctx, sizing, field.key, 'sizing', false, { ceiling: field.rule.ceiling });
      if (value !== undefined && mode !== undefined) {
        note(ctx, `sizing.${field.key}`, `ignored: sizing.mode is ${mode}`);
      }
    }
  }
}

/** Returns the set of valid checkpoint indexes, or undefined when the list is malformed. */
function checkTakeProfit(ctx: Ctx, root: Obj): Set<number> | undefined {
  const takeProfit = readSection(ctx, root, 'take_profit', '', TAKE_PROFIT_KEYS);
  if (!takeProfit) return undefined;

  let indexes: Set<number> | undefined;
  const checkpoints = readArray(ctx, takeProfit, 'checkpoints', 'take_profit');
  if (checkpoints) {
    if (checkpoints.length === 0) {
      fail(ctx, 'take_profit.checkpoints', 'must contain at least one checkpoint');
    } else {
      let wellFormed = true;
      let previous: number | undefined;
      let percentSum = 0;
      const found = new Set<number>();
      checkpoints.forEach((item, i) => {
        const base = `take_profit.checkpoints.${i}`;
        const row = asObject(ctx, item, base, CHECKPOINT_KEYS);
        if (!row) {
          wellFormed = false;
          return;
        }
        const index = readNumber(ctx, row, 'tp_index', base, true, { integer: true, min: 1, max: 10 });
        const percent = readNumber(ctx, row, 'close_percent', base, true, {
          min: 0,
          minExclusive: true,
          max: 100,
        });
        if (index === undefined || percent === undefined) {
          wellFormed = false;
          return;
        }
        if (previous !== undefined && index <= previous) {
          fail(ctx, `${base}.tp_index`, 'must be strictly ascending');
        }
        previous = index;
        found.add(index);
        percentSum += percent;
      });
      if (wellFormed) {
        if (Math.abs(percentSum - 100) > 1e-6) {
          fail(ctx, 'take_profit.checkpoints', `close_percent must sum to 100 (got ${percentSum})`);
        }
        indexes = found;
      }
    }
  }

  readEnum(ctx, takeProfit, 'missing_tp', 'take_profit', true, [
    'skip_trade',
    'merge_into_last_available',
  ] as const);
  readEnum(ctx, takeProfit, 'infeasible_split', 'take_profit', true, [
    'skip_trade',
    'merge_into_next',
  ] as const);
  readEnum(ctx, takeProfit, 'broker_tp', 'take_profit', true, ['final_checkpoint', 'none'] as const);
  return indexes;
}

/** Shared rule for break_even / trailing activation triggers. */
function readActivationValue(
  ctx: Ctx,
  section: Obj,
  base: string,
  key: string,
  trigger: (typeof ACTIVATIONS)[number] | undefined,
  enabled: boolean | undefined,
  cpIndexes: Set<number> | undefined,
): void {
  const rule: NumberRule =
    trigger === 'after_tp_index'
      ? { integer: true, min: 1, max: 10 }
      : trigger === 'price_distance'
        ? { min: 0, minExclusive: enabled === true }
        : {};
  const value = readNumber(ctx, section, key, base, true, rule);
  if (trigger === 'after_tp_index' && value !== undefined && cpIndexes && !cpIndexes.has(value)) {
    fail(ctx, join(base, key), 'must reference a checkpoint tp_index');
  }
}

function checkStopLoss(ctx: Ctx, root: Obj, cpIndexes: Set<number> | undefined): void {
  const stopLoss = readSection(ctx, root, 'stop_loss', '', STOP_LOSS_KEYS);
  if (!stopLoss) return;
  const min = readNumber(ctx, stopLoss, 'min_distance_price', 'stop_loss', true, { min: 0 });
  const max = readNumber(ctx, stopLoss, 'max_distance_price', 'stop_loss', true, {
    min: 0,
    minExclusive: true,
  });
  if (min !== undefined && max !== undefined && max <= min) {
    fail(ctx, 'stop_loss.max_distance_price', 'must be greater than min_distance_price');
  }

  const rows = readArray(ctx, stopLoss, 'after_checkpoint', 'stop_loss');
  if (!rows) return;
  const seen = new Set<number>();
  rows.forEach((item, i) => {
    const base = `stop_loss.after_checkpoint.${i}`;
    const row = asObject(ctx, item, base, AFTER_CHECKPOINT_KEYS);
    if (!row) return;
    const index = readNumber(ctx, row, 'after_tp_index', base, true, { integer: true, min: 1, max: 10 });
    readEnum(ctx, row, 'move_to', base, true, ['entry', 'previous_tp'] as const);
    readNumber(ctx, row, 'buffer_price', base, true, { min: 0 });
    if (index === undefined) return;
    if (cpIndexes && !cpIndexes.has(index)) {
      fail(ctx, `${base}.after_tp_index`, 'must reference a checkpoint tp_index');
    }
    if (seen.has(index)) fail(ctx, `${base}.after_tp_index`, 'duplicate after_tp_index');
    seen.add(index);
  });
}

function checkBreakEven(ctx: Ctx, root: Obj, cpIndexes: Set<number> | undefined): void {
  const breakEven = readSection(ctx, root, 'break_even', '', BREAK_EVEN_KEYS);
  if (!breakEven) return;
  const enabled = readBoolean(ctx, breakEven, 'enabled', 'break_even', true);
  const trigger = readEnum(ctx, breakEven, 'trigger', 'break_even', true, ACTIVATIONS);
  readActivationValue(ctx, breakEven, 'break_even', 'trigger_value', trigger, enabled, cpIndexes);
  readNumber(ctx, breakEven, 'buffer_price', 'break_even', true, { min: 0 });
}

function checkTrailing(ctx: Ctx, root: Obj, cpIndexes: Set<number> | undefined): void {
  const trailing = readSection(ctx, root, 'trailing', '', TRAILING_KEYS);
  if (!trailing) return;
  const enabled = readBoolean(ctx, trailing, 'enabled', 'trailing', true);
  const activation = readEnum(ctx, trailing, 'activation', 'trailing', true, ACTIVATIONS);
  readActivationValue(ctx, trailing, 'trailing', 'activation_value', activation, enabled, cpIndexes);
  readNumber(ctx, trailing, 'distance_price', 'trailing', true, { min: 0, minExclusive: enabled === true });
  readNumber(ctx, trailing, 'step_price', 'trailing', true, { min: 0, minExclusive: enabled === true });
}

function checkLimits(ctx: Ctx, root: Obj): void {
  const limits = readSection(ctx, root, 'limits', '', LIMIT_KEYS);
  if (!limits) return;
  const concurrent = readNumber(ctx, limits, 'max_concurrent_positions', 'limits', true, {
    integer: true,
    min: 1,
    ceiling: ceilingFor('max_concurrent_positions'),
  });
  const perSymbol = readNumber(ctx, limits, 'max_positions_per_symbol', 'limits', true, {
    integer: true,
    min: 1,
    ceiling: ceilingFor('max_positions_per_symbol'),
  });
  if (concurrent !== undefined && perSymbol !== undefined && perSymbol > concurrent) {
    fail(
      ctx,
      'limits.max_positions_per_symbol',
      `must be <= max_concurrent_positions ${concurrent} (got ${perSymbol})`,
      { value: perSymbol, limit: concurrent },
    );
  }
  readNumber(ctx, limits, 'max_spread_price', 'limits', true, {
    min: 0,
    minExclusive: true,
    ceiling: ceilingFor('max_spread_price'),
  });
  readNumber(ctx, limits, 'max_deviation_points', 'limits', true, {
    integer: true,
    min: 0,
    ceiling: ceilingFor('max_deviation_points'),
  });
  readNumber(ctx, limits, 'signal_max_age_sec', 'limits', true, {
    integer: true,
    min: 5,
    max: 3600,
    ceiling: ceilingFor('max_signal_age_sec'),
  });
  readNumber(ctx, limits, 'daily_loss_limit_money', 'limits', true, {
    min: 0,
    minExclusive: true,
    ceiling: ceilingFor('daily_loss_limit_money'),
  });
  readNumber(ctx, limits, 'max_total_risk_percent', 'limits', true, {
    min: 0,
    minExclusive: true,
    max: 50,
    ceiling: ceilingFor('max_total_risk_percent'),
  });
}

function checkEdits(ctx: Ctx, root: Obj): void {
  const edits = readSection(ctx, root, 'edits', '', EDIT_KEYS);
  if (!edits) return;
  readEnum(ctx, edits, 'before_fill', 'edits', true, ['ignore', 'apply_sl_tp'] as const);
  readEnum(ctx, edits, 'after_fill', 'edits', true, ['ignore', 'apply_tighten_only', 'apply'] as const);
  readEnum(ctx, edits, 'unparseable_edit', 'edits', true, ['ignore', 'cancel_pending_only'] as const);
  readEnum(ctx, edits, 'explicit_cancel', 'edits', true, [
    'ignore',
    'cancel_pending_only',
    'close_position',
  ] as const);
}

function checkProfile(ctx: Ctx, root: Obj): void {
  checkProfileHeader(ctx, root);
  checkSource(ctx, root);
  checkSymbols(ctx, root);
  checkEntry(ctx, root);
  checkSizing(ctx, root);
  const cpIndexes = checkTakeProfit(ctx, root);
  checkStopLoss(ctx, root, cpIndexes);
  checkBreakEven(ctx, root, cpIndexes);
  checkTrailing(ctx, root, cpIndexes);
  checkLimits(ctx, root);
  checkEdits(ctx, root);
  if (root.recommendations !== undefined && !isPlainObject(root.recommendations)) {
    fail(ctx, 'recommendations', 'must be an object');
  }
}

/**
 * Strict validation of an execution profile. Unknown keys, missing required
 * fields, bad enums/ranges and broken cross-references are errors. On success
 * `value` is a deep copy of the input. Never fills in defaults.
 */
export function validateProfile(input: unknown): ValidationResult<ExecutionProfile> {
  const ctx: Ctx = { errors: [], warnings: [] };
  const root = asObject(ctx, input, '', PROFILE_KEYS);
  if (root) checkProfile(ctx, root);
  const ok = ctx.errors.length === 0;
  return {
    ok,
    value: ok ? deepCopy(input as ExecutionProfile) : undefined,
    errors: ctx.errors,
    warnings: ctx.warnings,
  };
}

/**
 * Strict validation of the operator safety limits (settings.safety). Every
 * numeric field is required, > 0 (min_margin_level_percent >= 0) and <= the
 * matching HARD_CEILINGS value.
 */
export function validateSafetyLimits(input: unknown): ValidationResult<SafetyLimits> {
  const ctx: Ctx = { errors: [], warnings: [] };
  const s = asObject(ctx, input, '', SAFETY_KEYS);
  if (s) {
    const c = HARD_CEILINGS;
    readNumber(ctx, s, 'max_risk_percent_per_trade', '', true, { min: 0, minExclusive: true, max: c.max_risk_percent_per_trade });
    readNumber(ctx, s, 'max_risk_money_per_trade', '', true, { min: 0, minExclusive: true, max: c.max_risk_money_per_trade });
    readNumber(ctx, s, 'max_lots_per_trade', '', true, { min: 0, minExclusive: true, max: c.max_lots_per_trade });
    readNumber(ctx, s, 'max_concurrent_positions', '', true, { integer: true, min: 0, minExclusive: true, max: c.max_concurrent_positions });
    readNumber(ctx, s, 'max_positions_per_symbol', '', true, { integer: true, min: 0, minExclusive: true, max: c.max_positions_per_symbol });
    readNumber(ctx, s, 'daily_loss_limit_money', '', true, { min: 0, minExclusive: true, max: c.daily_loss_limit_money });
    readNumber(ctx, s, 'max_total_risk_percent', '', true, { min: 0, minExclusive: true, max: c.max_total_risk_percent });
    readNumber(ctx, s, 'max_spread_price', '', true, { min: 0, minExclusive: true, max: c.max_spread_price });
    readNumber(ctx, s, 'max_deviation_points', '', true, { integer: true, min: 0, minExclusive: true, max: c.max_deviation_points });
    readNumber(ctx, s, 'max_signal_age_sec', '', true, { integer: true, min: 0, minExclusive: true, max: c.max_signal_age_sec });
    readNumber(ctx, s, 'min_margin_level_percent', '', true, { min: 0, max: c.min_margin_level_percent });

    const symbols = readArray(ctx, s, 'allowed_signal_symbols', '');
    if (symbols) {
      if (symbols.length === 0) {
        fail(ctx, 'allowed_signal_symbols', 'must contain at least one symbol');
      }
      symbols.forEach((item, i) => {
        const path = `allowed_signal_symbols.${i}`;
        if (typeof item !== 'string' || !SIGNAL_SYMBOL_PATTERN.test(item)) {
          fail(ctx, path, 'must be an uppercase symbol string');
        }
      });
    }
  }
  const ok = ctx.errors.length === 0;
  return {
    ok,
    value: ok ? deepCopy(input as SafetyLimits) : undefined,
    errors: ctx.errors,
    warnings: ctx.warnings,
  };
}

interface SafetyMapping {
  path: string;
  key: NumericSafetyKey;
  read: (profile: ExecutionProfile) => number | undefined;
}

/** Profile values checked against a hard ceiling (validateProfile) or a safety limit (validateProfileAgainstSafety). */
const SAFETY_MAPPINGS: SafetyMapping[] = [
  { path: 'sizing.fixed_lots', key: 'max_lots_per_trade', read: (p) => p.sizing.fixed_lots },
  { path: 'sizing.risk_money', key: 'max_risk_money_per_trade', read: (p) => p.sizing.risk_money },
  { path: 'sizing.risk_percent', key: 'max_risk_percent_per_trade', read: (p) => p.sizing.risk_percent },
  {
    path: 'limits.max_concurrent_positions',
    key: 'max_concurrent_positions',
    read: (p) => p.limits.max_concurrent_positions,
  },
  {
    path: 'limits.max_positions_per_symbol',
    key: 'max_positions_per_symbol',
    read: (p) => p.limits.max_positions_per_symbol,
  },
  { path: 'limits.max_spread_price', key: 'max_spread_price', read: (p) => p.limits.max_spread_price },
  {
    path: 'limits.max_deviation_points',
    key: 'max_deviation_points',
    read: (p) => p.limits.max_deviation_points,
  },
  { path: 'limits.signal_max_age_sec', key: 'max_signal_age_sec', read: (p) => p.limits.signal_max_age_sec },
  {
    path: 'limits.daily_loss_limit_money',
    key: 'daily_loss_limit_money',
    read: (p) => p.limits.daily_loss_limit_money,
  },
  {
    path: 'limits.max_total_risk_percent',
    key: 'max_total_risk_percent',
    read: (p) => p.limits.max_total_risk_percent,
  },
];

/**
 * Checks a validated profile against the current operator safety limits.
 * Used at activation time and at runtime to refuse new entries. An empty
 * result means the profile is within safety and only uses allowed symbols.
 * Open trades are not affected: they are managed under their frozen snapshot.
 */
export function validateProfileAgainstSafety(
  profile: ExecutionProfile,
  safety: SafetyLimits,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const mapping of SAFETY_MAPPINGS) {
    const value = mapping.read(profile);
    const limit = safety[mapping.key];
    if (value !== undefined && value > limit) {
      const leaf = mapping.path.slice(mapping.path.lastIndexOf('.') + 1);
      issues.push({
        path: mapping.path,
        message: `${leaf} ${value} exceeds safety limit ${mapping.key} ${limit}`,
        value,
        limit,
      });
    }
  }
  const allowed = safety.allowed_signal_symbols.map((symbol) => symbol.toUpperCase());
  profile.symbols.forEach((row, i) => {
    if (!allowed.includes(row.signal_symbol.toUpperCase())) {
      issues.push({
        path: `symbols.${i}.signal_symbol`,
        message: `signal_symbol ${row.signal_symbol} is not in allowed_signal_symbols [${safety.allowed_signal_symbols.join(', ')}]`,
        value: row.signal_symbol,
        limit: safety.allowed_signal_symbols,
      });
    }
  });
  return issues;
}

/** Per-axis min() of the profile limits and the operator safety limits. */
export function effectiveLimits(profile: ExecutionProfile, safety: SafetyLimits): EffectiveLimits {
  return {
    maxRiskPercent: safety.max_risk_percent_per_trade,
    maxRiskMoney: safety.max_risk_money_per_trade,
    maxLots: safety.max_lots_per_trade,
    maxConcurrent: Math.min(profile.limits.max_concurrent_positions, safety.max_concurrent_positions),
    maxPerSymbol: Math.min(profile.limits.max_positions_per_symbol, safety.max_positions_per_symbol),
    dailyLossLimit: Math.min(profile.limits.daily_loss_limit_money, safety.daily_loss_limit_money),
    maxTotalRiskPercent: Math.min(profile.limits.max_total_risk_percent, safety.max_total_risk_percent),
    maxSpreadPrice: Math.min(profile.limits.max_spread_price, safety.max_spread_price),
    maxDeviationPoints: Math.min(profile.limits.max_deviation_points, safety.max_deviation_points),
    maxSignalAgeSec: Math.min(profile.limits.signal_max_age_sec, safety.max_signal_age_sec),
    minMarginLevelPercent: safety.min_margin_level_percent,
  };
}

/** Firestore document id for a stored profile version. */
/**
 * Server-owned fields stored beside a profile's own fields in
 * `execution_profiles/{docId}` (status, validation, who/when). They are not part
 * of the profile: the web routes strip them from client input, and the
 * AutoTrader strips them before validating a stored profile. One list for both,
 * so a field the web writes can never make a stored profile invalid at runtime.
 */
export const PROFILE_ENVELOPE_FIELDS: readonly string[] = [
  'status',
  'validation',
  'doc_id',
  'created_at',
  'created_by',
  'created_by_uid',
  'updated_at',
  'updated_by',
  'updated_by_uid',
  'approved_at',
  'approved_by',
  'approved_by_uid',
  'activated_at',
  'activated_by',
  'activated_by_uid',
  'superseded_at',
  'rejected_at',
  'rejected_by',
  'rejected_by_uid',
  'rejected_reason',
];

export function profileDocId(profileId: string, version: number): string {
  return `${profileId}__v${version}`;
}

/** Case-insensitive mapping from a signal symbol to the broker symbol, or null. */
export function resolveBrokerSymbol(profile: ExecutionProfile, signalSymbol: string): string | null {
  const wanted = signalSymbol.toUpperCase();
  const match = profile.symbols.find((row) => row.signal_symbol.toUpperCase() === wanted);
  return match ? match.broker_symbol : null;
}

/**
 * Validates the DRAFT execution profiles of the 2026-10-21 XAUUSD signal-provider
 * research with the REAL worker validator and planners:
 *   worker/src/lib/executionProfile.ts  (validateProfile, validateProfileAgainstSafety, ...)
 *   worker/src/lib/entryPolicy.ts       (decideEntry, validateStopLoss)
 *   worker/src/lib/positionSizing.ts    (computeVolume, planCheckpoints)
 *
 * Read-only. Reads the draft JSON files and imports the TypeScript sources through
 * Node's built-in type stripping (no compile, no emit, nothing written). No sockets,
 * no broker, no Firestore, no .env files. The stored drafts omit `version`; it is
 * injected in memory only, as the validator requires.
 *
 * Run (Node 24): node validate_profiles.mts
 */
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SAFETY_LIMITS,
  HARD_CEILINGS,
  effectiveLimits,
  resolveBrokerSymbol,
  validateProfile,
  validateProfileAgainstSafety,
  validateSafetyLimits,
} from '/home/kyle/projects/ByTrader/worker/src/lib/executionProfile.ts';
import { decideEntry, validateStopLoss } from '/home/kyle/projects/ByTrader/worker/src/lib/entryPolicy.ts';
import { computeVolume, planCheckpoints } from '/home/kyle/projects/ByTrader/worker/src/lib/positionSizing.ts';

const DRAFT_DIR = '/home/kyle/projects/ByTrader/docs/research/signal_provider/2026-10-21';
const DRAFTS = [
  { label: 'PRIMARY conservative (S_TP4|M5, E2)', file: `${DRAFT_DIR}/execution_profile.draft.json` },
  { label: 'ALTERNATE balanced (Q_25x4|M0, E2)', file: `${DRAFT_DIR}/alternates/balanced.draft.json` },
  { label: 'ALTERNATE aggressive (S_TP4|M0, E2, 1% risk)', file: `${DRAFT_DIR}/alternates/aggressive.draft.json` },
  { label: 'REFERENCE benchmark (S_TP1|M0, E2)', file: `${DRAFT_DIR}/alternates/benchmark_tp1.reference.json` },
];

type Json = Record<string, any>;

const loadStored = (file: string): Json => JSON.parse(readFileSync(file, 'utf8'));
/** In-memory only: the stored drafts must not carry version (OPTIMAL_REPORT_SCHEMA section 8). */
const withVersion = (raw: Json): Json => ({ ...raw, version: 1 });
const clone = (raw: Json): Json => structuredClone(raw);

/** The sanctioned relaxed-allowlist safety: HARD_CEILINGS numbers, only XAUUSD allowed. */
const HARD_CEILINGS_XAU = { ...HARD_CEILINGS, allowed_signal_symbols: ['XAUUSD'] };

const fmt = (v: unknown): string => (v === undefined ? 'n/a' : JSON.stringify(v));
function fmtIssue(i: { path: string; message: string; value?: unknown; limit?: unknown }): string {
  const parts = [`  - ${i.path}: ${i.message}`];
  if (i.value !== undefined) parts.push(`value=${fmt(i.value)}`);
  if (i.limit !== undefined) parts.push(`limit=${fmt(i.limit)}`);
  return parts.join(' | ');
}
function printIssues(title: string, list: { path: string; message: string; value?: unknown; limit?: unknown }[]) {
  console.log(`${title} (${list.length}):`);
  for (const i of list) console.log(fmtIssue(i));
}
function header(title: string) {
  console.log('');
  console.log('='.repeat(96));
  console.log(title);
  console.log('='.repeat(96));
}

// ---------------------------------------------------------------------------
header('A. Environment and sanity checks');
console.log(`node ${process.version}`);
console.log('validator source: worker/src/lib/executionProfile.ts (imported via Node type stripping, not compiled)');
const sv = validateSafetyLimits(DEFAULT_SAFETY_LIMITS);
console.log(`validateSafetyLimits(DEFAULT_SAFETY_LIMITS): ok=${sv.ok} errors=${sv.errors.length} warnings=${sv.warnings.length}`);
const svH = validateSafetyLimits(HARD_CEILINGS);
console.log(`validateSafetyLimits(HARD_CEILINGS) [allowed_signal_symbols is empty by design]: ok=${svH.ok}`);
for (const e of svH.errors) console.log(fmtIssue(e));
const svHX = validateSafetyLimits(HARD_CEILINGS_XAU);
console.log(`validateSafetyLimits(HARD_CEILINGS + allowed XAUUSD): ok=${svHX.ok} errors=${svHX.errors.length}`);

// ---------------------------------------------------------------------------
header('B. Real validator on each stored draft (version:1 injected in memory)');
const stored: Record<string, Json> = {};
for (const d of DRAFTS) {
  const raw = loadStored(d.file);
  stored[d.file] = raw;
  console.log('');
  console.log(`--- ${d.label}`);
  console.log(`file: ${d.file}`);
  console.log(`stored file has 'version' key: ${'version' in raw} (expected false)`);
  console.log(`profile_id ${JSON.stringify(raw.profile_id)} matches /^[a-z0-9][a-z0-9-]{2,47}$/: ${/^[a-z0-9][a-z0-9-]{2,47}$/.test(raw.profile_id)}`);
  console.log(`name length ${raw.name.length} (must be 1..80)`);
  console.log(`broker_symbol ${JSON.stringify(raw.symbols[0].broker_symbol)} matches broker regex /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/: ${/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(raw.symbols[0].broker_symbol)}`);

  const v = validateProfile(withVersion(raw));
  console.log(`validateProfile: ok=${v.ok}`);
  printIssues('  errors', v.errors);
  printIssues('  warnings', v.warnings);

  if (v.ok && v.value) {
    const a = validateProfileAgainstSafety(v.value, DEFAULT_SAFETY_LIMITS);
    printIssues('validateProfileAgainstSafety vs DEFAULT_SAFETY_LIMITS (settings.safety absent case)', a);
    const b = validateProfileAgainstSafety(v.value, HARD_CEILINGS_XAU);
    printIssues('validateProfileAgainstSafety vs HARD_CEILINGS + allowed XAUUSD', b);
    const whatIf = { ...DEFAULT_SAFETY_LIMITS, max_spread_price: 1.0 };
    const c = validateProfileAgainstSafety(v.value, whatIf);
    printIssues('validateProfileAgainstSafety vs DEFAULT with max_spread_price=1.0 (what-if, in memory only)', c);
    const eff = effectiveLimits(v.value, DEFAULT_SAFETY_LIMITS);
    console.log(`effectiveLimits vs DEFAULT: ${JSON.stringify(eff)}`);
    console.log(`resolveBrokerSymbol('XAUUSD') -> ${fmt(resolveBrokerSymbol(v.value, 'XAUUSD'))}`);
  }
}

// ---------------------------------------------------------------------------
header('C. Negative tests: strictness and the broker-symbol placeholder');
const primary = stored[DRAFTS[0].file];

function expectRejected(label: string, mutated: Json, withVer = true) {
  const input = withVer ? withVersion(mutated) : mutated;
  const r = validateProfile(input);
  console.log('');
  console.log(`N: ${label}`);
  console.log(`   validateProfile ok=${r.ok}`);
  printIssues('   errors', r.errors);
}

{
  const r = validateProfile(primary);
  console.log('');
  console.log('N0: primary exactly as stored (no version): expect version required');
  console.log(`   validateProfile ok=${r.ok}`);
  printIssues('   errors', r.errors);
}
{
  const m = clone(primary);
  m.sizing.fixedlots = 0.1;
  expectRejected('unknown nested key sizing.fixedlots (typo for fixed_lots) added to the primary', m);
}
{
  const m = clone(primary);
  m.status = 'approved';
  expectRejected('server-owned top-level key status added to the primary (not a profile field)', m);
}
{
  const m = clone(primary);
  m.break_even.trigger_valu = m.break_even.trigger_value;
  delete m.break_even.trigger_value;
  expectRejected('typo trigger_valu instead of trigger_value (one unknown key plus one missing field)', m);
}
{
  const m = clone(primary);
  m.sizing.risk_percent = 6;
  expectRejected('sizing.risk_percent 6 (above the 5 ceiling; also inside the 0..10 range rule)', m);
}
{
  const m = clone(primary);
  m.entry.market_tolerance_price = '0.5';
  expectRejected('numeric field as a string (entry.market_tolerance_price "0.5")', m);
}
{
  const sym = primary.symbols[0].broker_symbol;
  const regexOk = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(sym);
  const v = validateProfile(withVersion(primary));
  console.log('');
  console.log(`N: broker placeholder ${JSON.stringify(sym)} against the schema`);
  console.log(`   regex only: ${regexOk}`);
  console.log(`   validateProfile ok=${v.ok} (passes the schema)`);
  console.log(`   resolveBrokerSymbol -> ${fmt(resolveBrokerSymbol(v.value ?? withVersion(primary), 'XAUUSD'))}`);
  console.log('   NOT tested here: the terminal lookup. Reading mt5TradeEngine.ts gate 6, the engine maps a');
  console.log('   terminal "unknown symbol" rejection (retcode 5007) to skip symbol_not_mapped. No socket was opened.');
}

// ---------------------------------------------------------------------------
header('D. Entry decisions (entryPolicy.decideEntry, primary entry block)');
const entryPrimary = primary.entry;
const base = { symbol: 'XAUUSD', entryLow: 4000, entryHigh: 4002, stopLoss: 3995, takeProfits: [4006, 4010, 4014, 4018] };
const entryCases: [string, object, { bid: number; ask: number }, object][] = [
  ['market BUY, range 4000-4002, Ask 4001.0 (inside range)', { ...base, direction: 'buy', orderType: 'market' }, { bid: 4000.8, ask: 4001.0 }, entryPrimary],
  ['market BUY, Ask 4002.4 (inside tolerance 0.5)', { ...base, direction: 'buy', orderType: 'market' }, { bid: 4002.2, ask: 4002.4 }, entryPrimary],
  ['market BUY, Ask 4003.0 (beyond high+0.5)', { ...base, direction: 'buy', orderType: 'market' }, { bid: 4002.8, ask: 4003.0 }, entryPrimary],
  ['market BUY, Ask 3999.0 (below low-0.5; not pending-eligible for BUY)', { ...base, direction: 'buy', orderType: 'market' }, { bid: 3998.8, ask: 3999.0 }, entryPrimary],
  ['buy_limit BUY signal, Ask 4003.0 (BUY_LIMIT at 4002 still valid)', { ...base, direction: 'buy', orderType: 'buy_limit' }, { bid: 4002.8, ask: 4003.0 }, entryPrimary],
  ['buy_limit BUY signal, Ask 4001.0 (4002 not below Ask), fallback=false', { ...base, direction: 'buy', orderType: 'buy_limit' }, { bid: 4000.8, ask: 4001.0 }, entryPrimary],
  ['buy_limit BUY signal, Ask 4001.0, fallback=true (in-memory what-if)', { ...base, direction: 'buy', orderType: 'buy_limit' }, { bid: 4000.8, ask: 4001.0 }, { ...entryPrimary, allow_market_fallback: true }],
  ['market SELL, range 3998-4000, Bid 3996.0 (beyond low-0.5)', { ...base, entryLow: 3998, entryHigh: 4000, direction: 'sell', orderType: 'market', stopLoss: 4005, takeProfits: [3992, 3988, 3984, 3980] }, { bid: 3996.0, ask: 3996.2 }, entryPrimary],
];
for (const [label, sig, quote, entry] of entryCases) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decision = decideEntry(sig as any, quote as { bid: number; ask: number }, entry as any);
  console.log(`- ${label}`);
  console.log(`    -> ${JSON.stringify(decision)}`);
}

header('E. Stop-loss checks (entryPolicy.validateStopLoss, primary stop_loss block, entry ref 4002 BUY)');
for (const sl of [3995, 4001.5, 3980, 4003]) {
  const r = validateStopLoss('buy', 4002, sl, primary.stop_loss);
  console.log(`- BUY stop ${sl} (distance ${(4002 - sl).toFixed(2)}): ${JSON.stringify(r)}`);
}

// ---------------------------------------------------------------------------
header('F. Volume sizing (positionSizing.computeVolume) with DEFAULT safety, ASSUMED contract spec');
console.log('ASSUMED spec (not verified for Vantage): tickSize 0.01, tickValueLoss 1.00 USD per lot per tick (100 oz/lot),');
console.log('volumeMin 0.01, volumeMax 100, volumeStep 0.01. Entry 4000 BUY; stop = entry - distance.');
console.log('Cell = volume (lots). SKIP:min = volume_below_min (below_min_volume skip). c = clamped to max. cap = min(50 USD, equity * 1%) under DEFAULT safety.');
const spec = { tickSize: 0.01, tickValueLoss: 1.0, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 };
const limitsDefault = effectiveLimits(primary as any, DEFAULT_SAFETY_LIMITS);
const distances = [2, 5, 10, 12, 15];
const equities = [500, 1000, 2000, 5000, 10000];
for (const risk of [0.25, 0.5, 1.0]) {
  console.log('');
  console.log(`risk_percent ${risk} (below_min_volume skip)`);
  console.log(`  equity  | ${distances.map((d) => `stop ${d}`.padEnd(12)).join('')}`);
  for (const equity of equities) {
    const cells = distances.map((d) => {
      const r = computeVolume({
        sizing: { mode: 'equity_risk_percent', risk_percent: risk, below_min_volume: 'skip' } as any,
        entryPrice: 4000,
        stopLoss: 4000 - d,
        equity,
        spec,
        limits: limitsDefault,
      });
      const text = r.ok ? `${r.volume.toFixed(2)}${r.clampedBy ? 'c' : ''}` : `SKIP:${r.reason === 'volume_below_min' ? 'min' : r.reason}`;
      return text.padEnd(12);
    });
    console.log(`  ${String(equity).padEnd(7)} | ${cells.join('')}`);
  }
}

// ---------------------------------------------------------------------------
header('G. Checkpoint planning (positionSizing.planCheckpoints), BUY entry 4002, TP1..TP4 = 4006/4010/4014/4018');
const tps = [4006, 4010, 4014, 4018];
const tpsNoTp4 = [4006, 4010, 4014];
const plan = (label: string, totalVolume: number, takeProfit: Json, takeProfits = tps) => {
  const r = planCheckpoints({
    totalVolume,
    direction: 'buy',
    entryPrice: 4002,
    takeProfits,
    takeProfit: takeProfit as any,
    spec: { volumeMin: 0.01, volumeStep: 0.01 },
  });
  console.log(`- ${label}, total ${totalVolume}: ${JSON.stringify(r)}`);
};
console.log('PRIMARY S_TP4 (100% at TP4, skip_trade on missing or infeasible):');
for (const v of [0.01, 0.04, 0.1]) plan('S_TP4', v, primary.take_profit);
plan('S_TP4 with TP4 missing from signal', 0.04, primary.take_profit, tpsNoTp4);
const balanced = stored[DRAFTS[1].file];
console.log('');
console.log('BALANCED Q_25x4 (25/25/25/25; merge_into_next, merge_into_last_available):');
for (const v of [0.02, 0.03, 0.04, 0.1]) plan('Q_25x4 merge_into_next', v, balanced.take_profit);
console.log('');
console.log('Same split with infeasible_split=skip_trade (in-memory what-if) to show when the full 4-way split is exact:');
for (const v of [0.03, 0.04]) plan('Q_25x4 skip_trade', v, { ...balanced.take_profit, infeasible_split: 'skip_trade' });
console.log('');
console.log('Q_25x4 with TP4 missing:');
plan('Q_25x4 merge_into_last_available', 0.04, balanced.take_profit, tpsNoTp4);
plan('Q_25x4 skip_trade on missing', 0.04, { ...balanced.take_profit, missing_tp: 'skip_trade' }, tpsNoTp4);

// ---------------------------------------------------------------------------
header('H. Safety-gate what-if: spread gate and default safety (memory only, no file changed)');
const spreadWhatIfs = [0.5, 0.69, 1.0];
for (const s of spreadWhatIfs) {
  const issues = validateProfileAgainstSafety(
    validateProfile(withVersion(primary)).value as any,
    { ...DEFAULT_SAFETY_LIMITS, max_spread_price: s },
  );
  console.log(`- safety.max_spread_price=${s}: ${issues.length === 0 ? 'no safety issues' : issues.map((i) => i.path + ' ' + i.message).join('; ')}`);
}
console.log('Runtime effect (mt5TradeEngine.ts gate 2): any safety issue -> skip invalid_profile for every new entry.');
console.log('The profile is refused, not clamped; effectiveLimits min() never sees a value above safety at runtime.');

console.log('');
console.log('Done. No file was written by this script. Output is printed to stdout only.');

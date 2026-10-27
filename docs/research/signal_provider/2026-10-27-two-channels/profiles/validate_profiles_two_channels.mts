/**
 * Validates the 2026-10-27 two-channel DRAFT profile(s) with the REAL TypeScript validators and planners
 * (worker/src/lib/executionProfile.ts, entryPolicy.ts, positionSizing.ts) via Node 24 type stripping.
 * Read-only: no compile, no sockets, no broker, no Firestore, no .env. version:1 injected in memory only.
 * usage: node validate_profiles_two_channels.mts DRAFT_JSON [...]
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_SAFETY_LIMITS, HARD_CEILINGS, effectiveLimits, resolveBrokerSymbol, validateProfile,
  validateProfileAgainstSafety } from '/home/kyle/projects/ByTrader/worker/src/lib/executionProfile.ts';
import { computeVolume, planCheckpoints } from '/home/kyle/projects/ByTrader/worker/src/lib/positionSizing.ts';

const show = (t: string, l: any[]) => { console.log(`${t} (${l.length}):`); for (const i of l) console.log(`  - ${i.path}: ${i.message}${i.value !== undefined ? ' | value=' + JSON.stringify(i.value) : ''}${i.limit !== undefined ? ' | limit=' + JSON.stringify(i.limit) : ''}`); };
for (const file of process.argv.slice(2)) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n=== ${file}\nstored 'version' key: ${'version' in raw} (expected false)`);
  const v = validateProfile({ ...raw, version: 1 });
  console.log(`validateProfile: ok=${v.ok}`); show('  errors', v.errors); show('  warnings', v.warnings);
  if (!v.ok || !v.value) continue;
  show('vs DEFAULT_SAFETY_LIMITS', validateProfileAgainstSafety(v.value, DEFAULT_SAFETY_LIMITS));
  show('vs DEFAULT with max_spread_price=1.0 (what-if, memory only)', validateProfileAgainstSafety(v.value, { ...DEFAULT_SAFETY_LIMITS, max_spread_price: 1.0 }));
  show('vs HARD_CEILINGS + allowed XAUUSD', validateProfileAgainstSafety(v.value, { ...HARD_CEILINGS, allowed_signal_symbols: ['XAUUSD'] }));
  console.log(`effectiveLimits vs DEFAULT: ${JSON.stringify(effectiveLimits(v.value, DEFAULT_SAFETY_LIMITS))}`);
  console.log(`resolveBrokerSymbol('XAUUSD') -> ${JSON.stringify(resolveBrokerSymbol(v.value, 'XAUUSD'))}`);
  const spec = { tickSize: 0.01, tickValueLoss: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 }; // bridge 2026-10-27
  const lim = effectiveLimits(v.value, DEFAULT_SAFETY_LIMITS);
  for (const eq of [1000, 5000, 7000, 50000]) {
    const vol = computeVolume({ sizing: v.value.sizing, entryPrice: 3992.05, stopLoss: 3984, equity: eq, spec: spec as any, limits: lim as any });
    const plan = vol.ok ? planCheckpoints({ totalVolume: vol.volume, direction: 'buy', entryPrice: 3992.05, takeProfits: [3998, 4006, 4014], takeProfit: v.value.take_profit, spec: spec as any }) : null;
    console.log(`equity ${eq}: computeVolume(S3 E2 fill, stop 3984) -> ${JSON.stringify(vol)}; planCheckpoints -> ${JSON.stringify(plan)}`);
  }
}

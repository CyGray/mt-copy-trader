// Read-budget ledger for Firestore research scripts. Every call reserves its MAX read count first; the
// reservation is settled to the docs actually returned (count() = 1 read per 1000 index entries).
// Hard cap CAP (agree it with the owner; the free plan allows about 50k reads/day shared with the AutoTrader).
// Writes are never called from these scripts. Log and state live in $SP_BUDGET_DIR (default: this directory).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = process.env.SP_BUDGET_DIR ?? dirname(fileURLToPath(import.meta.url));
const LOG = `${DIR}/fs_reads_log.txt`;
const STATE = `${DIR}/fs_budget_state.json`;
export const CAP = Number(process.env.SP_READ_CAP ?? 2500);
let st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { reserved_or_spent: 0, settled_actual: 0 };
const save = () => writeFileSync(STATE, JSON.stringify(st));
const ts = () => new Date().toISOString();
const line = (s) => appendFileSync(LOG, `${ts()} | ${s}\n`);
export function reserve(label, maxReads, query) {
  if (st.reserved_or_spent + maxReads > CAP) {
    line(`ABORT | ${label} | reserve=${maxReads} would exceed cap ${CAP} | cumulative_reserved=${st.reserved_or_spent}`);
    throw new Error(`budget cap reached before ${label}`);
  }
  st.reserved_or_spent += maxReads; save();
  line(`QUERY | ${label} | ${query} | reserved_max_reads=${maxReads} | cumulative_reserved=${st.reserved_or_spent}`);
  return maxReads;
}
export function settle(label, reserved, actualReads, note = '') {
  st.reserved_or_spent -= (reserved - actualReads); st.settled_actual = (st.settled_actual ?? 0) + actualReads; save();
  line(`DONE  | ${label} | actual_reads=${actualReads} | cumulative_reserved=${st.reserved_or_spent}${note ? ' | ' + note : ''}`);
}
export function fail(label, reserved, err) {
  st.reserved_or_spent -= reserved; save();
  line(`FAIL  | ${label} | reads=0 (refunded) | error=${String(err?.code ?? '')} ${String(err?.details ?? err?.message ?? err).slice(0, 160)}`);
}
export function totals() { return { reserved_or_spent: st.reserved_or_spent, settled_actual: st.settled_actual ?? 0 }; }

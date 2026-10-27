/**
 * bridgeHealth.ts
 *
 * One read-only PING through the MT5 bridge queue, shared by the AutoTrader's
 * /health route, its startup checks and the alert monitor. Never throws and
 * never sends a mutation.
 */

import { getCachedGmtSkewSec, getCachedServerTimeOffsetSec, mt5Request } from './mt5Client';

export const REQUIRED_EA_MAJOR = '2.';

export interface PingDetails {
  reachable: boolean;
  eaVersion: string | null;
  terminalConnected: boolean | null;
  tradeAllowed: boolean | null;
  latencyMs: number;
  serverOffsetSec: number | null;
  /** EA TimeGMT() minus the worker clock, seconds. */
  gmtSkewSec: number | null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export async function pingBridge(): Promise<PingDetails> {
  const started = Date.now();
  try {
    const data = await mt5Request('PING');
    return {
      reachable: true,
      eaVersion: typeof data.ea_version === 'string' ? data.ea_version : null,
      terminalConnected: bool(data.terminal_connected),
      tradeAllowed: bool(data.terminal_trade_allowed),
      latencyMs: Date.now() - started,
      serverOffsetSec: getCachedServerTimeOffsetSec(),
      gmtSkewSec: getCachedGmtSkewSec(),
    };
  } catch {
    return {
      reachable: false,
      eaVersion: null,
      terminalConnected: null,
      tradeAllowed: null,
      latencyMs: Date.now() - started,
      serverOffsetSec: getCachedServerTimeOffsetSec(),
      gmtSkewSec: getCachedGmtSkewSec(),
    };
  }
}

/** Largest tolerated |EA TimeGMT − worker clock| before entries are refused (MAX_CLOCK_SKEW_SEC, default 5). */
export function maxClockSkewSec(): number {
  const n = Number(process.env.MAX_CLOCK_SKEW_SEC);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** True when the EA reports protocol-v2 major version. */
export function eaVersionCompatible(version: string | null): boolean {
  return typeof version === 'string' && version.startsWith(REQUIRED_EA_MAJOR);
}

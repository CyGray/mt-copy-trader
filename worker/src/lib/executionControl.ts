/**
 * executionControl.ts
 *
 * Runtime execution policy read from Firestore (contracts §4): mode, kill
 * switch, active execution profile and safety limits. Cached for 5 s.
 *
 * Any missing or unreadable config fails closed: the result blocks new
 * entries. The kill switch blocks entries and pending placement only; it does
 * not stop protective management of open trades.
 */

import {
  DEFAULT_SAFETY_LIMITS,
  PROFILE_ENVELOPE_FIELDS,
  validateProfile,
  validateProfileAgainstSafety,
  validateSafetyLimits,
} from './executionProfile';
import type { ExecutionProfile, SafetyLimits, ValidationIssue } from './executionProfile';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';

export type ExecutionMode = 'disabled' | 'paper' | 'demo' | 'live';

export interface ExecutionControl {
  mode: ExecutionMode;
  killSwitch: boolean;
  activeProfileDocId: string | null;
  activeProfile: ExecutionProfile | null;
  profileErrors: string[];
  safety: SafetyLimits | null;
  safetyErrors: string[];
  liveTradingEnvEnabled: boolean;
  source: 'firestore' | 'fail_closed';
  reason?: string;
  loadedAt: number;
}

const CACHE_TTL_MS = 5_000;
const FAIL_CLOSED_LOG_INTERVAL_MS = 60_000;
const EXECUTION_MODES: readonly string[] = ['disabled', 'paper', 'demo', 'live'];

let cached: ExecutionControl | null = null;
let lastFetch = 0;
let lastFailClosedLogAt: number | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatErrors(issues: ValidationIssue[], fallback: string): string[] {
  const formatted = issues.map((issue) => `${issue.path}: ${issue.message}`);
  return formatted.length > 0 ? formatted : [fallback];
}

function reportFailClosed(reason: string): void {
  logger.warn('execution_control_fail_closed', { reason });

  const now = Date.now();
  if (lastFailClosedLogAt !== null && now - lastFailClosedLogAt < FAIL_CLOSED_LOG_INTERVAL_MS) return;
  lastFailClosedLogAt = now;
  void writeSystemLog('warn', 'execution_control', 'execution control unavailable; new entries blocked', {
    reason,
  }).catch(() => undefined);
}

function failClosed(now: number, reason: string): ExecutionControl {
  reportFailClosed(reason);
  return {
    mode: 'disabled',
    killSwitch: true,
    activeProfileDocId: null,
    activeProfile: null,
    profileErrors: [],
    safety: null,
    safetyErrors: [],
    liveTradingEnvEnabled: process.env.BYTRADER_LIVE_TRADING === 'enabled',
    source: 'fail_closed',
    reason,
    loadedAt: now,
  };
}

async function loadControl(now: number): Promise<ExecutionControl> {
  try {
    const firestore = initFirestore();
    if (!firestore) return failClosed(now, 'firestore_unavailable');

    const settingsSnap = await firestore.collection('settings').doc('default').get();
    const settings = (settingsSnap.data() ?? {}) as Record<string, unknown>;
    const reasons: string[] = [];

    const execution = isRecord(settings.execution) ? settings.execution : {};
    let mode: ExecutionMode = 'disabled';
    const rawMode = execution.mode;
    if (rawMode === undefined || rawMode === null || rawMode === '') {
      reasons.push('mode_missing');
    } else if (typeof rawMode === 'string' && EXECUTION_MODES.includes(rawMode)) {
      mode = rawMode as ExecutionMode;
    } else {
      reasons.push(`unknown_mode:${String(rawMode)}`);
    }

    const trading = isRecord(settings.trading) ? settings.trading : {};
    const rawKillSwitch = trading.kill_switch;
    let killSwitch = false;
    if (rawKillSwitch === true) {
      killSwitch = true;
      reasons.push('kill_switch_active');
    } else if (rawKillSwitch !== undefined && rawKillSwitch !== false) {
      killSwitch = true;
      reasons.push(`kill_switch_malformed:${typeof rawKillSwitch}`);
    }

    let safety: SafetyLimits | null = null;
    let safetyErrors: string[] = [];
    if (settings.safety === undefined) {
      safety = structuredClone(DEFAULT_SAFETY_LIMITS);
    } else {
      const result = validateSafetyLimits(settings.safety);
      if (result.ok && result.value) {
        safety = result.value;
      } else {
        safetyErrors = formatErrors(result.errors, 'safety: invalid');
      }
    }

    let activeProfileDocId: string | null = null;
    let activeProfile: ExecutionProfile | null = null;
    const profileErrors: string[] = [];
    const rawProfileId = execution.active_profile_doc_id;
    if (typeof rawProfileId === 'string' && rawProfileId.length > 0) {
      activeProfileDocId = rawProfileId;
    } else if (rawProfileId !== undefined && rawProfileId !== null && rawProfileId !== '') {
      profileErrors.push('active_profile_doc_id: must be a string');
    }

    if (activeProfileDocId) {
      const profileSnap = await firestore.collection('execution_profiles').doc(activeProfileDocId).get();
      if (!profileSnap.exists) {
        profileErrors.push('active_profile_not_found');
      } else {
        const data = (profileSnap.data() ?? {}) as Record<string, unknown>;
        const status = data.status;
        if (status !== 'active' && status !== 'approved') {
          profileErrors.push(`profile_status_${String(status ?? 'missing')}`);
        } else {
          const body: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(data)) {
            if (!PROFILE_ENVELOPE_FIELDS.includes(key)) body[key] = value;
          }
          const result = validateProfile(body);
          if (result.ok && result.value) {
            // A profile approved under looser limits must not open trades once safety tightens.
            const safetyIssues = safety ? validateProfileAgainstSafety(result.value, safety) : [];
            if (safetyIssues.length > 0) {
              profileErrors.push(...formatErrors(safetyIssues, 'profile: violates safety limits'));
            } else {
              activeProfile = result.value;
            }
          } else {
            profileErrors.push(...formatErrors(result.errors, 'profile: invalid'));
          }
        }
      }
    }

    return {
      mode,
      killSwitch,
      activeProfileDocId,
      activeProfile,
      profileErrors,
      safety,
      safetyErrors,
      liveTradingEnvEnabled: process.env.BYTRADER_LIVE_TRADING === 'enabled',
      source: 'firestore',
      ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
      loadedAt: now,
    };
  } catch (err) {
    return failClosed(now, `read_error: ${errorMessage(err)}`);
  }
}

export async function getExecutionControl(): Promise<ExecutionControl> {
  const now = Date.now();
  if (cached && now - lastFetch < CACHE_TTL_MS) return cached;

  const control = await loadControl(now);
  cached = control;
  lastFetch = now;
  return control;
}

export function invalidateExecutionControl(): void {
  cached = null;
  lastFetch = 0;
}

/** Last loaded value regardless of age; null before the first load. Use getExecutionControl() for fresh data. */
export function getExecutionControlSync(): ExecutionControl | null {
  return cached;
}

export function canOpenNewEntries(
  c: ExecutionControl,
): { allowed: true } | { allowed: false; reason: string } {
  const deny = (reason: string) => ({ allowed: false as const, reason });
  if (c.source === 'fail_closed') return deny('config_unavailable');
  if (c.mode === 'disabled') return deny('execution_disabled');
  if (c.killSwitch) return deny('kill_switch');
  if (c.mode === 'live' && !c.liveTradingEnvEnabled) return deny('live_not_enabled');
  if (c.safety === null) return deny('invalid_safety');
  if (c.activeProfileDocId === null) return deny('no_active_profile');
  if (c.activeProfile === null) return deny('invalid_profile');
  return { allowed: true };
}

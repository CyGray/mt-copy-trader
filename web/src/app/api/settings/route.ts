import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { commitWithAudit, getAdminDb, jsonError, readJsonObject, settingsRef } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';

/** Whitelisted telegram knobs. Kill switch, execution mode and safety have dedicated routes. */
const TELEGRAM_KEYS = ['allowed_chat_ids', 'blocked_chat_ids', 'chat_id_labels'] as const;

/**
 * trading.* keys of the Bybit-era engine. The v2 AutoTrader reads none of them
 * (sizing and limits come from the execution profile and settings.safety), so
 * they are refused rather than stored where an operator would expect an effect.
 */
const LEGACY_TRADING_KEYS = [
  'risk_mode',
  'risk_value',
  'max_open_positions',
  'max_positions_per_symbol',
  'max_signal_delay_sec',
  'slippage_tol',
  'tp1_skip_buffer',
  'bybit_optional',
  'mt5_optional',
];

const DISALLOWED_HINTS: Record<string, string> = {
  'trading.kill_switch': 'use POST /api/execution/kill-switch',
  'trading.paper_mode': 'paper mode is set with POST /api/execution/mode',
  execution: 'use POST /api/execution/mode',
  safety: 'use POST /api/execution/safety',
};

type Issue = { path: string; message: string };

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 64) return null;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function labelMap(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, label] of Object.entries(value as Record<string, unknown>)) {
    if (!key || key.length > 64 || typeof label !== 'string' || label.length > 120) return null;
    out[key] = label;
  }
  return out;
}

/** POST /api/settings: partial update of the telegram knobs. trading.* is refused (see LEGACY_TRADING_KEYS). */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;

  const body = await readJsonObject(request);
  if (!body) return jsonError('Body must be a JSON object', 400);

  const unknown: string[] = [];
  for (const key of Object.keys(body)) {
    if (key !== 'trading' && key !== 'telegram') unknown.push(key);
  }
  if (unknown.length) {
    return jsonError('Unknown keys', 400, {
      unknown,
      hints: Object.fromEntries(unknown.filter((k) => DISALLOWED_HINTS[k]).map((k) => [k, DISALLOWED_HINTS[k]])),
    });
  }

  const issues: Issue[] = [];
  const telegram: Record<string, unknown> = {};

  const tradingInput = body.trading;
  if (tradingInput !== undefined) {
    if (tradingInput === null || typeof tradingInput !== 'object' || Array.isArray(tradingInput)) {
      issues.push({ path: 'trading', message: 'must be an object' });
    } else {
      for (const key of Object.keys(tradingInput as Record<string, unknown>)) {
        const path = `trading.${key}`;
        if (DISALLOWED_HINTS[path]) {
          issues.push({ path, message: `not allowed here; ${DISALLOWED_HINTS[path]}` });
        } else if (LEGACY_TRADING_KEYS.includes(key)) {
          issues.push({ path, message: 'no longer used: sizing and limits come from the execution profile and safety limits' });
        } else {
          issues.push({ path, message: 'unknown key' });
        }
      }
    }
  }

  const telegramInput = body.telegram;
  if (telegramInput !== undefined) {
    if (telegramInput === null || typeof telegramInput !== 'object' || Array.isArray(telegramInput)) {
      issues.push({ path: 'telegram', message: 'must be an object' });
    } else {
      const input = telegramInput as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        if (!(TELEGRAM_KEYS as readonly string[]).includes(key)) {
          issues.push({ path: `telegram.${key}`, message: 'unknown key' });
        }
      }
      for (const key of TELEGRAM_KEYS) {
        if (!(key in input)) continue;
        const value = input[key];
        const path = `telegram.${key}`;
        if (key === 'chat_id_labels') {
          const labels = labelMap(value);
          if (labels) telegram[key] = labels;
          else issues.push({ path, message: 'must be an object of string keys to string labels' });
        } else {
          const list = stringArray(value);
          if (list) telegram[key] = list;
          else issues.push({ path, message: 'must be an array of non-empty strings (max 64 chars)' });
        }
      }
    }
  }

  if (issues.length) return jsonError('Invalid settings', 400, { issues });

  const mergeFields = Object.keys(telegram).map((k) => `telegram.${k}`);
  if (mergeFields.length === 0) return jsonError('Nothing to update', 400);

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    await commitWithAudit(db, auth, 'settings.update', { patch: { telegram } }, (batch) => {
      batch.set(settingsRef(db), { telegram }, { mergeFields });
    });
  } catch {
    return jsonError('Write failed', 503);
  }

  return NextResponse.json({ ok: true, updated: mergeFields });
}

/**
 * lifecycleManager.ts
 *
 * Background polling loop that monitors open MT5 XAUUSD positions and applies
 * dynamic risk management rules:
 *
 *  1. Break-Even (BE):  When price moves beTriggerPips in favour of the trade,
 *                       move SL to entry price + beBufferPips.
 *  2. Trailing Stop:    After BE is active, trail SL by trailStepPips behind
 *                       the current high/low water-mark.
 *  3. Signal Cancel:    If Firestore marks a trade as CANCEL_REQUESTED (e.g. the
 *                       source Telegram message was deleted), close the position.
 *
 * Runs as an asyncio-style loop via setInterval / recursive setTimeout.
 * Started from index.ts after the MT5 bridge confirms healthy.
 */

import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { mt5ClosePosition, mt5GetPositions, mt5ModifyOrder, Mt5Position } from './mt5Client';
import { getMt5Config } from './mt5Secrets';
import { writeSystemLog } from './systemLog';
import { getTradingSettings } from './tradingSettings';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;

/** ticket → entry price (populated on first sight of a position) */
const _entryPriceCache = new Map<number, number>();

/** ticket → highest/lowest price seen (for trailing) */
const _watermark = new Map<number, number>();

/** ticket → whether break-even has already been applied */
const _beApplied = new Set<number>();

// ---------------------------------------------------------------------------
// Pip utilities (Gold / XAUUSD: 1 pip = $0.10, point = $0.01)
// We work in price units: 1 pip = 0.10 for XAUUSD
// ---------------------------------------------------------------------------

const XAUUSD_PIP = 0.10;

function pipsToPrice(pips: number): number {
  return pips * XAUUSD_PIP;
}

// ---------------------------------------------------------------------------
// Per-position lifecycle rules
// ---------------------------------------------------------------------------

async function applyBreakEven(
  pos: Mt5Position,
  beTriggerPips: number,
  beBufferPips: number,
): Promise<void> {
  if (_beApplied.has(pos.ticket)) return;

  const entry = _entryPriceCache.get(pos.ticket) ?? pos.open_price;
  const triggerDist = pipsToPrice(beTriggerPips);
  const bufferDist = pipsToPrice(beBufferPips);

  const isBuy = pos.type === 'BUY';
  const profitDist = isBuy
    ? pos.open_price - entry // current price baked into spread — use entry vs open_price
    : entry - pos.open_price;

  // Use watermark as proxy for current price movement
  const wm = _watermark.get(pos.ticket) ?? pos.open_price;
  const moved = isBuy ? wm - entry : entry - wm;

  if (moved < triggerDist) return; // not triggered yet

  const newSl = isBuy ? entry + bufferDist : entry - bufferDist;

  // Don't move SL in the wrong direction
  if (isBuy && newSl <= pos.sl) return;
  if (!isBuy && newSl >= pos.sl) return;

  logger.info('lifecycle_be_triggered', { ticket: pos.ticket, entry, newSl, moved });

  await mt5ModifyOrder(pos.ticket, newSl, pos.tp);
  _beApplied.add(pos.ticket);

  await writeSystemLog('info', 'lifecycle', 'break_even_applied', {
    ticket: pos.ticket,
    entry,
    newSl,
    moved,
  });
}

async function applyTrailingStop(
  pos: Mt5Position,
  trailStepPips: number,
  stopBufferPips: number,
): Promise<void> {
  if (!_beApplied.has(pos.ticket)) return; // Only trail after BE is active

  const wm = _watermark.get(pos.ticket) ?? pos.open_price;
  const trailDist = pipsToPrice(trailStepPips);
  const bufferDist = pipsToPrice(stopBufferPips);

  const isBuy = pos.type === 'BUY';
  const newSl = isBuy ? wm - trailDist - bufferDist : wm + trailDist + bufferDist;

  // Only tighten the stop
  if (isBuy && newSl <= pos.sl) return;
  if (!isBuy && newSl >= pos.sl) return;

  logger.info('lifecycle_trail_triggered', { ticket: pos.ticket, wm, newSl });

  await mt5ModifyOrder(pos.ticket, newSl, pos.tp);

  await writeSystemLog('info', 'lifecycle', 'trailing_stop_applied', {
    ticket: pos.ticket,
    wm,
    newSl,
  });
}

async function checkCancelRequest(pos: Mt5Position): Promise<void> {
  const firestore = initFirestore();
  if (!firestore) return;

  // Find trades for this ticket
  const snap = await firestore
    .collection('trade_sets')
    .where('mt5.ticket', '==', pos.ticket)
    .where('state', '==', 'CANCEL_REQUESTED')
    .limit(1)
    .get();

  if (snap.empty) return;

  logger.info('lifecycle_cancel_requested', { ticket: pos.ticket });

  await mt5ClosePosition(pos.ticket);

  const doc = snap.docs[0];
  await doc.ref.set(
    { state: 'CANCELLED', updated_at: new Date().toISOString() },
    { merge: true },
  );

  await writeSystemLog('info', 'lifecycle', 'position_cancelled', { ticket: pos.ticket });
}

// ---------------------------------------------------------------------------
// Update watermarks from current positions
// ---------------------------------------------------------------------------

function updateWatermarks(positions: Mt5Position[]): void {
  for (const pos of positions) {
    const prev = _watermark.get(pos.ticket);
    const isBuy = pos.type === 'BUY';

    if (prev === undefined) {
      _watermark.set(pos.ticket, pos.open_price);
      _entryPriceCache.set(pos.ticket, pos.open_price);
    } else {
      // Track highest for BUY, lowest for SELL
      if (isBuy && pos.open_price > prev) _watermark.set(pos.ticket, pos.open_price);
      if (!isBuy && pos.open_price < prev) _watermark.set(pos.ticket, pos.open_price);
    }
  }

  // Clean up state for closed positions
  const liveTickets = new Set(positions.map((p) => p.ticket));
  for (const ticket of _watermark.keys()) {
    if (!liveTickets.has(ticket)) {
      _watermark.delete(ticket);
      _entryPriceCache.delete(ticket);
      _beApplied.delete(ticket);
    }
  }
}

// ---------------------------------------------------------------------------
// Main poll tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  try {
    const settings = await getTradingSettings();
    const mt5Config = await getMt5Config();

    const positions = await mt5GetPositions(mt5Config.symbol);

    updateWatermarks(positions);

    for (const pos of positions) {
      // Only manage positions placed by our magic number
      if (pos.magic !== mt5Config.magic) continue;

      await Promise.allSettled([
        applyBreakEven(pos, settings.beTriggerPips, settings.beBufferPips),
        applyTrailingStop(pos, settings.trailStepPips, settings.stopBufferPips),
        checkCancelRequest(pos),
      ]);
    }
  } catch (err) {
    logger.warn('lifecycle_tick_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startLifecycleManager(intervalMs = 2000): void {
  if (_running) return;
  _running = true;

  logger.info('lifecycle_manager_started', { intervalMs });
  void writeSystemLog('info', 'lifecycle', 'manager_started', { intervalMs });

  const loop = (): void => {
    if (!_running) return;
    void tick().finally(() => {
      if (_running) {
        _timer = setTimeout(loop, intervalMs);
      }
    });
  };

  _timer = setTimeout(loop, intervalMs);
}

export function stopLifecycleManager(): void {
  _running = false;
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
  logger.info('lifecycle_manager_stopped');
  void writeSystemLog('info', 'lifecycle', 'manager_stopped');
}

export function isLifecycleManagerRunning(): boolean {
  return _running;
}

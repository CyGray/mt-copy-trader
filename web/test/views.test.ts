import { describe, expect, it } from 'vitest';
import { alertStatusTone, openCounts, queueStatusTone, severityTone, toAlertRow } from '@/lib/alertView';
import { filterRows, sortByTimestamp, stateTone, toEvent, toRow } from '@/lib/tradeView';

const schema2 = {
  schema: 2,
  trade_set_id: '-100_5',
  symbol: 'XAUUSD',
  direction: 'buy',
  mode: 'demo',
  state: 'PARTIALLY_CLOSED',
  created_at: '2026-10-18T10:00:00.000Z',
  profile: { doc_id: 'p__v2', profile_id: 'p', version: 2 },
  plan: { volume: 0.1, sl: 1995, entry_ref_price: 2001 },
  broker_refs: { fill_price: 2001, position_ticket: 9, order_ticket: 8, deal_ticket: 7, filled_volume: 0.1 },
  lifecycle: {
    current_volume: 0.05,
    current_sl: 2001.2,
    checkpoints: [
      { tp_index: 1, status: 'done', realized_pnl: 40 },
      { tp_index: 2, status: 'pending' },
    ],
  },
  result: null,
};

describe('trade view model', () => {
  it('maps a schema-2 trade set: profile label, current SL, partial realized PnL from checkpoints', () => {
    const row = toRow('-100_5', schema2);
    expect(row).toMatchObject({
      schema: 2,
      symbol: 'XAUUSD',
      direction: 'buy',
      mode: 'demo',
      state: 'PARTIALLY_CLOSED',
      profileLabel: 'p v2',
      volume: 0.1,
      currentVolume: 0.05,
      entryPrice: 2001,
      sl: 2001.2,
      realizedPnl: 40,
    });
  });

  it('a closed trade reports the final realized PnL, not the checkpoint sum', () => {
    const row = toRow('x', { ...schema2, state: 'CLOSED', result: { closed_at: 'z', close_reason: 'tp', realized_pnl: 95.5 } });
    expect(row.realizedPnl).toBe(95.5);
    expect(stateTone(row.state, row.realizedPnl)).toBe('success');
    expect(stateTone('CLOSED', -3)).toBe('danger');
  });

  it('still displays historical schema-1 (Bybit-era) records', () => {
    const row = toRow('legacy', { symbol: 'BTCUSDT', direction: 'LONG', state: 'CLOSED', bybit: { qty: '0.5', avg_entry_price: '61000' }, pnl_value: '12.5', created_at: '2025-01-01T00:00:00Z' });
    expect(row).toMatchObject({ schema: 1, symbol: 'BTCUSDT', direction: 'buy', volume: 0.5, entryPrice: 61000, realizedPnl: 12.5, mode: null });
    expect(row.legacy).not.toBeNull();
  });

  it('flags unknown or ambiguous states as issues', () => {
    const rows = ['SUBMIT_UNKNOWN', 'OPEN', 'CLOSED', 'SKIPPED', 'ERROR', 'PENDING_ORDER'].map((state, i) => toRow(String(i), { ...schema2, state }));
    expect(filterRows(rows, 'issues').map((r) => r.state)).toEqual(['SUBMIT_UNKNOWN', 'SKIPPED', 'ERROR']);
    expect(filterRows(rows, 'active').map((r) => r.state)).toEqual(['OPEN', 'PENDING_ORDER']);
    expect(filterRows(rows, 'closed').map((r) => r.state)).toEqual(['CLOSED']);
    expect(filterRows(rows, 'all')).toHaveLength(6);
    expect(stateTone('SUBMIT_UNKNOWN', null)).toBe('danger');
    expect(stateTone('SUBMITTING', null)).toBe('warning');
  });

  it('maps trade events and sorts the timeline by timestamp', () => {
    const events = [
      toEvent('b', { type: 'partial_close_confirmed', timestamp: '2026-10-18T10:05:00Z', volume: 0.05, realized_pnl: 40, position_ticket: 9 }),
      toEvent('a', { type: 'entry_confirmed', timestamp: '2026-10-18T10:00:00Z', price: '2001', order_ticket: 8 }),
      toEvent('c', { event_type: 'legacy_event', timestamp: null }),
    ];
    expect(sortByTimestamp(events).map((e) => e.id)).toEqual(['c', 'a', 'b']);
    expect(events[1]).toMatchObject({ type: 'entry_confirmed', price: 2001, orderTicket: 8 });
    expect(events[2].type).toBe('legacy_event');
  });
});

describe('alert view model', () => {
  it('normalises alert documents with safe defaults', () => {
    expect(toAlertRow({ id: 'x', severity: 'bogus', status: 'weird' })).toMatchObject({ severity: 'info', status: 'open', type: 'unknown', title: 'Alert', count: 1 });
    const row = toAlertRow({ id: 'y', type: 'submit_unknown', severity: 'critical', status: 'acknowledged', title: 'T', count: 3 });
    expect(row).toMatchObject({ severity: 'critical', status: 'acknowledged', title: 'T', count: 3 });
  });

  it('counts only open alerts by severity', () => {
    const rows = [
      toAlertRow({ id: '1', severity: 'critical', status: 'open' }),
      toAlertRow({ id: '2', severity: 'critical', status: 'acknowledged' }),
      toAlertRow({ id: '3', severity: 'warning', status: 'open' }),
    ];
    expect(openCounts(rows)).toEqual({ critical: 1, error: 0, warning: 1, info: 0 });
  });

  it('maps tones', () => {
    expect(severityTone('critical')).toBe('danger');
    expect(severityTone('warning')).toBe('warning');
    expect(alertStatusTone('resolved')).toBe('success');
    expect(queueStatusTone('dead_letter')).toBe('danger');
    expect(queueStatusTone('retry_wait')).toBe('warning');
    expect(queueStatusTone(undefined)).toBe('neutral');
  });
});

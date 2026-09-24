import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./mt5TradeEngine', () => ({
  handleGoldSignal: vi.fn(async () => undefined),
  cancelGoldTrade: vi.fn(async () => undefined),
}));
vi.mock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => null) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./systemLog', () => ({ writeSystemLog: vi.fn(async () => undefined) }));
vi.mock('./mt5Secrets', () => ({ getMt5Config: vi.fn(async () => ({})) }));

import { dispatchSignalEvent } from './signalFeed';
import { cancelGoldTrade, handleGoldSignal } from './mt5TradeEngine';
import type { GoldSignal } from './vipSignalParser';

const SOURCE = ['-1003271337051'];

const SIGNAL: GoldSignal = {
  symbol: 'XAUUSD',
  direction: 'sell',
  orderType: 'market',
  entryLow: 4258.5,
  entryHigh: 4261,
  stopLoss: 4264,
  takeProfits: [4254, 4247, 4240, 4225],
};

describe('dispatchSignalEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a signal event from a configured source chat', async () => {
    await dispatchSignalEvent(
      {
        chat_id: SOURCE[0],
        message_id: '3664',
        kind: 'signal',
        signal: SIGNAL,
        message_date: '2026-09-24T10:54:22.908Z',
      },
      SOURCE,
    );

    expect(handleGoldSignal).toHaveBeenCalledTimes(1);
    expect(handleGoldSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: SOURCE[0],
        messageId: '3664',
        signal: SIGNAL,
      }),
    );
    expect(cancelGoldTrade).not.toHaveBeenCalled();
  });

  it('ignores events from chats that are not configured sources', async () => {
    await dispatchSignalEvent(
      {
        chat_id: '-1009999999999',
        message_id: '1',
        kind: 'signal',
        signal: SIGNAL,
      },
      SOURCE,
    );

    expect(handleGoldSignal).not.toHaveBeenCalled();
    expect(cancelGoldTrade).not.toHaveBeenCalled();
  });

  it('cancels the trade on a cancel event', async () => {
    await dispatchSignalEvent({ chat_id: SOURCE[0], message_id: '3664', kind: 'cancel' }, SOURCE);

    expect(cancelGoldTrade).toHaveBeenCalledWith(SOURCE[0], '3664');
    expect(handleGoldSignal).not.toHaveBeenCalled();
  });

  it('ignores events without a chat or message id', async () => {
    await dispatchSignalEvent({ chat_id: SOURCE[0], kind: 'signal', signal: SIGNAL }, SOURCE);
    expect(handleGoldSignal).not.toHaveBeenCalled();
  });
});

// Mock data for UI demonstration
// Replace these with actual Firebase data when connecting logic

import type { ActivityItem } from '@/components/ui/ActivityFeed';

// Dashboard metrics
export const mockMetrics = {
  dailyChange: '+2.3%',
  dailyChangeTrend: 'up' as const,
  openPositions: 3,
  pnlToday: '+$234.50',
  pnlTrend: 'up' as const,
  signalsToday: 12,
  winRate: '68%',
  avgProfit: '$45.20',
};

// System status
export const mockSystemStatus = {
  health: 'healthy' as const,
  worker: 'online' as const,
  telegram: 'connected' as const,
  bybit: 'connected' as const,
  lastSignal: 'BTCUSDT',
  lastSignalTime: '2 min ago',
};

// Recent activity feed
export const mockActivityFeed: ActivityItem[] = [
  {
    id: '1',
    timestamp: 'Feb 01 05:36 pm',
    message: 'BTCUSDT LONG signal detected',
    type: 'info',
  },
  {
    id: '2',
    timestamp: 'Feb 01 05:22 pm',
    message: 'Position opened: ETHUSDT SHORT',
    type: 'success',
  },
  {
    id: '3',
    timestamp: 'Feb 01 05:15 pm',
    message: 'TP1 hit on BTCUSDT (+$45.20)',
    type: 'success',
  },
  {
    id: '4',
    timestamp: 'Feb 01 04:58 pm',
    message: 'Rate limit warning from Bybit',
    type: 'warning',
  },
  {
    id: '5',
    timestamp: 'Feb 01 04:45 pm',
    message: 'SL moved to breakeven on SOLUSDT',
    type: 'info',
  },
  {
    id: '6',
    timestamp: 'Feb 01 04:30 pm',
    message: 'New Telegram message received',
    type: 'info',
  },
  {
    id: '7',
    timestamp: 'Feb 01 04:12 pm',
    message: 'Position closed: XRPUSDT (-$12.50)',
    type: 'error',
  },
  {
    id: '8',
    timestamp: 'Feb 01 03:55 pm',
    message: 'Worker heartbeat OK',
    type: 'info',
  },
];

// Trades data
export const mockTrades = [
  {
    id: '1',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    state: 'OPEN',
    entry: 48234,
    tp1: 48890,
    tp2: 49200,
    tp3: 49500,
    sl: 47800,
    pnl: '+$45.20',
    pnlValue: 45.2,
    createdAt: 'Feb 01 05:36 pm',
    qty: 0.05,
  },
  {
    id: '2',
    symbol: 'ETHUSDT',
    direction: 'SHORT',
    state: 'CLOSED',
    entry: 3245,
    tp1: 3180,
    tp2: 3120,
    tp3: 3050,
    sl: 3300,
    pnl: '-$12.50',
    pnlValue: -12.5,
    createdAt: 'Feb 01 03:15 pm',
    qty: 0.2,
  },
  {
    id: '3',
    symbol: 'SOLUSDT',
    direction: 'LONG',
    state: 'PROTECTION_PLACED',
    entry: 98.5,
    tp1: 102,
    tp2: 105,
    tp3: 110,
    sl: 97,
    pnl: '+$28.00',
    pnlValue: 28,
    createdAt: 'Feb 01 02:45 pm',
    qty: 5,
  },
  {
    id: '4',
    symbol: 'XRPUSDT',
    direction: 'LONG',
    state: 'CLOSED',
    entry: 0.52,
    tp1: 0.54,
    tp2: 0.56,
    tp3: 0.58,
    sl: 0.50,
    pnl: '+$15.75',
    pnlValue: 15.75,
    createdAt: 'Jan 31 11:20 am',
    qty: 500,
  },
];

// Telegram logs
export const mockTelegramLogs = [
  {
    id: '1',
    timestamp: 'Feb 01 05:36 pm',
    chatId: '-1001234567890',
    chatLabel: 'Signals Channel',
    message: 'BTCUSDT LONG\nEntry: 48234\nTP1: 48890...',
    parsedOk: true,
    type: 'new',
  },
  {
    id: '2',
    timestamp: 'Feb 01 05:22 pm',
    chatId: '-1001234567890',
    chatLabel: 'Signals Channel',
    message: 'ETHUSDT SHORT\nEntry: 3245\nSL: 3300...',
    parsedOk: true,
    type: 'new',
  },
  {
    id: '3',
    timestamp: 'Feb 01 04:58 pm',
    chatId: '-1009876543210',
    chatLabel: 'Updates',
    message: 'Market volatility increasing...',
    parsedOk: false,
    type: 'new',
  },
];

// System logs
export const mockSystemLogs = [
  {
    id: '1',
    timestamp: 'Feb 01 05:36 pm',
    level: 'info',
    component: 'trade_engine',
    message: 'Signal detected: BTCUSDT LONG',
  },
  {
    id: '2',
    timestamp: 'Feb 01 05:35 pm',
    level: 'info',
    component: 'bybit',
    message: 'Order placed successfully',
  },
  {
    id: '3',
    timestamp: 'Feb 01 05:30 pm',
    level: 'warning',
    component: 'bybit',
    message: 'Rate limit approaching',
  },
  {
    id: '4',
    timestamp: 'Feb 01 05:25 pm',
    level: 'error',
    component: 'telegram',
    message: 'Connection timeout, reconnecting...',
  },
  {
    id: '5',
    timestamp: 'Feb 01 05:20 pm',
    level: 'info',
    component: 'worker',
    message: 'Heartbeat OK',
  },
];

// Settings data
export const mockSettings = {
  trading: {
    riskMode: 'FIXED_USDT',
    riskValue: 20,
    maxOpenPositions: 3,
    maxPositionsPerSymbol: 1,
    maxSignalDelay: 120,
    slippageTol: 0.001,
    tp1SkipBuffer: 0.0015,
    paperMode: false,
    killSwitch: false,
    bybitOptional: false,
  },
  telegram: {
    chatIds: ['-1001234567890', '-1009876543210'],
    chatLabels: {
      '-1001234567890': 'Signals Channel',
      '-1009876543210': 'Updates',
    },
  },
};

// Trade events
export const mockTradeEvents = [
  { id: '1', type: 'DETECTED', timestamp: 'Feb 01 05:36 pm', details: 'Signal parsed' },
  { id: '2', type: 'ENTRY_PLACED', timestamp: 'Feb 01 05:36 pm', details: 'Market order sent' },
  { id: '3', type: 'OPEN_CONFIRMED', timestamp: 'Feb 01 05:36 pm', details: 'Position opened at 48234' },
  { id: '4', type: 'TP1_FILLED', timestamp: 'Feb 01 05:45 pm', details: 'Partial close at 48890' },
];

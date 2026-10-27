import { describe, expect, it } from 'vitest';
import type { ExecutionProfile } from './executionProfile.js';
import type { CheckpointState } from './tradeSetTypes.js';
import {
  breakEvenTriggered,
  checkpointAction,
  classifyCloseReason,
  closeVolumeFor,
  desiredStopLoss,
  fillCheckpoints,
  isCheckpointReached,
  isStopModificationValid,
  realizedPnlFromDeals,
  roundPrice,
  trailingActivated,
  updateBestPrice,
  type StopLossInput,
} from './lifecycleRules.js';

const STEP = 0.01;

function makeProfile(
  patch: {
    after?: ExecutionProfile['stop_loss']['after_checkpoint'];
    be?: Partial<ExecutionProfile['break_even']>;
    trailing?: Partial<ExecutionProfile['trailing']>;
  } = {},
): ExecutionProfile {
  return {
    schema_version: 1,
    profile_id: 'gold-rules-test',
    version: 1,
    name: 'rules test',
    source: { type: 'manual' },
    broker: 'vantage_mt5',
    symbols: [{ signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD' }],
    entry: {
      policy: 'follow_signal',
      market_tolerance_price: 0.5,
      pending_expiry_minutes: 60,
      allow_market_fallback: false,
    },
    sizing: { mode: 'fixed_lots', fixed_lots: 0.1, below_min_volume: 'skip' },
    take_profit: {
      checkpoints: [
        { tp_index: 1, close_percent: 50 },
        { tp_index: 2, close_percent: 30 },
        { tp_index: 3, close_percent: 20 },
      ],
      missing_tp: 'skip_trade',
      infeasible_split: 'skip_trade',
      broker_tp: 'final_checkpoint',
    },
    stop_loss: { min_distance_price: 2, max_distance_price: 25, after_checkpoint: patch.after ?? [] },
    break_even: {
      enabled: false,
      trigger: 'price_distance',
      trigger_value: 5,
      buffer_price: 0.2,
      ...patch.be,
    },
    trailing: {
      enabled: false,
      activation: 'price_distance',
      activation_value: 3,
      distance_price: 2,
      step_price: 0.5,
      ...patch.trailing,
    },
    limits: {
      max_concurrent_positions: 3,
      max_positions_per_symbol: 1,
      max_spread_price: 0.5,
      max_deviation_points: 30,
      signal_max_age_sec: 120,
      daily_loss_limit_money: 100,
      max_total_risk_percent: 3,
    },
    edits: {
      before_fill: 'ignore',
      after_fill: 'ignore',
      unparseable_edit: 'ignore',
      explicit_cancel: 'ignore',
    },
  };
}

function cp(
  tpIndex: number,
  price: number,
  target: number,
  status: CheckpointState['status'] = 'pending',
  extra: Partial<CheckpointState> = {},
): CheckpointState {
  return {
    tp_index: tpIndex,
    price,
    close_volume: 0.05,
    target_remaining_volume: target,
    status,
    attempts: 0,
    ...extra,
  };
}

function stopInput(patch: Partial<StopLossInput> & Pick<StopLossInput, 'direction'>): StopLossInput {
  const buy = patch.direction === 'buy';
  return {
    entry: 2000,
    closePrice: 2000,
    currentSl: buy ? 1995 : 2005,
    bestPrice: 2000,
    beApplied: false,
    trailingActive: false,
    digits: 2,
    profile: makeProfile(),
    checkpoints: [cp(1, buy ? 2010 : 1990, 0.05), cp(2, buy ? 2020 : 1980, 0.02), cp(3, buy ? 2030 : 1970, 0)],
    ...patch,
  };
}

describe('isCheckpointReached', () => {
  it('BUY is reached at or above the checkpoint price', () => {
    expect(isCheckpointReached('buy', 2010, 2010)).toBe(true);
    expect(isCheckpointReached('buy', 2010.01, 2010)).toBe(true);
    expect(isCheckpointReached('buy', 2009.99, 2010)).toBe(false);
  });

  it('SELL is reached at or below the checkpoint price', () => {
    expect(isCheckpointReached('sell', 1990, 1990)).toBe(true);
    expect(isCheckpointReached('sell', 1989.99, 1990)).toBe(true);
    expect(isCheckpointReached('sell', 1990.01, 1990)).toBe(false);
  });
});

describe('checkpointAction', () => {
  it('marks done when the position already holds the target remaining volume', () => {
    const c = cp(1, 2010, 0.05);
    expect(checkpointAction(c, 0.05, 2000, 'buy', 1000, STEP)).toBe('mark_done');
    expect(checkpointAction(c, 0.04, 2000, 'buy', 1000, STEP)).toBe('mark_done');
    expect(checkpointAction(c, 0.06, 2000, 'buy', 1000, STEP)).toBe('none');
  });

  it('sends a close for a pending checkpoint once reached', () => {
    expect(checkpointAction(cp(1, 2010, 0.05), 0.10, 2010, 'buy', 1000, STEP)).toBe('send_close');
    expect(checkpointAction(cp(1, 2010, 0.05), 0.10, 2009, 'buy', 1000, STEP)).toBe('none');
  });

  it('SELL sends a close when price falls to the checkpoint', () => {
    const c = cp(1, 1990, 0.05);
    expect(checkpointAction(c, 0.10, 1990, 'sell', 1000, STEP)).toBe('send_close');
    expect(checkpointAction(c, 0.10, 1991, 'sell', 1000, STEP)).toBe('none');
  });

  it('waits inside the ambiguity window and retries after it', () => {
    const c = cp(1, 2010, 0.05, 'closing', { ambiguous_until: 1015 });
    expect(checkpointAction(c, 0.10, 2011, 'buy', 1010, STEP)).toBe('wait');
    expect(checkpointAction(c, 0.10, 2011, 'buy', 1015, STEP)).toBe('wait');
    expect(checkpointAction(c, 0.10, 2011, 'buy', 1016, STEP)).toBe('send_close');
    expect(checkpointAction(c, 0.10, 2009, 'buy', 1016, STEP)).toBe('none');
  });

  it('done and failed checkpoints never send a close', () => {
    expect(checkpointAction(cp(1, 2010, 0.05, 'done'), 0.10, 2020, 'buy', 1000, STEP)).toBe('none');
    expect(checkpointAction(cp(1, 2010, 0.05, 'failed'), 0.10, 2020, 'buy', 1000, STEP)).toBe('none');
  });

  it('a failed checkpoint is still marked done when the volume shows it happened', () => {
    expect(checkpointAction(cp(1, 2010, 0.05, 'failed'), 0.05, 2000, 'buy', 1000, STEP)).toBe('mark_done');
  });
});

describe('closeVolumeFor', () => {
  it('closes the difference to the target remaining volume', () => {
    expect(closeVolumeFor(0.1, 0.05, STEP)).toEqual({ volume: 0.05, full: false });
    expect(closeVolumeFor(0.05, 0.02, STEP)).toEqual({ volume: 0.03, full: false });
  });

  it('rounds the close down to a whole step', () => {
    expect(closeVolumeFor(0.07, 0.02, STEP)).toEqual({ volume: 0.05, full: false });
    expect(closeVolumeFor(0.3, 0.1, 0.1)).toEqual({ volume: 0.2, full: false });
  });

  it('a zero target is a full close of the position volume', () => {
    expect(closeVolumeFor(0.02, 0, STEP)).toEqual({ volume: 0.02, full: true });
  });
});

describe('break-even and trailing triggers', () => {
  const buyView = { direction: 'buy' as const, entry: 2000, closePrice: 2005, checkpoints: [cp(1, 2010, 0.05, 'done')] };
  const sellView = { direction: 'sell' as const, entry: 2000, closePrice: 1995, checkpoints: [cp(1, 1990, 0.05, 'done')] };

  it('BUY break-even price_distance triggers at entry + distance', () => {
    const p = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5 } });
    expect(breakEvenTriggered(buyView, p)).toBe(true);
    expect(breakEvenTriggered({ ...buyView, closePrice: 2004.99 }, p)).toBe(false);
  });

  it('SELL break-even price_distance triggers at entry - distance', () => {
    const p = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5 } });
    expect(breakEvenTriggered(sellView, p)).toBe(true);
    expect(breakEvenTriggered({ ...sellView, closePrice: 1995.01 }, p)).toBe(false);
  });

  it('break-even after_tp_index triggers when that checkpoint is done', () => {
    const p = makeProfile({ be: { enabled: true, trigger: 'after_tp_index', trigger_value: 1 } });
    expect(breakEvenTriggered({ ...buyView, closePrice: 2000 }, p)).toBe(true);
    expect(breakEvenTriggered({ ...buyView, closePrice: 2000, checkpoints: [cp(1, 2010, 0.05)] }, p)).toBe(false);
  });

  it('disabled break-even never triggers', () => {
    expect(breakEvenTriggered(buyView, makeProfile())).toBe(false);
  });

  it('trailing activation by price distance and after_tp_index, per direction', () => {
    const p = makeProfile({ trailing: { enabled: true, activation: 'price_distance', activation_value: 3 } });
    expect(trailingActivated({ ...buyView, closePrice: 2003 }, p)).toBe(true);
    expect(trailingActivated({ ...sellView, closePrice: 1997.5 }, p)).toBe(false);
    expect(trailingActivated({ ...sellView, closePrice: 1997 }, p)).toBe(true);
    const byTp = makeProfile({ trailing: { enabled: true, activation: 'after_tp_index', activation_value: 1 } });
    expect(trailingActivated({ ...sellView, closePrice: 2000 }, byTp)).toBe(true);
  });
});

describe('desiredStopLoss: break-even', () => {
  it('BUY price_distance moves SL to entry + buffer once triggered', () => {
    const profile = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    const out = desiredStopLoss(stopInput({ direction: 'buy', profile, closePrice: 2005, currentSl: 1995 }));
    expect(out).toEqual({ sl: 2000.2, reasons: ['break_even'] });
  });

  it('SELL price_distance moves SL to entry - buffer once triggered', () => {
    const profile = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    const out = desiredStopLoss(stopInput({ direction: 'sell', profile, closePrice: 1995, currentSl: 2005 }));
    expect(out).toEqual({ sl: 1999.8, reasons: ['break_even'] });
  });

  it('not triggered yet gives no move', () => {
    const profile = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5 } });
    expect(desiredStopLoss(stopInput({ direction: 'buy', profile, closePrice: 2003 }))).toBeNull();
  });

  it('after_tp_index triggers only when the checkpoint is done', () => {
    const profile = makeProfile({ be: { enabled: true, trigger: 'after_tp_index', trigger_value: 1, buffer_price: 0.2 } });
    const done = stopInput({
      direction: 'buy',
      profile,
      checkpoints: [cp(1, 2010, 0.05, 'done'), cp(2, 2020, 0.02), cp(3, 2030, 0)],
    });
    expect(desiredStopLoss(done)).toEqual({ sl: 2000.2, reasons: ['break_even'] });
    expect(desiredStopLoss({ ...done, checkpoints: [cp(1, 2010, 0.05), cp(2, 2020, 0.02), cp(3, 2030, 0)] })).toBeNull();
  });

  it('is sticky once applied even when price has fallen back', () => {
    const profile = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    const out = desiredStopLoss(stopInput({ direction: 'buy', profile, closePrice: 2001, currentSl: 1995, beApplied: true }));
    expect(out).toEqual({ sl: 2000.2, reasons: ['break_even'] });
  });

  it('does not loosen a stop that is already tighter', () => {
    const profile = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    expect(desiredStopLoss(stopInput({ direction: 'buy', profile, closePrice: 2005, currentSl: 2001 }))).toBeNull();
    expect(desiredStopLoss(stopInput({ direction: 'sell', profile, closePrice: 1995, currentSl: 1999 }))).toBeNull();
  });

  it('an unset stop (0) is always tightened', () => {
    const profile = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    expect(desiredStopLoss(stopInput({ direction: 'buy', profile, closePrice: 2005, currentSl: 0 }))).toEqual({
      sl: 2000.2,
      reasons: ['break_even'],
    });
  });
});

describe('desiredStopLoss: trailing', () => {
  const trailProfile = makeProfile({
    trailing: { enabled: true, activation: 'price_distance', activation_value: 3, distance_price: 2, step_price: 0.5 },
  });

  it('BUY trails best price minus distance, once activated', () => {
    const out = desiredStopLoss(
      stopInput({ direction: 'buy', profile: trailProfile, closePrice: 2010, bestPrice: 2010, currentSl: 1995 }),
    );
    expect(out).toEqual({ sl: 2008, reasons: ['trailing'] });
  });

  it('BUY does not trail before activation', () => {
    expect(
      desiredStopLoss(stopInput({ direction: 'buy', profile: trailProfile, closePrice: 2002, bestPrice: 2002, currentSl: 1995 })),
    ).toBeNull();
  });

  it('BUY needs a step_price improvement for a trailing-only move', () => {
    const at = (best: number) =>
      desiredStopLoss(
        stopInput({ direction: 'buy', profile: trailProfile, closePrice: best, bestPrice: best, currentSl: 2008, trailingActive: true }),
      );
    expect(at(2010.3)).toBeNull();
    expect(at(2010.5)).toEqual({ sl: 2008.5, reasons: ['trailing'] });
  });

  it('BUY never loosens the stop', () => {
    expect(
      desiredStopLoss(
        stopInput({ direction: 'buy', profile: trailProfile, closePrice: 2009, bestPrice: 2009, currentSl: 2008, trailingActive: true }),
      ),
    ).toBeNull();
  });

  it('SELL trails best (lowest) price plus distance', () => {
    const out = desiredStopLoss(
      stopInput({ direction: 'sell', profile: trailProfile, closePrice: 1990, bestPrice: 1990, currentSl: 2005 }),
    );
    expect(out).toEqual({ sl: 1992, reasons: ['trailing'] });
  });

  it('SELL step and tighten-only rules mirror BUY', () => {
    const at = (best: number, sl: number) =>
      desiredStopLoss(
        stopInput({ direction: 'sell', profile: trailProfile, closePrice: best, bestPrice: best, currentSl: sl, trailingActive: true }),
      );
    expect(at(1991, 1992)).toBeNull(); // would loosen
    expect(at(1989.6, 1992)).toBeNull(); // improves 0.4 < step 0.5
    expect(at(1989.4, 1992)).toEqual({ sl: 1991.4, reasons: ['trailing'] });
  });
});

describe('desiredStopLoss: after_checkpoint moves', () => {
  it('BUY move_to entry sets entry + buffer after the checkpoint is done', () => {
    const profile = makeProfile({ after: [{ after_tp_index: 1, move_to: 'entry', buffer_price: 0.2 }] });
    const out = desiredStopLoss(stopInput({ direction: 'buy', profile, checkpoints: [cp(1, 2010, 0.05, 'done'), cp(2, 2020, 0.02), cp(3, 2030, 0)] }));
    expect(out).toEqual({ sl: 2000.2, reasons: ['after_checkpoint'] });
  });

  it('SELL move_to entry sets entry - buffer after the checkpoint is done', () => {
    const profile = makeProfile({ after: [{ after_tp_index: 1, move_to: 'entry', buffer_price: 0.2 }] });
    const out = desiredStopLoss(
      stopInput({ direction: 'sell', profile, checkpoints: [cp(1, 1990, 0.05, 'done'), cp(2, 1980, 0.02), cp(3, 1970, 0)] }),
    );
    expect(out).toEqual({ sl: 1999.8, reasons: ['after_checkpoint'] });
  });

  it('BUY previous_tp uses the checkpoint before the referenced one, minus buffer', () => {
    const profile = makeProfile({ after: [{ after_tp_index: 2, move_to: 'previous_tp', buffer_price: 0.5 }] });
    const out = desiredStopLoss(
      stopInput({ direction: 'buy', profile, checkpoints: [cp(1, 2010, 0.05, 'done'), cp(2, 2020, 0.02, 'done'), cp(3, 2030, 0)] }),
    );
    expect(out).toEqual({ sl: 2009.5, reasons: ['after_checkpoint'] });
  });

  it('SELL previous_tp uses the previous TP plus buffer', () => {
    const profile = makeProfile({ after: [{ after_tp_index: 2, move_to: 'previous_tp', buffer_price: 0.5 }] });
    const out = desiredStopLoss(
      stopInput({ direction: 'sell', profile, checkpoints: [cp(1, 1990, 0.05, 'done'), cp(2, 1980, 0.02, 'done'), cp(3, 1970, 0)] }),
    );
    expect(out).toEqual({ sl: 1990.5, reasons: ['after_checkpoint'] });
  });

  it('previous_tp for the first checkpoint falls back to entry plus buffer (never below entry)', () => {
    const profile = makeProfile({ after: [{ after_tp_index: 1, move_to: 'previous_tp', buffer_price: 0.5 }] });
    const out = desiredStopLoss(
      stopInput({ direction: 'buy', profile, currentSl: 1995, checkpoints: [cp(1, 2010, 0.05, 'done'), cp(2, 2020, 0.02), cp(3, 2030, 0)] }),
    );
    expect(out).toEqual({ sl: 2000.5, reasons: ['after_checkpoint'] });
  });

  it('SELL previous_tp for the first checkpoint falls back to entry minus buffer', () => {
    const profile = makeProfile({ after: [{ after_tp_index: 1, move_to: 'previous_tp', buffer_price: 0.5 }] });
    const out = desiredStopLoss(
      stopInput({ direction: 'sell', profile, currentSl: 2005, checkpoints: [cp(1, 1990, 0.05, 'done'), cp(2, 1980, 0.02), cp(3, 1970, 0)] }),
    );
    expect(out).toEqual({ sl: 1999.5, reasons: ['after_checkpoint'] });
  });

  it('a rule whose checkpoint is not done does not apply', () => {
    const profile = makeProfile({ after: [{ after_tp_index: 2, move_to: 'entry', buffer_price: 0.2 }] });
    expect(desiredStopLoss(stopInput({ direction: 'buy', profile }))).toBeNull();
  });
});

describe('desiredStopLoss: most protective candidate and rounding', () => {
  it('BUY picks the highest candidate and names every rule that produced it', () => {
    const profile = makeProfile({
      after: [{ after_tp_index: 1, move_to: 'entry', buffer_price: 0.2 }],
      be: { enabled: true, trigger: 'after_tp_index', trigger_value: 1, buffer_price: 1 },
    });
    const out = desiredStopLoss(
      stopInput({ direction: 'buy', profile, checkpoints: [cp(1, 2010, 0.05, 'done'), cp(2, 2020, 0.02), cp(3, 2030, 0)] }),
    );
    expect(out).toEqual({ sl: 2001, reasons: ['break_even'] });
  });

  it('SELL picks the lowest candidate', () => {
    const profile = makeProfile({
      after: [{ after_tp_index: 1, move_to: 'entry', buffer_price: 0.2 }],
      be: { enabled: true, trigger: 'after_tp_index', trigger_value: 1, buffer_price: 0.5 },
    });
    const out = desiredStopLoss(
      stopInput({ direction: 'sell', profile, checkpoints: [cp(1, 1990, 0.05, 'done'), cp(2, 1980, 0.02), cp(3, 1970, 0)] }),
    );
    expect(out).toEqual({ sl: 1999.5, reasons: ['break_even'] });
  });

  it('reports every rule that ties for the chosen value', () => {
    const profile = makeProfile({
      after: [{ after_tp_index: 1, move_to: 'entry', buffer_price: 0.2 }],
      be: { enabled: true, trigger: 'after_tp_index', trigger_value: 1, buffer_price: 0.2 },
    });
    const out = desiredStopLoss(
      stopInput({ direction: 'buy', profile, checkpoints: [cp(1, 2010, 0.05, 'done'), cp(2, 2020, 0.02), cp(3, 2030, 0)] }),
    );
    expect(out).toEqual({ sl: 2000.2, reasons: ['after_checkpoint', 'break_even'] });
  });

  it('rounds the candidate to digits before comparing', () => {
    const profile = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2345 } });
    const out = desiredStopLoss(stopInput({ direction: 'buy', profile, closePrice: 2005, currentSl: 1995, digits: 2 }));
    expect(out).toEqual({ sl: 2000.23, reasons: ['break_even'] });
  });

  it('returns null when the rounded candidate equals the current stop', () => {
    const profile = makeProfile({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    expect(desiredStopLoss(stopInput({ direction: 'buy', profile, closePrice: 2005, currentSl: 2000.2 }))).toBeNull();
  });
});

describe('isStopModificationValid', () => {
  // XAUUSD-like: point 0.01, stops level 10 points (0.10 price).
  it('BUY: stop must sit below Bid by at least the stops level', () => {
    expect(isStopModificationValid('buy', 1999.85, 2000, 2000.2, 10, 0, 0.01)).toBe(true);
    expect(isStopModificationValid('buy', 1999.95, 2000, 2000.2, 10, 0, 0.01)).toBe(false);
    expect(isStopModificationValid('buy', 2000.05, 2000, 2000.2, 10, 0, 0.01)).toBe(false);
  });

  it('SELL: stop must sit above Ask by at least the stops level', () => {
    expect(isStopModificationValid('sell', 2000.35, 2000, 2000.2, 10, 0, 0.01)).toBe(true);
    expect(isStopModificationValid('sell', 2000.25, 2000, 2000.2, 10, 0, 0.01)).toBe(false);
    expect(isStopModificationValid('sell', 1999.9, 2000, 2000.2, 10, 0, 0.01)).toBe(false);
  });

  it('the larger of stops and freeze level applies', () => {
    expect(isStopModificationValid('buy', 1999.6, 2000, 2000.2, 10, 50, 0.01)).toBe(false);
    expect(isStopModificationValid('buy', 1999.4, 2000, 2000.2, 10, 50, 0.01)).toBe(true);
  });

  it('rejects unusable inputs', () => {
    expect(isStopModificationValid('buy', 0, 2000, 2000.2, 10, 0, 0.01)).toBe(false);
    expect(isStopModificationValid('buy', 1990, 2000, 2000.2, 10, 0, 0)).toBe(false);
  });
});

describe('updateBestPrice and roundPrice', () => {
  it('BUY keeps the highest price, SELL the lowest', () => {
    expect(updateBestPrice('buy', 2000, 2005)).toBe(2005);
    expect(updateBestPrice('buy', 2005, 2001)).toBe(2005);
    expect(updateBestPrice('sell', 2000, 1995)).toBe(1995);
    expect(updateBestPrice('sell', 1995, 2001)).toBe(1995);
  });

  it('an unset best price starts at the close price', () => {
    expect(updateBestPrice('buy', 0, 2001)).toBe(2001);
    expect(updateBestPrice('sell', 0, 1999)).toBe(1999);
  });

  it('roundPrice rounds to the symbol digits', () => {
    expect(roundPrice(2000.2345, 2)).toBe(2000.23);
    expect(roundPrice(2000.2355, 3)).toBe(2000.236);
  });
});

describe('classifyCloseReason and realizedPnlFromDeals', () => {
  const deal = (
    ticket: number,
    entry: 'IN' | 'OUT' | 'OUT_BY',
    reason: 'SL' | 'TP' | 'CLIENT' | 'EXPERT',
    time: number,
    profit = 0,
  ) => ({ ticket, entry, reason, time, profit, commission: 0, swap: 0, fee: 0 });

  it('uses the last exit deal: SL -> sl, TP -> tp, otherwise manual', () => {
    expect(classifyCloseReason([deal(1, 'IN', 'EXPERT', 1), deal(2, 'OUT', 'SL', 5)])).toBe('sl');
    expect(classifyCloseReason([deal(1, 'IN', 'EXPERT', 1), deal(2, 'OUT', 'TP', 5)])).toBe('tp');
    expect(classifyCloseReason([deal(1, 'IN', 'EXPERT', 1), deal(2, 'OUT', 'CLIENT', 5)])).toBe('manual');
  });

  it('an earlier SL does not override a later manual close', () => {
    const deals = [deal(3, 'OUT', 'CLIENT', 9), deal(2, 'OUT', 'SL', 5)];
    expect(classifyCloseReason(deals)).toBe('manual');
  });

  it('no exit deal is manual; OUT_BY counts as an exit', () => {
    expect(classifyCloseReason([deal(1, 'IN', 'EXPERT', 1)])).toBe('manual');
    expect(classifyCloseReason([deal(1, 'OUT_BY', 'TP', 1)])).toBe('tp');
  });

  it('realized pnl sums exit deals only, including partial closes and costs', () => {
    const deals = [
      { entry: 'IN' as const, profit: 0, commission: -7, swap: 0, fee: 0 },
      { entry: 'OUT' as const, profit: 10, commission: -1, swap: -0.5, fee: 0 },
      { entry: 'OUT' as const, profit: -2.25, commission: 0, swap: 0, fee: -0.25 },
    ];
    expect(realizedPnlFromDeals(deals)).toBe(6);
  });
});

describe('fillCheckpoints', () => {
  const base = [
    { tp_index: 1, price: 2010 },
    { tp_index: 2, price: 2020 },
    { tp_index: 3, price: 2030 },
  ];
  const spec = { volumeMin: 0.01, volumeStep: 0.01 };
  const withStatus = (list: { tp_index: number; price: number }[]): CheckpointState[] =>
    list.map((c) => ({ ...c, close_volume: 0, target_remaining_volume: 0, status: 'pending', attempts: 0 }));

  it('keeps the checkpoints (status included) when the fill matches the plan', () => {
    const cps = withStatus(base);
    cps[0].status = 'done';
    const out = fillCheckpoints({
      plannedVolume: 0.1,
      filledVolume: 0.1,
      direction: 'buy',
      entryPrice: 2000,
      profile: makeProfile(),
      spec,
      checkpoints: cps,
    });
    expect(out?.[0].status).toBe('done');
    expect(out).toHaveLength(3);
  });

  it('re-plans for a partial fill so the targets track the filled size', () => {
    const out = fillCheckpoints({
      plannedVolume: 0.1,
      filledVolume: 0.05,
      direction: 'buy',
      entryPrice: 2000,
      profile: makeProfile(),
      spec,
      checkpoints: withStatus(base),
    });
    expect(out?.map((c) => c.close_volume)).toEqual([0.02, 0.01, 0.02]);
    expect(out?.map((c) => c.target_remaining_volume)).toEqual([0.03, 0.02, 0]);
    expect(out?.every((c) => c.status === 'pending')).toBe(true);
  });

  it('returns null when the filled size cannot be split (skip_trade)', () => {
    const out = fillCheckpoints({
      plannedVolume: 0.1,
      filledVolume: 0.01,
      direction: 'buy',
      entryPrice: 2000,
      profile: makeProfile(),
      spec,
      checkpoints: withStatus(base),
    });
    expect(out).toBeNull();
  });

  it('with no planned volume the checkpoints are kept', () => {
    const out = fillCheckpoints({
      plannedVolume: null,
      filledVolume: 0.05,
      direction: 'buy',
      entryPrice: 2000,
      profile: makeProfile(),
      spec,
      checkpoints: withStatus(base),
    });
    expect(out).toHaveLength(3);
    expect(out?.[0].close_volume).toBe(0);
  });
});

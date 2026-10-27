/**
 * Pure entry decision (market vs pending, skip reasons) and stop-loss side and
 * distance checks, per docs/project_memory/VANTAGE_DESIGN_CONTRACTS.md section 6.
 * No I/O; the engine calls these after gating and before sizing.
 */
import type { ExecutionProfile, GoldSignalLike } from './executionProfile.js';

export type EntryDecision =
  | {
      ok: true;
      orderType: 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP';
      orderPrice: number;
      entryRefPrice: number;
      isPending: boolean;
    }
  | {
      ok: false;
      reason: 'price_outside_entry_range' | 'pending_not_allowed' | 'invalid_pending_price' | 'invalid_quote';
      detail: string;
    };

export type StopLossCheck =
  | { ok: true }
  | { ok: false; reason: 'sl_wrong_side' | 'sl_too_close' | 'sl_too_far'; detail: string };

type Entry = ExecutionProfile['entry'];
type StopLossConfig = ExecutionProfile['stop_loss'];

const PENDING_ORDER_TYPES: Record<string, { side: 'buy' | 'sell' }> = {
  buy_limit: { side: 'buy' },
  sell_limit: { side: 'sell' },
  buy_stop: { side: 'buy' },
  sell_stop: { side: 'sell' },
};

export function decideEntry(
  signal: GoldSignalLike,
  quote: { bid: number; ask: number },
  entry: Entry,
): EntryDecision {
  const { bid, ask } = quote;
  if (!(bid > 0) || !(ask > 0) || !Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) {
    return { ok: false, reason: 'invalid_quote', detail: `invalid quote bid=${bid} ask=${ask}` };
  }

  const isBuy = signal.direction === 'buy';
  const price = isBuy ? ask : bid;
  const tol = entry.market_tolerance_price;
  const low = signal.entryLow;
  const high = signal.entryHigh;
  const inRange = price >= low - tol && price <= high + tol;
  const marketSide = isBuy ? 'BUY' : 'SELL';
  const marketOrder = (): EntryDecision => ({
    ok: true,
    orderType: marketSide,
    orderPrice: 0,
    entryRefPrice: price,
    isPending: false,
  });
  const outsideRange = (): EntryDecision => ({
    ok: false,
    reason: 'price_outside_entry_range',
    detail: `price ${price} outside [${low - tol}, ${high + tol}]`,
  });

  if (signal.orderType === 'market') {
    if (inRange) return marketOrder();
    if (entry.policy === 'pending_at_range') {
      if (isBuy && price > high + tol) {
        return pendingOrder('BUY_LIMIT', high);
      }
      if (!isBuy && price < low - tol) {
        return pendingOrder('SELL_LIMIT', low);
      }
    }
    return outsideRange();
  }

  const pending = PENDING_ORDER_TYPES[signal.orderType];
  if (!pending) {
    return {
      ok: false,
      reason: 'invalid_pending_price',
      detail: `unknown order type ${signal.orderType}`,
    };
  }
  if (pending.side !== signal.direction) {
    return {
      ok: false,
      reason: 'invalid_pending_price',
      detail: `order type ${signal.orderType} disagrees with direction ${signal.direction}`,
    };
  }

  if (entry.policy === 'market_only') {
    if (entry.allow_market_fallback && inRange) return marketOrder();
    return {
      ok: false,
      reason: 'pending_not_allowed',
      detail: `policy market_only does not place ${signal.orderType}`,
    };
  }

  const orderType = signal.orderType.toUpperCase() as 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP';
  const pendingPrice = pendingPriceFor(orderType, low, high, bid, ask);
  if (pendingPrice.valid) return pendingOrder(orderType, pendingPrice.price);
  if (entry.allow_market_fallback && inRange) return marketOrder();
  return {
    ok: false,
    reason: 'invalid_pending_price',
    detail: `${orderType} at ${pendingPrice.price} is not valid against bid=${bid} ask=${ask}`,
  };
}

/** Order price per contracts section 6 (BUY_LIMIT/SELL_STOP at high, SELL_LIMIT/BUY_STOP at low) and its side check. */
function pendingPriceFor(
  orderType: 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP',
  low: number,
  high: number,
  bid: number,
  ask: number,
): { price: number; valid: boolean } {
  switch (orderType) {
    case 'BUY_LIMIT':
      return { price: high, valid: high < ask };
    case 'SELL_LIMIT':
      return { price: low, valid: low > bid };
    case 'BUY_STOP':
      return { price: low, valid: low > ask };
    case 'SELL_STOP':
      return { price: high, valid: high < bid };
  }
}

function pendingOrder(
  orderType: 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP',
  orderPrice: number,
): EntryDecision {
  return { ok: true, orderType, orderPrice, entryRefPrice: orderPrice, isPending: true };
}

/**
 * BUY requires SL below the entry reference, SELL above it. Distance must lie
 * within [min_distance_price, max_distance_price].
 */
export function validateStopLoss(
  direction: 'buy' | 'sell',
  entryRefPrice: number,
  stopLoss: number,
  stopLossCfg: StopLossConfig,
): StopLossCheck {
  if (!Number.isFinite(stopLoss) || !Number.isFinite(entryRefPrice)) {
    return { ok: false, reason: 'sl_wrong_side', detail: `non-finite entry ${entryRefPrice} or stop ${stopLoss}` };
  }
  const correctSide = direction === 'buy' ? stopLoss < entryRefPrice : stopLoss > entryRefPrice;
  if (!correctSide) {
    return {
      ok: false,
      reason: 'sl_wrong_side',
      detail: `${direction} stop ${stopLoss} must be ${direction === 'buy' ? 'below' : 'above'} entry ${entryRefPrice}`,
    };
  }
  const distance = Math.abs(entryRefPrice - stopLoss);
  if (distance < stopLossCfg.min_distance_price) {
    return {
      ok: false,
      reason: 'sl_too_close',
      detail: `stop distance ${distance} below min ${stopLossCfg.min_distance_price}`,
    };
  }
  if (distance > stopLossCfg.max_distance_price) {
    return {
      ok: false,
      reason: 'sl_too_far',
      detail: `stop distance ${distance} above max ${stopLossCfg.max_distance_price}`,
    };
  }
  return { ok: true };
}

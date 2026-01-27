import { RestClientV5 } from 'bybit-api';
import { getBybitClient } from './bybitClient';
import { getBybitCredentials } from './bybitSecrets';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';
import { TelegramSignal } from './telegramParser';
import { getTradingSettings } from './tradingSettings';
import {
  applySafetyBuffer,
  calculateQuantity,
  calculateRiskAmount,
  formatByStep,
  interpretTolerance,
  roundDownToStep,
  splitTakeProfits,
} from './tradeSizing';

const CATEGORY = 'linear';

export type SignalContext = {
  chatId: string;
  messageId: string;
  messageDate?: Date | null;
  signal: TelegramSignal;
};

type InstrumentInfo = {
  qtyStep: number;
  minOrderQty: number;
  minOrderValue: number;
  tickSize: number;
};

function toNumber(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function pickMessageTimestamp(date?: Date | null): number | null {
  if (!date) return null;
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

async function unwrapResult<T>(promise: Promise<any>, context: string): Promise<T> {
  const response = await promise;
  if (!response) {
    throw new Error(`${context}: empty response`);
  }
  if (response.retCode !== 0) {
    throw new Error(`${context}: ${response.retMsg ?? 'unknown_error'}`);
  }
  return response.result as T;
}

async function getTickerPrice(client: RestClientV5, symbol: string): Promise<number> {
  const result = await unwrapResult<{ list: Array<{ lastPrice: string }> }>(
    client.getTickers({ category: CATEGORY, symbol }),
    'ticker',
  );
  const price = result.list?.[0]?.lastPrice;
  return toNumber(price, 0);
}

async function getMessagePrice(
  client: RestClientV5,
  symbol: string,
  messageTimeMs: number,
): Promise<number | null> {
  const start = messageTimeMs - 60_000;
  const end = messageTimeMs + 60_000;
  const result = await unwrapResult<{ list: Array<string[]> }>(
    client.getKline({
      category: CATEGORY,
      symbol,
      interval: '1',
      start,
      end,
    }),
    'kline',
  );

  if (!result.list?.length) return null;

  let closest: string[] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const entry of result.list) {
    const timestamp = toNumber(entry[0], 0);
    const distance = Math.abs(timestamp - messageTimeMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      closest = entry;
    }
  }

  const close = closest?.[4];
  if (!close) return null;
  const parsed = toNumber(close, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getInstrumentInfo(
  client: RestClientV5,
  symbol: string,
): Promise<InstrumentInfo> {
  const result = await unwrapResult<{ list: Array<any> }>(
    client.getInstrumentsInfo({ category: CATEGORY, symbol }),
    'instrument_info',
  );
  const info = result.list?.[0] ?? {};
  const lot = info.lotSizeFilter ?? {};
  const price = info.priceFilter ?? {};
  return {
    qtyStep: toNumber(lot.qtyStep, 1),
    minOrderQty: toNumber(lot.minOrderQty, 0),
    minOrderValue: toNumber(lot.minOrderValue, 0),
    tickSize: toNumber(price.tickSize, 0.0001),
  };
}

async function getAvailableMargin(client: RestClientV5): Promise<number> {
  const result = await unwrapResult<{ list: Array<any> }>(
    client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' }),
    'wallet_balance',
  );
  const entry = result.list?.[0];
  const coin = entry?.coin?.[0];
  return (
    toNumber(coin?.availableToWithdraw, 0) ||
    toNumber(coin?.walletBalance, 0) ||
    toNumber(coin?.equity, 0)
  );
}

async function getPosition(client: RestClientV5, symbol: string): Promise<any | null> {
  const result = await unwrapResult<{ list: Array<any> }>(
    client.getPositionInfo({ category: CATEGORY, symbol }),
    'position_info',
  );
  return result.list?.[0] ?? null;
}

function getStopLossTriggerDirection(direction: 'long' | 'short'): 1 | 2 {
  return direction === 'long' ? 2 : 1;
}

function roundPrice(price: number, tickSize: number): number {
  return roundDownToStep(price, tickSize);
}

async function placeMarketEntry(
  client: RestClientV5,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
): Promise<string> {
  const result = await unwrapResult<{ orderId: string }>(
    client.submitOrder({
      category: CATEGORY,
      symbol,
      side,
      orderType: 'Market',
      qty,
      timeInForce: 'IOC',
    }),
    'entry_order',
  );
  return result.orderId;
}

async function placeReduceOnlyLimit(
  client: RestClientV5,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  price: string,
): Promise<string> {
  const result = await unwrapResult<{ orderId: string }>(
    client.submitOrder({
      category: CATEGORY,
      symbol,
      side,
      orderType: 'Limit',
      qty,
      price,
      timeInForce: 'GTC',
      reduceOnly: true,
    }),
    'tp_order',
  );
  return result.orderId;
}

async function placeStopLossOrder(
  client: RestClientV5,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  triggerPrice: string,
  triggerDirection: 1 | 2,
): Promise<string> {
  const result = await unwrapResult<{ orderId: string }>(
    client.submitOrder({
      category: CATEGORY,
      symbol,
      side,
      orderType: 'Market',
      qty,
      triggerBy: 'LastPrice',
      triggerPrice,
      triggerDirection,
      reduceOnly: true,
      closeOnTrigger: true,
      orderFilter: 'StopOrder',
    }),
    'stop_loss',
  );
  return result.orderId;
}

async function updateTradeSet(
  tradeSetId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const firestore = initFirestore();
  if (!firestore) return;
  await firestore.collection('trade_sets').doc(tradeSetId).set(payload, { merge: true });
}

export async function handleParsedSignal(context: SignalContext): Promise<void> {
  const firestore = initFirestore();
  if (!firestore) return;

  const tradeSetId = `${context.chatId}_${context.messageId}`;
  const tradeRef = firestore.collection('trade_sets').doc(tradeSetId);
  const existing = await tradeRef.get();
  if (existing.exists) return;

  const nowIso = new Date().toISOString();
  const { signal } = context;

  await tradeRef.set({
    trade_set_id: tradeSetId,
    source_message_id: context.messageId,
    chat_id: context.chatId,
    symbol: signal.symbol,
    direction: signal.direction,
    entry_type: 'market',
    sl: signal.stopLoss,
    tp1: signal.takeProfits[0],
    tp2: signal.takeProfits[1],
    tp3: signal.takeProfits[2],
    state: 'DETECTED',
    created_at: nowIso,
    updated_at: nowIso,
  });

  try {
    const settings = await getTradingSettings();

    let creds;
    try {
      creds = await getBybitCredentials();
    } catch (error) {
      if (settings.bybitOptional) {
        await updateTradeSet(tradeSetId, {
          state: 'SKIPPED',
          skip_reason: 'bybit_not_configured',
          updated_at: new Date().toISOString(),
        });
        await writeSystemLog('warn', 'bybit', 'bybit_not_configured', {
          tradeSetId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    }

    const client = getBybitClient(creds);

    const messageTimeMs = pickMessageTimestamp(context.messageDate);
    const nowMs = Date.now();

    if (messageTimeMs) {
      const delayMs = nowMs - messageTimeMs;
      if (delayMs > settings.maxSignalDelaySec * 1000) {
        await updateTradeSet(tradeSetId, {
          state: 'SKIPPED',
          skip_reason: 'signal_too_old',
          updated_at: new Date().toISOString(),
        });
        await writeSystemLog('info', 'bybit', 'signal_skipped_late', {
          tradeSetId,
          delay_ms: delayMs,
        });
        return;
      }
    }

    const currentPrice = await getTickerPrice(client, signal.symbol);
    const messagePrice = messageTimeMs
      ? await getMessagePrice(client, signal.symbol, messageTimeMs)
      : null;
    const referencePrice = messagePrice ?? currentPrice;

    const slippageTolAbs = interpretTolerance(referencePrice, settings.slippageTol);
    const tp1BufferAbs = interpretTolerance(referencePrice, settings.tp1SkipBuffer);

    if (signal.direction === 'long') {
      if (currentPrice > referencePrice + slippageTolAbs) {
        await updateTradeSet(tradeSetId, {
          state: 'SKIPPED',
          skip_reason: 'unfavorable_price',
          updated_at: new Date().toISOString(),
        });
        await writeSystemLog('info', 'bybit', 'signal_skipped_unfavorable', {
          tradeSetId,
          currentPrice,
          referencePrice,
        });
        return;
      }
      if (currentPrice >= signal.takeProfits[0] - tp1BufferAbs) {
        await updateTradeSet(tradeSetId, {
          state: 'SKIPPED',
          skip_reason: 'tp1_already_close',
          updated_at: new Date().toISOString(),
        });
        await writeSystemLog('info', 'bybit', 'signal_skipped_tp1', {
          tradeSetId,
          currentPrice,
        });
        return;
      }
    } else {
      if (currentPrice < referencePrice - slippageTolAbs) {
        await updateTradeSet(tradeSetId, {
          state: 'SKIPPED',
          skip_reason: 'unfavorable_price',
          updated_at: new Date().toISOString(),
        });
        await writeSystemLog('info', 'bybit', 'signal_skipped_unfavorable', {
          tradeSetId,
          currentPrice,
          referencePrice,
        });
        return;
      }
      if (currentPrice <= signal.takeProfits[0] + tp1BufferAbs) {
        await updateTradeSet(tradeSetId, {
          state: 'SKIPPED',
          skip_reason: 'tp1_already_close',
          updated_at: new Date().toISOString(),
        });
        await writeSystemLog('info', 'bybit', 'signal_skipped_tp1', {
          tradeSetId,
          currentPrice,
        });
        return;
      }
    }

    const instrument = await getInstrumentInfo(client, signal.symbol);
    const availableMargin = await getAvailableMargin(client);
    const riskAmount = calculateRiskAmount(
      availableMargin,
      settings.riskMode,
      settings.riskValue,
    );

    let rawQty = calculateQuantity(currentPrice, signal.stopLoss, riskAmount);
    rawQty = applySafetyBuffer(rawQty);
    const qtyRounded = roundDownToStep(rawQty, instrument.qtyStep);

    if (qtyRounded <= 0 || qtyRounded < instrument.minOrderQty) {
      await updateTradeSet(tradeSetId, {
        state: 'SKIPPED',
        skip_reason: 'qty_below_min',
        updated_at: new Date().toISOString(),
      });
      await writeSystemLog('info', 'bybit', 'signal_skipped_min_qty', {
        tradeSetId,
        qtyRounded,
      });
      return;
    }

    if (instrument.minOrderValue > 0 && qtyRounded * currentPrice < instrument.minOrderValue) {
      await updateTradeSet(tradeSetId, {
        state: 'SKIPPED',
        skip_reason: 'notional_below_min',
        updated_at: new Date().toISOString(),
      });
      await writeSystemLog('info', 'bybit', 'signal_skipped_min_value', {
        tradeSetId,
        qtyRounded,
      });
      return;
    }

    const entrySide = signal.direction === 'long' ? 'Buy' : 'Sell';
    const reduceSide = signal.direction === 'long' ? 'Sell' : 'Buy';

    const entryQty = formatByStep(qtyRounded, instrument.qtyStep);
    const entryOrderId = await placeMarketEntry(client, signal.symbol, entrySide, entryQty);

    await updateTradeSet(tradeSetId, {
      state: 'ENTRY_PLACED',
      risk_amount: riskAmount,
      qty: qtyRounded,
      bybit: {
        entry_order_id: entryOrderId,
      },
      updated_at: new Date().toISOString(),
    });

    const position = await getPosition(client, signal.symbol);
    const filledQty = toNumber(position?.size, qtyRounded);
    const avgEntryPrice = toNumber(position?.avgPrice, currentPrice);

    const [tp1Raw, tp2Raw, tp3Raw] = splitTakeProfits(filledQty);
    const tp1Qty = roundDownToStep(tp1Raw, instrument.qtyStep);
    const tp2Qty = roundDownToStep(tp2Raw, instrument.qtyStep);
    const tp3Qty = roundDownToStep(tp3Raw, instrument.qtyStep);

    const tp1Price = roundPrice(signal.takeProfits[0], instrument.tickSize);
    const tp2Price = roundPrice(signal.takeProfits[1], instrument.tickSize);
    const tp3Price = roundPrice(signal.takeProfits[2], instrument.tickSize);
    const slPrice = roundPrice(signal.stopLoss, instrument.tickSize);

    const tp1OrderId = await placeReduceOnlyLimit(
      client,
      signal.symbol,
      reduceSide,
      formatByStep(tp1Qty, instrument.qtyStep),
      formatByStep(tp1Price, instrument.tickSize),
    );

    const tp2OrderId = await placeReduceOnlyLimit(
      client,
      signal.symbol,
      reduceSide,
      formatByStep(tp2Qty, instrument.qtyStep),
      formatByStep(tp2Price, instrument.tickSize),
    );

    const tp3OrderId = await placeReduceOnlyLimit(
      client,
      signal.symbol,
      reduceSide,
      formatByStep(tp3Qty, instrument.qtyStep),
      formatByStep(tp3Price, instrument.tickSize),
    );

    const slOrderId = await placeStopLossOrder(
      client,
      signal.symbol,
      reduceSide,
      formatByStep(filledQty, instrument.qtyStep),
      formatByStep(slPrice, instrument.tickSize),
      getStopLossTriggerDirection(signal.direction),
    );

    await updateTradeSet(tradeSetId, {
      state: 'PROTECTION_PLACED',
      qty: filledQty,
      bybit: {
        entry_order_id: entryOrderId,
        sl_order_id: slOrderId,
        tp1_order_id: tp1OrderId,
        tp2_order_id: tp2OrderId,
        tp3_order_id: tp3OrderId,
        avg_entry_price: avgEntryPrice,
      },
      updated_at: new Date().toISOString(),
    });

    await writeSystemLog('info', 'bybit', 'trade_protection_placed', {
      tradeSetId,
      symbol: signal.symbol,
      qty: filledQty,
    });
  } catch (error) {
    logger.error('bybit_trade_failed', {
      tradeSetId,
      error: error instanceof Error ? error.message : String(error),
    });
    await updateTradeSet(tradeSetId, {
      state: 'ERROR',
      error: error instanceof Error ? error.message : String(error),
      updated_at: new Date().toISOString(),
    });
    await writeSystemLog('error', 'bybit', 'trade_failed', {
      tradeSetId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

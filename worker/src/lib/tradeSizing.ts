import { RiskMode } from './tradingSettings';

export function decimalPlaces(step: number): number {
  if (!Number.isFinite(step)) return 0;
  const normalized = step.toString();
  if (normalized.includes('e-')) {
    const parts = normalized.split('e-');
    return Number(parts[1] ?? 0);
  }
  const dot = normalized.indexOf('.');
  return dot === -1 ? 0 : normalized.length - dot - 1;
}

export function roundDownToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  return Math.floor(value / step) * step;
}

export function formatByStep(value: number, step: number): string {
  const decimals = decimalPlaces(step);
  return value.toFixed(decimals);
}

export function calculateRiskAmount(
  availableMargin: number,
  riskMode: RiskMode,
  riskValue: number,
): number {
  if (riskMode === 'PERCENT_AVAILABLE_MARGIN') {
    return Math.max(0, availableMargin * (riskValue / 100));
  }
  return Math.max(0, riskValue);
}

export function calculateQuantity(
  entryPrice: number,
  stopLoss: number,
  riskAmount: number,
): number {
  const distance = Math.abs(entryPrice - stopLoss);
  if (distance <= 0 || !Number.isFinite(distance)) return 0;
  return riskAmount / distance;
}

export function splitTakeProfits(totalQty: number): [number, number, number] {
  const tp1 = totalQty * 0.6;
  const tp2 = totalQty * 0.25;
  const tp3 = totalQty * 0.15;
  return [tp1, tp2, tp3];
}

export function applySafetyBuffer(quantity: number, buffer = 0.98): number {
  if (buffer <= 0 || buffer > 1) return quantity;
  return quantity * buffer;
}

export function interpretTolerance(price: number, tolerance: number): number {
  if (!Number.isFinite(price)) return tolerance;
  if (tolerance <= 1) {
    return price * tolerance;
  }
  return tolerance;
}

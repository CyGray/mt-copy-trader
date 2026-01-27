import { describe, expect, it } from 'vitest';
import {
  applySafetyBuffer,
  calculateQuantity,
  calculateRiskAmount,
  decimalPlaces,
  formatByStep,
  interpretTolerance,
  roundDownToStep,
  splitTakeProfits,
} from './tradeSizing';

describe('trade sizing helpers', () => {
  it('rounds down to step and formats correctly', () => {
    expect(roundDownToStep(1.237, 0.01)).toBeCloseTo(1.23);
    expect(decimalPlaces(0.001)).toBe(3);
    expect(formatByStep(1.23, 0.01)).toBe('1.23');
  });

  it('calculates risk amount for percent mode', () => {
    expect(calculateRiskAmount(1000, 'PERCENT_AVAILABLE_MARGIN', 2)).toBe(20);
  });

  it('calculates quantity from risk', () => {
    expect(calculateQuantity(1, 0.9, 10)).toBeCloseTo(100);
  });

  it('splits take profits by weights', () => {
    const [tp1, tp2, tp3] = splitTakeProfits(100);
    expect(tp1).toBeCloseTo(60);
    expect(tp2).toBeCloseTo(25);
    expect(tp3).toBeCloseTo(15);
  });

  it('applies safety buffer', () => {
    expect(applySafetyBuffer(100, 0.98)).toBeCloseTo(98);
  });

  it('interprets tolerance as percent when <= 1', () => {
    expect(interpretTolerance(100, 0.01)).toBeCloseTo(1);
    expect(interpretTolerance(100, 2)).toBe(2);
  });
});

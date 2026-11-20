import { describe, test, expect } from 'vitest';
import { addMonths, currentMonth, formatMonth, isMonth, monthsBetween } from './months';

describe('months', () => {
  test('isMonth', () => {
    expect(isMonth('2026-10')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth(null)).toBe(false);
  });

  test('addMonths crosses years both ways', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(addMonths('2026-10', -23)).toBe('2024-11');
  });

  test('monthsBetween is inclusive', () => {
    expect(monthsBetween('2025-12', '2026-02')).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2026-02', '2026-01')).toEqual([]);
  });

  test('currentMonth and formatMonth', () => {
    expect(currentMonth(new Date(2026, 10, 19))).toBe('2026-11');
    expect(formatMonth('2026-10')).toBe('Oct 2026');
    expect(formatMonth('bad')).toBe('bad');
  });
});

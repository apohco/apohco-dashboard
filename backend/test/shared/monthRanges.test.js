const { parseMonth, monthBounds, monthsBetween, currentMonth, monthOf } = require('../../src/shared/monthRanges');

describe('parseMonth', () => {
  test.each(['2026-01', '1999-12'])('accepts %s', (m) => expect(parseMonth(m)).not.toBeNull());
  test.each(['2026-13', '2026-00', '2026-1', '26-01', '2026-01-01', '', null, undefined])('rejects %s', (m) =>
    expect(parseMonth(m)).toBeNull()
  );
});

describe('monthBounds', () => {
  test('handles month lengths and leap years', () => {
    expect(monthBounds('2026-10')).toEqual({ startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(monthBounds('2026-04')).toEqual({ startDate: '2026-04-01', endDate: '2026-04-30' });
    expect(monthBounds('2024-02')).toEqual({ startDate: '2024-02-01', endDate: '2024-02-29' });
    expect(monthBounds('2026-02')).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
  });

  test('throws on a bad month', () => {
    expect(() => monthBounds('2026-13')).toThrow('Invalid month');
  });
});

describe('monthsBetween', () => {
  test('is inclusive and crosses year boundaries', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  test('a single month', () => {
    expect(monthsBetween('2026-10', '2026-10')).toEqual(['2026-10']);
  });

  test('is empty when the range is reversed', () => {
    expect(monthsBetween('2026-10', '2026-09')).toEqual([]);
  });

  test('24 months of backfill', () => {
    const months = monthsBetween('2024-11', '2026-10');
    expect(months).toHaveLength(24);
    expect(months[0]).toBe('2024-11');
    expect(months[23]).toBe('2026-10');
  });
});

describe('currentMonth / monthOf', () => {
  test('currentMonth uses UTC', () => {
    expect(currentMonth(new Date('2026-11-30T23:30:00Z'))).toBe('2026-11');
    expect(currentMonth(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
  });

  test('monthOf accepts Date objects and date strings', () => {
    expect(monthOf(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10');
    expect(monthOf('2026-10-01')).toBe('2026-10');
  });
});

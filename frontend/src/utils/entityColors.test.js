import { test, expect } from 'vitest';
import { SERIES, UNASSIGNED_COLOR, OTHER_COLOR, colorFor, entityColorMap, pivotByMonth } from './entityColors';

const ENTITIES = [
  { entityId: 'w', entityName: 'Westside' },
  { entityId: 'a', entityName: 'APOHCO' },
  { entityId: 'l', entityName: 'Lebanon' },
];

test('each entity keeps one color, by name order, whatever the chart shows', () => {
  const map = entityColorMap(ENTITIES);
  expect(map.get('a')).toBe(SERIES[0]);
  expect(map.get('l')).toBe(SERIES[1]);
  expect(map.get('w')).toBe(SERIES[2]);
  expect(colorFor(map, null)).toBe(UNASSIGNED_COLOR);
  expect(colorFor(map, 'gone')).toBe(OTHER_COLOR);
});

test('past eight entities the rest share the Other gray (no generated hues)', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ entityId: `e${i}`, entityName: `Entity ${i}` }));
  const map = entityColorMap(many);
  expect(new Set([...map.values()]).size).toBe(9);
  expect(map.get('e9')).toBe(OTHER_COLOR);
});

test('pivotByMonth: one row per month, entities in list order, unassigned last', () => {
  const { data, keys } = pivotByMonth(
    [
      { month: '2026-09', entityId: null, amount: 5 },
      { month: '2026-09', entityId: 'w', amount: 10 },
      { month: '2026-10', entityId: 'a', amount: 3 },
      { month: '2026-10', entityId: 'a', amount: 2 },
      { month: '2026-10', entityId: 'old', amount: 1 },
      { month: '2025-01', entityId: 'a', amount: 99 },
    ],
    ['2026-09', '2026-10'],
    ENTITIES
  );
  expect(keys).toEqual(['a', 'w', 'old', '']);
  expect(data).toEqual([{ month: '2026-09', '': 5, w: 10 }, { month: '2026-10', a: 5, old: 1 }]);
});

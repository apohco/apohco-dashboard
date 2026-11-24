// Chart colors for Controller entities. Each entity keeps one color
// everywhere (assigned by its place in the Group's entity list sorted by
// name, never by rank in a chart), from a categorical palette validated for
// color-vision deficiency on the light surface (dataviz reference palette,
// slots in fixed order). "Unassigned" is a neutral gray, not a series hue.
// Three slots are under 3:1 contrast on white, so every chart that uses
// these also offers a table view.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const UNASSIGNED_COLOR = '#9a9a96';
export const OTHER_COLOR = '#c3c2b7';
export const CHART_SURFACE = '#ffffff';
export const GRID_COLOR = '#e3e5e8';
export const AXIS_TEXT = '#6b6c72';

// entityId -> color. Past eight entities the rest share "Other" gray
// (a ninth hue is never generated).
export function entityColorMap(entities) {
  const sorted = [...entities].sort((a, b) => a.entityName.localeCompare(b.entityName));
  const map = new Map();
  sorted.forEach((e, i) => map.set(e.entityId, i < SERIES.length ? SERIES[i] : OTHER_COLOR));
  return map;
}

export const colorFor = (map, entityId) => (entityId ? map.get(entityId) || OTHER_COLOR : UNASSIGNED_COLOR);

// Rows of { month, entityId, amount } -> one object per month keyed by
// entity id ('' for unassigned), for stacked bar charts; plus the entity
// keys present, in the entity list's order (unassigned last).
export function pivotByMonth(rows, months, entities) {
  const byMonth = new Map(months.map((m) => [m, { month: m }]));
  const present = new Set();
  for (const r of rows) {
    const key = r.entityId || '';
    const target = byMonth.get(r.month);
    if (!target) continue;
    target[key] = (target[key] || 0) + r.amount;
    present.add(key);
  }
  const order = [...entities].sort((a, b) => a.entityName.localeCompare(b.entityName)).map((e) => e.entityId);
  // Known entities first, then ids no longer active, then unassigned.
  const known = order.filter((id) => present.has(id));
  const former = [...present].filter((id) => id && !order.includes(id));
  const keys = [...known, ...former, ...(present.has('') ? [''] : [])];
  return { data: [...byMonth.values()], keys };
}

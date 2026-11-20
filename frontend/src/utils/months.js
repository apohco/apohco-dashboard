// "YYYY-MM" month helpers for the Controller module (all UTC-free integer
// arithmetic, so the browser time zone never shifts a month).

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isMonth = (value) => MONTH_RE.test(String(value ?? ''));

const toIndex = (m) => {
  const [, y, mo] = MONTH_RE.exec(m);
  return Number(y) * 12 + Number(mo) - 1;
};
const fromIndex = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function addMonths(month, delta) {
  return fromIndex(toIndex(month) + delta);
}

// Every month from `from` to `to` inclusive (empty if reversed).
export function monthsBetween(from, to) {
  const out = [];
  for (let i = toIndex(from); i <= toIndex(to); i++) out.push(fromIndex(i));
  return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-10" -> "Oct 2026"
export function formatMonth(month) {
  if (!isMonth(month)) return month;
  const [y, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

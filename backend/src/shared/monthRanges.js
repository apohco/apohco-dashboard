// Month helpers for Controller pulls. Months are passed around as
// "YYYY-MM" strings in the API and stored as the first day of the month
// (DATE) in the database. All arithmetic is done in UTC on plain
// year/month integers, so server time zone never shifts a month.

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function parseMonth(value) {
  const match = MONTH_RE.exec(String(value ?? ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

const pad = (n) => String(n).padStart(2, '0');
const formatMonth = ({ year, month }) => `${year}-${pad(month)}`;
const monthIndex = ({ year, month }) => year * 12 + (month - 1);
const fromIndex = (i) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });

// First and last calendar day of a "YYYY-MM" month, as YYYY-MM-DD.
function monthBounds(value) {
  const m = parseMonth(value);
  if (!m) throw new Error(`Invalid month: ${value}`);
  const lastDay = new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
  return { startDate: `${formatMonth(m)}-01`, endDate: `${formatMonth(m)}-${pad(lastDay)}` };
}

// Every month from `from` to `to` inclusive, as "YYYY-MM" strings.
function monthsBetween(from, to) {
  const a = parseMonth(from);
  const b = parseMonth(to);
  if (!a || !b) throw new Error('Months must be formatted YYYY-MM');
  const months = [];
  for (let i = monthIndex(a); i <= monthIndex(b); i++) months.push(formatMonth(fromIndex(i)));
  return months;
}

function currentMonth(now = new Date()) {
  return formatMonth({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
}

// "YYYY-MM" from a DATE value (a pg Date object or "YYYY-MM-DD" string).
function monthOf(dateValue) {
  if (dateValue instanceof Date) {
    return formatMonth({ year: dateValue.getUTCFullYear(), month: dateValue.getUTCMonth() + 1 });
  }
  return String(dateValue).slice(0, 7);
}

module.exports = { parseMonth, monthBounds, monthsBetween, currentMonth, monthOf };

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCurrency(amount) {
  const value = Number(amount) || 0;
  const formatted = currencyFormatter.format(Math.abs(value));
  return value < 0 ? `(${formatted})` : formatted;
}

export function formatPercent(amount, base) {
  if (!base) return '—';
  return `${((Number(amount) / base) * 100).toFixed(1)}%`;
}

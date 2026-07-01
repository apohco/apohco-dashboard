import dayjs from 'dayjs';

// Builds the `periods` array the report Lambdas expect, from a view mode
// and a selected month ("YYYY-MM"). P&L/Cash Flow periods are date ranges;
// Balance Sheet periods are single as-of dates.

function monthRange(monthStr) {
  const start = dayjs(`${monthStr}-01`);
  return { start, end: start.endOf('month') };
}

export function buildRangePeriods(viewMode, selectedMonth) {
  const { start: selectedStart, end: selectedEnd } = monthRange(selectedMonth);

  if (viewMode === 'single') {
    return [
      {
        label: selectedStart.format('MMM YYYY'),
        startDate: selectedStart.format('YYYY-MM-DD'),
        endDate: selectedEnd.format('YYYY-MM-DD'),
      },
    ];
  }

  if (viewMode === 'compare') {
    const priorYearStart = selectedStart.subtract(1, 'year');
    return [
      {
        label: selectedStart.format('MMM YYYY'),
        startDate: selectedStart.format('YYYY-MM-DD'),
        endDate: selectedEnd.format('YYYY-MM-DD'),
      },
      {
        label: `${priorYearStart.format('MMM YYYY')} (PY)`,
        startDate: priorYearStart.format('YYYY-MM-DD'),
        endDate: priorYearStart.endOf('month').format('YYYY-MM-DD'),
      },
    ];
  }

  // multi: January through the selected month, one period per month
  const periods = [];
  let cursor = selectedStart.startOf('year');
  while (cursor.isBefore(selectedStart) || cursor.isSame(selectedStart, 'month')) {
    periods.push({
      label: cursor.format('MMM YYYY'),
      startDate: cursor.format('YYYY-MM-DD'),
      endDate: cursor.endOf('month').format('YYYY-MM-DD'),
    });
    cursor = cursor.add(1, 'month');
  }
  return periods;
}

export function buildAsOfPeriods(viewMode, selectedMonth) {
  const { end: selectedEnd } = monthRange(selectedMonth);

  if (viewMode === 'single') {
    return [{ label: selectedEnd.format('MMM YYYY'), asOfDate: selectedEnd.format('YYYY-MM-DD') }];
  }

  if (viewMode === 'compare') {
    const priorYearEnd = selectedEnd.subtract(1, 'year');
    return [
      { label: selectedEnd.format('MMM YYYY'), asOfDate: selectedEnd.format('YYYY-MM-DD') },
      { label: `${priorYearEnd.format('MMM YYYY')} (PY)`, asOfDate: priorYearEnd.format('YYYY-MM-DD') },
    ];
  }

  const periods = [];
  let cursor = selectedEnd.startOf('year').endOf('month');
  while (cursor.isBefore(selectedEnd) || cursor.isSame(selectedEnd, 'month')) {
    periods.push({ label: cursor.format('MMM YYYY'), asOfDate: cursor.format('YYYY-MM-DD') });
    cursor = cursor.add(1, 'month').endOf('month');
  }
  return periods;
}

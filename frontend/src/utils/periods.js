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

// Single period covering the trailing twelve months ending at the selected
// month (e.g. selecting "2026-06" covers Jul 2025 through Jun 2026).
export function buildTtmPeriod(selectedMonth) {
  const { end } = monthRange(selectedMonth);
  const start = end.subtract(11, 'month').startOf('month');
  return [
    {
      label: `TTM ${end.format('MMM YYYY')}`,
      startDate: start.format('YYYY-MM-DD'),
      endDate: end.format('YYYY-MM-DD'),
    },
  ];
}

// One period per month across an arbitrary ["YYYY-MM", "YYYY-MM"] range
// (inclusive), for Multi-Month view — replaces the old assumption that
// multi-month always starts at January of the selected month's year.
export function buildCustomRangePeriods(fromMonth, toMonth) {
  const periods = [];
  let cursor = dayjs(`${fromMonth}-01`);
  const last = dayjs(`${toMonth}-01`);
  while (cursor.isBefore(last) || cursor.isSame(last, 'month')) {
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

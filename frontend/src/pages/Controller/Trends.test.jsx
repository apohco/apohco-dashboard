import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({ getTrends: vi.fn() }));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import { getTrends } from '../../api/controller';
import { listGroups } from '../../api/settings';
import Trends, { describeAnomaly, reviewLink } from './Trends';

const name = (id) => ({ leb: 'Lebanon', mil: 'Milford' })[id] || 'Unassigned';
const ANOMALIES = [
  { type: 'MissingRecurring', vendorKey: 'v:rent', vendorName: 'Landlord', amount: 3000, months: 3, qboId: 'mgmt' },
  { type: 'SpendSpike', entityId: 'leb', accountKey: 'code:6100', accountLabel: '6100 Supplies', amount: 1600, baseline: 1000, increase: 600, percent: 60, qboId: 'mgmt' },
  { type: 'SplitShift', vendorKey: 'v:k', vendorName: 'Kroger', entityId: 'mil', currentShare: 0.8, baselineShare: 0.1, points: 70, amount: 400, qboId: 'mgmt' },
  { type: 'NewVendor', vendorKey: 'v:new', vendorName: 'New Co', amount: 80, qboId: 'wpd' },
];

describe('helpers', () => {
  test('describeAnomaly', () => {
    expect(describeAnomaly(ANOMALIES[0], name)).toBe('Landlord: nothing this month, after a charge in each of the last 3 months (about $3,000.00)');
    expect(describeAnomaly(ANOMALIES[1], name)).toBe('Lebanon · 6100 Supplies: $1,600.00 vs $1,000.00 average (+60%)');
    expect(describeAnomaly({ ...ANOMALIES[1], percent: null, baseline: 0 }, name)).toBe('Lebanon · 6100 Supplies: $1,600.00 vs $0.00 average (no spend before)');
    expect(describeAnomaly(ANOMALIES[2], name)).toBe("Kroger: Milford is 80% of this month's spend vs 10% usually (+70 points)");
    expect(describeAnomaly(ANOMALIES[3], name)).toBe('New Co: first time in the General Ledger');
  });

  test('reviewLink opens the file, month and vendor or account', () => {
    expect(reviewLink(ANOMALIES[2], '2026-10')).toBe('/controller/review?month=2026-10&qboId=mgmt&vendor=Kroger');
    expect(reviewLink(ANOMALIES[1], '2026-10')).toBe('/controller/review?month=2026-10&qboId=mgmt&account=6100');
    // A missing charge opens the last month it appeared.
    expect(reviewLink(ANOMALIES[0], '2026-10')).toBe('/controller/review?month=2026-09&qboId=mgmt&vendor=Landlord');
  });
});

describe('Trends page', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    getTrends.mockResolvedValue({
      month: '2026-10', latestMonth: '2026-10', months: ['2026-09', '2026-10'], baselineMonths: ['2026-09'],
      settings: { splitShiftPoints: 25, spikePercent: 50, spikeMinAmount: 500, recurringMonths: 3, baselineMonths: 6 },
      entities: [{ entityId: 'leb', entityName: 'Lebanon' }, { entityId: 'mil', entityName: 'Milford' }],
      entitySpend: [{ month: '2026-09', entityId: 'leb', amount: 1000 }, { month: '2026-10', entityId: 'leb', amount: 1600 }, { month: '2026-10', entityId: null, amount: 50 }],
      vendorSplits: [
        { vendorKey: 'v:k', vendorName: 'Kroger', total: 900, rows: [{ month: '2026-10', entityId: 'mil', amount: 320 }, { month: '2026-10', entityId: 'leb', amount: 80 }] },
        { vendorKey: 'v:a', vendorName: 'Amazon', total: 300, rows: [{ month: '2026-09', entityId: 'leb', amount: 300 }] },
      ],
      anomalies: ANOMALIES,
    });
  });

  test('loads the latest month and lists the trend checks with review links', async () => {
    render(<Trends />, { wrapper: MemoryRouter });
    expect(await screen.findByText('Trend checks for Oct 2026')).toBeInTheDocument();
    expect(getTrends).toHaveBeenCalledWith('g1', undefined);
    expect(screen.getByText('Missing recurring charge')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Review' })).toHaveLength(4);
    expect(screen.getByLabelText('Month')).toHaveValue('2026-10');
  });

  test('spend by entity has a table view, including unassigned spend', async () => {
    const user = userEvent.setup();
    render(<Trends />, { wrapper: MemoryRouter });
    await screen.findByText('Spend by entity by month');
    await user.click(screen.getAllByRole('button', { name: 'Show table' })[0]);
    const table = screen.getByRole('table', { name: 'Spend by entity by month table' });
    expect(table).toHaveTextContent('Unassigned');
    expect(table).toHaveTextContent('$1,650.00');
  });

  test('pick a vendor to see its split by entity', async () => {
    const user = userEvent.setup();
    render(<Trends />, { wrapper: MemoryRouter });
    expect(await screen.findByText('Kroger: split by entity')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Vendor' }));
    await user.click(screen.getByRole('option', { name: /Amazon/ }));
    expect(screen.getByText('Amazon: split by entity')).toBeInTheDocument();
  });
});

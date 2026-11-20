import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({ getControllerOverview: vi.fn(), listControllerLines: vi.fn() }));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import { getControllerOverview, listControllerLines } from '../../api/controller';
import { listGroups } from '../../api/settings';
import LedgerBrowser, { describeChange } from './LedgerBrowser';

const line = (over) => ({
  lineId: 'l1', snapshotId: 's1', fingerprint: 'f1', txnDate: '2026-10-03', txnType: 'Expense', docNum: '1001',
  payeeName: 'Kroger', memo: 'Break room', accountCode: '6100', accountName: 'Supplies', className: null,
  debit: 42.1, credit: 0, amount: 42.1, changeType: null, previous: null, ...over,
});

describe('describeChange', () => {
  test('lists what differs from the previous pull', () => {
    const text = describeChange(line({ debit: 50, className: 'Lebanon', previous: { txnDate: '2026-10-03', debit: 42.1, credit: 0, className: null, payeeName: 'Kroger', memo: 'Break room' } }));
    expect(text).toBe('debit was $42.10; class was (none)');
  });
  test('empty for lines that are not "changed"', () => {
    expect(describeChange(line())).toBe('');
  });
});

describe('LedgerBrowser page', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    getControllerOverview.mockResolvedValue({ qbos: [{ qboId: 'q1', qboName: 'MGMT' }], snapshots: [] });
    listControllerLines.mockResolvedValue({
      snapshots: [{ snapshotId: 's1', month: '2026-10' }],
      previousSnapshot: null,
      total: 1,
      totals: { debit: 42.1, credit: 0 },
      changeCounts: null,
      lines: [line()],
    });
  });

  const renderAt = (url) => render(<MemoryRouter initialEntries={[url]}><LedgerBrowser /></MemoryRouter>);

  test('opens the file and month from the link and lists its lines', async () => {
    renderAt('/controller/ledger?qboId=q1&month=2026-10');
    expect(await screen.findByText('Kroger')).toBeInTheDocument();
    expect(screen.getByText('6100 Supplies')).toBeInTheDocument();
    expect(listControllerLines).toHaveBeenCalledWith('g1', expect.objectContaining({ qboId: 'q1', fromMonth: '2026-10', toMonth: '2026-10', limit: 200, offset: 0 }));
  });

  test('"No class only" filters for unclassified lines', async () => {
    const user = userEvent.setup();
    renderAt('/controller/ledger?qboId=q1&month=2026-10');
    await screen.findByText('Kroger');
    await user.click(screen.getByLabelText('No class only'));
    await waitFor(() =>
      expect(listControllerLines).toHaveBeenLastCalledWith('g1', expect.objectContaining({ className: '__none__' }))
    );
  });

  test('comparing shows change counts and marks changed lines', async () => {
    const user = userEvent.setup();
    renderAt('/controller/ledger?qboId=q1&month=2026-10');
    await screen.findByText('Kroger');

    listControllerLines.mockResolvedValue({
      snapshots: [{ snapshotId: 's2', month: '2026-10' }],
      previousSnapshot: { snapshotId: 's1', pulledAt: '2026-11-01T00:00:00Z' },
      total: 1,
      totals: { debit: 50, credit: 0 },
      changeCounts: { added: 2, changed: 1, removed: 3, unchanged: 10 },
      lines: [line({ debit: 50, changeType: 'changed', previous: { txnDate: '2026-10-03', debit: 42.1, credit: 0, className: null, payeeName: 'Kroger', memo: 'Break room' } })],
    });
    await user.click(screen.getByLabelText('Compare with previous pull'));

    expect(await screen.findByTestId('change-counts')).toHaveTextContent('2 added, 1 changed, 3 removed');
    expect(screen.getByText('changed')).toBeInTheDocument();
    expect(listControllerLines).toHaveBeenLastCalledWith('g1', expect.objectContaining({ compare: 'previous' }));
  });

  test('explains when a month has never been pulled', async () => {
    listControllerLines.mockResolvedValue({ snapshots: [], previousSnapshot: null, total: 0, totals: { debit: 0, credit: 0 }, lines: [] });
    renderAt('/controller/ledger?qboId=q1&month=2026-10');
    expect(await screen.findByText(/Nothing stored for Oct 2026/)).toBeInTheDocument();
  });
});

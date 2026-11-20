import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({
  getControllerOverview: vi.fn(),
  listControllerJobs: vi.fn(),
  startControllerPull: vi.fn(),
  getControllerJob: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import { getControllerOverview, listControllerJobs, startControllerPull, getControllerJob } from '../../api/controller';
import { listGroups } from '../../api/settings';
import ControllerOverview, { gridMonths, indexSnapshots, connectionState } from './ControllerOverview';
import { addMonths, currentMonth } from '../../utils/months';

const lastMonth = addMonths(currentMonth(), -1);

describe('helpers', () => {
  test('gridMonths shows at least 12 months, more if older data exists, capped at 36', () => {
    const now = new Date(2026, 10, 19);
    expect(gridMonths([], now)).toHaveLength(12);
    expect(gridMonths([], now)[11]).toBe('2026-11');
    expect(gridMonths([{ month: '2024-11' }], now)[0]).toBe('2024-11');
    expect(gridMonths([{ month: '2019-01' }], now)).toHaveLength(36);
  });

  test('indexSnapshots keeps the latest pull and counts pulls', () => {
    const index = indexSnapshots([
      { qboId: 'q', month: '2026-10', isLatest: false, lineCount: 1 },
      { qboId: 'q', month: '2026-10', isLatest: true, lineCount: 2 },
    ]);
    expect(index.get('q|2026-10')).toEqual({ pulls: 2, latest: expect.objectContaining({ lineCount: 2 }) });
  });

  test('connectionState flags a connection not renewed for 3+ days', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    expect(connectionState({ isApiConnected: false }, now).label).toBe('Manual upload only');
    expect(connectionState({ isApiConnected: true, tokenExpiry: '2026-11-19T10:00:00Z' }, now).color).toBe('success');
    expect(connectionState({ isApiConnected: true, tokenExpiry: '2026-11-10T10:00:00Z' }, now).color).toBe('warning');
  });
});

describe('ControllerOverview page', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    getControllerOverview.mockResolvedValue({
      qbos: [
        { qboId: 'q1', qboName: 'MGMT', isApiConnected: true, tokenExpiry: new Date(Date.now() + 1800e3).toISOString() },
        { qboId: 'q2', qboName: 'Manual Co', isApiConnected: false, tokenExpiry: null },
      ],
      snapshots: [
        { snapshotId: 's1', qboId: 'q1', month: lastMonth, pulledAt: new Date().toISOString(), lineCount: 1234, isLatest: true, changedFromPrevious: true },
      ],
    });
    listControllerJobs.mockResolvedValue([]);
  });

  const renderPage = () => render(<MemoryRouter><ControllerOverview /></MemoryRouter>);

  test('auto-selects the only Group and shows stored months per file', async () => {
    renderPage();
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(screen.getByLabelText('changed since previous pull')).toBeInTheDocument();
    expect(getControllerOverview).toHaveBeenCalledWith('g1');
    expect(screen.getByText('Manual upload only')).toBeInTheDocument();
  });

  test('only API-connected files can be pulled, and starting a pull tracks the job', async () => {
    const user = userEvent.setup();
    startControllerPull.mockResolvedValue({ jobId: 'job-1' });
    getControllerJob.mockResolvedValue({
      jobId: 'job-1', qboName: 'MGMT', fromMonth: lastMonth, toMonth: lastMonth, status: 'Succeeded',
      taskCounts: { queued: 0, running: 0, succeeded: 1, failed: 0, stalled: 0 }, lineCount: 1234, tasks: [],
    });
    renderPage();
    await screen.findByText('1,234');

    await user.click(screen.getByLabelText('QBO file'));
    const options = within(screen.getByRole('listbox'));
    expect(options.queryByText('Manual Co')).not.toBeInTheDocument();
    await user.click(options.getByText('MGMT'));
    await user.click(screen.getByRole('button', { name: 'Pull month' }));

    expect(startControllerPull).toHaveBeenCalledWith('g1', 'q1', lastMonth, lastMonth);
    expect(await screen.findByTestId('active-job')).toHaveTextContent('1 of 1 months done');
  });

  test('shows an API error', async () => {
    getControllerOverview.mockRejectedValue({ response: { data: { message: 'Not authorized for the Controller module' } } });
    renderPage();
    expect(await screen.findByText('Not authorized for the Controller module')).toBeInTheDocument();
  });
});

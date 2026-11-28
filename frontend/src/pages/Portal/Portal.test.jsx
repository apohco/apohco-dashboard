import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../../api/portal', () => ({
  listPortalReports: vi.fn(),
  getPortalReport: vi.fn(),
  setPortalEntryStatus: vi.fn(),
  addPortalComment: vi.fn(),
  getPortalDoc: vi.fn(),
  exportPortalReport: vi.fn(),
}));

import * as api from '../../api/portal';
import PortalReports, { workLabel } from './PortalReports';
import PortalReport from './PortalReport';

const counts = (over = {}) => ({ notWorked: 2, booked: 0, declined: 0, bookedUnconfirmed: 0, openQuestions: 0, ...over });
const LIST = {
  accountant: { fullName: 'Casey CPA', firm: 'Firm LLP' },
  groups: [{ groupId: 'g1', groupName: 'APOHCO' }],
  reports: [
    { reportId: 'r2', groupId: 'g1', qboId: 'mgmt', qboName: 'APOHCO Management', month: '2026-10', reportNumber: 'MGMT-2026-10-AJE-002', status: 'Published', supersedes: 'MGMT-2026-10-AJE-001', entryCount: 2, totalAmount: 300, counts: counts({ openQuestions: 1 }) },
    { reportId: 'r1', groupId: 'g1', qboId: 'mgmt', qboName: 'APOHCO Management', month: '2026-10', reportNumber: 'MGMT-2026-10-AJE-001', status: 'Superseded', supersedes: null, entryCount: 2, totalAmount: 300, counts: counts() },
  ],
};

const entry = (over = {}) => ({
  entryId: 'e1', entryNumber: 'MGMT-2026-10-AJE-002.01', qboNum: 'MGMT-2610-AJE002.01', kind: 'ClassMove', kindLabel: 'Class change', entryDate: '2026-10-31',
  vendor: 'Kroger', memo: 'MGMT-2026-10-AJE-002.01 Class change', amount: 150, warnings: [], posted: null,
  lines: [{ accountCode: '6100', accountName: 'Supplies', className: 'Lebanon', debit: 150, credit: 0 }],
  sources: [{ side: 'Own', txnDate: '2026-10-05', payeeName: 'Kroger', memo: 'x', amount: 150, from: [], to: [] }],
  support: [{ savedId: 's1', fileName: 'inv.pdf' }],
  portal: { status: 'NotWorked', statusLabel: 'Not worked', reason: null, setBy: null, setAt: null, questionOpen: false, comments: 0 },
  thread: [],
  ...over,
});
const REPORT = { ...LIST.reports[0], entries: [entry()], note: null, supersededBy: null };

const renderReport = () =>
  render(
    <MemoryRouter initialEntries={['/portal/reports/r2']}>
      <Routes>
        <Route path="/portal/reports/:reportId" element={<PortalReport />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.listPortalReports.mockResolvedValue(LIST);
  api.getPortalReport.mockResolvedValue(REPORT);
});

describe('report list', () => {
  test('shows reports in force with progress and open questions; replaced ones on request', async () => {
    render(<MemoryRouter><PortalReports /></MemoryRouter>);
    expect(await screen.findByText('MGMT-2026-10-AJE-002')).toBeInTheDocument();
    expect(screen.getByText('Casey CPA · Firm LLP')).toBeInTheDocument();
    expect(screen.getByText('2 to work')).toBeInTheDocument();
    expect(screen.getByText('1 open')).toBeInTheDocument();
    expect(screen.queryByText('MGMT-2026-10-AJE-001')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('Show replaced reports'));
    expect(screen.getByText('MGMT-2026-10-AJE-001')).toBeInTheDocument();
  });

  test('workLabel', () => {
    expect(workLabel({ status: 'Published', counts: counts({ notWorked: 0 }) })).toBe('All worked');
    expect(workLabel({ status: 'Superseded', counts: counts() })).toBe('Replaced');
  });
});

describe('one report', () => {
  test('marking an entry Booked saves it', async () => {
    api.setPortalEntryStatus.mockResolvedValue({ changed: true, status: 'Booked', statusLabel: 'Booked', setBy: 'Casey CPA', setAt: '2026-11-28T12:00:00Z', reason: null });
    renderReport();
    await screen.findByText('MGMT-2026-10-AJE-002.01');
    await userEvent.click(screen.getByRole('combobox', { name: /Status/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Booked' }));
    await waitFor(() => expect(api.setPortalEntryStatus).toHaveBeenCalledWith('e1', 'Booked', undefined));
    expect(await screen.findByText(/Booked by Casey CPA/)).toBeInTheDocument();
  });

  test('Declined asks for a reason first', async () => {
    api.setPortalEntryStatus.mockResolvedValue({ changed: true, status: 'Declined', statusLabel: 'Declined', setBy: 'Casey CPA', setAt: '2026-11-28', reason: 'Wrong period' });
    renderReport();
    await screen.findByText('MGMT-2026-10-AJE-002.01');
    await userEvent.click(screen.getByRole('combobox', { name: /Status/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Declined' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Decline' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'Wrong period');
    await userEvent.click(confirm);
    await waitFor(() => expect(api.setPortalEntryStatus).toHaveBeenCalledWith('e1', 'Declined', 'Wrong period'));
  });

  test('asking a question adds it to the thread', async () => {
    api.addPortalComment.mockResolvedValue({ commentId: 'c1', authorName: 'Casey CPA', authorRole: 'Accountant', body: 'Which class?', createdAt: '2026-11-28' });
    renderReport();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Comment on MGMT-2026-10-AJE-002.01' }), 'Which class?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(api.addPortalComment).toHaveBeenCalledWith('e1', 'Which class?'));
    expect(await screen.findByText('Which class?')).toBeInTheDocument();
    expect(screen.getByText('Question open')).toBeInTheDocument();
  });

  test('support opens through a short-lived link; exports download', async () => {
    api.getPortalDoc.mockResolvedValue({ url: 'https://signed/doc' });
    api.exportPortalReport.mockResolvedValue({ url: 'https://signed/x.pdf', supportIncluded: 1 });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderReport();
    await userEvent.click(await screen.findByText('inv.pdf'));
    await waitFor(() => expect(api.getPortalDoc).toHaveBeenCalledWith('r2', 's1'));
    expect(open).toHaveBeenCalledWith('https://signed/doc', '_blank', 'noopener');
    await userEvent.click(screen.getByRole('button', { name: 'PDF with support' }));
    await waitFor(() => expect(api.exportPortalReport).toHaveBeenCalledWith('r2', 'pdf'));
    expect(await screen.findByText(/with 1 support file attached/)).toBeInTheDocument();
    open.mockRestore();
  });

  test('a replaced report is read-only', async () => {
    api.getPortalReport.mockResolvedValue({ ...REPORT, status: 'Superseded', supersededBy: 'MGMT-2026-10-AJE-003' });
    renderReport();
    expect(await screen.findByText(/replaced by MGMT-2026-10-AJE-003/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Status/ })).not.toBeInTheDocument();
  });
});

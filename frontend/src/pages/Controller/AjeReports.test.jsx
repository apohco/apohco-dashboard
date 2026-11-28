import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({
  getAjeOverview: vi.fn(),
  getAjeDraft: vi.fn(),
  publishAjeReport: vi.fn(),
  getAjeReport: vi.fn(),
  exportAjeReport: vi.fn(),
  checkAjePosted: vi.fn(),
  saveAjeSettings: vi.fn(),
  getSavedEvidenceDownload: vi.fn(),
  replyToAjeEntry: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import * as api from '../../api/controller';
import { listGroups } from '../../api/settings';
import AjeReports, { describeState, nextReportNumber, postedLabel, revisableReportId } from './AjeReports';

const OVERVIEW = {
  defaultGrouping: 'Grouped',
  files: [
    { qboId: 'mgmt', qboName: 'APOHCO Management', isClassBased: true, fileCode: 'MGMT', codeSaved: true },
    { qboId: 'wpd', qboName: 'Westside Pediatric Dentistry', isClassBased: false, fileCode: 'WPD', codeSaved: false },
  ],
  activity: [{ qboId: 'mgmt', month: '2026-10', decidedLines: 12 }],
  reports: [
    { reportId: 'r1', qboId: 'mgmt', qboName: 'APOHCO Management', month: '2026-10', seq: 1, reportNumber: 'MGMT-2026-10-AJE-001', status: 'Published', entryCount: 2, totalAmount: 300, postedCount: 1, supersedes: null, supersededBy: null },
  ],
};
const ENTRY = (key, over = {}) => ({
  key, kind: 'ClassMove', kindLabel: 'Class change', vendor: 'Kroger', memo: `Class change: Kroger ${key}`, amount: 150, issues: [], warnings: [],
  lines: [{ accountCode: '6100', accountName: 'Supplies', className: 'Lebanon', debit: 150, credit: 0 }, { accountCode: '6100', accountName: 'Supplies', className: 'Unclassified', debit: 0, credit: 150 }],
  sources: [{ side: 'Own', sourceQboId: 'mgmt', fingerprint: `fp-${key}`, txnDate: '2026-10-05', payeeName: 'Kroger', memo: 'x', amount: 150, from: [], to: [] }],
  support: [],
  ...over,
});
const DRAFT = {
  file: OVERVIEW.files[0], month: '2026-10', grouping: 'Grouped', entryDate: '2026-10-31', revise: null,
  activeReports: [{ reportId: 'r1', reportNumber: 'MGMT-2026-10-AJE-001' }],
  entries: [ENTRY('k1'), ENTRY('k2', { vendor: 'Amazon', issues: ['Westside has no QuickBooks class linked in this file (set it in Entities)'] })],
};

const renderPage = () => render(<MemoryRouter><AjeReports /></MemoryRouter>);

describe('helpers', () => {
  test('nextReportNumber continues the file and month sequence', () => {
    expect(nextReportNumber('MGMT', '2026-10', OVERVIEW.reports, 'mgmt')).toBe('MGMT-2026-10-AJE-002');
    expect(nextReportNumber('WPD', '2026-10', OVERVIEW.reports, 'wpd')).toBe('WPD-2026-10-AJE-001');
  });

  test('describeState, postedLabel, revisableReportId', () => {
    expect(describeState([{ code: '6100', name: 'Supplies', className: 'Lebanon', amount: 1 }])).toBe('6100 Supplies · Lebanon');
    expect(describeState([])).toBe('—');
    expect(postedLabel({ entryCount: 2, postedCount: 1 })).toBe('1 of 2 posted');
    expect(postedLabel({ entryCount: 2, postedCount: 2 })).toBe('All posted');
    expect(postedLabel({ entryCount: 2, postedCount: 0 })).toBe('Not seen in GL');
    const reports = [
      { reportId: 'a', qboId: 'm', month: '2026-10', seq: 1, status: 'Superseded' },
      { reportId: 'b', qboId: 'm', month: '2026-10', seq: 2, status: 'Published' },
      { reportId: 'c', qboId: 'm', month: '2026-10', seq: 3, status: 'Published' },
    ];
    expect(revisableReportId(reports, reports[1])).toBe('c');
  });
});

describe('AJE reports page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    api.getAjeOverview.mockResolvedValue(OVERVIEW);
    api.getAjeDraft.mockResolvedValue(DRAFT);
  });

  test('shows the draft for the busiest month; entries with problems are left out and locked', async () => {
    renderPage();
    expect(await screen.findByText(/Publishing numbers this report/)).toBeInTheDocument();
    expect(screen.getByText('MGMT-2026-10-AJE-002')).toBeInTheDocument();
    expect(api.getAjeDraft).toHaveBeenCalledWith('g1', { qboId: 'mgmt', month: '2026-10', grouping: 'Grouped', reviseReportId: undefined });
    expect(screen.getByRole('checkbox', { name: 'Include Kroger' })).toBeChecked();
    const blocked = screen.getByRole('checkbox', { name: 'Include Amazon' });
    expect(blocked).not.toBeChecked();
    expect(blocked).toBeDisabled();
    expect(screen.getByText(/Westside has no QuickBooks class/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish 1 entry' })).toBeEnabled();
  });

  test('publishes the chosen entries with edited memos and the draft keys', async () => {
    api.publishAjeReport.mockResolvedValue({ reportId: 'r2', reportNumber: 'MGMT-2026-10-AJE-002', entryCount: 1, totalAmount: 150, supersedes: null });
    renderPage();
    const memo = (await screen.findAllByRole('textbox', { name: 'Memo' }))[0];
    await userEvent.clear(memo);
    await userEvent.type(memo, 'Groceries to Lebanon');
    await userEvent.click(screen.getByRole('button', { name: 'Publish 1 entry' }));
    await waitFor(() => expect(api.publishAjeReport).toHaveBeenCalled());
    expect(api.publishAjeReport).toHaveBeenCalledWith('g1', {
      qboId: 'mgmt', month: '2026-10', grouping: 'Grouped', expectedKeys: ['k1', 'k2'], include: [{ key: 'k1', memo: 'Groceries to Lebanon' }],
    });
    expect(await screen.findByText(/Published MGMT-2026-10-AJE-002/)).toBeInTheDocument();
  });

  test('switching to per line reloads the draft', async () => {
    renderPage();
    await screen.findByText(/Publishing numbers this report/);
    await userEvent.click(screen.getByRole('button', { name: 'Per line' }));
    await waitFor(() => expect(api.getAjeDraft).toHaveBeenLastCalledWith('g1', { qboId: 'mgmt', month: '2026-10', grouping: 'PerLine', reviseReportId: undefined }));
  });

  test('a published report opens with QBO Nums, posted state and exports; Revise loads a revision draft', async () => {
    api.getAjeReport.mockResolvedValue({
      ...OVERVIEW.reports[0], qboName: 'APOHCO Management', grouping: 'Grouped', note: null,
      entries: [{
        entryId: 'e1', entryNumber: 'MGMT-2026-10-AJE-001.01', qboNum: 'MGMT-2610-AJE001.01', kind: 'ClassMove', kindLabel: 'Class change', vendor: 'Kroger',
        entryDate: '2026-10-31', memo: 'MGMT-2026-10-AJE-001.01 Class change', amount: 150, warnings: [], lines: ENTRY('x').lines,
        posted: { month: '2026-10', docNum: 'MGMT-2610-AJE001.01' }, sources: ENTRY('x').sources, support: [{ savedId: 's1', fileName: 'inv.pdf' }],
      }],
    });
    api.exportAjeReport.mockResolvedValue({ url: 'https://signed/x', fileName: 'x.pdf', supportIncluded: 1 });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'MGMT-2026-10-AJE-001' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('MGMT-2610-AJE001.01')).toBeInTheDocument();
    expect(within(dialog).getByText('Posted (seen in Oct 2026 GL)')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'PDF with support' }));
    await waitFor(() => expect(api.exportAjeReport).toHaveBeenCalledWith('g1', 'r1', 'pdf'));
    expect(open).toHaveBeenCalledWith('https://signed/x', '_blank', 'noopener');
    expect(await within(dialog).findByText(/with 1 support file attached/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Revise…' }));
    await waitFor(() => expect(api.getAjeDraft).toHaveBeenLastCalledWith('g1', { qboId: 'mgmt', month: '2026-10', grouping: 'Grouped', reviseReportId: 'r1' }));
    expect(screen.getByText('Revise MGMT-2026-10-AJE-001')).toBeInTheDocument();
    open.mockRestore();
  });

  test("a report shows the accountant's status and question, and the controller can reply", async () => {
    const detail = (thread) => ({
      ...OVERVIEW.reports[0], qboName: 'APOHCO Management', grouping: 'Grouped', note: null,
      entries: [{
        entryId: 'e1', entryNumber: 'MGMT-2026-10-AJE-001.01', qboNum: 'MGMT-2610-AJE001.01', kind: 'ClassMove', kindLabel: 'Class change', vendor: 'Kroger',
        entryDate: '2026-10-31', memo: 'm', amount: 150, warnings: [], lines: ENTRY('x').lines, posted: null, sources: ENTRY('x').sources, support: [],
        portal: { status: 'Declined', statusLabel: 'Declined', reason: 'Wrong period', setBy: 'Casey', questionOpen: true, comments: 1 },
        thread,
      }],
    });
    const question = { commentId: 'c1', authorName: 'Casey', authorRole: 'Accountant', body: 'Is this October?', createdAt: '2026-11-27' };
    api.getAjeReport.mockResolvedValueOnce(detail([question])).mockResolvedValueOnce(detail([question, { ...question, commentId: 'c2', authorName: 'paul', authorRole: 'Controller', body: 'Yes.' }]));
    api.replyToAjeEntry.mockResolvedValue({});
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'MGMT-2026-10-AJE-001' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Accountant: Declined')).toBeInTheDocument();
    expect(within(dialog).getByText('Question open')).toBeInTheDocument();
    expect(within(dialog).getByText(/Declined by Casey: Wrong period/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Comment on MGMT-2026-10-AJE-001.01' }), 'Yes.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(api.replyToAjeEntry).toHaveBeenCalledWith('g1', 'e1', 'Yes.'));
    expect(await within(dialog).findByText('Yes.')).toBeInTheDocument();
  });

  test('settings save file codes and the default grouping', async () => {
    api.saveAjeSettings.mockResolvedValue(OVERVIEW);
    renderPage();
    await screen.findByText(/Publishing numbers this report/);
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const code = await screen.findByRole('textbox', { name: 'Code for Westside Pediatric Dentistry' });
    await userEvent.clear(code);
    await userEvent.type(code, 'wsd');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveAjeSettings).toHaveBeenCalledWith('g1', {
      defaultGrouping: 'Grouped', files: [{ qboId: 'mgmt', fileCode: 'MGMT' }, { qboId: 'wpd', fileCode: 'WSD' }],
    }));
  });

  test('nothing to recommend', async () => {
    api.getAjeDraft.mockResolvedValue({ ...DRAFT, entries: [], activeReports: [] });
    renderPage();
    expect(await screen.findByText(/Nothing to recommend/)).toBeInTheDocument();
  });
});

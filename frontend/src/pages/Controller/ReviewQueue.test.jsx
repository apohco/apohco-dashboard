import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({
  getControllerOverview: vi.fn(),
  getReviewAccounts: vi.fn(),
  saveDueToFromAccount: vi.fn(),
  getReviewSettings: vi.fn(),
  listReviewLines: vi.fn(),
  listReviewRuns: vi.fn(),
  saveReviewDecisions: vi.fn(),
  saveReviewSettings: vi.fn(),
  startReviewRun: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import {
  getControllerOverview,
  getReviewAccounts,
  getReviewSettings,
  listReviewLines,
  saveDueToFromAccount,
  listReviewRuns,
  saveReviewDecisions,
  saveReviewSettings,
  startReviewRun,
} from '../../api/controller';
import { listGroups } from '../../api/settings';
import ReviewQueue, { confidenceLabel, describeDecision, describeSuggestion, splitFromTemplate } from './ReviewQueue';

const ENTITIES = [
  { entityId: 'leb', entityName: 'Lebanon' },
  { entityId: 'mil', entityName: 'Milford' },
];
const line = (over = {}) => ({
  lineId: 'l1', txnDate: '2026-10-03', vendorName: 'Kroger', payeeName: 'Kroger', memo: 'Breakroom', accountCode: '6100',
  accountName: 'Supplies', accountType: 'Expense', amount: 100, className: 'Milford', currentEntityId: 'mil', suggestedEntityId: 'leb',
  confidence: 0.95, status: 'LikelyMisclassified', reasons: ['History: 95% went to Lebanon'], decision: null, watchMode: false,
  splitTemplate: null, ...over,
});
const summary = {
  Conflict: { count: 0, open: 0, amount: 0 },
  LikelyMisclassified: { count: 1, open: 1, amount: 100 },
  Unclassified: { count: 0, open: 0, amount: 0 },
  NeedsEvidence: { count: 0, open: 0, amount: 0 },
  Confirmed: { count: 250, open: 250, amount: 5000 },
};
const linesResponse = (lines, total = lines.length) => ({
  run: { runId: 'run-1', threshold: 0.9, mediumThreshold: 0.7 },
  entities: ENTITIES,
  summary,
  total,
  totalAmount: 5100,
  lines,
});

const ACCOUNTS = {
  ownerEntityId: 'mil',
  accounts: [
    { code: '1500', name: 'Due From Lebanon', type: 'Asset' },
    { code: '6100', name: 'Supplies', type: 'Expense' },
    { code: '6150', name: 'Breakroom', type: 'Expense' },
  ],
  dueToFrom: [{ entityId: 'leb', account: { code: '1500', name: 'Due From Lebanon' } }],
};

describe('helpers', () => {
  test('confidenceLabel', () => {
    expect(confidenceLabel(0.95, 0.9, 0.7)).toBe('High 95%');
    expect(confidenceLabel(0.8, 0.9, 0.7)).toBe('Medium 80%');
    expect(confidenceLabel(0.5, 0.9, 0.7)).toBe('Low 50%');
    expect(confidenceLabel(0, 0.9, 0.7)).toBeNull();
  });

  test('splitFromTemplate puts the rounding remainder on the last entity', () => {
    expect(splitFromTemplate([{ entityId: 'a', percent: 33.33 }, { entityId: 'b', percent: 33.33 }, { entityId: 'c', percent: 33.34 }], -100)).toEqual([
      { entityId: 'a', amount: '33.33' }, { entityId: 'b', amount: '33.33' }, { entityId: 'c', amount: '33.34' },
    ]);
    expect(splitFromTemplate(null, 10)).toEqual([]);
  });

  test('describeDecision', () => {
    const name = (id) => ({ leb: 'Lebanon', mil: 'Milford' })[id];
    expect(describeDecision({ action: 'Approve', entityId: 'leb' }, name)).toBe('Approved: Lebanon');
    expect(describeDecision({ action: 'Split', allocations: [{ entityId: 'leb', amount: 60 }, { entityId: 'mil', amount: 40 }] }, name)).toBe(
      'Split: Lebanon $60.00, Milford $40.00'
    );
    expect(describeDecision(null, name)).toBeNull();
  });
});

describe('ReviewQueue page', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    getControllerOverview.mockResolvedValue({
      qbos: [{ qboId: 'mgmt', qboName: 'APOHCO', isClassBased: true }, { qboId: 'wpd', qboName: 'WPD', isClassBased: false }],
      snapshots: [],
    });
    listReviewRuns.mockResolvedValue({
      latestSnapshot: { snapshotId: 's1' },
      runs: [{ runId: 'run-1', runDate: '2026-11-23T10:00:00Z', lineCount: 251, isStale: false }],
    });
    saveReviewDecisions.mockResolvedValue({ decided: 1, skipped: { alreadyDecided: 0, watchMode: 0, nothingToApply: 0 } });
    getReviewAccounts.mockResolvedValue(ACCOUNTS);
  });

  test('loads the latest run for the class-based file, filtered to open Expense lines', async () => {
    listReviewLines.mockResolvedValue(linesResponse([line()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    expect(await screen.findByText('Breakroom')).toBeInTheDocument();
    expect(listReviewRuns).toHaveBeenCalledWith('g1', 'mgmt', expect.stringMatching(/^\d{4}-\d{2}$/));
    expect(listReviewLines).toHaveBeenCalledWith('g1', expect.objectContaining({ runId: 'run-1', reviewState: 'open', accountType: 'Expense', offset: 0 }));
    expect(screen.getByText('High 95%')).toBeInTheDocument();
    expect(screen.getByText(/Confirmed: 250 open of 250/)).toBeInTheDocument();
  });

  test('approving one line records a decision for that line', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(linesResponse([line()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole('button', { name: 'Approve l1' }));
    expect(saveReviewDecisions).toHaveBeenCalledWith('g1', { runId: 'run-1', action: 'Approve', lineIds: ['l1'] });
    expect(await screen.findByText(/Approve recommendation: 1 line\./)).toBeInTheDocument();
  });

  test('select all matching lines, then bulk approve by filter after confirming the count', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 3 }, (_, i) => line({ lineId: `l${i}`, status: 'Confirmed', memo: `m${i}` }));
    listReviewLines.mockResolvedValue(linesResponse(many, 250));
    saveReviewDecisions.mockResolvedValue({ decided: 248, skipped: { alreadyDecided: 0, watchMode: 2, nothingToApply: 0 } });
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await screen.findByText('m0');

    await user.click(screen.getByRole('checkbox', { name: 'Select page' }));
    await user.click(screen.getByRole('button', { name: 'Select all 250 matching lines' }));
    expect(within(screen.getByTestId('bulk-bar')).getByText(/250 selected/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve recommendation' }));
    expect(screen.getByText(/Apply to all 250 matching lines\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(saveReviewDecisions).toHaveBeenCalledWith('g1', {
      runId: 'run-1', action: 'Approve', expectedCount: 250, filter: { reviewState: 'open', accountType: 'Expense' },
    });
    expect(await screen.findByText(/248 lines \(skipped 2 from watch-mode vendors\)/)).toBeInTheDocument();
  });

  test('split a line using the vendor template', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(linesResponse([line({ splitTemplate: [{ entityId: 'leb', percent: 60 }, { entityId: 'mil', percent: 40 }] })]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole('button', { name: 'More actions for l1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Split…' }));
    expect(screen.getByText('Adds up to the line amount.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save split' }));
    expect(saveReviewDecisions).toHaveBeenCalledWith('g1', {
      runId: 'run-1', action: 'Split', lineIds: ['l1'], allocations: [{ entityId: 'leb', amount: 60 }, { entityId: 'mil', amount: 40 }],
    });
  });

  test('a split that does not add up cannot be saved', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(linesResponse([line()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole('button', { name: 'More actions for l1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Split…' }));
    await user.type(screen.getByLabelText('Split amount 1'), '70');
    await user.type(screen.getByLabelText('Split amount 2'), '20');
    expect(screen.getByText('$10.00 left to assign')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save split' })).toBeDisabled();
  });

  test('running a review when no run exists yet', async () => {
    const user = userEvent.setup();
    listReviewRuns.mockResolvedValueOnce({ latestSnapshot: { snapshotId: 's1' }, runs: [] });
    startReviewRun.mockResolvedValue({ lineCount: 251 });
    listReviewLines.mockResolvedValue(linesResponse([line()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole('button', { name: 'Run review' }));
    expect(startReviewRun).toHaveBeenCalledWith('g1', 'mgmt', expect.any(String));
    await waitFor(() => expect(listReviewLines).toHaveBeenCalled());
    expect(await screen.findByText('Reviewed 251 lines.')).toBeInTheDocument();
  });
});

describe('account review helpers', () => {
  const name = (id) => ({ leb: 'Lebanon', mil: 'Milford' })[id];
  test('describeDecision for Reclassify, Due To/From and Keep', () => {
    expect(describeDecision({ action: 'Reclassify', targetAccount: { code: '6150', name: 'Breakroom' } }, name)).toBe('Reclassified to 6150 Breakroom');
    expect(describeDecision({ action: 'DueToFrom', counterpartyEntityId: 'leb', targetAccount: { code: null, name: 'Due From Lebanon' } }, name)).toBe(
      'Due To/From Lebanon (Due From Lebanon)'
    );
    expect(describeDecision({ action: 'Keep', entityId: null }, name)).toBe('Kept as is');
  });

  test('describeSuggestion', () => {
    const l = { accountCode: '6100', accountName: 'Supplies' };
    expect(describeSuggestion({ ...l, suggestedAction: 'Keep' }, name)).toBe('Keep in 6100 Supplies');
    expect(describeSuggestion({ ...l, suggestedAction: 'Reclassify', suggestedAccount: { code: '6150', name: 'Breakroom' } }, name)).toBe('Reclassify to 6150 Breakroom');
    expect(describeSuggestion({ ...l, suggestedAction: 'DueToFrom', suggestedEntityId: 'leb' }, name)).toBe('Due To/From Lebanon');
    expect(describeSuggestion({ ...l, suggestedAction: null }, name)).toBe('—');
  });
});

describe('account review of a file without classes', () => {
  const accountLine = (over = {}) =>
    line({
      className: '', currentEntityId: 'mil', suggestedEntityId: null, suggestedAction: 'Reclassify',
      suggestedAccount: { code: '6150', name: 'Breakroom' }, status: 'LikelyMisclassified', ...over,
    });
  const accountResponse = (lines) => ({ ...linesResponse(lines), run: { runId: 'run-2', reviewKind: 'Account', threshold: 0.9, mediumThreshold: 0.7 } });

  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    getControllerOverview.mockResolvedValue({ qbos: [{ qboId: 'mil-file', qboName: 'Milford', isClassBased: false }], snapshots: [] });
    listReviewRuns.mockResolvedValue({ latestSnapshot: { snapshotId: 's2' }, runs: [{ runId: 'run-2', runDate: '2026-11-23T10:00:00Z', lineCount: 40, isStale: false }] });
    getReviewAccounts.mockResolvedValue(ACCOUNTS);
    saveReviewDecisions.mockResolvedValue({ decided: 1, skipped: { alreadyDecided: 0, watchMode: 0, nothingToApply: 0, noDueToFromAccount: 0 } });
  });

  test('shows account suggestions and account actions (no class or entity actions)', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(accountResponse([accountLine()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    expect(await screen.findByText('Reclassify to 6150 Breakroom')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'QBO file' })).toHaveTextContent('Milford (account review)');
    expect(screen.queryByText('Class now')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set entity…' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep as is' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions for l1' }));
    expect(screen.queryByRole('menuitem', { name: 'Split…' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Reclassify…' })).toBeInTheDocument();
  });

  test('reclassify one line to another account', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(accountResponse([accountLine()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole('button', { name: 'More actions for l1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Reclassify…' }));
    await user.click(screen.getByLabelText('Move to account'));
    await user.click(screen.getByRole('option', { name: '6150 Breakroom' }));
    await user.click(screen.getByRole('button', { name: 'Reclassify' }));
    expect(saveReviewDecisions).toHaveBeenCalledWith('g1', {
      runId: 'run-2', action: 'Reclassify', lineIds: ['l1'], account: { code: '6150', name: 'Breakroom' },
    });
  });

  test("due to/from uses the entity's saved account (the file's own entity is not offered)", async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(accountResponse([accountLine()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole('button', { name: 'More actions for l1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Due To/From…' }));
    await user.click(screen.getByRole('combobox', { name: 'Other entity' }));
    expect(screen.queryByRole('option', { name: 'Milford' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Lebanon' }));
    expect(screen.getByLabelText('Due To/From account in this file')).toHaveValue('1500 Due From Lebanon');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveReviewDecisions).toHaveBeenCalledWith('g1', { runId: 'run-2', action: 'DueToFrom', lineIds: ['l1'], counterpartyEntityId: 'leb' });
  });

  test('bulk due to/from with a newly chosen account saves the account too', async () => {
    const user = userEvent.setup();
    getReviewAccounts.mockResolvedValue({ ...ACCOUNTS, dueToFrom: [] });
    listReviewLines.mockResolvedValue(accountResponse([accountLine(), accountLine({ lineId: 'l2', memo: 'other' })]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await screen.findByText('other');
    await user.click(screen.getByRole('checkbox', { name: 'Select page' }));
    await user.click(screen.getByRole('button', { name: 'Due To/From…' }));
    await user.click(screen.getByRole('combobox', { name: 'Other entity' }));
    await user.click(screen.getByRole('option', { name: 'Lebanon' }));
    await user.click(screen.getByLabelText('Due To/From account in this file'));
    await user.click(screen.getByRole('option', { name: '1500 Due From Lebanon' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveReviewDecisions).toHaveBeenCalledWith('g1', {
      runId: 'run-2', action: 'DueToFrom', lineIds: ['l1', 'l2'], counterpartyEntityId: 'leb',
      account: { code: '1500', name: 'Due From Lebanon' }, rememberAccount: true,
    });
    await waitFor(() => expect(getReviewAccounts).toHaveBeenCalledTimes(2));
  });

  test('the account named for the entity is filled in when none is saved', async () => {
    const user = userEvent.setup();
    getReviewAccounts.mockResolvedValue({ ...ACCOUNTS, dueToFrom: [], detectedDueToFrom: [{ entityId: 'leb', account: { code: '1500', name: 'Due From Lebanon' } }] });
    listReviewLines.mockResolvedValue(accountResponse([accountLine()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole('button', { name: 'More actions for l1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Due To/From…' }));
    await user.click(screen.getByRole('combobox', { name: 'Other entity' }));
    await user.click(screen.getByRole('option', { name: 'Lebanon' }));
    expect(screen.getByLabelText('Due To/From account in this file')).toHaveValue('1500 Due From Lebanon');
    expect(screen.getByRole('checkbox', { name: /Make this the default/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveReviewDecisions).toHaveBeenCalledWith('g1', {
      runId: 'run-2', action: 'DueToFrom', lineIds: ['l1'], counterpartyEntityId: 'leb',
      account: { code: '1500', name: 'Due From Lebanon' }, rememberAccount: true,
    });
  });

  test('a one-off account (e.g. Due To instead of Due From) is not made the default unless ticked', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(accountResponse([accountLine()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole('button', { name: 'More actions for l1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Due To/From…' }));
    await user.click(screen.getByRole('combobox', { name: 'Other entity' }));
    await user.click(screen.getByRole('option', { name: 'Lebanon' }));
    expect(screen.queryByRole('checkbox', { name: /Make this the default/ })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Due To/From account in this file'));
    await user.click(screen.getByRole('option', { name: '6150 Breakroom' }));
    expect(screen.getByRole('checkbox', { name: /Make this the default/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveReviewDecisions).toHaveBeenCalledWith('g1', {
      runId: 'run-2', action: 'DueToFrom', lineIds: ['l1'], counterpartyEntityId: 'leb',
      account: { code: '6150', name: 'Breakroom' }, rememberAccount: false,
    });
    expect(getReviewAccounts).toHaveBeenCalledTimes(1);
  });

  test('set up the Due To/From accounts for the file', async () => {
    const user = userEvent.setup();
    getReviewAccounts.mockResolvedValue({ ...ACCOUNTS, dueToFrom: [] });
    saveDueToFromAccount.mockResolvedValue({});
    listReviewLines.mockResolvedValue(accountResponse([accountLine()]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await screen.findByText('Reclassify to 6150 Breakroom');
    await user.click(screen.getByRole('button', { name: 'Due To/From accounts' }));
    // One picker per other entity (not Milford, whose file this is).
    expect(screen.queryByLabelText('Milford')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Lebanon'));
    await user.click(screen.getByRole('option', { name: '1500 Due From Lebanon' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveDueToFromAccount).toHaveBeenCalledWith('g1', 'mil-file', 'leb', { code: '1500', name: 'Due From Lebanon' });
    expect(await screen.findByText(/Due To\/From accounts saved/)).toBeInTheDocument();
  });
});

describe('Phase 2b: drill-down links, conflicts prompt, trend settings', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    getControllerOverview.mockResolvedValue({
      qbos: [{ qboId: 'mgmt', qboName: 'APOHCO', isClassBased: true }, { qboId: 'wpd', qboName: 'WPD', isClassBased: false }],
      snapshots: [],
    });
    listReviewRuns.mockResolvedValue({ latestSnapshot: { snapshotId: 's1' }, runs: [{ runId: 'run-1', runDate: '2026-11-23T10:00:00Z', lineCount: 5, isStale: false }] });
    getReviewAccounts.mockResolvedValue(ACCOUNTS);
  });
  const at = (path) => ({ wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter> });

  test('a link with ?qboId=&month=&vendor= opens that file and month, filtered to the vendor (all lines)', async () => {
    listReviewLines.mockResolvedValue(linesResponse([line()]));
    render(<ReviewQueue />, at('/controller/review?qboId=wpd&month=2026-09&vendor=Kroger'));
    await screen.findByText('Breakroom');
    expect(listReviewRuns).toHaveBeenCalledWith('g1', 'wpd', '2026-09');
    expect(listReviewLines).toHaveBeenCalledWith('g1', expect.objectContaining({ vendor: 'Kroger', reviewState: 'all' }));
    expect(screen.getByLabelText('Vendor')).toHaveValue('Kroger');
  });

  test('open conflicts on a class review point to the Conflicts screen', async () => {
    listReviewLines.mockResolvedValue({ ...linesResponse([line()]), summary: { ...summary, Conflict: { count: 2, open: 2, amount: 50 } } });
    render(<ReviewQueue />, at('/controller/review?month=2026-10'));
    const link = await screen.findByRole('link', { name: 'Resolve in Conflicts' });
    expect(link).toHaveAttribute('href', '/controller/conflicts?qboId=mgmt&month=2026-10');
  });

  test('settings include the trend-check thresholds', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(linesResponse([line()]));
    getReviewSettings.mockResolvedValue({
      threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12, splitShiftPoints: 25, spikePercent: 50, spikeMinAmount: 500, recurringMonths: 3, baselineMonths: 6,
    });
    saveReviewSettings.mockResolvedValue({});
    render(<ReviewQueue />, at('/controller/review'));
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const spike = await screen.findByLabelText('Spend spike, at least ($)');
    await user.clear(spike);
    await user.type(spike, '750');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveReviewSettings).toHaveBeenCalledWith('g1', {
      threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12, splitShiftPoints: 25, spikePercent: 50, spikeMinAmount: 750, recurringMonths: 3, baselineMonths: 6,
    });
  });
});

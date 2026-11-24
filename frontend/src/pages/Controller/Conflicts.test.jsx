import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({
  getControllerOverview: vi.fn(),
  listReviewRuns: vi.fn(),
  listConflicts: vi.fn(),
  previewRelabel: vi.fn(),
  resolveConflict: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import { getControllerOverview, listConflicts, listReviewRuns, previewRelabel, resolveConflict } from '../../api/controller';
import { listGroups } from '../../api/settings';
import Conflicts, { describeResolution } from './Conflicts';

const ENTITIES = [
  { entityId: 'leb', entityName: 'Lebanon' },
  { entityId: 'mil', entityName: 'Milford' },
];
const conflict = (over = {}) => ({
  lineId: 'l1', txnDate: '2026-10-03', vendorName: 'Kroger', memo: 'breakroom', accountCode: '6100', accountName: 'Supplies', className: 'Milford',
  amount: 42.1, currentEntityId: 'mil', decision: null,
  rule: { ruleId: 'r2', version: 2, text: 'Kroger is Lebanon', defaultEntityId: 'leb', keywords: [], entityId: 'leb', matchedKeyword: null, ruleWins: false },
  history: { scope: 'account', total: 19, shares: [{ entityId: 'mil', weight: 18, share: 0.947 }, { entityId: 'leb', weight: 1, share: 0.053 }] },
  ...over,
});
const renderPage = (path = '/controller/conflicts?month=2026-10') => render(<Conflicts />, { wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter> });

test('describeResolution', () => {
  const name = (id) => ({ leb: 'Lebanon' })[id];
  expect(describeResolution({ resolution: 'RuleWinsRelabel', entityId: 'leb' }, name)).toBe('Rule wins, history relabeled: Lebanon');
  expect(describeResolution(null, name)).toBeNull();
});

describe('Conflicts page', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    getControllerOverview.mockResolvedValue({ qbos: [{ qboId: 'mgmt', qboName: 'APOHCO', isClassBased: true }, { qboId: 'wpd', qboName: 'WPD', isClassBased: false }] });
    listReviewRuns.mockResolvedValue({ runs: [{ runId: 'run-1' }] });
    listConflicts.mockResolvedValue({ entities: ENTITIES, conflicts: [conflict(), conflict({ lineId: 'l2', memo: 'done', decision: { action: 'Keep', entityId: 'mil', resolution: 'LineOnly' } })] });
    resolveConflict.mockResolvedValue({ resolution: 'RuleWins', decided: 3, relabeled: 0, ruleVersion: 3 });
  });

  test('shows the rule and the history side by side for the latest run of the class-based file', async () => {
    renderPage();
    const card = await screen.findByTestId('conflict');
    expect(listReviewRuns).toHaveBeenCalledWith('g1', 'mgmt', '2026-10');
    expect(within(card).getByText('Rule v2 says Lebanon')).toBeInTheDocument();
    expect(within(card).getByText('“Kroger is Lebanon”')).toBeInTheDocument();
    expect(within(card).getByText('History says Milford')).toBeInTheDocument();
    expect(within(card).getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('1 open · 1 resolved')).toBeInTheDocument();
    expect(screen.getByText('This transaction only: Milford')).toBeInTheDocument();
  });

  test('this transaction only', async () => {
    const user = userEvent.setup();
    resolveConflict.mockResolvedValue({ resolution: 'LineOnly', decided: 1, relabeled: 0, ruleVersion: null });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'This transaction only…' }));
    await user.click(screen.getByRole('combobox', { name: 'Entity for this line' }));
    await user.click(screen.getByRole('option', { name: 'Milford' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(resolveConflict).toHaveBeenCalledWith('g1', 'run-1', 'l1', { resolution: 'LineOnly', entityId: 'mil' });
    expect(await screen.findByText('This transaction only: 1 line decided.')).toBeInTheDocument();
  });

  test('rule wins from now on', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Rule wins from now on' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(resolveConflict).toHaveBeenCalledWith('g1', 'run-1', 'l1', { resolution: 'RuleWins' });
    expect(await screen.findByText('Rule wins from now on: 3 lines decided, rule v3 now takes priority.')).toBeInTheDocument();
    expect(previewRelabel).not.toHaveBeenCalled();
  });

  test('rule wins and relabel: preview, then the AJE request is off unless ticked', async () => {
    const user = userEvent.setup();
    previewRelabel.mockResolvedValue({
      count: 37, amount: 4210, months: ['2026-01', '2026-02'], byMonth: {}, previouslyDecided: 2, skippedSplits: 1, ruleVersion: 2,
      sample: [{ lineId: 'o1', txnDate: '2026-01-05', memo: 'old', account: '6100 Supplies', amount: 10, fromEntityId: 'mil', toEntityId: 'leb' }],
    });
    resolveConflict.mockResolvedValue({ resolution: 'RuleWinsRelabel', decided: 1, relabeled: 37, ruleVersion: 3 });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Rule wins and relabel history…' }));
    expect(await screen.findByText(/Relabel 37 earlier lines across 2 months, \$4,210\.00\./)).toBeInTheDocument();
    expect(screen.getByText(/2 of them had an earlier decision/)).toBeInTheDocument();
    const aje = screen.getByRole('checkbox', { name: 'Request adjusting journal entries for the relabeled lines' });
    expect(aje).not.toBeChecked();
    await user.click(aje);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(resolveConflict).toHaveBeenCalledWith('g1', 'run-1', 'l1', { resolution: 'RuleWinsRelabel', requestAje: true, expectedRelabelCount: 37 });
    expect(await screen.findByText(/37 earlier lines relabeled/)).toBeInTheDocument();
  });

  test('no run yet points to Review', async () => {
    listReviewRuns.mockResolvedValue({ runs: [] });
    renderPage();
    expect(await screen.findByRole('link', { name: 'Run it in Review' })).toBeInTheDocument();
    expect(listConflicts).not.toHaveBeenCalled();
  });
});

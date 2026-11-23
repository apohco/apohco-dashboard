import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/controller', () => ({
  getControllerOverview: vi.fn(),
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
  listReviewLines,
  listReviewRuns,
  saveReviewDecisions,
  startReviewRun,
} from '../../api/controller';
import { listGroups } from '../../api/settings';
import ReviewQueue, { confidenceLabel, describeDecision, splitFromTemplate } from './ReviewQueue';

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
  });

  test('loads the latest run for the class-based file, filtered to open Expense lines', async () => {
    listReviewLines.mockResolvedValue(linesResponse([line()]));
    render(<ReviewQueue />);
    expect(await screen.findByText('Breakroom')).toBeInTheDocument();
    expect(listReviewRuns).toHaveBeenCalledWith('g1', 'mgmt', expect.stringMatching(/^\d{4}-\d{2}$/));
    expect(listReviewLines).toHaveBeenCalledWith('g1', expect.objectContaining({ runId: 'run-1', reviewState: 'open', accountType: 'Expense', offset: 0 }));
    expect(screen.getByText('High 95%')).toBeInTheDocument();
    expect(screen.getByText(/Confirmed: 250 open of 250/)).toBeInTheDocument();
  });

  test('approving one line records a decision for that line', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(linesResponse([line()]));
    render(<ReviewQueue />);
    await user.click(await screen.findByRole('button', { name: 'Approve l1' }));
    expect(saveReviewDecisions).toHaveBeenCalledWith('g1', { runId: 'run-1', action: 'Approve', lineIds: ['l1'] });
    expect(await screen.findByText(/Approve recommendation: 1 line\./)).toBeInTheDocument();
  });

  test('select all matching lines, then bulk approve by filter after confirming the count', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 3 }, (_, i) => line({ lineId: `l${i}`, status: 'Confirmed', memo: `m${i}` }));
    listReviewLines.mockResolvedValue(linesResponse(many, 250));
    saveReviewDecisions.mockResolvedValue({ decided: 248, skipped: { alreadyDecided: 0, watchMode: 2, nothingToApply: 0 } });
    render(<ReviewQueue />);
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
    render(<ReviewQueue />);
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
    render(<ReviewQueue />);
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
    render(<ReviewQueue />);
    await user.click(await screen.findByRole('button', { name: 'Run review' }));
    expect(startReviewRun).toHaveBeenCalledWith('g1', 'mgmt', expect.any(String));
    await waitFor(() => expect(listReviewLines).toHaveBeenCalled());
    expect(await screen.findByText('Reviewed 251 lines.')).toBeInTheDocument();
  });
});

// Phase 3: AI suggestions in the Review queue.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  getAiStatus: vi.fn(),
  getAiUsage: vi.fn(),
  startAiJob: vi.fn(),
  getAiJob: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import {
  getControllerOverview,
  getReviewAccounts,
  getReviewSettings,
  listReviewLines,
  listReviewRuns,
  saveReviewDecisions,
  saveReviewSettings,
  startReviewRun,
  getAiStatus,
  getAiUsage,
  startAiJob,
} from '../../api/controller';
import { listGroups } from '../../api/settings';
import ReviewQueue from './ReviewQueue';

const ENTITIES = [
  { entityId: 'leb', entityName: 'Lebanon' },
  { entityId: 'mil', entityName: 'Milford' },
];
const AI_IDLE = { enabled: true, confidenceCap: 0.85, monthSpend: 0, monthlyBudget: 25, answered: 0, suggested: 0, job: null };
const line = (over = {}) => ({
  lineId: 'l1', txnDate: '2026-10-03', vendorName: 'Kroger', payeeName: 'Kroger', memo: 'Breakroom', accountCode: '6100',
  accountName: 'Supplies', accountType: 'Expense', amount: 100, className: 'Lebanon', currentEntityId: 'leb', suggestedEntityId: null,
  confidence: 0.4, status: 'NeedsEvidence', reasons: [], decision: null, watchMode: false, splitTemplate: null,
  ai: { action: 'Assign', entityId: 'mil', account: null, confidence: 0.85, reason: 'Memo says Milford', usedRule: true, redacted: false },
  ...over,
});
const summary = {
  Conflict: { count: 0, open: 0, amount: 0 },
  LikelyMisclassified: { count: 0, open: 0, amount: 0 },
  Unclassified: { count: 0, open: 0, amount: 0 },
  NeedsEvidence: { count: 2, open: 2, amount: 200 },
  Confirmed: { count: 0, open: 0, amount: 0 },
};
const linesResponse = (lines, total = lines.length) => ({
  run: { runId: 'run-1', threshold: 0.9, mediumThreshold: 0.7 }, entities: ENTITIES, summary, total, totalAmount: 200, lines,
});

beforeEach(() => {
  listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
  getControllerOverview.mockResolvedValue({ qbos: [{ qboId: 'mgmt', qboName: 'APOHCO', isClassBased: true }], snapshots: [] });
  listReviewRuns.mockResolvedValue({ latestSnapshot: { snapshotId: 's1' }, runs: [{ runId: 'run-1', runDate: '2026-11-23T10:00:00Z', lineCount: 5, isStale: false }] });
  getReviewAccounts.mockResolvedValue({ ownerEntityId: null, accounts: [], dueToFrom: [], detectedDueToFrom: [] });
  saveReviewDecisions.mockResolvedValue({ decided: 1, skipped: { alreadyDecided: 0, watchMode: 0, nothingToApply: 0, noDueToFromAccount: 0 } });
  getAiStatus.mockResolvedValue(AI_IDLE);
  getAiUsage.mockResolvedValue({ monthSpend: 1.25, agreement: { decided: 4, agreed: 3, agreeRate: 0.75 } });
});
afterEach(() => vi.useRealTimers());

test('the AI column shows the suggestion; Accept AI records it for that line', async () => {
  const user = userEvent.setup();
  listReviewLines.mockResolvedValue(linesResponse([line(), line({ lineId: 'l2', memo: 'other', ai: { action: 'Unsure', confidence: 0, reason: 'Nothing to go on' } })]));
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  await screen.findByText('Breakroom');
  expect(screen.getByText('Milford')).toBeInTheDocument();
  expect(screen.getByText('AI 85% · by rule')).toBeInTheDocument();
  expect(screen.getByText('AI unsure')).toBeInTheDocument();
  // Only the line with a real suggestion can be accepted.
  const accept = screen.getAllByRole('button', { name: 'Accept AI' });
  expect(accept).toHaveLength(1);
  await user.click(accept[0]);
  expect(saveReviewDecisions).toHaveBeenCalledWith('g1', { runId: 'run-1', action: 'AcceptAi', lineIds: ['l1'] });
  expect(await screen.findByText(/Accept AI suggestion: 1 line\./)).toBeInTheDocument();
});

test('bulk Accept AI on all matching lines, filtered to AI suggestions, after confirming', async () => {
  const user = userEvent.setup();
  listReviewLines.mockResolvedValue(linesResponse([line(), line({ lineId: 'l2', memo: 'm2' })], 40));
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  await screen.findByText('m2');
  await user.click(screen.getByRole('combobox', { name: 'AI filter' }));
  await user.click(screen.getByRole('option', { name: 'AI suggested' }));
  await waitFor(() => expect(listReviewLines).toHaveBeenLastCalledWith('g1', expect.objectContaining({ ai: 'suggested' })));
  await screen.findByText('m2');
  await user.click(screen.getByRole('checkbox', { name: 'Select page' }));
  await user.click(screen.getByRole('button', { name: 'Select all 40 matching lines' }));
  await user.click(screen.getByRole('button', { name: 'Accept AI suggestions' }));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(saveReviewDecisions).toHaveBeenCalledWith('g1', {
    runId: 'run-1', action: 'AcceptAi', expectedCount: 40, filter: { reviewState: 'open', accountType: 'Expense', ai: 'suggested' },
  });
});

test('the AI pass shows progress, and the queue reloads as answers arrive', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const running = {
    ...AI_IDLE, answered: 25, suggested: 20, monthSpend: 0.4,
    job: { finished: false, batchCount: 4, batches: { Succeeded: 1, Failed: 0, Skipped: 0, Stalled: 0, Queued: 2, Running: 1 }, errors: [] },
  };
  const done = { ...running, answered: 100, suggested: 70, job: { ...running.job, finished: true, batches: { ...running.job.batches, Succeeded: 4, Queued: 0, Running: 0 } } };
  getAiStatus.mockResolvedValueOnce(running).mockResolvedValue(done);
  listReviewLines.mockResolvedValue(linesResponse([line()]));
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  expect(await screen.findByText('Asking the AI: 1 of 4 batches')).toBeInTheDocument();
  expect(screen.getByText(/20 suggestions, 5 unsure · This month \$0.40 of \$25.00/)).toBeInTheDocument();
  const loadsBefore = listReviewLines.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5100);
  expect(await screen.findByText(/70 suggestions, 30 unsure/)).toBeInTheDocument();
  await waitFor(() => expect(listReviewLines.mock.calls.length).toBeGreaterThan(loadsBefore));
  expect(screen.queryByText(/Asking the AI/)).not.toBeInTheDocument();
});

test('ask the AI about the run when it has no answers yet', async () => {
  const user = userEvent.setup();
  listReviewLines.mockResolvedValue(linesResponse([line({ ai: null })]));
  startAiJob.mockResolvedValue({ jobId: 'j2', lineCount: 12, batchCount: 1 });
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  await user.click(await screen.findByRole('button', { name: 'Run AI pass' }));
  expect(startAiJob).toHaveBeenCalledWith('g1', { kind: 'Review', runId: 'run-1' });
  await waitFor(() => expect(getAiStatus.mock.calls.length).toBeGreaterThan(1));
});

test('running a review says how many lines the AI is looking at', async () => {
  const user = userEvent.setup();
  startReviewRun.mockResolvedValue({ lineCount: 251, ai: { jobId: 'j1', lineCount: 84, batchCount: 4 } });
  listReviewLines.mockResolvedValue(linesResponse([line()]));
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  await user.click(await screen.findByRole('button', { name: 'Run review again' }));
  expect(await screen.findByText(/Reviewed 251 lines\. The AI is looking at 84 lines/)).toBeInTheDocument();
});

test('AI settings are saved with the rest, with spend and agree rate shown', async () => {
  const user = userEvent.setup();
  listReviewLines.mockResolvedValue(linesResponse([line()]));
  getReviewSettings.mockResolvedValue({
    threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12, splitShiftPoints: 25, spikePercent: 50, spikeMinAmount: 500, recurringMonths: 3, baselineMonths: 6,
    aiEnabled: true, aiConfidenceCap: 0.85, aiMonthlyBudget: 25, aiRedactPatientInfo: true,
  });
  saveReviewSettings.mockResolvedValue({});
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  const budget = await screen.findByLabelText('Monthly AI budget ($)');
  expect(await screen.findByText(/Spent this month: \$1.25/)).toBeInTheDocument();
  expect(screen.getByText(/you agreed with 3 of 4 AI suggestions/)).toBeInTheDocument();
  await user.clear(budget);
  await user.type(budget, '40');
  await user.click(screen.getByRole('checkbox', { name: 'Withhold payee and memo on refund and patient lines' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(saveReviewSettings).toHaveBeenCalledWith('g1', expect.objectContaining({ aiEnabled: true, aiConfidenceCap: 0.85, aiMonthlyBudget: 40, aiRedactPatientInfo: false }));
});

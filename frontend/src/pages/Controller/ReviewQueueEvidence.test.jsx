// Phase 4a: evidence in the Review queue.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({
  getControllerOverview: vi.fn(),
  getReviewAccounts: vi.fn(),
  getReviewSettings: vi.fn(),
  listReviewLines: vi.fn(),
  listReviewRuns: vi.fn(),
  saveReviewDecisions: vi.fn(),
  getAiStatus: vi.fn(),
  getAiUsage: vi.fn(),
  findEvidence: vi.fn(),
  startEvidenceSearch: vi.fn(),
  getEvidenceJob: vi.fn(),
  getLineEvidence: vi.fn(),
  getEvidencePreview: vi.fn(),
  confirmEvidence: vi.fn(),
  getSavedEvidenceDownload: vi.fn(),
  searchInvoiceNumbers: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import {
  getControllerOverview,
  getReviewAccounts,
  listReviewLines,
  listReviewRuns,
  getAiStatus,
  findEvidence,
  startEvidenceSearch,
  getEvidenceJob,
  getLineEvidence,
  getEvidencePreview,
  confirmEvidence,
  getSavedEvidenceDownload,
  searchInvoiceNumbers,
} from '../../api/controller';
import { listGroups } from '../../api/settings';
import ReviewQueue from './ReviewQueue';
import { signalLabels, mentionedInvoices, invoiceSummary } from '../../components/controller/Evidence';

const ENTITIES = [
  { entityId: 'leb', entityName: 'Lebanon' },
  { entityId: 'mil', entityName: 'Milford' },
];
const line = (over = {}) => ({
  lineId: 'l1', txnDate: '2026-10-03', vendorName: 'Minuteman', payeeName: 'Minuteman', memo: 'Printing', accountCode: '6100',
  accountName: 'Supplies', accountType: 'Expense', amount: 1250, className: 'Milford', currentEntityId: 'mil', suggestedEntityId: null,
  confidence: 0.4, status: 'NeedsEvidence', reasons: ['History: 55% Milford'], decision: null, watchMode: false, splitTemplate: null, ai: null,
  evidence: { count: 0, best: null, entityHintId: null, searchedAt: null },
  ...over,
});
const response = (lines, total = lines.length) => ({
  run: { runId: 'run-1', threshold: 0.9, mediumThreshold: 0.7 },
  entities: ENTITIES,
  summary: Object.fromEntries(['Conflict', 'LikelyMisclassified', 'Unclassified', 'NeedsEvidence', 'Confirmed'].map((s) => [s, { count: 0, open: 0, amount: 0 }])),
  total,
  totalAmount: 1250,
  lines,
});
const CANDIDATE = {
  candidateId: 'c1', source: 'Gmail', account: 'info@apohco.com', title: 'Invoice 4471', sender: 'Minuteman <ar@mm.com>', sentAt: '2026-10-02T12:00:00Z',
  snippet: 'Your invoice', attachmentNames: ['INV-4471.pdf'], score: 1, signals: { amount: true, vendor: true, days: 1, entityTerm: 'Main St' }, entityHintId: 'leb',
};

beforeEach(() => {
  listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
  getControllerOverview.mockResolvedValue({ qbos: [{ qboId: 'mgmt', qboName: 'APOHCO', isClassBased: true }], snapshots: [] });
  listReviewRuns.mockResolvedValue({ latestSnapshot: { snapshotId: 's1' }, runs: [{ runId: 'run-1', runDate: '2026-11-23T10:00:00Z', lineCount: 5, isStale: false }] });
  getReviewAccounts.mockResolvedValue({ ownerEntityId: null, accounts: [], dueToFrom: [], detectedDueToFrom: [] });
  getAiStatus.mockResolvedValue({ enabled: true, confidenceCap: 0.85, monthSpend: 0, monthlyBudget: 25, answered: 0, suggested: 0, job: null });
});

test('signalLabels', () => {
  expect(signalLabels(CANDIDATE.signals, (id) => ({ leb: 'Lebanon' })[id], 'leb')).toEqual(['Amount matches', 'Vendor matches', '1 day apart', 'Names Lebanon ("Main St")']);
});

test('Find Evidence on one line, then the line detail shows the match; preview opens the email', async () => {
  const user = userEvent.setup();
  listReviewLines.mockResolvedValue(response([line()]));
  findEvidence.mockResolvedValue({ searched: 1, found: 1, sources: 1, errors: [], candidates: [CANDIDATE], lastSearch: { at: '2026-11-25T10:00:00Z', sources: 1, found: 1 } });
  getLineEvidence.mockResolvedValue({ candidates: [CANDIDATE], lastSearch: { at: '2026-11-25T10:00:00Z', sources: 1, found: 1, error: null } });
  getEvidencePreview.mockResolvedValue({ candidateId: 'c1', mailbox: 'info@apohco.com', subject: 'Invoice 4471', from: 'ar@mm.com', to: 'info@apohco.com', sentAt: '2026-10-02T12:00:00Z', text: 'Ship to 12 Main St\nTotal $1,250.00', attachments: [{ name: 'INV-4471.pdf' }] });
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  await screen.findByText('Printing');
  await user.click(screen.getByRole('button', { name: 'Find Evidence' }));
  expect(findEvidence).toHaveBeenCalledWith('g1', 'run-1', 'l1');
  expect(await screen.findByText('Found 1 possible match.')).toBeInTheDocument();
  const detail = await screen.findByTestId('line-detail');
  expect(await within(detail).findByText('Invoice 4471')).toBeInTheDocument();
  expect(within(detail).getByText('Names Lebanon ("Main St")')).toBeInTheDocument();
  expect(within(detail).getByText('100%')).toBeInTheDocument();
  await user.click(within(detail).getByRole('button', { name: 'Preview' }));
  const preview = await screen.findByTestId('evidence-preview');
  expect(within(preview).getByText(/Total \$1,250\.00/)).toBeInTheDocument();
  expect(getEvidencePreview).toHaveBeenCalledWith('g1', 'c1');
});

test('a line with evidence shows the count and the practice it names', async () => {
  listReviewLines.mockResolvedValue(response([line({ evidence: { count: 2, best: 0.85, entityHintId: 'leb', searchedAt: 'x' } }), line({ lineId: 'l2', memo: 'Other', evidence: { count: 0, best: null, entityHintId: null, searchedAt: 'x' } })]));
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  expect(await screen.findByText('2 found · best 85%')).toBeInTheDocument();
  expect(screen.getByText('Names Lebanon')).toBeInTheDocument();
  expect(screen.getByText('None found')).toBeInTheDocument();
});

test('Search All runs over every matching line in the background, then reloads', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  listReviewLines.mockResolvedValue(response([line()], 40));
  startEvidenceSearch.mockResolvedValue({ jobId: 'j1', lineCount: 40, skipped: 0, batchCount: 4 });
  getEvidenceJob
    .mockResolvedValueOnce({ jobId: 'j1', lineCount: 40, batchCount: 4, finished: false, batches: { Succeeded: 1, Failed: 0, Stalled: 0, Queued: 2, Running: 1 }, errors: [] })
    .mockResolvedValue({ jobId: 'j1', lineCount: 40, batchCount: 4, finished: true, batches: { Succeeded: 4, Failed: 0, Stalled: 0, Queued: 0, Running: 0 }, errors: [] });
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  await screen.findByText('Printing');
  await user.click(screen.getByRole('button', { name: 'Search All' }));
  expect(startEvidenceSearch).toHaveBeenCalledWith('g1', { runId: 'run-1', filter: { reviewState: 'open', accountType: 'Expense' }, expectedCount: 40 });
  expect(await screen.findByText('Searching for evidence: 10 of 40 lines')).toBeInTheDocument();
  const loads = listReviewLines.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4100);
  expect(await screen.findByText('Evidence search finished for 40 lines.')).toBeInTheDocument();
  await waitFor(() => expect(listReviewLines.mock.calls.length).toBeGreaterThan(loads));
  vi.useRealTimers();
});

test('the evidence filter', async () => {
  const user = userEvent.setup();
  listReviewLines.mockResolvedValue(response([line()]));
  render(<ReviewQueue />, { wrapper: MemoryRouter });
  await screen.findByText('Printing');
  await user.click(screen.getByRole('combobox', { name: 'Evidence filter' }));
  await user.click(screen.getByRole('option', { name: 'Not searched' }));
  await waitFor(() => expect(listReviewLines).toHaveBeenLastCalledWith('g1', expect.objectContaining({ evidence: 'unsearched' })));
});

describe('Phase 4b: invoice folders and Save as support', () => {
  const DRIVE = {
    ...CANDIDATE, candidateId: 'd1', source: 'Drive', account: 'src-1', title: 'Minuteman INV-4471.pdf', sender: 'amy@apohco.com',
    link: 'https://drive.google.com/file/d/x/view', path: 'Invoices / 2026', attachmentNames: [], saved: null,
  };

  test('a Drive match shows its folder and an Open in Drive link; Save as support saves it, then it can be downloaded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    listReviewLines.mockResolvedValue(response([line({ evidence: { count: 1, best: 1, entityHintId: null, searchedAt: 'x', saved: 0 } })]));
    getLineEvidence
      .mockResolvedValueOnce({ candidates: [DRIVE], saved: [], lastSearch: { at: '2026-11-27T10:00:00Z', sources: 2, found: 1 } })
      .mockResolvedValueOnce({ candidates: [{ ...DRIVE, saved: { savedId: 's1', status: 'Saving' } }], saved: [{ savedId: 's1', status: 'Saving', title: DRIVE.title }], lastSearch: null })
      .mockResolvedValue({
        candidates: [{ ...DRIVE, saved: { savedId: 's1', status: 'Saved' } }],
        saved: [{ savedId: 's1', status: 'Saved', fileName: '2026-10-03_Minuteman_1250.00.pdf', drivePath: 'Controller Evidence / Lebanon / 2026-10 / 2026-10-03_Minuteman_1250.00.pdf', error: null }],
        lastSearch: null,
      });
    confirmEvidence.mockResolvedValue({ savedId: 's1', status: 'Saving' });
    getSavedEvidenceDownload.mockResolvedValue({ url: 'https://s3/signed', fileName: 'x.pdf', expiresInSeconds: 300 });
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByText('1 found · best 100%'));
    const detail = await screen.findByTestId('line-detail');
    expect(await within(detail).findByText('Minuteman INV-4471.pdf')).toBeInTheDocument();
    expect(within(detail).getByText('Drive file')).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: 'Open in Drive' })).toHaveAttribute('href', DRIVE.link);

    await user.click(within(detail).getByRole('button', { name: 'Save as support' }));
    expect(confirmEvidence).toHaveBeenCalledWith('g1', 'run-1', 'l1', 'd1');
    expect(await within(detail).findByText('Saving…', { selector: 'span' })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(4100);
    const saved = await within(detail).findByTestId('saved-support');
    expect(await within(saved).findByText('Filed in Drive: Controller Evidence / Lebanon / 2026-10 / 2026-10-03_Minuteman_1250.00.pdf')).toBeInTheDocument();
    expect(within(detail).getByText('Saved as support')).toBeInTheDocument();
    await user.click(within(saved).getByRole('button', { name: 'Download' }));
    expect(getSavedEvidenceDownload).toHaveBeenCalledWith('g1', 's1');
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://s3/signed', '_blank', 'noopener'));
    open.mockRestore();
    vi.useRealTimers();
  }, 15000);

  test('a supported line is marked in the queue', async () => {
    listReviewLines.mockResolvedValue(response([line({ evidence: { count: 0, best: null, entityHintId: null, searchedAt: 'x', saved: 1 } })]));
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    expect(await screen.findByText('Supported')).toBeInTheDocument();
    expect(screen.getByText('View support')).toBeInTheDocument();
  });
});

describe('invoices behind a payment', () => {
  const PAYMENT = { ...CANDIDATE, candidateId: 'p1', title: 'Payment confirmation', signals: { amount: true, vendor: true, days: 0, mentions: ['4471', '4472', '4480'] }, entityHintId: null, saved: null };
  const inv = (n, total, over = {}) => ({
    ...CANDIDATE, candidateId: `i${n}`, title: `Patterson Invoice ${n}`, saved: null, entityHintId: null,
    signals: { invoiceNumber: n, invoiceNumbers: [n], invoiceTotal: total, vendor: true }, ...over,
  });

  test('helpers', () => {
    expect(mentionedInvoices([PAYMENT, inv('4471', 400)])).toEqual(['4472', '4480']);
    expect(invoiceSummary([inv('4471', 400), inv('4471', null, { candidateId: 'dup', source: 'Drive' }), inv('4472', null)])).toEqual({
      invoices: [{ number: '4471', total: 400 }, { number: '4472', total: null }], sum: 400, missingTotals: 1,
    });
    expect(signalLabels(inv('4471', 412.5).signals, () => '', null)).toEqual(['Invoice 4471 · total $412.50', 'Vendor matches']);
  });

  test('the numbers a payment email mentions can be searched in one click; the totals are checked against the payment', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(response([line({ evidence: { count: 1, best: 1, entityHintId: null, searchedAt: 'x', saved: 0 } })]));
    getLineEvidence.mockResolvedValue({ candidates: [PAYMENT], saved: [], lastSearch: { at: '2026-11-27T10:00:00Z', sources: 2, found: 1 } });
    searchInvoiceNumbers.mockResolvedValue({
      numbers: ['4471', '4472', '4480'], foundNumbers: ['4471', '4472', '4480'], notFound: [], found: 3, sources: 2, errors: [],
      candidates: [PAYMENT, inv('4471', 400), inv('4472', 600), inv('4480', 250)], saved: [], lastSearch: null,
    });
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByText('1 found · best 100%'));
    const box = await screen.findByTestId('invoice-search');
    expect(within(box).getByText('A match mentions invoices 4471, 4472, 4480.')).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'Find invoices 4471, 4472, 4480' }));
    expect(searchInvoiceNumbers).toHaveBeenCalledWith('g1', 'run-1', 'l1', ['4471', '4472', '4480']);
    expect(await within(box).findByText('Found 4471, 4472, 4480.')).toBeInTheDocument();
    expect(within(box).getByTestId('invoice-total')).toHaveTextContent('3 invoices found: $1,250.00 of the $1,250.00 payment ✓ adds up');
    expect(screen.getByText('Invoice 4472 · total $600.00')).toBeInTheDocument();
    // All found: nothing left to suggest.
    expect(within(box).queryByText(/A match mentions/)).not.toBeInTheDocument();
  });

  test('type invoice numbers; ones not found are listed', async () => {
    const user = userEvent.setup();
    listReviewLines.mockResolvedValue(response([line({ evidence: { count: 1, best: 1, entityHintId: null, searchedAt: 'x', saved: 0 } })]));
    getLineEvidence.mockResolvedValue({ candidates: [CANDIDATE], saved: [], lastSearch: null });
    searchInvoiceNumbers.mockResolvedValue({ numbers: ['9001', '9002'], foundNumbers: ['9001'], notFound: ['9002'], found: 1, errors: [], candidates: [CANDIDATE, inv('9001', 100)], saved: [] });
    render(<ReviewQueue />, { wrapper: MemoryRouter });
    await user.click(await screen.findByText('1 found · best 100%'));
    const box = await screen.findByTestId('invoice-search');
    await user.type(within(box).getByLabelText('Invoice numbers'), '9001, 9002');
    await user.click(within(box).getByRole('button', { name: 'Search' }));
    expect(searchInvoiceNumbers).toHaveBeenCalledWith('g1', 'run-1', 'l1', '9001, 9002');
    expect(await within(box).findByText('Found 9001. Not found: 9002.')).toBeInTheDocument();
    expect(within(box).getByTestId('invoice-total')).toHaveTextContent('1 invoice found: $100.00 of the $1,250.00 payment');
  });
});

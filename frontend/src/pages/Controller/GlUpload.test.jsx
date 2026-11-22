import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({
  analyzeControllerUpload: vi.fn(),
  createControllerUpload: vi.fn(),
  getControllerOverview: vi.fn(),
  importControllerUpload: vi.fn(),
  listControllerUploads: vi.fn(),
  putControllerUploadFile: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import {
  analyzeControllerUpload,
  createControllerUpload,
  getControllerOverview,
  importControllerUpload,
  listControllerUploads,
  putControllerUploadFile,
} from '../../api/controller';
import { listGroups } from '../../api/settings';
import GlUpload, { defaultPeriod, exampleValue } from './GlUpload';

const FIELDS = [
  { key: 'account', label: 'Distribution account', required: false },
  { key: 'txnDate', label: 'Transaction date', required: true },
  { key: 'name', label: 'Name', required: false },
  { key: 'amount', label: 'Amount', required: false },
  { key: 'debit', label: 'Debit', required: false },
  { key: 'credit', label: 'Credit', required: false },
];
const HEADERS = ['Distribution account', 'Transaction date', 'Payee', 'Amount'];
const MAPPING = { account: 0, txnDate: 1, name: 2, amount: 3, debit: null, credit: null };

const analysis = (over = {}) => ({
  uploadId: 'u1',
  fileName: 'gl.csv',
  fields: FIELDS,
  mappingSource: 'detected',
  headerRow: 0,
  headers: HEADERS,
  mapping: MAPPING,
  amountConvention: 'natural',
  problems: [],
  rawPreview: [HEADERS, ['', '', '', ''], ['6100 Supplies', '10/03/2026', 'Kroger', '42.10']],
  sample: [
    { sourceRow: 3, txnDate: '2026-10-03', accountCode: '6100', accountName: 'Supplies', payeeName: 'Kroger', debit: 42.1, credit: 0 },
  ],
  lineCount: 1,
  months: [{ month: '2026-10', lineCount: 1 }],
  totals: { debit: 42.1, credit: 0, difference: 42.1 },
  errorCount: 0,
  errors: [],
  skippedRows: 0,
  unknownAccounts: [],
  previousImport: null,
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <GlUpload />
    </MemoryRouter>
  );

async function uploadFile(user) {
  await screen.findByRole('combobox', { name: 'QBO file' });
  await user.click(screen.getByRole('combobox', { name: 'QBO file' }));
  await user.click(await screen.findByRole('option', { name: 'WPD' }));
  await user.upload(screen.getByTestId('gl-file'), new File(['x'], 'gl.csv', { type: 'text/csv' }));
  await user.click(screen.getByRole('button', { name: 'Upload and match columns' }));
}

describe('helpers', () => {
  test('exampleValue shows the first non-blank value under a column', () => {
    expect(exampleValue(analysis(), 2)).toBe('Kroger');
    expect(exampleValue(analysis(), null)).toBe('');
  });

  test('defaultPeriod spans the months in the file', () => {
    expect(defaultPeriod([{ month: '2026-01' }, { month: '2026-03' }])).toEqual({ fromMonth: '2026-01', toMonth: '2026-03' });
    expect(defaultPeriod([])).toEqual({ fromMonth: '', toMonth: '' });
  });
});

describe('GlUpload page', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    getControllerOverview.mockResolvedValue({ qbos: [{ qboId: 'q1', qboName: 'WPD', isApiConnected: false }], snapshots: [] });
    listControllerUploads.mockResolvedValue([]);
    createControllerUpload.mockResolvedValue({ uploadId: 'u1', uploadUrl: 'https://s3/put', contentType: 'text/csv' });
    putControllerUploadFile.mockResolvedValue({});
  });

  test('uploads the file, shows the detected mapping and a preview, then imports', async () => {
    const user = userEvent.setup();
    analyzeControllerUpload.mockResolvedValue(analysis());
    importControllerUpload.mockResolvedValue({ lineCount: 1, outsideRange: 0, errorCount: 0, snapshots: [{ snapshotId: 's1', month: '2026-10', lineCount: 1 }] });
    renderPage();
    await uploadFile(user);

    expect(createControllerUpload).toHaveBeenCalledWith('g1', 'q1', 'gl.csv');
    expect(putControllerUploadFile).toHaveBeenCalledWith('https://s3/put', expect.any(File), 'text/csv');
    const panel = await screen.findByTestId('analysis');
    expect(within(panel).getByRole('combobox', { name: 'Column for Name' })).toHaveTextContent('C: Payee');
    // Once as the mapping example, once in the stored-lines preview.
    expect(within(panel).getAllByText('Kroger', { selector: 'td' })).toHaveLength(2);
    expect(within(panel).getByText(/out by/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import month' }));
    expect(importControllerUpload).toHaveBeenCalledWith('g1', 'u1', {
      classifications: {}, headerRow: 0, mapping: MAPPING, amountConvention: 'natural', fromMonth: '2026-10', toMonth: '2026-10',
    });
    expect(await screen.findByText(/Stored 1 lines as 1 monthly snapshot/)).toBeInTheDocument();
  });

  test('changing a column re-checks the file with the new mapping', async () => {
    const user = userEvent.setup();
    analyzeControllerUpload.mockResolvedValue(analysis());
    renderPage();
    await uploadFile(user);
    await screen.findByTestId('analysis');

    await user.click(screen.getByRole('combobox', { name: 'Column for Name' }));
    await user.click(screen.getByRole('option', { name: 'Not in file' }));
    await waitFor(() => expect(analyzeControllerUpload).toHaveBeenCalledTimes(2));
    expect(analyzeControllerUpload.mock.calls[1][2].mapping).toEqual({ ...MAPPING, name: null });
  });

  test('new accounts get their suggested type filled in, and must be classified before import', async () => {
    const user = userEvent.setup();
    const loan = { accountKey: 'code:2500', accountCode: '2500', accountName: 'Loan', lineCount: 2, suggested: 'Liability' };
    const odd = { accountKey: 'name:misc', accountCode: null, accountName: 'Misc', lineCount: 1, suggested: null };
    analyzeControllerUpload
      .mockResolvedValueOnce(analysis({ unknownAccounts: [loan, odd] }))
      .mockResolvedValueOnce(analysis({ unknownAccounts: [odd] }))
      .mockResolvedValue(analysis());
    renderPage();
    await uploadFile(user);

    // The suggestion is applied automatically and re-checked.
    await waitFor(() => expect(analyzeControllerUpload).toHaveBeenCalledTimes(2));
    expect(analyzeControllerUpload.mock.calls[1][2].classifications).toEqual({ 'code:2500': 'Liability' });
    expect(await screen.findByRole('combobox', { name: 'Type for Loan' })).toHaveTextContent('Liability');
    expect(screen.getByRole('button', { name: 'Import month' })).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'Type for Misc' }));
    await user.click(screen.getByRole('option', { name: 'Expense' }));
    await waitFor(() => expect(analyzeControllerUpload).toHaveBeenCalledTimes(3));
    expect(analyzeControllerUpload.mock.calls[2][2].classifications).toEqual({ 'code:2500': 'Liability', 'name:misc': 'Expense' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import month' })).toBeEnabled());
  });

  test('missing columns block the import and say what to map', async () => {
    const user = userEvent.setup();
    analyzeControllerUpload.mockResolvedValue(analysis({ problems: ['Map a column to Transaction date.'], lineCount: 0, sample: [] }));
    renderPage();
    await uploadFile(user);
    expect(await screen.findByText('Map a column to Transaction date.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import/ })).toBeDisabled();
  });

  test('warns when the same file was imported before', async () => {
    const user = userEvent.setup();
    analyzeControllerUpload.mockResolvedValue(analysis({ previousImport: { uploadId: 'u0', fileName: 'gl.csv', importedDate: '2026-11-01T00:00:00Z' } }));
    renderPage();
    await uploadFile(user);
    expect(await screen.findByText(/This exact file was already imported/)).toBeInTheDocument();
  });
});

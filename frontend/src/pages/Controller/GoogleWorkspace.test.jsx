import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/controller', () => ({
  getGoogleSettings: vi.fn(),
  saveGoogleSettings: vi.fn(),
  testGoogleConnection: vi.fn(),
  getGoogleDirectory: vi.fn(),
  setGoogleSource: vi.fn(),
  addGoogleFolder: vi.fn(),
  indexGoogleFolder: vi.fn(),
  removeGoogleFolder: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import {
  addGoogleFolder,
  getGoogleDirectory,
  getGoogleSettings,
  indexGoogleFolder,
  removeGoogleFolder,
  saveGoogleSettings,
  setGoogleSource,
  testGoogleConnection,
} from '../../api/controller';
import { listGroups } from '../../api/settings';
import GoogleWorkspace, { folderStatus } from './GoogleWorkspace';

const MAILBOX = { sourceId: 's1', kind: 'Mailbox', sourceKey: 'info@apohco.com', displayName: 'info@apohco.com', enabled: true };
const FOLDER = {
  sourceId: 'f1', kind: 'Folder', sourceKey: 'fld1', displayName: 'Invoices', enabled: true, folderPath: 'Shared drive CFO / Invoices', actAs: 'info@apohco.com',
  files: 40, readable: 38, lastRun: { status: 'Succeeded', toIndex: 40, indexed: 38, failed: 2, finishedAt: '2026-11-27T08:00:00Z' },
};
const CONNECTED = { keyConfigured: true, settings: { adminEmail: 'info@apohco.com', domain: 'apohco.com', lastTest: { ok: true } }, sources: [MAILBOX, FOLDER] };

beforeEach(() => {
  listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
});

test('folderStatus', () => {
  expect(folderStatus({ lastRun: null })).toBe('Not indexed yet');
  expect(folderStatus({ lastRun: { status: 'Scanning' } })).toBe('Listing files…');
  expect(folderStatus({ lastRun: { status: 'Indexing', indexed: 3, failed: 1, toIndex: 10 } })).toBe('Indexing: 4 of 10 files');
  expect(folderStatus({ lastRun: { status: 'Failed', error: 'Google 404' } })).toBe('Failed: Google 404');
  expect(folderStatus(FOLDER)).toMatch(/^40 files indexed \(38 readable\) · .* · 2 couldn't be read$/);
});

test('first connection: save the admin account', async () => {
  const user = userEvent.setup();
  getGoogleSettings.mockResolvedValue({ keyConfigured: false, settings: null, sources: [] });
  saveGoogleSettings.mockResolvedValue({ ...CONNECTED, sources: [MAILBOX] });
  render(<GoogleWorkspace />);
  expect(await screen.findByText('The service account key is not configured on the server yet.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  await user.type(screen.getByLabelText('Workspace admin account'), 'info@apohco.com');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(saveGoogleSettings).toHaveBeenCalledWith('g1', 'info@apohco.com');
  expect(await screen.findByText('Saved. Test the connection next.')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Search info@apohco.com (Gmail mailbox)' })).toBeChecked();
});

test('test connection shows each check', async () => {
  const user = userEvent.setup();
  getGoogleSettings.mockResolvedValue(CONNECTED);
  testGoogleConnection.mockResolvedValue({ ok: false, checks: [{ name: 'List workspace users', ok: false, detail: 'Domain-wide delegation is not set up' }] });
  render(<GoogleWorkspace />);
  await user.click(await screen.findByRole('button', { name: 'Test connection' }));
  expect(within(await screen.findByTestId('test-checks')).getByText(/✗ List workspace users: Domain-wide delegation is not set up/)).toBeInTheDocument();
});

test('add an invoice folder by link (optionally read as its owner)', async () => {
  const user = userEvent.setup();
  getGoogleSettings.mockResolvedValue({ ...CONNECTED, sources: [MAILBOX] });
  addGoogleFolder.mockResolvedValue({ ...CONNECTED, sources: [MAILBOX, { ...FOLDER, lastRun: { status: 'Scanning' } }], added: { folderPath: 'Shared drive CFO / Invoices' } });
  render(<GoogleWorkspace />);
  expect(await screen.findByText('No invoice folders yet.')).toBeInTheDocument();
  await user.type(screen.getByLabelText('Folder link'), 'https://drive.google.com/drive/folders/abc123defg');
  await user.type(screen.getByLabelText('Owner (only if not shared with the admin)'), 'amy@apohco.com');
  await user.click(screen.getByRole('button', { name: 'Add folder' }));
  expect(addGoogleFolder).toHaveBeenCalledWith('g1', 'https://drive.google.com/drive/folders/abc123defg', 'amy@apohco.com');
  expect(await screen.findByText('Added Shared drive CFO / Invoices. Indexing has started.')).toBeInTheDocument();
  expect(screen.getByText('Listing files…')).toBeInTheDocument();
  expect(screen.getByLabelText('Folder link')).toHaveValue('');
});

test('several folders: each can be switched off, re-indexed or removed', async () => {
  const user = userEvent.setup();
  const second = { ...FOLDER, sourceId: 'f2', sourceKey: 'fld2', displayName: 'Receipts', folderPath: "amy@apohco.com's My Drive / Receipts", actAs: 'amy@apohco.com' };
  getGoogleSettings.mockResolvedValue({ ...CONNECTED, sources: [MAILBOX, FOLDER, second] });
  setGoogleSource.mockResolvedValue(CONNECTED);
  indexGoogleFolder.mockResolvedValue({ indexRunId: 'r1' });
  removeGoogleFolder.mockResolvedValue({ ...CONNECTED, sources: [MAILBOX, FOLDER] });
  render(<GoogleWorkspace />);
  expect(await screen.findByText('Shared drive CFO / Invoices')).toBeInTheDocument();
  expect(screen.getByText("amy@apohco.com's My Drive / Receipts")).toBeInTheDocument();
  expect(screen.getByText('Read as amy@apohco.com')).toBeInTheDocument();

  await user.click(screen.getByRole('checkbox', { name: 'Search Receipts' }));
  expect(setGoogleSource).toHaveBeenCalledWith('g1', { kind: 'Folder', sourceKey: 'fld2', enabled: false });

  await user.click(screen.getAllByRole('button', { name: 'Index now' })[0]);
  expect(indexGoogleFolder).toHaveBeenCalledWith('g1', 'f1');

  await user.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
  expect(removeGoogleFolder).toHaveBeenCalledWith('g1', 'f2');
  expect(await screen.findByText(/Removed Receipts and its index/)).toBeInTheDocument();
});

test('a folder being indexed refreshes until done', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getGoogleSettings
    .mockResolvedValueOnce({ ...CONNECTED, sources: [{ ...FOLDER, lastRun: { status: 'Indexing', indexed: 5, failed: 0, toIndex: 40 } }] })
    .mockResolvedValue(CONNECTED);
  render(<GoogleWorkspace />);
  expect(await screen.findByText('Indexing: 5 of 40 files')).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(5100);
  await waitFor(() => expect(screen.getByText(/40 files indexed/)).toBeInTheDocument());
  vi.useRealTimers();
});

test('browse the workspace: Gmail only (no whole drives)', async () => {
  const user = userEvent.setup();
  getGoogleSettings.mockResolvedValue(CONNECTED);
  getGoogleDirectory.mockResolvedValue({ users: [{ email: 'drvaughan@apohco.com', name: 'Dr Vaughan', suspended: false, mailbox: false }] });
  setGoogleSource.mockResolvedValue(CONNECTED);
  render(<GoogleWorkspace />);
  await user.click(await screen.findByRole('button', { name: 'Browse workspace' }));
  await screen.findByTestId('directory');
  expect(screen.queryByText(/My Drive$/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'Gmail drvaughan@apohco.com' }));
  expect(setGoogleSource).toHaveBeenCalledWith('g1', { kind: 'Mailbox', sourceKey: 'drvaughan@apohco.com', displayName: 'Dr Vaughan', enabled: true });
});

test('add a mailbox by email; the field clears only when it worked', async () => {
  const user = userEvent.setup();
  getGoogleSettings.mockResolvedValue(CONNECTED);
  setGoogleSource.mockRejectedValueOnce({ response: { data: { message: 'Only apohco.com accounts can be added' } } }).mockResolvedValue(CONNECTED);
  render(<GoogleWorkspace />);
  const field = await screen.findByLabelText('Workspace account');
  await user.type(field, 'x@gmail.com');
  await user.click(screen.getByRole('button', { name: 'Add mailbox' }));
  expect(await screen.findByText('Only apohco.com accounts can be added')).toBeInTheDocument();
  expect(field).toHaveValue('x@gmail.com');
  await user.clear(field);
  await user.type(field, 'office@apohco.com');
  await user.click(screen.getByRole('button', { name: 'Add mailbox' }));
  await waitFor(() => expect(field).toHaveValue(''));
});

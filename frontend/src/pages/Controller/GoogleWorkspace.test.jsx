import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/controller', () => ({
  getGoogleSettings: vi.fn(),
  saveGoogleSettings: vi.fn(),
  testGoogleConnection: vi.fn(),
  getGoogleDirectory: vi.fn(),
  setGoogleSource: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import { getGoogleDirectory, getGoogleSettings, saveGoogleSettings, setGoogleSource, testGoogleConnection } from '../../api/controller';
import { listGroups } from '../../api/settings';
import GoogleWorkspace from './GoogleWorkspace';

const CONNECTED = {
  keyConfigured: true,
  settings: { adminEmail: 'info@apohco.com', domain: 'apohco.com', lastTest: { ok: true } },
  sources: [{ sourceId: 's1', kind: 'Mailbox', sourceKey: 'info@apohco.com', displayName: 'info@apohco.com', enabled: true }],
};

beforeEach(() => {
  listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
});

test('first connection: save the admin account', async () => {
  const user = userEvent.setup();
  getGoogleSettings.mockResolvedValue({ keyConfigured: false, settings: null, sources: [] });
  saveGoogleSettings.mockResolvedValue(CONNECTED);
  render(<GoogleWorkspace />);
  expect(await screen.findByText('The service account key is not configured on the server yet.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  await user.type(screen.getByLabelText('Workspace admin account'), 'info@apohco.com');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(saveGoogleSettings).toHaveBeenCalledWith('g1', 'info@apohco.com');
  expect(await screen.findByText('Saved. Test the connection next.')).toBeInTheDocument();
  expect(screen.getByText('Gmail mailbox')).toBeInTheDocument();
});

test('test connection shows each check', async () => {
  const user = userEvent.setup();
  getGoogleSettings.mockResolvedValue(CONNECTED);
  testGoogleConnection.mockResolvedValue({
    ok: false,
    checks: [
      { name: 'Service account key', ok: true, detail: 'Key for sa@x' },
      { name: 'List workspace users', ok: false, detail: 'Domain-wide delegation is not set up' },
    ],
  });
  render(<GoogleWorkspace />);
  await user.click(await screen.findByRole('button', { name: 'Test connection' }));
  const checks = await screen.findByTestId('test-checks');
  expect(within(checks).getByText(/✗ List workspace users: Domain-wide delegation is not set up/)).toBeInTheDocument();
  expect(screen.getByText('Not working')).toBeInTheDocument();
});

test('switch a source off', async () => {
  const user = userEvent.setup();
  getGoogleSettings.mockResolvedValue(CONNECTED);
  setGoogleSource.mockResolvedValue({ ...CONNECTED, sources: [{ ...CONNECTED.sources[0], enabled: false }] });
  render(<GoogleWorkspace />);
  await user.click(await screen.findByRole('checkbox', { name: 'Search info@apohco.com (Gmail mailbox)' }));
  expect(setGoogleSource).toHaveBeenCalledWith('g1', { kind: 'Mailbox', sourceKey: 'info@apohco.com', enabled: false });
});

test('browse the workspace and opt in a user\'s Gmail and a shared drive', async () => {
  const user = userEvent.setup();
  getGoogleSettings.mockResolvedValue(CONNECTED);
  getGoogleDirectory.mockResolvedValue({
    users: [
      { email: 'info@apohco.com', name: 'Info', suspended: false, mailbox: true, drive: false },
      { email: 'drvaughan@apohco.com', name: 'Dr Vaughan', suspended: false, mailbox: false, drive: false },
    ],
    sharedDrives: [{ id: 'drv1', name: 'Accounting', enabled: false }],
  });
  setGoogleSource.mockResolvedValue(CONNECTED);
  render(<GoogleWorkspace />);
  await user.click(await screen.findByRole('button', { name: 'Browse workspace' }));
  await screen.findByTestId('directory');
  await user.click(screen.getByRole('checkbox', { name: 'Gmail drvaughan@apohco.com' }));
  expect(setGoogleSource).toHaveBeenCalledWith('g1', { kind: 'Mailbox', sourceKey: 'drvaughan@apohco.com', displayName: 'Dr Vaughan', enabled: true });
  await user.click(screen.getByRole('checkbox', { name: 'Shared drive Accounting' }));
  expect(setGoogleSource).toHaveBeenLastCalledWith('g1', { kind: 'SharedDrive', sourceKey: 'drv1', displayName: 'Accounting', enabled: true });
});

test('add an account by email; the field clears only when it worked', async () => {
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
  await user.click(screen.getByRole('button', { name: 'Add My Drive' }));
  expect(setGoogleSource).toHaveBeenLastCalledWith('g1', { kind: 'UserDrive', sourceKey: 'office@apohco.com', enabled: true });
  await vi.waitFor(() => expect(field).toHaveValue(''));
});

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({
  getAccountants: vi.fn(),
  inviteAccountant: vi.fn(),
  updateAccountant: vi.fn(),
  accountantAction: vi.fn(),
  saveAccountantNotifySettings: vi.fn(),
  sendAccountantNotifyTest: vi.fn(),
  getAjeRollup: vi.fn(),
  replyToAjeEntry: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import * as api from '../../api/controller';
import { listGroups } from '../../api/settings';
import Accountants, { accessLabel, suggestUsername } from './Accountants';
import AjeActivity, { activityText } from './AjeActivity';

const FILES = [{ qboId: 'mgmt', qboName: 'APOHCO Management' }, { qboId: 'wpd', qboName: 'Westside' }];
const CASEY = {
  accountantId: 'a1', username: 'casey', fullName: 'Casey CPA', email: 'casey@firm.com', firm: 'Firm LLP', active: true, notifyByEmail: true,
  hasAccess: true, qboIds: null, otherGroups: 0, loginStatus: 'Active', lastActiveAt: null,
};
const DATA = { accountants: [CASEY], files: FILES, notify: { emailEnabled: false, controllerEmail: null, senderEmail: 'admin@apohco.com', googleConnected: true } };

beforeEach(() => {
  vi.clearAllMocks();
  listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
  api.getAccountants.mockResolvedValue(DATA);
});

describe('helpers', () => {
  test('suggestUsername and accessLabel', () => {
    expect(suggestUsername('Casey.Smith+x@firm.com')).toBe('casey.smithx');
    expect(suggestUsername('jo@firm.com')).toBe('jo.cpa');
    expect(accessLabel(CASEY, FILES)).toBe('All files');
    expect(accessLabel({ ...CASEY, qboIds: ['wpd'] }, FILES)).toBe('Westside');
    expect(accessLabel({ ...CASEY, hasAccess: false }, FILES)).toBe('No access to this Group');
  });

  test('activityText', () => {
    expect(activityText({ kind: 'status', who: 'Casey', entryNumber: 'X.01', statusLabel: 'Declined', reason: 'Wrong period' })).toBe('Casey marked X.01 Declined: Wrong period');
    expect(activityText({ kind: 'comment', who: 'paul', authorRole: 'Controller', entryNumber: 'X.01', body: 'Hi' })).toBe('paul (you) on X.01: Hi');
  });
});

describe('Accountants page', () => {
  test('lists the team with sign-in state and access', async () => {
    render(<MemoryRouter><Accountants /></MemoryRouter>);
    expect(await screen.findByText('Casey CPA')).toBeInTheDocument();
    expect(screen.getByText('All files')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  test('adding an accountant limited to one file sends the invite', async () => {
    api.inviteAccountant.mockResolvedValue({ accountantId: 'a2' });
    render(<MemoryRouter><Accountants /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Add accountant' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Dana Lee');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Email' }), 'dana.lee@firm.com');
    expect(within(dialog).getByRole('textbox', { name: 'Username' })).toHaveValue('dana.lee');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Only these files' }));
    const send = within(dialog).getByRole('button', { name: 'Send invite' });
    expect(send).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Westside' }));
    await userEvent.click(send);
    await waitFor(() => expect(api.inviteAccountant).toHaveBeenCalledWith('g1', {
      fullName: 'Dana Lee', email: 'dana.lee@firm.com', firm: '', notifyByEmail: true, username: 'dana.lee', qboIds: ['wpd'],
    }));
    expect(await screen.findByText(/Invite sent to dana.lee@firm.com/)).toBeInTheDocument();
  }, 15000);

  test('deactivate from the row menu', async () => {
    api.accountantAction.mockResolvedValue({ ...DATA, accountants: [{ ...CASEY, active: false }] });
    render(<MemoryRouter><Accountants /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Casey CPA' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));
    await waitFor(() => expect(api.accountantAction).toHaveBeenCalledWith('g1', 'a1', 'deactivate'));
    expect(await screen.findByText('Deactivated')).toBeInTheDocument();
  });

  test('turning email on saves the setting', async () => {
    api.saveAccountantNotifySettings.mockResolvedValue({});
    render(<MemoryRouter><Accountants /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Send emails from admin@apohco.com/ }));
    await waitFor(() => expect(api.saveAccountantNotifySettings).toHaveBeenCalledWith('g1', { emailEnabled: true, controllerEmail: null }));
  });
});

describe('Accountant activity page', () => {
  test('shows totals and answers an open question', async () => {
    api.getAjeRollup.mockResolvedValue({
      totals: { notWorked: 3, booked: 2, declined: 1, bookedUnconfirmed: 1, openQuestions: 1 },
      reports: [{ reportId: 'r1', reportNumber: 'MGMT-2026-10-AJE-001', qboName: 'APOHCO Management', month: '2026-10', status: 'Published', entryCount: 6, counts: { notWorked: 3, booked: 2, declined: 1, bookedUnconfirmed: 1, openQuestions: 1 } }],
      openQuestions: [{ entryId: 'e1', reportId: 'r1', entryNumber: 'MGMT-2026-10-AJE-001.02', reportNumber: 'MGMT-2026-10-AJE-001', qboName: 'APOHCO Management', authorName: 'Casey', body: 'Which class?', askedAt: '2026-11-28' }],
      activity: [],
      accountants: [{ accountantId: 'a1', fullName: 'Casey', active: true }],
    });
    api.replyToAjeEntry.mockResolvedValue({});
    render(<MemoryRouter><AjeActivity /></MemoryRouter>);
    expect(await screen.findByText('Which class?')).toBeInTheDocument();
    expect(screen.getByText('Booked, not yet seen in GL')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Comment on MGMT-2026-10-AJE-001.02' }), 'Use Lebanon.');
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(api.replyToAjeEntry).toHaveBeenCalledWith('g1', 'e1', 'Use Lebanon.'));
    expect(api.getAjeRollup).toHaveBeenCalledTimes(2);
  });
});

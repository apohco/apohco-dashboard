import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/settings', () => ({
  listUsers: vi.fn(),
  inviteUser: vi.fn(),
  updateUser: vi.fn(),
  userAction: vi.fn(),
}));

import { listUsers, inviteUser, updateUser, userAction } from '../../api/settings';
import UserManagement, { availableActions } from './UserManagement';

const base = { email: 'x@x.com', emailVerified: true, enabled: true, status: 'CONFIRMED', mfaEnabled: true, isSelf: false, isProtected: false };
const paul = { ...base, username: 'paul', role: 'SoftwareAdmin', isSelf: true, isProtected: true };
const drv = { ...base, username: 'drv', role: 'Owner', groupId: 'g1', groupName: 'APOHCO', emailVerified: false, mfaEnabled: false };
const invited = { ...base, username: 'newbie', role: 'TeamMember', groupId: 'g1', groupName: 'APOHCO', status: 'FORCE_CHANGE_PASSWORD', mfaEnabled: false };

describe('availableActions', () => {
  test('nothing for yourself or a protected account', () => {
    expect(availableActions(paul)).toEqual([]);
    expect(availableActions({ ...drv, isProtected: true })).toEqual([]);
  });
  test('nothing for an accountant portal login (managed in Controller > Accountants)', () => {
    expect(availableActions({ ...base, username: 'cpa', role: 'Accountant', isAccountant: true })).toEqual([]);
  });
  test('invited users get "resend invite"; active users get password reset', () => {
    expect(availableActions(invited)).toEqual(['resend-invite', 'disable']);
    expect(availableActions({ ...drv, mfaEnabled: true })).toEqual(['reset-password', 'reset-mfa', 'disable']);
  });
  test('a disabled user can only be re-enabled', () => {
    expect(availableActions({ ...drv, enabled: false })).toEqual(['enable']);
  });
});

describe('UserManagement page', () => {
  beforeEach(() => {
    listUsers.mockResolvedValue({ users: [drv, invited, paul], groups: [{ groupId: 'g1', groupName: 'APOHCO' }] });
  });

  test('lists users, flags unverified emails, and locks your own protected account', async () => {
    render(<UserManagement />);
    const paulRow = (await screen.findByText('paul')).closest('tr');
    expect(within(paulRow).getByLabelText('protected account')).toBeInTheDocument();
    expect(within(paulRow).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

    const drvRow = screen.getByText('drv').closest('tr');
    expect(within(drvRow).getByText('Unverified')).toBeInTheDocument();
    expect(within(screen.getByText('newbie').closest('tr')).getByText('Invited')).toBeInTheDocument();
  });

  test('invites a practice user', async () => {
    const user = userEvent.setup();
    inviteUser.mockResolvedValue({});
    render(<UserManagement />);
    await screen.findByText('drv');

    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    await user.type(screen.getByLabelText('Username'), 'frontdesk');
    await user.type(screen.getByLabelText('Email'), 'fd@x.com');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));

    expect(inviteUser).toHaveBeenCalledWith({ username: 'frontdesk', email: 'fd@x.com', role: 'TeamMember', groupId: 'g1' });
    expect(await screen.findByText('Invite emailed to fd@x.com.')).toBeInTheDocument();
  });

  test('a platform role has no practice', async () => {
    const user = userEvent.setup();
    inviteUser.mockResolvedValue({});
    render(<UserManagement />);
    await screen.findByText('drv');

    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    await user.type(screen.getByLabelText('Username'), 'rep');
    await user.type(screen.getByLabelText('Email'), 'r@x.com');
    await user.click(screen.getByLabelText('Role'));
    await user.click(within(screen.getByRole('listbox')).getByText('Software Rep'));
    expect(screen.queryByLabelText('Practice')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(inviteUser).toHaveBeenCalledWith({ username: 'rep', email: 'r@x.com', role: 'SoftwareRep', groupId: null });
  });

  test('editing an email saves it and warns nothing about sign-out', async () => {
    const user = userEvent.setup();
    updateUser.mockResolvedValue({});
    render(<UserManagement />);
    const row = (await screen.findByText('drv')).closest('tr');
    await user.click(within(row).getByRole('button', { name: 'Edit' }));

    const email = screen.getByLabelText('Email');
    await user.clear(email);
    await user.type(email, 'drv@x.com');
    expect(screen.queryByText(/signs drv out/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateUser).toHaveBeenCalledWith('drv', { email: 'drv@x.com', role: 'Owner', groupId: 'g1' });
  });

  test('actions ask for confirmation before running', async () => {
    const user = userEvent.setup();
    userAction.mockResolvedValue({});
    render(<UserManagement />);
    await screen.findByText('drv');

    await user.click(screen.getByLabelText('More actions for drv'));
    await user.click(screen.getByRole('menuitem', { name: 'Disable account' }));
    expect(userAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Disable drv\?/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(userAction).toHaveBeenCalledWith('drv', 'disable');
    expect(await screen.findByText('drv: Account disabled.')).toBeInTheDocument();
  });

  test('shows the API error when an action is refused', async () => {
    const user = userEvent.setup();
    userAction.mockRejectedValue({ response: { data: { message: "This user's email isn't verified" } } });
    listUsers.mockResolvedValue({ users: [{ ...drv, mfaEnabled: true }], groups: [] });
    render(<UserManagement />);
    await screen.findByText('drv');
    await user.click(screen.getByLabelText('More actions for drv'));
    await user.click(screen.getByRole('menuitem', { name: 'Send password reset' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText("This user's email isn't verified")).toBeInTheDocument();
  });
});

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockAuth = {
  user: { username: 'paul', email: 'p@x.com', role: 'SoftwareAdmin' },
  changePassword: vi.fn(),
  getMfaStatus: vi.fn(),
};
vi.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));

import MyProfile, { passwordProblems } from './MyProfile';

beforeEach(() => {
  mockAuth.getMfaStatus.mockResolvedValue({ totpEnabled: true });
});

describe('passwordProblems', () => {
  test('mirrors the pool policy', () => {
    expect(passwordProblems('short')).toEqual(['at least 10 characters', 'an uppercase letter', 'a number']);
    expect(passwordProblems('GoodPassw0rd')).toEqual([]);
  });
});

describe('MyProfile', () => {
  test('shows account details and authenticator status', async () => {
    render(<MyProfile />);
    expect(screen.getByText('paul')).toBeInTheDocument();
    expect(screen.getByText('Software Admin')).toBeInTheDocument();
    expect(await screen.findByText('Set up')).toBeInTheDocument();
  });

  test('changes the password once the new one meets the policy and matches', async () => {
    const user = userEvent.setup();
    mockAuth.changePassword.mockResolvedValue(undefined);
    render(<MyProfile />);
    const save = screen.getByRole('button', { name: 'Change password' });

    await user.type(screen.getByLabelText('Current password'), 'OldPassw0rd!');
    await user.type(screen.getByLabelText('New password'), 'weak');
    expect(screen.getByText(/Needs at least 10 characters/)).toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'NewPassw0rd2026');
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassw0rd2027');
    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassw0rd2026');
    await user.click(save);

    expect(mockAuth.changePassword).toHaveBeenCalledWith('OldPassw0rd!', 'NewPassw0rd2026');
    expect(await screen.findByText('Password changed.')).toBeInTheDocument();
  });

  test('shows an incorrect current password error', async () => {
    const user = userEvent.setup();
    mockAuth.changePassword.mockRejectedValue(new Error('Incorrect username or password.'));
    render(<MyProfile />);
    await user.type(screen.getByLabelText('Current password'), 'wrong');
    await user.type(screen.getByLabelText('New password'), 'NewPassw0rd2026');
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassw0rd2026');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Incorrect username or password.')).toBeInTheDocument();
  });
});

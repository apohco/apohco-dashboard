import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mockAuth = { isAccountant: false };
vi.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));

import { HomeRedirect, RequireAccountant, RequireDashboard } from './RoleGuards';

const app = (path) => (
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route index element={<HomeRedirect />} />
      <Route element={<RequireAccountant />}>
        <Route path="/portal" element={<div>Portal page</div>} />
      </Route>
      <Route element={<RequireDashboard />}>
        <Route path="/financial/profit-and-loss" element={<div>P&L page</div>} />
        <Route path="/settings" element={<div>Settings page</div>} />
      </Route>
    </Routes>
  </MemoryRouter>
);

describe('role guards', () => {
  test.each(['/', '/financial/profit-and-loss', '/settings', '/portal'])('an accountant going to %s lands on the portal', (path) => {
    mockAuth.isAccountant = true;
    render(app(path));
    expect(screen.getByText('Portal page')).toBeInTheDocument();
  });

  test('everyone else goes to the P&L and cannot open the portal', () => {
    mockAuth.isAccountant = false;
    const { unmount } = render(app('/'));
    expect(screen.getByText('P&L page')).toBeInTheDocument();
    unmount();
    render(app('/portal'));
    expect(screen.getByText('P&L page')).toBeInTheDocument();
  });
});

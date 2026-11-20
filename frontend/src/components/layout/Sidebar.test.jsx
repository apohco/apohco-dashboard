import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mockAuth = { isControllerOwner: false };
vi.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));

import Sidebar from './Sidebar';
import RequireControllerOwner from '../auth/RequireControllerOwner';

describe('Sidebar', () => {
  test('hides the Controller section from everyone but the ControllerOwner', () => {
    mockAuth.isControllerOwner = false;
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(screen.getByText('Profit & Loss')).toBeInTheDocument();
    expect(screen.queryByText('Controller')).not.toBeInTheDocument();
  });

  test('shows the Controller pages to the ControllerOwner', () => {
    mockAuth.isControllerOwner = true;
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    for (const label of ['Controller', 'Overview', 'Ledger Browser', 'Entities']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('RequireControllerOwner', () => {
  const app = () => (
    <MemoryRouter initialEntries={['/controller']}>
      <Routes>
        <Route path="/" element={<div>Home</div>} />
        <Route element={<RequireControllerOwner />}>
          <Route path="/controller" element={<div>Controller page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );

  test('redirects anyone else home', () => {
    mockAuth.isControllerOwner = false;
    render(app());
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  test('lets the ControllerOwner in', () => {
    mockAuth.isControllerOwner = true;
    render(app());
    expect(screen.getByText('Controller page')).toBeInTheDocument();
  });
});

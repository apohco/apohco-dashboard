import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

// Navigation only; the API enforces the same split on every request.

// Where "/" (and unknown paths) lead: the portal for accountants, the P&L for everyone else.
export function HomeRedirect() {
  const { isAccountant } = useAuth();
  return <Navigate to={isAccountant ? '/portal' : '/financial/profit-and-loss'} replace />;
}

// The dashboard itself (reports, settings, Controller): never for accountants.
export function RequireDashboard() {
  const { isAccountant } = useAuth();
  if (isAccountant) return <Navigate to="/portal" replace />;
  return <Outlet />;
}

// The AJE portal: accountants only.
export function RequireAccountant() {
  const { isAccountant } = useAuth();
  if (!isAccountant) return <Navigate to="/" replace />;
  return <Outlet />;
}

import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

// Hides the Controller pages from everyone but the ControllerOwner. This
// is only for navigation; the API enforces the same rule on every request.
export default function RequireControllerOwner() {
  const { isControllerOwner } = useAuth();
  if (!isControllerOwner) return <Navigate to="/" replace />;
  return <Outlet />;
}

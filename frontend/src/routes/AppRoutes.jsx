import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import RequireAuth from '../components/auth/RequireAuth';
import Login from '../pages/Login';
import ProfitAndLossReport from '../pages/Financial/ProfitAndLossReport';
import BalanceSheetReport from '../pages/Financial/BalanceSheetReport';
import CashFlowReport from '../pages/Financial/CashFlowReport';
import SettingsHome from '../pages/Settings/SettingsHome';
import ManageGroups from '../pages/Settings/ManageGroups';
import QBOSetup from '../pages/Settings/QBOSetup';
import ChartOfAccountsSetup from '../pages/Settings/ChartOfAccountsSetup';
import ConsolidationGroups from '../pages/Settings/ConsolidationGroups';
import QBODataSync from '../pages/Settings/QBODataSync';
import CashFlowConfiguration from '../pages/Settings/CashFlowConfiguration';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/financial/profit-and-loss" replace />} />
          <Route path="financial/profit-and-loss" element={<ProfitAndLossReport />} />
          <Route path="financial/balance-sheet" element={<BalanceSheetReport />} />
          <Route path="financial/cash-flow" element={<CashFlowReport />} />
          <Route path="settings" element={<SettingsHome />} />
          <Route path="settings/groups" element={<ManageGroups />} />
          <Route path="settings/qbo-setup" element={<QBOSetup />} />
          <Route path="settings/chart-of-accounts" element={<ChartOfAccountsSetup />} />
          <Route path="settings/consolidation-groups" element={<ConsolidationGroups />} />
          <Route path="settings/qbo-data-sync" element={<QBODataSync />} />
          <Route path="settings/cash-flow-configuration" element={<CashFlowConfiguration />} />
          <Route path="*" element={<Navigate to="/financial/profit-and-loss" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

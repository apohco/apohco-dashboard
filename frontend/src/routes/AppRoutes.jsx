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
import ReportLayout from '../pages/Settings/ReportLayout';
import UserManagement from '../pages/Settings/UserManagement';
import MyProfile from '../pages/Profile/MyProfile';
import RequireControllerOwner from '../components/auth/RequireControllerOwner';
import ControllerOverview from '../pages/Controller/ControllerOverview';
import LedgerBrowser from '../pages/Controller/LedgerBrowser';
import EntitiesSetup from '../pages/Controller/EntitiesSetup';
import GlUpload from '../pages/Controller/GlUpload';
import ReviewQueue from '../pages/Controller/ReviewQueue';
import Vendors from '../pages/Controller/Vendors';
import VendorProfile from '../pages/Controller/VendorProfile';
import Conflicts from '../pages/Controller/Conflicts';
import Trends from '../pages/Controller/Trends';
import GoogleWorkspace from '../pages/Controller/GoogleWorkspace';
import AjeReports from '../pages/Controller/AjeReports';

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
          <Route path="settings/report-layout" element={<ReportLayout />} />
          <Route path="settings/users" element={<UserManagement />} />
          <Route path="profile" element={<MyProfile />} />
          <Route element={<RequireControllerOwner />}>
            <Route path="controller" element={<ControllerOverview />} />
            <Route path="controller/ledger" element={<LedgerBrowser />} />
            <Route path="controller/entities" element={<EntitiesSetup />} />
            <Route path="controller/upload" element={<GlUpload />} />
            <Route path="controller/review" element={<ReviewQueue />} />
            <Route path="controller/conflicts" element={<Conflicts />} />
            <Route path="controller/vendors" element={<Vendors />} />
            <Route path="controller/vendors/:vendorId" element={<VendorProfile />} />
            <Route path="controller/trends" element={<Trends />} />
            <Route path="controller/google" element={<GoogleWorkspace />} />
            <Route path="controller/aje" element={<AjeReports />} />
          </Route>
          <Route path="*" element={<Navigate to="/financial/profit-and-loss" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

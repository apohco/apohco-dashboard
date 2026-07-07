import axios from 'axios';
import apiClient from './client';

// Groups (Group Practices / tenants) — SoftwareAdmin only
export const listGroups = () => apiClient.get('/api/settings/groups').then((r) => r.data);

export const createGroup = (groupName, initialOwnerUserId) =>
  apiClient.post('/api/settings/groups', { groupName, initialOwnerUserId }).then((r) => r.data);

export const renameGroup = (groupId, groupName) =>
  apiClient.put(`/api/settings/groups/${groupId}`, { groupName }).then((r) => r.data);

export const deleteGroup = (groupId, force = false) =>
  apiClient.delete(`/api/settings/groups/${groupId}`, { params: force ? { force: 'true' } : {} });

// Account Groupings
export const listAccountGroupings = (groupId, accountType) =>
  apiClient
    .get('/api/settings/account-groupings', { params: { groupId, accountType } })
    .then((r) => r.data);

export const createAccountGrouping = (groupId, groupingName, accountType) =>
  apiClient
    .post('/api/settings/account-groupings', { groupId, groupingName, accountType })
    .then((r) => r.data);

export const renameAccountGrouping = (groupingId, groupId, groupingName) =>
  apiClient
    .put(`/api/settings/account-groupings/${groupingId}`, { groupId, groupingName })
    .then((r) => r.data);

export const deleteAccountGrouping = (groupingId, groupId) =>
  apiClient.delete(`/api/settings/account-groupings/${groupingId}`, { params: { groupId } });

// Chart of Accounts
export const listChartOfAccounts = (groupId, qboId) =>
  apiClient.get('/api/settings/chart-of-accounts', { params: { groupId, qboId } }).then((r) => r.data);

export const saveChartOfAccounts = (groupId, mappings) =>
  apiClient.put('/api/settings/chart-of-accounts', { groupId, mappings }).then((r) => r.data);

// Consolidation Groups
export const listConsolidationGroups = (groupId) =>
  apiClient
    .get('/api/settings/consolidation-groups', { params: { groupId } })
    .then((r) => r.data);

export const createConsolidationGroup = (groupId, consolidationGroupName, qbos) =>
  apiClient
    .post('/api/settings/consolidation-groups', { groupId, consolidationGroupName, qbos })
    .then((r) => r.data);

export const updateConsolidationGroup = (consolidationGroupId, groupId, consolidationGroupName, qbos) =>
  apiClient
    .put(`/api/settings/consolidation-groups/${consolidationGroupId}`, {
      groupId,
      consolidationGroupName,
      qbos,
    })
    .then((r) => r.data);

export const deleteConsolidationGroup = (consolidationGroupId, groupId) =>
  apiClient.delete(`/api/settings/consolidation-groups/${consolidationGroupId}`, {
    params: { groupId },
  });

// Report Layout (one Report View's ordered Grouping/Total/Net rows —
// replaces the old Cash Flow Mappings page, which is now just a CashFlow
// Report View)
export const getReportLayout = (groupId, statement, reportViewId) =>
  apiClient
    .get('/api/settings/report-layout', { params: { groupId, statement, reportViewId } })
    .then((r) => r.data);

export const saveReportLayout = (groupId, statement, reportViewId, rows) =>
  apiClient.put('/api/settings/report-layout', { groupId, statement, reportViewId, rows }).then((r) => r.data);

// Report Views (multiple named layouts per Group+Statement, e.g. two
// different P&L views to switch between)
export const listReportViews = (groupId, statement) =>
  apiClient.get('/api/settings/report-views', { params: { groupId, statement } }).then((r) => r.data);

export const createReportView = (groupId, statement, viewName, cloneFromReportViewId) =>
  apiClient
    .post('/api/settings/report-views', { groupId, statement, viewName, cloneFromReportViewId })
    .then((r) => r.data);

export const renameReportView = (reportViewId, groupId, viewName) =>
  apiClient.put(`/api/settings/report-views/${reportViewId}`, { groupId, viewName }).then((r) => r.data);

export const setDefaultReportView = (reportViewId, groupId) =>
  apiClient.put(`/api/settings/report-views/${reportViewId}`, { groupId, setDefault: true }).then((r) => r.data);

export const deleteReportView = (reportViewId, groupId) =>
  apiClient.delete(`/api/settings/report-views/${reportViewId}`, { params: { groupId } });

// QBOs
export const listQBOs = (groupId) =>
  apiClient.get('/api/settings/qbos', { params: { groupId } }).then((r) => r.data);

export const updateQBO = (qboId, groupId, updates) =>
  apiClient.patch(`/api/settings/qbos/${qboId}`, { groupId, ...updates }).then((r) => r.data);

export const deleteQBO = (qboId, groupId) =>
  apiClient.delete(`/api/settings/qbos/${qboId}`, { params: { groupId } });

export const startQBOConnect = (groupId, qboName, isClassBased) =>
  apiClient.post('/api/qbo/connect', { groupId, qboName, isClassBased }).then((r) => r.data);

export const syncQBOData = (qboId, startDate, endDate) =>
  apiClient.post('/api/qbo/sync', { qboId, startDate, endDate }).then((r) => r.data);

export const createQBOManually = (groupId, qboName, isClassBased, classNames) =>
  apiClient
    .post('/api/settings/qbos', { groupId, qboName, isClassBased, classNames })
    .then((r) => r.data);

// Manual Upload (CSV/Excel)
export const presignManualUpload = (qboId, fileName) =>
  apiClient.post('/api/qbo/manual-upload/presign', { qboId, fileName }).then((r) => r.data);

// Direct PUT to S3 via the presigned URL — deliberately bypasses apiClient
// so our Cognito bearer token isn't attached (S3 presigned URLs sign the
// request themselves; an extra Authorization header would break it).
export const uploadFileToS3 = (uploadUrl, file, contentType) =>
  axios.put(uploadUrl, file, { headers: { 'Content-Type': contentType } });

export const previewManualUpload = (qboId, s3Key) =>
  apiClient.post('/api/qbo/manual-upload/preview', { qboId, s3Key }).then((r) => r.data);

export const confirmManualUpload = (qboId, s3Key, startDate, endDate) =>
  apiClient
    .post('/api/qbo/manual-upload/confirm', { qboId, s3Key, startDate, endDate })
    .then((r) => r.data);

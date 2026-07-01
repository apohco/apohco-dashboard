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

// Cash Flow Mappings
export const listCashFlowMappings = (groupId) =>
  apiClient.get('/api/settings/cash-flow-mappings', { params: { groupId } }).then((r) => r.data);

export const saveCashFlowMappings = (groupId, mappings) =>
  apiClient.put('/api/settings/cash-flow-mappings', { groupId, mappings }).then((r) => r.data);

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

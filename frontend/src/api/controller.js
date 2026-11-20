import apiClient from './client';

// Controller module API. Every route requires SoftwareAdmin + the
// ControllerOwner Cognito group (enforced server-side).

export const getControllerOverview = (groupId) =>
  apiClient.get('/api/controller/overview', { params: { groupId } }).then((r) => r.data);

export const startControllerPull = (groupId, qboId, fromMonth, toMonth) =>
  apiClient.post('/api/controller/sync', { groupId, qboId, fromMonth, toMonth }).then((r) => r.data);

export const listControllerJobs = (groupId) =>
  apiClient.get('/api/controller/jobs', { params: { groupId } }).then((r) => r.data);

export const getControllerJob = (groupId, jobId) =>
  apiClient.get(`/api/controller/jobs/${jobId}`, { params: { groupId } }).then((r) => r.data);

// params: { qboId, fromMonth, toMonth?, snapshotId?, compare?, payee?,
//           account?, className?, changeType?, limit?, offset? }
export const listControllerLines = (groupId, params) =>
  apiClient.get('/api/controller/lines', { params: { groupId, ...params } }).then((r) => r.data);

export const listControllerEntities = (groupId) =>
  apiClient.get('/api/controller/entities', { params: { groupId } }).then((r) => r.data);

export const createControllerEntity = (groupId, entity) =>
  apiClient.post('/api/controller/entities', { groupId, ...entity }).then((r) => r.data);

export const updateControllerEntity = (groupId, entityId, entity) =>
  apiClient.put(`/api/controller/entities/${entityId}`, { groupId, ...entity }).then((r) => r.data);

export const deleteControllerEntity = (groupId, entityId) =>
  apiClient.delete(`/api/controller/entities/${entityId}`, { params: { groupId } });

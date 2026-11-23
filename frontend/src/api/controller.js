import axios from 'axios';
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

// GL file uploads. Flow: createControllerUpload -> PUT the file to the
// returned uploadUrl -> analyzeControllerUpload (as often as the mapping
// changes) -> importControllerUpload.
export const createControllerUpload = (groupId, qboId, fileName) =>
  apiClient.post('/api/controller/uploads', { groupId, qboId, fileName }).then((r) => r.data);

export const putControllerUploadFile = (uploadUrl, file, contentType) =>
  axios.put(uploadUrl, file, { headers: { 'Content-Type': contentType } });

// options: { headerRow?, mapping?, amountConvention?, classifications? }
export const analyzeControllerUpload = (groupId, uploadId, options = {}) =>
  apiClient.post(`/api/controller/uploads/${uploadId}/analyze`, { groupId, ...options }).then((r) => r.data);

// options: { headerRow, mapping, amountConvention, classifications, fromMonth, toMonth }
export const importControllerUpload = (groupId, uploadId, options) =>
  apiClient.post(`/api/controller/uploads/${uploadId}/import`, { groupId, ...options }).then((r) => r.data);

export const listControllerUploads = (groupId) =>
  apiClient.get('/api/controller/uploads', { params: { groupId } }).then((r) => r.data);

// Review (Phase 2).
export const getReviewSettings = (groupId) =>
  apiClient.get('/api/controller/review/settings', { params: { groupId } }).then((r) => r.data);

export const saveReviewSettings = (groupId, settings) =>
  apiClient.put('/api/controller/review/settings', { groupId, ...settings }).then((r) => r.data);

export const listReviewRuns = (groupId, qboId, month) =>
  apiClient.get('/api/controller/review/runs', { params: { groupId, qboId, month } }).then((r) => r.data);

export const startReviewRun = (groupId, qboId, month) =>
  apiClient.post('/api/controller/review/runs', { groupId, qboId, month }).then((r) => r.data);

// params: { runId, status?, reviewState?, accountType?, account?, vendor?, entityId?, search?, limit?, offset? }
export const listReviewLines = (groupId, params) =>
  apiClient.get('/api/controller/review/lines', { params: { groupId, ...params } }).then((r) => r.data);

// body: { runId, action, lineIds | (filter + expectedCount), entityId?, allocations?,
//         account?: { code, name }, counterpartyEntityId?, note? }
export const saveReviewDecisions = (groupId, body) =>
  apiClient.post('/api/controller/review/decisions', { groupId, ...body }).then((r) => r.data);

// A file's accounts (for Reclassify) and its Due To/From accounts:
// { ownerEntityId, accounts: [{ code, name, type }], dueToFrom: [{ entityId, account }] }
export const getReviewAccounts = (groupId, qboId) =>
  apiClient.get('/api/controller/review/accounts', { params: { groupId, qboId } }).then((r) => r.data);

// account: { code, name }, or null to clear.
export const saveDueToFromAccount = (groupId, qboId, counterpartyEntityId, account) =>
  apiClient.put('/api/controller/review/due-to-from', { groupId, qboId, counterpartyEntityId, account }).then((r) => r.data);

// Vendors.
export const listVendors = (groupId) =>
  apiClient.get('/api/controller/vendors', { params: { groupId } }).then((r) => r.data);

export const updateVendor = (groupId, vendorId, body) =>
  apiClient.put(`/api/controller/vendors/${vendorId}`, { groupId, ...body }).then((r) => r.data);

export const mergeVendor = (groupId, vendorId, fromVendorId) =>
  apiClient.post(`/api/controller/vendors/${vendorId}/merge`, { groupId, fromVendorId }).then((r) => r.data);

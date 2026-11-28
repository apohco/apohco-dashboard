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

// Conflicts (Phase 2b). resolution: 'LineOnly' | 'RuleWins' | 'RuleWinsRelabel'.
export const listConflicts = (groupId, runId) =>
  apiClient.get('/api/controller/conflicts', { params: { groupId, runId } }).then((r) => r.data);

export const previewRelabel = (groupId, runId, lineId) =>
  apiClient.post(`/api/controller/conflicts/${lineId}/preview`, { groupId, runId }).then((r) => r.data);

// body: { resolution, entityId? (LineOnly), requestAje?, expectedRelabelCount? (RuleWinsRelabel), note? }
export const resolveConflict = (groupId, runId, lineId, body) =>
  apiClient.post(`/api/controller/conflicts/${lineId}/resolve`, { groupId, runId, ...body }).then((r) => r.data);

// Trends (Phase 2b): month defaults to the latest stored month.
export const getTrends = (groupId, month) =>
  apiClient.get('/api/controller/trends', { params: { groupId, ...(month ? { month } : {}) } }).then((r) => r.data);

// Vendors.
export const getVendorProfile = (groupId, vendorId) =>
  apiClient.get(`/api/controller/vendors/${vendorId}`, { params: { groupId } }).then((r) => r.data);

// rule: { defaultEntityId, keywords }; months 3..12. Nothing is saved.
export const testVendorRule = (groupId, vendorId, rule, months) =>
  apiClient.post(`/api/controller/vendors/${vendorId}/rules/test`, { groupId, rule, months }).then((r) => r.data);

export const listVendors = (groupId) =>
  apiClient.get('/api/controller/vendors', { params: { groupId } }).then((r) => r.data);

export const updateVendor = (groupId, vendorId, body) =>
  apiClient.put(`/api/controller/vendors/${vendorId}`, { groupId, ...body }).then((r) => r.data);

export const mergeVendor = (groupId, vendorId, fromVendorId) =>
  apiClient.post(`/api/controller/vendors/${vendorId}/merge`, { groupId, fromVendorId }).then((r) => r.data);

// AI matching (Phase 3). The AI only suggests; nothing is decided here.
export const getAiStatus = (groupId, runId) =>
  apiClient.get('/api/controller/ai/status', { params: { groupId, runId } }).then((r) => r.data);

export const getAiUsage = (groupId) =>
  apiClient.get('/api/controller/ai/usage', { params: { groupId } }).then((r) => r.data);

// body: { kind: 'Review', runId } | { kind: 'RuleTest', vendorId, ruleText, months? }
//     | { kind: 'Backtest', qboId, month? }
export const startAiJob = (groupId, body) =>
  apiClient.post('/api/controller/ai/jobs', { groupId, ...body }).then((r) => r.data);

export const getAiJob = (groupId, jobId) =>
  apiClient.get(`/api/controller/ai/jobs/${jobId}`, { params: { groupId } }).then((r) => r.data);

// Google Workspace connection and opted-in sources (Phase 4).
export const getGoogleSettings = (groupId) =>
  apiClient.get('/api/controller/google', { params: { groupId } }).then((r) => r.data);

export const saveGoogleSettings = (groupId, adminEmail) =>
  apiClient.put('/api/controller/google', { groupId, adminEmail }).then((r) => r.data);

export const testGoogleConnection = (groupId) =>
  apiClient.post('/api/controller/google/test', { groupId }).then((r) => r.data);

export const getGoogleDirectory = (groupId) =>
  apiClient.get('/api/controller/google/directory', { params: { groupId } }).then((r) => r.data);

// kind: 'Mailbox' | 'UserDrive' | 'SharedDrive'
export const setGoogleSource = (groupId, { kind, sourceKey, displayName, enabled }) =>
  apiClient.put('/api/controller/google/sources', { groupId, kind, sourceKey, displayName, enabled }).then((r) => r.data);

// Invoice folders (Phase 4b): only these are indexed in Drive.
// actAs: the workspace account that can read the folder (default: the admin).
export const addGoogleFolder = (groupId, link, actAs) =>
  apiClient.post('/api/controller/google/folders', { groupId, link, ...(actAs ? { actAs } : {}) }).then((r) => r.data);

export const indexGoogleFolder = (groupId, sourceId) =>
  apiClient.post(`/api/controller/google/folders/${sourceId}/index`, { groupId }).then((r) => r.data);

export const removeGoogleFolder = (groupId, sourceId) =>
  apiClient.delete(`/api/controller/google/folders/${sourceId}`, { params: { groupId } }).then((r) => r.data);

// Search the opted-in sources for invoice numbers (a payment covering
// several invoices). numbers: list or "4471, 4472".
export const searchInvoiceNumbers = (groupId, runId, lineId, numbers) =>
  apiClient.post('/api/controller/evidence/invoices', { groupId, runId, lineId, numbers }).then((r) => r.data);

// Save as support (Phase 4b).
export const confirmEvidence = (groupId, runId, lineId, candidateId) =>
  apiClient.post(`/api/controller/evidence/${candidateId}/confirm`, { groupId, runId, lineId }).then((r) => r.data);

export const getSavedEvidenceDownload = (groupId, savedId) =>
  apiClient.get(`/api/controller/evidence/saved/${savedId}/download`, { params: { groupId } }).then((r) => r.data);

// Evidence for review lines (Phase 4).
export const getLineEvidence = (groupId, runId, lineId) =>
  apiClient.get('/api/controller/evidence', { params: { groupId, runId, lineId } }).then((r) => r.data);

export const findEvidence = (groupId, runId, lineId) =>
  apiClient.post('/api/controller/evidence/find', { groupId, runId, lineId }).then((r) => r.data);

export const getEvidencePreview = (groupId, candidateId) =>
  apiClient.get(`/api/controller/evidence/${candidateId}/preview`, { params: { groupId } }).then((r) => r.data);

// body: { runId, lineIds } | { runId, filter, expectedCount }
export const startEvidenceSearch = (groupId, body) =>
  apiClient.post('/api/controller/review/evidence-search', { groupId, ...body }).then((r) => r.data);

export const getEvidenceJob = (groupId, jobId) =>
  apiClient.get(`/api/controller/evidence/jobs/${jobId}`, { params: { groupId } }).then((r) => r.data);

// AJE reports (Phase 5a): recommended adjusting entries. Nothing is
// written to QuickBooks; the accountant books them.
export const getAjeOverview = (groupId) =>
  apiClient.get('/api/controller/aje', { params: { groupId } }).then((r) => r.data);

// body: { defaultGrouping?, files?: [{ qboId, fileCode }] }
export const saveAjeSettings = (groupId, body) =>
  apiClient.put('/api/controller/aje/settings', { groupId, ...body }).then((r) => r.data);

export const getAjeDraft = (groupId, { qboId, month, grouping, reviseReportId } = {}) =>
  apiClient
    .get('/api/controller/aje/draft', {
      params: { groupId, qboId, month, ...(grouping ? { grouping } : {}), ...(reviseReportId ? { reviseReportId } : {}) },
    })
    .then((r) => r.data);

// body: { qboId, month, grouping, expectedKeys, include: [{ key, memo? }], reviseReportId?, note? }
export const publishAjeReport = (groupId, body) =>
  apiClient.post('/api/controller/aje/reports', { groupId, ...body }).then((r) => r.data);

export const getAjeReport = (groupId, reportId) =>
  apiClient.get(`/api/controller/aje/reports/${reportId}`, { params: { groupId } }).then((r) => r.data);

// format: 'pdf' | 'xlsx'. Returns { url, fileName } (a 5-minute link).
export const exportAjeReport = (groupId, reportId, format, includeSupport = true) =>
  apiClient.post(`/api/controller/aje/reports/${reportId}/export`, { groupId, format, includeSupport }).then((r) => r.data);

export const checkAjePosted = (groupId, qboId) =>
  apiClient.post('/api/controller/aje/check-posted', { groupId, qboId }).then((r) => r.data);

import apiClient from './client';

// Accountant AJE portal API (Accountant role only, enforced server-side).
// The server decides which Groups and files the caller can see; groupId
// here is only a filter.

export const listPortalReports = (groupId) =>
  apiClient.get('/api/controller/portal/reports', { params: groupId ? { groupId } : {} }).then((r) => r.data);

export const getPortalReport = (reportId) =>
  apiClient.get(`/api/controller/portal/reports/${reportId}`).then((r) => r.data);

export const setPortalEntryStatus = (entryId, status, reason) =>
  apiClient.put(`/api/controller/portal/entries/${entryId}/status`, { status, reason }).then((r) => r.data);

export const addPortalComment = (entryId, body) =>
  apiClient.post(`/api/controller/portal/entries/${entryId}/comments`, { body }).then((r) => r.data);

export const getPortalDoc = (reportId, savedId) =>
  apiClient.get(`/api/controller/portal/reports/${reportId}/docs/${savedId}`).then((r) => r.data);

export const exportPortalReport = (reportId, format) =>
  apiClient.post(`/api/controller/portal/reports/${reportId}/export`, { format }).then((r) => r.data);

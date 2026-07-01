import apiClient from './client';

const post = (path, body) => apiClient.post(path, body).then((r) => r.data);

export const getProfitAndLoss = (payload) => post('/api/reports/profit-and-loss', payload);
export const getBalanceSheet = (payload) => post('/api/reports/balance-sheet', payload);
export const getCashFlow = (payload) => post('/api/reports/cash-flow', payload);

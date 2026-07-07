import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { Box, Typography, TextField, Select, MenuItem, CircularProgress, Alert } from '@mui/material';
import ReportToolbar from '../../components/reports/ReportToolbar';
import ReportTable from '../../components/reports/ReportTable';
import ReportNotConfigured from '../../components/reports/ReportNotConfigured';
import EmptyState from '../../components/EmptyState';
import { useAuth } from '../../context/AuthContext';
import useEntityOptions, { parseEntityValue } from '../../hooks/useEntityOptions';
import { buildRangePeriods } from '../../utils/periods';
import { getCashFlow } from '../../api/reports';
import { listReportViews } from '../../api/settings';

export default function CashFlowReport() {
  const { groupId } = useAuth();
  const { options: entityOptions } = useEntityOptions(groupId);

  const [viewMode, setViewMode] = useState('single');
  const [entity, setEntity] = useState('');
  const [detailLevel, setDetailLevel] = useState('summary');
  const [selectedMonth, setSelectedMonth] = useState(dayjs().format('YYYY-MM'));

  const [reportViews, setReportViews] = useState([]);
  const [reportViewId, setReportViewId] = useState('');

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const periods = useMemo(() => buildRangePeriods(viewMode, selectedMonth), [viewMode, selectedMonth]);

  useEffect(() => {
    if (!groupId) return;
    listReportViews(groupId, 'CashFlow').then((list) => {
      setReportViews(list);
      setReportViewId((prev) =>
        prev && list.some((v) => v.reportViewId === prev)
          ? prev
          : list.find((v) => v.isDefault)?.reportViewId || list[0]?.reportViewId || ''
      );
    });
  }, [groupId]);

  useEffect(() => {
    if (!groupId || !entity) return;
    const { entityType, entityId } = parseEntityValue(entity);
    setLoading(true);
    setError(null);
    getCashFlow({ groupId, entityType, entityId, periods, detailLevel, reportViewId })
      .then(setReport)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [groupId, entity, periods, detailLevel, reportViewId]);

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Cash Flow
      </Typography>
      <ReportToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        entity={entity}
        onEntityChange={setEntity}
        entityOptions={entityOptions}
        detailLevel={detailLevel}
        onDetailLevelChange={setDetailLevel}
        lastSynced={report?.lastSyncedAt ? dayjs(report.lastSyncedAt).format('MMM D, YYYY h:mm A') : null}
        extraControls={
          <>
            {reportViews.length > 1 && (
              <Select size="small" value={reportViewId} onChange={(e) => setReportViewId(e.target.value)}>
                {reportViews.map((v) => (
                  <MenuItem key={v.reportViewId} value={v.reportViewId}>
                    {v.viewName}
                  </MenuItem>
                ))}
              </Select>
            )}
            <TextField
              size="small"
              type="month"
              label="Month"
              InputLabelProps={{ shrink: true }}
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
            />
          </>
        }
      />

      {!entity && <EmptyState message="Select a QBO or Consolidation Group to view its Cash Flow." />}
      {loading && (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {error && <Alert severity="error">{error.response?.data?.message || error.message}</Alert>}
      {report && !loading && report.configured === false && <ReportNotConfigured statementLabel="Cash Flow" />}
      {report && !loading && report.configured && !report.lastSyncedAt && (
        <EmptyState message="No Cash Flow data available for this selection. Connect a QBO and run a data sync to get started." />
      )}
      {report && !loading && report.configured && report.lastSyncedAt && (
        <ReportTable periods={periods} detailLevel={detailLevel} rows={report.rows} />
      )}
    </Box>
  );
}

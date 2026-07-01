import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { Box, Typography, TextField, CircularProgress, Alert } from '@mui/material';
import ReportToolbar from '../../components/reports/ReportToolbar';
import ReportTable from '../../components/reports/ReportTable';
import EmptyState from '../../components/EmptyState';
import { useAuth } from '../../context/AuthContext';
import useEntityOptions, { parseEntityValue } from '../../hooks/useEntityOptions';
import { buildRangePeriods } from '../../utils/periods';
import { getCashFlow } from '../../api/reports';

export default function CashFlowReport() {
  const { groupId } = useAuth();
  const { options: entityOptions } = useEntityOptions(groupId);

  const [viewMode, setViewMode] = useState('single');
  const [entity, setEntity] = useState('');
  const [detailLevel, setDetailLevel] = useState('summary');
  const [selectedMonth, setSelectedMonth] = useState(dayjs().format('YYYY-MM'));

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const periods = useMemo(() => buildRangePeriods(viewMode, selectedMonth), [viewMode, selectedMonth]);

  useEffect(() => {
    if (!groupId || !entity) return;
    const { entityType, entityId } = parseEntityValue(entity);
    setLoading(true);
    setError(null);
    getCashFlow({ groupId, entityType, entityId, periods, detailLevel })
      .then(setReport)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [groupId, entity, periods, detailLevel]);

  const isEmpty =
    report &&
    report.operations.groupings.length === 0 &&
    report.investing.groupings.length === 0 &&
    report.financing.groupings.length === 0;

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
          <TextField
            size="small"
            type="month"
            label="Month"
            InputLabelProps={{ shrink: true }}
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
          />
        }
      />

      {!entity && <EmptyState message="Select a QBO or Consolidation Group to view its Cash Flow." />}
      {loading && (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {error && <Alert severity="error">{error.response?.data?.message || error.message}</Alert>}
      {isEmpty && (
        <EmptyState message="No Cash Flow Groupings are configured yet. Assign Groupings to Operations/Investing/Financing in Settings, then run a data sync." />
      )}
      {report && !loading && !isEmpty && (
        <ReportTable
          periods={periods}
          detailLevel={detailLevel}
          sections={[
            { title: 'Operations', section: report.operations },
            { title: 'Investing', section: report.investing },
            { title: 'Financing', section: report.financing },
          ]}
          summaryRows={[{ label: 'Net Cash Change', valuesByPeriod: report.netCashChangeByPeriod }]}
        />
      )}
    </Box>
  );
}

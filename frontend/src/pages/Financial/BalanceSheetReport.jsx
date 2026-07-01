import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { Box, Typography, TextField, CircularProgress, Alert } from '@mui/material';
import ReportToolbar from '../../components/reports/ReportToolbar';
import ReportTable from '../../components/reports/ReportTable';
import EmptyState from '../../components/EmptyState';
import { useAuth } from '../../context/AuthContext';
import useEntityOptions, { parseEntityValue } from '../../hooks/useEntityOptions';
import { buildAsOfPeriods } from '../../utils/periods';
import { getBalanceSheet } from '../../api/reports';

export default function BalanceSheetReport() {
  const { groupId } = useAuth();
  const { options: entityOptions } = useEntityOptions(groupId);

  const [viewMode, setViewMode] = useState('single');
  const [entity, setEntity] = useState('');
  const [detailLevel, setDetailLevel] = useState('summary');
  const [selectedMonth, setSelectedMonth] = useState(dayjs().format('YYYY-MM'));

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const periods = useMemo(() => buildAsOfPeriods(viewMode, selectedMonth), [viewMode, selectedMonth]);

  useEffect(() => {
    if (!groupId || !entity) return;
    const { entityType, entityId } = parseEntityValue(entity);
    setLoading(true);
    setError(null);
    getBalanceSheet({ groupId, entityType, entityId, periods, detailLevel })
      .then(setReport)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [groupId, entity, periods, detailLevel]);

  const isEmpty =
    report && report.assets.groupings.length === 0 && report.liabilities.groupings.length === 0;

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Balance Sheet
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
            label="As of Month"
            InputLabelProps={{ shrink: true }}
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
          />
        }
      />

      {!entity && <EmptyState message="Select a QBO or Consolidation Group to view its Balance Sheet." />}
      {loading && (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {error && <Alert severity="error">{error.response?.data?.message || error.message}</Alert>}
      {isEmpty && (
        <EmptyState message="No Balance Sheet data available for this selection. Connect a QBO and run a data sync to get started." />
      )}
      {report && !loading && !isEmpty && (
        <ReportTable
          periods={periods}
          detailLevel={detailLevel}
          sections={[
            { title: 'Assets', section: report.assets },
            { title: 'Liabilities', section: report.liabilities },
            { title: 'Equity', section: report.equity },
          ]}
          summaryRows={[
            { label: 'Total Assets', valuesByPeriod: report.totalAssetsByPeriod },
            { label: 'Total Liabilities & Equity', valuesByPeriod: report.totalLiabilitiesAndEquityByPeriod },
          ]}
        />
      )}
    </Box>
  );
}

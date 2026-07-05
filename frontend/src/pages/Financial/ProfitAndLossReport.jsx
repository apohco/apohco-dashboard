import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { Box, Typography, ToggleButton, ToggleButtonGroup, TextField, CircularProgress, Alert } from '@mui/material';
import ReportToolbar from '../../components/reports/ReportToolbar';
import ReportTable from '../../components/reports/ReportTable';
import EmptyState from '../../components/EmptyState';
import { useAuth } from '../../context/AuthContext';
import useEntityOptions, { parseEntityValue } from '../../hooks/useEntityOptions';
import {
  buildRangePeriods,
  buildTtmPeriod,
  buildCompareTtmPeriods,
  buildCustomRangePeriods,
} from '../../utils/periods';
import { getProfitAndLoss } from '../../api/reports';

export default function ProfitAndLossReport() {
  const { groupId } = useAuth();
  const { options: entityOptions } = useEntityOptions(groupId);

  const [viewMode, setViewMode] = useState('single');
  const [periodType, setPeriodType] = useState('month'); // 'month' | 'ttm' -- applies to Single Month and Compare
  const [entity, setEntity] = useState('');
  const [detailLevel, setDetailLevel] = useState('summary');
  const [showPercentOfRevenue, setShowPercentOfRevenue] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(dayjs().format('YYYY-MM'));
  const [fromMonth, setFromMonth] = useState(dayjs().startOf('year').format('YYYY-MM'));
  const [toMonth, setToMonth] = useState(dayjs().format('YYYY-MM'));

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const periods = useMemo(() => {
    if (viewMode === 'multi') return buildCustomRangePeriods(fromMonth, toMonth);
    if (periodType === 'ttm') {
      return viewMode === 'compare' ? buildCompareTtmPeriods(selectedMonth) : buildTtmPeriod(selectedMonth);
    }
    return buildRangePeriods(viewMode, selectedMonth);
  }, [viewMode, periodType, selectedMonth, fromMonth, toMonth]);

  useEffect(() => {
    if (!groupId || !entity) return;
    const { entityType, entityId } = parseEntityValue(entity);
    setLoading(true);
    setError(null);
    getProfitAndLoss({ groupId, entityType, entityId, periods, detailLevel })
      .then(setReport)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [groupId, entity, periods, detailLevel]);

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Profit &amp; Loss
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
            {viewMode !== 'multi' && (
              <ToggleButtonGroup
                size="small"
                exclusive
                value={periodType}
                onChange={(e, v) => v && setPeriodType(v)}
              >
                <ToggleButton value="month">Month</ToggleButton>
                <ToggleButton value="ttm">Annual TTM</ToggleButton>
              </ToggleButtonGroup>
            )}
            {viewMode !== 'multi' && (
              <TextField
                size="small"
                type="month"
                label={periodType === 'ttm' ? 'TTM Ending' : 'Month'}
                InputLabelProps={{ shrink: true }}
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
              />
            )}
            {viewMode === 'multi' && (
              <>
                <TextField
                  size="small"
                  type="month"
                  label="From"
                  InputLabelProps={{ shrink: true }}
                  value={fromMonth}
                  onChange={(e) => setFromMonth(e.target.value)}
                />
                <TextField
                  size="small"
                  type="month"
                  label="To"
                  InputLabelProps={{ shrink: true }}
                  value={toMonth}
                  onChange={(e) => setToMonth(e.target.value)}
                />
              </>
            )}
            <ToggleButtonGroup
              size="small"
              exclusive
              value={showPercentOfRevenue ? 'on' : 'off'}
              onChange={(e, v) => v && setShowPercentOfRevenue(v === 'on')}
            >
              <ToggleButton value="off">$</ToggleButton>
              <ToggleButton value="on">% of Revenue</ToggleButton>
            </ToggleButtonGroup>
          </>
        }
      />

      {!entity && <EmptyState message="Select a QBO or Consolidation Group to view its P&L." />}
      {loading && (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {error && <Alert severity="error">{error.response?.data?.message || error.message}</Alert>}
      {report && !loading && report.income.groupings.length === 0 && report.expenses.groupings.length === 0 && (
        <EmptyState message="No P&L data available for this selection. Connect a QBO and run a data sync to get started." />
      )}
      {report && !loading && (report.income.groupings.length > 0 || report.expenses.groupings.length > 0) && (
        <ReportTable
          periods={periods}
          detailLevel={detailLevel}
          showPercentOfRevenue={showPercentOfRevenue}
          revenueByPeriod={report.income.totalsByPeriod}
          sections={[
            { title: 'Income', section: report.income },
            { title: 'Expenses', section: report.expenses },
          ]}
          summaryRows={[{ label: 'Net Income', valuesByPeriod: report.netIncomeByPeriod }]}
        />
      )}
    </Box>
  );
}

import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import {
  Box,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  Select,
  MenuItem,
  Paper,
  CircularProgress,
  Alert,
} from '@mui/material';
import ReportToolbar from '../../components/reports/ReportToolbar';
import ReportTable from '../../components/reports/ReportTable';
import ReportNotConfigured from '../../components/reports/ReportNotConfigured';
import EmptyState from '../../components/EmptyState';
import { useAuth } from '../../context/AuthContext';
import useEntityOptions, { parseEntityValue } from '../../hooks/useEntityOptions';
import { buildRangePeriods, buildTtmPeriod, buildCustomRangePeriods } from '../../utils/periods';
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

  // Compare mode's second column can independently pick a different
  // entity and/or a different date -- blank compareEntity means "same
  // entity as the primary column" (compare two periods for one entity).
  const [compareEntity, setCompareEntity] = useState('');
  const [comparePeriodType, setComparePeriodType] = useState('month');
  const [compareSelectedMonth, setCompareSelectedMonth] = useState(
    dayjs().subtract(1, 'year').format('YYYY-MM')
  );

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const periods = useMemo(() => {
    if (viewMode === 'multi') return buildCustomRangePeriods(fromMonth, toMonth);
    if (viewMode === 'compare') {
      const primary = periodType === 'ttm' ? buildTtmPeriod(selectedMonth)[0] : buildRangePeriods('single', selectedMonth)[0];
      const compareRaw =
        comparePeriodType === 'ttm' ? buildTtmPeriod(compareSelectedMonth)[0] : buildRangePeriods('single', compareSelectedMonth)[0];
      return [primary, { ...compareRaw, label: `${compareRaw.label} (Compare)` }];
    }
    if (periodType === 'ttm') return buildTtmPeriod(selectedMonth);
    return buildRangePeriods(viewMode, selectedMonth);
  }, [viewMode, periodType, selectedMonth, fromMonth, toMonth, comparePeriodType, compareSelectedMonth]);

  useEffect(() => {
    if (!groupId || !entity) return;
    const { entityType, entityId } = parseEntityValue(entity);
    setLoading(true);
    setError(null);

    if (viewMode === 'compare') {
      const { entityType: cEntityType, entityId: cEntityId } = parseEntityValue(compareEntity || entity);
      Promise.all([
        getProfitAndLoss({ groupId, entityType, entityId, periods: [periods[0]], detailLevel }),
        getProfitAndLoss({ groupId, entityType: cEntityType, entityId: cEntityId, periods: [periods[1]], detailLevel }),
      ])
        .then(([primaryReport, compareReport]) => {
          if (!primaryReport.configured) {
            setReport(primaryReport);
            return;
          }
          const compareRowsById = new Map((compareReport.rows || []).map((r) => [r.rowId, r]));
          const mergedRows = primaryReport.rows.map((r) => ({
            ...r,
            valuesByPeriod: { ...r.valuesByPeriod, ...(compareRowsById.get(r.rowId)?.valuesByPeriod || {}) },
          }));
          setReport({ ...primaryReport, rows: mergedRows });
        })
        .catch(setError)
        .finally(() => setLoading(false));
      return;
    }

    getProfitAndLoss({ groupId, entityType, entityId, periods, detailLevel })
      .then(setReport)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [groupId, entity, periods, detailLevel, viewMode, compareEntity]);

  const compareEntityLabel = entityOptions.find((o) => o.id === entity)?.label || 'same entity';

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

      {viewMode === 'compare' && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
            Compare to:
          </Typography>
          <Select size="small" displayEmpty value={compareEntity} onChange={(e) => setCompareEntity(e.target.value)}>
            <MenuItem value="">
              <em>Same entity ({compareEntityLabel})</em>
            </MenuItem>
            {entityOptions.map((opt) => (
              <MenuItem key={opt.id} value={opt.id}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={comparePeriodType}
            onChange={(e, v) => v && setComparePeriodType(v)}
          >
            <ToggleButton value="month">Month</ToggleButton>
            <ToggleButton value="ttm">Annual TTM</ToggleButton>
          </ToggleButtonGroup>
          <TextField
            size="small"
            type="month"
            label={comparePeriodType === 'ttm' ? 'TTM Ending' : 'Month'}
            InputLabelProps={{ shrink: true }}
            value={compareSelectedMonth}
            onChange={(e) => setCompareSelectedMonth(e.target.value)}
          />
        </Paper>
      )}

      {!entity && <EmptyState message="Select a QBO or Consolidation Group to view its P&L." />}
      {loading && (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {error && <Alert severity="error">{error.response?.data?.message || error.message}</Alert>}
      {report && !loading && report.configured === false && <ReportNotConfigured statementLabel="Profit & Loss" />}
      {report && !loading && report.configured && !report.lastSyncedAt && (
        <EmptyState message="No P&L data available for this selection. Connect a QBO and run a data sync to get started." />
      )}
      {report && !loading && report.configured && report.lastSyncedAt && (
        <ReportTable
          periods={periods}
          detailLevel={detailLevel}
          showPercentOfRevenue={showPercentOfRevenue}
          revenueByPeriod={report.rows.find((r) => r.isRevenueBase)?.valuesByPeriod}
          rows={report.rows}
          showTotalColumn={viewMode === 'multi'}
        />
      )}
    </Box>
  );
}

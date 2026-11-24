import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Link,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import EntityStackedBars from '../../components/controller/EntityStackedBars';
import { getTrends } from '../../api/controller';
import { addMonths, formatMonth, isMonth } from '../../utils/months';
import { formatCurrency } from '../../utils/format';

const errorText = (err) => err?.response?.data?.message || err?.message;
const pct = (share) => `${Math.round(share * 100)}%`;

export const ANOMALY_LABELS = {
  SplitShift: 'Split shift',
  SpendSpike: 'Spend spike',
  NewVendor: 'New vendor',
  MissingRecurring: 'Missing recurring charge',
};

// One-line description of a trend check result.
export function describeAnomaly(a, entityName) {
  switch (a.type) {
    case 'SplitShift':
      return `${a.vendorName}: ${entityName(a.entityId)} is ${pct(a.currentShare)} of this month's spend vs ${pct(a.baselineShare)} usually (${a.points > 0 ? '+' : ''}${a.points} points)`;
    case 'SpendSpike':
      return `${entityName(a.entityId)} · ${a.accountLabel}: ${formatCurrency(a.amount)} vs ${formatCurrency(a.baseline)} average${a.percent === null ? ' (no spend before)' : ` (+${a.percent}%)`}`;
    case 'NewVendor':
      return `${a.vendorName}: first time in the General Ledger`;
    case 'MissingRecurring':
      return `${a.vendorName}: nothing this month, after a charge in each of the last ${a.months} months (about ${formatCurrency(a.amount)})`;
    default:
      return a.type;
  }
}

// Review queue link for an anomaly: its file and vendor or account, in the
// month (a missing charge opens the last month it appeared).
export function reviewLink(a, month) {
  const params = new URLSearchParams({ month: a.type === 'MissingRecurring' ? addMonths(month, -1) : month });
  if (a.qboId) params.set('qboId', a.qboId);
  if (a.vendorName) params.set('vendor', a.vendorName);
  if (a.type === 'SpendSpike' && a.accountLabel) params.set('account', a.accountLabel.split(' ')[0]);
  return `/controller/review?${params.toString()}`;
}

export default function Trends() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [month, setMonth] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [vendorKey, setVendorKey] = useState('');

  const load = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getTrends(groupId, isMonth(month) ? month : undefined);
      setData(result);
      if (!month && result.month) setMonth(result.month);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [groupId, month]);
  useEffect(() => {
    load();
  }, [load]);

  const entities = useMemo(() => data?.entities || [], [data]);
  const entityName = useCallback((id) => (id ? entities.find((e) => e.entityId === id)?.entityName || 'Former entity' : 'Unassigned'), [entities]);
  const vendor = data?.vendorSplits?.find((v) => v.vendorKey === vendorKey) || data?.vendorSplits?.[0] || null;
  const s = data?.settings;

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Trends
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{errorText(error)}</Alert>}

      <Paper variant="outlined" sx={{ p: 2, mb: 2, display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField size="small" type="month" label="Month" InputLabelProps={{ shrink: true }} value={month} onChange={(e) => setMonth(e.target.value)} />
        {loading && <CircularProgress size={20} />}
        {s && (
          <Typography variant="body2" color="text.secondary">
            Expense lines from every file, with your decisions applied. Compared with the previous {data.baselineMonths?.length ?? 0} stored month
            {data.baselineMonths?.length === 1 ? '' : 's'} (up to {s.baselineMonths}). Thresholds are in Review → Settings.
          </Typography>
        )}
      </Paper>

      {data && !data.month && <Alert severity="info">No General Ledger is stored yet.</Alert>}
      {data?.month && (
        <>
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              Trend checks for {formatMonth(data.month)}
            </Typography>
            {data.anomalies.length === 0 ? (
              <Typography color="text.secondary" variant="body2">
                Nothing unusual this month.
              </Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Check</TableCell>
                    <TableCell>What changed</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.anomalies.map((a, i) => (
                    <TableRow key={`${a.type}-${a.vendorKey || a.accountKey}-${a.entityId}-${i}`}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <Chip size="small" variant="outlined" label={ANOMALY_LABELS[a.type]} />
                      </TableCell>
                      <TableCell>{describeAnomaly(a, entityName)}</TableCell>
                      <TableCell align="right">{formatCurrency(a.amount)}</TableCell>
                      <TableCell>
                        {a.qboId && (
                          <Link component={RouterLink} to={reviewLink(a, data.month)}>
                            Review
                          </Link>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Paper>

          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <EntityStackedBars title="Spend by entity by month" rows={data.entitySpend} months={data.months} entities={entities} />
          </Paper>

          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            {data.vendorSplits.length === 0 ? (
              <Typography color="text.secondary">No vendor spend in these months.</Typography>
            ) : (
              <>
                <Select
                  size="small"
                  value={vendor?.vendorKey || ''}
                  onChange={(e) => setVendorKey(e.target.value)}
                  sx={{ mb: 2, minWidth: 260 }}
                  inputProps={{ 'aria-label': 'Vendor' }}
                >
                  {data.vendorSplits.map((v) => (
                    <MenuItem key={v.vendorKey} value={v.vendorKey}>
                      {v.vendorName} · {formatCurrency(v.total)}
                    </MenuItem>
                  ))}
                </Select>
                {vendor && (
                  <EntityStackedBars title={`${vendor.vendorName}: split by entity`} rows={vendor.rows} months={data.months} entities={entities} percent />
                )}
              </>
            )}
          </Paper>
        </>
      )}
    </Box>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import { getControllerOverview, listControllerLines } from '../../api/controller';
import { formatCurrency } from '../../utils/format';
import { addMonths, currentMonth, formatMonth, isMonth } from '../../utils/months';

const PAGE_SIZES = [100, 200, 500];
const CHANGE_COLORS = { added: 'success', changed: 'warning', removed: 'error' };
const FILTER_DEBOUNCE_MS = 350;

const errorText = (err) => err?.response?.data?.message || err?.message;

function useDebounced(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// What changed on a line since the previous pull, for the tooltip.
export function describeChange(line) {
  const prev = line.previous;
  if (!prev) return '';
  const diffs = [];
  if (prev.txnDate !== line.txnDate) diffs.push(`date was ${prev.txnDate}`);
  if (prev.debit !== line.debit) diffs.push(`debit was ${formatCurrency(prev.debit)}`);
  if (prev.credit !== line.credit) diffs.push(`credit was ${formatCurrency(prev.credit)}`);
  if ((prev.className || '') !== (line.className || '')) diffs.push(`class was ${prev.className || '(none)'}`);
  if ((prev.payeeName || '') !== (line.payeeName || '')) diffs.push(`payee was ${prev.payeeName || '(none)'}`);
  if ((prev.memo || '') !== (line.memo || '')) diffs.push(`memo was "${prev.memo || ''}"`);
  return diffs.join('; ');
}

export default function LedgerBrowser() {
  const [searchParams] = useSearchParams();
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();

  const initialMonth = isMonth(searchParams.get('month')) ? searchParams.get('month') : addMonths(currentMonth(), -1);
  const [qbos, setQbos] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [qboId, setQboId] = useState(searchParams.get('qboId') || '');
  const [fromMonth, setFromMonth] = useState(initialMonth);
  const [toMonth, setToMonth] = useState(initialMonth);
  const [snapshotId, setSnapshotId] = useState('');
  const [compare, setCompare] = useState(false);
  const [changeType, setChangeType] = useState('');
  const [payee, setPayee] = useState('');
  const [account, setAccount] = useState('');
  const [className, setClassName] = useState('');
  const [unclassifiedOnly, setUnclassifiedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(200);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const singleMonth = fromMonth === toMonth;
  // Debounced as a string so the value is stable between renders.
  const debouncedKey = useDebounced(JSON.stringify({ payee, account, className }), FILTER_DEBOUNCE_MS);
  const debouncedText = useMemo(() => JSON.parse(debouncedKey), [debouncedKey]);

  useEffect(() => {
    if (!groupId) return;
    getControllerOverview(groupId)
      .then((ov) => {
        setQbos(ov.qbos);
        setSnapshots(ov.snapshots);
      })
      .catch(setError);
  }, [groupId]);

  // Pulls of the selected file and month, newest first, for the picker.
  const monthSnapshots = useMemo(
    () =>
      snapshots
        .filter((s) => s.qboId === qboId && s.month === fromMonth)
        .sort((a, b) => (a.pulledAt < b.pulledAt ? 1 : -1)),
    [snapshots, qboId, fromMonth]
  );

  useEffect(() => {
    setSnapshotId('');
    setPage(0);
  }, [qboId, fromMonth, toMonth]);

  useEffect(() => {
    if (!singleMonth) {
      setCompare(false);
      setChangeType('');
    }
  }, [singleMonth]);

  useEffect(() => {
    setPage(0);
  }, [debouncedText, unclassifiedOnly, compare, changeType, snapshotId, pageSize]);

  useEffect(() => {
    if (!groupId || !qboId || !isMonth(fromMonth) || !isMonth(toMonth) || toMonth < fromMonth) {
      setData(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = {
      qboId,
      fromMonth,
      toMonth,
      limit: pageSize,
      offset: page * pageSize,
      ...(snapshotId && singleMonth ? { snapshotId } : {}),
      ...(compare && singleMonth ? { compare: 'previous' } : {}),
      ...(compare && changeType ? { changeType } : {}),
      ...(debouncedText.payee ? { payee: debouncedText.payee } : {}),
      ...(debouncedText.account ? { account: debouncedText.account } : {}),
      ...(unclassifiedOnly ? { className: '__none__' } : debouncedText.className ? { className: debouncedText.className } : {}),
    };
    listControllerLines(groupId, params)
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [groupId, qboId, fromMonth, toMonth, snapshotId, compare, changeType, debouncedText, unclassifiedOnly, page, pageSize, singleMonth]);

  const comparing = Boolean(data?.previousSnapshot);

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Ledger Browser
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
          <Select
            size="small"
            displayEmpty
            value={qboId}
            onChange={(e) => setQboId(e.target.value)}
            sx={{ minWidth: 220 }}
            inputProps={{ 'aria-label': 'QBO file' }}
          >
            <MenuItem value="" disabled>
              Select a QBO file
            </MenuItem>
            {qbos.map((q) => (
              <MenuItem key={q.qboId} value={q.qboId}>
                {q.qboName}
              </MenuItem>
            ))}
          </Select>
          <TextField size="small" type="month" label="From" InputLabelProps={{ shrink: true }} value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} />
          <TextField size="small" type="month" label="To" InputLabelProps={{ shrink: true }} value={toMonth} onChange={(e) => setToMonth(e.target.value)} />
          {singleMonth && monthSnapshots.length > 1 && (
            <Select
              size="small"
              displayEmpty
              value={snapshotId}
              onChange={(e) => setSnapshotId(e.target.value)}
              sx={{ minWidth: 220 }}
              inputProps={{ 'aria-label': 'Pull' }}
            >
              <MenuItem value="">Latest pull</MenuItem>
              {monthSnapshots.map((s) => (
                <MenuItem key={s.snapshotId} value={s.snapshotId}>
                  Pulled {new Date(s.pulledAt).toLocaleString()}
                </MenuItem>
              ))}
            </Select>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField size="small" label="Payee" value={payee} onChange={(e) => setPayee(e.target.value)} />
          <TextField size="small" label="Account" value={account} onChange={(e) => setAccount(e.target.value)} />
          <TextField size="small" label="Class" value={className} disabled={unclassifiedOnly} onChange={(e) => setClassName(e.target.value)} />
          <FormControlLabel
            control={<Checkbox size="small" checked={unclassifiedOnly} onChange={(e) => setUnclassifiedOnly(e.target.checked)} />}
            label="No class only"
          />
          <Tooltip title={singleMonth ? '' : 'Pick a single month to compare pulls'}>
            <FormControlLabel
              control={<Checkbox size="small" checked={compare} disabled={!singleMonth} onChange={(e) => setCompare(e.target.checked)} />}
              label="Compare with previous pull"
            />
          </Tooltip>
          {compare && (
            <Select size="small" displayEmpty value={changeType} onChange={(e) => setChangeType(e.target.value)} inputProps={{ 'aria-label': 'Change type' }}>
              <MenuItem value="">All lines</MenuItem>
              <MenuItem value="added">Added</MenuItem>
              <MenuItem value="changed">Changed</MenuItem>
              <MenuItem value="removed">Removed</MenuItem>
              <MenuItem value="unchanged">Unchanged</MenuItem>
            </Select>
          )}
        </Box>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
      {!qboId && <Typography color="text.secondary">Select a QBO file and month.</Typography>}
      {loading && !data && <CircularProgress size={24} />}

      {data && data.snapshots.length === 0 && (
        <Alert severity="info">
          Nothing stored for {formatMonth(fromMonth)}
          {singleMonth ? '' : ` – ${formatMonth(toMonth)}`} yet. Start a pull from the Controller overview.
        </Alert>
      )}

      {data && data.snapshots.length > 0 && (
        <>
          <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mb: 1 }}>
            <Typography variant="body2">
              {data.total.toLocaleString()} lines · Debits {formatCurrency(data.totals.debit)} · Credits{' '}
              {formatCurrency(data.totals.credit)}
            </Typography>
            {compare && !comparing && (
              <Typography variant="body2" color="text.secondary">
                This is the first pull of this month, so there is nothing to compare against.
              </Typography>
            )}
            {data.changeCounts && (
              <Typography variant="body2" color="text.secondary" data-testid="change-counts">
                Since pull of {new Date(data.previousSnapshot.pulledAt).toLocaleString()}: {data.changeCounts.added} added,{' '}
                {data.changeCounts.changed} changed, {data.changeCounts.removed} removed
              </Typography>
            )}
          </Box>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Doc #</TableCell>
                  <TableCell>Payee</TableCell>
                  <TableCell>Memo</TableCell>
                  <TableCell>Account</TableCell>
                  <TableCell>Class</TableCell>
                  <TableCell align="right">Debit</TableCell>
                  <TableCell align="right">Credit</TableCell>
                  {comparing && <TableCell>Change</TableCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.lines.map((l) => (
                  <TableRow
                    key={`${l.snapshotId}-${l.fingerprint}`}
                    sx={l.changeType === 'removed' ? { '& td': { color: 'text.disabled', textDecoration: 'line-through' } } : undefined}
                  >
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{l.txnDate}</TableCell>
                    <TableCell>{l.txnType}</TableCell>
                    <TableCell>{l.docNum}</TableCell>
                    <TableCell>{l.payeeName}</TableCell>
                    <TableCell sx={{ maxWidth: 260 }}>{l.memo}</TableCell>
                    <TableCell>{[l.accountCode, l.accountName].filter(Boolean).join(' ')}</TableCell>
                    <TableCell>{l.className || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</TableCell>
                    <TableCell align="right">{l.debit ? formatCurrency(l.debit) : ''}</TableCell>
                    <TableCell align="right">{l.credit ? formatCurrency(l.credit) : ''}</TableCell>
                    {comparing && (
                      <TableCell>
                        {CHANGE_COLORS[l.changeType] && (
                          <Tooltip title={describeChange(l)}>
                            <Chip size="small" label={l.changeType} color={CHANGE_COLORS[l.changeType]} variant="outlined" />
                          </Tooltip>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={data.total}
            page={page}
            onPageChange={(_, p) => setPage(p)}
            rowsPerPage={pageSize}
            rowsPerPageOptions={PAGE_SIZES}
            onRowsPerPageChange={(e) => setPageSize(Number(e.target.value))}
          />
        </>
      )}
    </Box>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { listPortalReports } from '../../api/portal';
import { formatMonth } from '../../utils/months';
import { formatCurrency } from '../../utils/format';

const errorText = (err) => err?.response?.data?.message || err?.message;

// What still needs the accountant's attention on a report.
export function workLabel(report) {
  const c = report.counts;
  if (report.status === 'Superseded') return 'Replaced';
  if (!c.notWorked) return 'All worked';
  return `${c.notWorked} to work`;
}

// The accountant's home: every AJE report published to them.
export default function PortalReports() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [fileFilter, setFileFilter] = useState('');
  const [showReplaced, setShowReplaced] = useState(false);

  useEffect(() => {
    listPortalReports().then(setData).catch((err) => setError(errorText(err)));
  }, []);

  const files = useMemo(() => {
    const map = new Map();
    for (const r of data?.reports || []) map.set(r.qboId, r.qboName);
    return [...map.entries()].map(([qboId, qboName]) => ({ qboId, qboName }));
  }, [data]);

  const reports = (data?.reports || []).filter((r) => (!fileFilter || r.qboId === fileFilter) && (showReplaced || r.status === 'Published'));
  const multiGroup = (data?.groups || []).length > 1;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>AJE reports</Typography>
      {data && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {data.accountant.fullName}{data.accountant.firm ? ` · ${data.accountant.firm}` : ''}
        </Typography>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {!data && !error && <CircularProgress size={24} />}
      {data && (
        <>
          <Alert severity="info" sx={{ mb: 2 }}>
            These are recommended adjusting journal entries. Book each one in QuickBooks (use its QBO Num and memo), then mark it Booked, or Declined
            with a reason. Ask a question on any entry and the controller answers in the same thread.
          </Alert>
          <Stack direction="row" spacing={2} sx={{ mb: 2 }} alignItems="center">
            {files.length > 1 && (
              <TextField select size="small" label="File" value={fileFilter} onChange={(e) => setFileFilter(e.target.value)} sx={{ minWidth: 260 }}>
                <MenuItem value="">All files</MenuItem>
                {files.map((f) => <MenuItem key={f.qboId} value={f.qboId}>{f.qboName}</MenuItem>)}
              </TextField>
            )}
            <Chip
              label={showReplaced ? 'Showing replaced reports' : 'Show replaced reports'}
              variant={showReplaced ? 'filled' : 'outlined'}
              onClick={() => setShowReplaced((v) => !v)}
            />
          </Stack>
          {!reports.length ? (
            <Paper variant="outlined" sx={{ p: 3 }}>
              <Typography color="text.secondary">No reports yet. You&apos;ll see them here as soon as they&apos;re published.</Typography>
            </Paper>
          ) : (
            <Paper variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Report</TableCell>
                    {multiGroup && <TableCell>Group</TableCell>}
                    <TableCell>File</TableCell>
                    <TableCell>Month</TableCell>
                    <TableCell align="right">Entries</TableCell>
                    <TableCell align="right">Total</TableCell>
                    <TableCell>Progress</TableCell>
                    <TableCell>Questions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {reports.map((r) => (
                    <TableRow key={r.reportId} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/portal/reports/${r.reportId}`)}>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600}>{r.reportNumber}</Typography>
                        {r.supersedes && <Typography variant="caption" color="text.secondary">Replaces {r.supersedes}</Typography>}
                      </TableCell>
                      {multiGroup && <TableCell>{r.groupName}</TableCell>}
                      <TableCell>{r.qboName}</TableCell>
                      <TableCell>{formatMonth(r.month)}</TableCell>
                      <TableCell align="right">{r.entryCount}</TableCell>
                      <TableCell align="right">{formatCurrency(r.totalAmount)}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5}>
                          <Chip size="small" label={workLabel(r)} color={r.status === 'Published' && r.counts.notWorked ? 'primary' : 'default'} variant="outlined" />
                          {r.counts.booked > 0 && <Chip size="small" color="success" label={`${r.counts.booked} booked`} />}
                          {r.counts.declined > 0 && <Chip size="small" color="error" label={`${r.counts.declined} declined`} />}
                        </Stack>
                      </TableCell>
                      <TableCell>{r.counts.openQuestions ? <Chip size="small" color="warning" label={`${r.counts.openQuestions} open`} /> : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
          )}
        </>
      )}
    </Box>
  );
}

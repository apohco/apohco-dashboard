import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Link,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import useControllerGroup from '../../hooks/useControllerGroup';
import useControllerJob, { isJobActive } from '../../hooks/useControllerJob';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import { getControllerOverview, listControllerJobs, startControllerPull } from '../../api/controller';
import { addMonths, currentMonth, formatMonth, monthsBetween } from '../../utils/months';

const GRID_MIN_MONTHS = 12;
const GRID_MAX_MONTHS = 36;
const STALE_TOKEN_MS = 3 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

const STATUS_COLORS = {
  Succeeded: 'success',
  Running: 'info',
  Queued: 'default',
  PartiallyFailed: 'warning',
  Failed: 'error',
  Stalled: 'warning',
};

const errorText = (err) => err?.response?.data?.message || err?.message;

// Months shown as grid columns: at least the last 12, extended back to the
// earliest stored month, capped at 36.
export function gridMonths(snapshots, now = new Date()) {
  const latest = currentMonth(now);
  const earliestStored = snapshots.reduce((min, s) => (s.month < min ? s.month : min), latest);
  const defaultStart = addMonths(latest, -(GRID_MIN_MONTHS - 1));
  const floor = addMonths(latest, -(GRID_MAX_MONTHS - 1));
  let start = earliestStored < defaultStart ? earliestStored : defaultStart;
  if (start < floor) start = floor;
  return monthsBetween(start, latest);
}

// Latest pull per QBO and month, plus how many pulls exist.
export function indexSnapshots(snapshots) {
  const index = new Map();
  for (const s of snapshots) {
    const key = `${s.qboId}|${s.month}`;
    const entry = index.get(key) || { pulls: 0, latest: null };
    entry.pulls += 1;
    if (s.isLatest) entry.latest = s;
    index.set(key, entry);
  }
  return index;
}

// QBO access tokens last an hour, so TokenExpiry - 1h is when the
// connection was last renewed (daily, by the refreshQBOTokens job).
export function connectionState(qbo, now = Date.now()) {
  if (!qbo.isApiConnected) return { label: 'Manual upload only', color: 'default' };
  if (!qbo.tokenExpiry) return { label: 'Never renewed', color: 'warning' };
  const renewedAt = new Date(qbo.tokenExpiry).getTime() - ACCESS_TOKEN_LIFETIME_MS;
  if (now - renewedAt > STALE_TOKEN_MS) {
    return { label: `Last renewed ${new Date(renewedAt).toLocaleDateString()}`, color: 'warning' };
  }
  return { label: 'Connected', color: 'success' };
}

function PullForm({ qbos, groupId, disabled, onStarted }) {
  const latest = currentMonth();
  const [qboId, setQboId] = useState('');
  const [fromMonth, setFromMonth] = useState(addMonths(latest, -1));
  const [toMonth, setToMonth] = useState(addMonths(latest, -1));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const pullable = qbos.filter((q) => q.isApiConnected);
  const monthCount = fromMonth && toMonth && toMonth >= fromMonth ? monthsBetween(fromMonth, toMonth).length : 0;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      onStarted(await startControllerPull(groupId, qboId, fromMonth, toMonth));
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Pull from QuickBooks
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Reads the General Ledger one month at a time and stores it as a new snapshot. Earlier pulls are
        kept, and nothing is ever written to QuickBooks.
      </Typography>
      {pullable.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          No QBO file is connected to the QuickBooks API yet.{' '}
          <Link component={RouterLink} to="/controller/upload">
            Upload a General Ledger export
          </Link>{' '}
          instead.
        </Alert>
      )}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select
          size="small"
          displayEmpty
          value={qboId}
          onChange={(e) => setQboId(e.target.value)}
          sx={{ minWidth: 240 }}
          inputProps={{ 'aria-label': 'QBO file' }}
        >
          <MenuItem value="" disabled>
            Select a QBO file
          </MenuItem>
          {pullable.map((q) => (
            <MenuItem key={q.qboId} value={q.qboId}>
              {q.qboName}
            </MenuItem>
          ))}
        </Select>
        <TextField
          size="small"
          type="month"
          label="From"
          InputLabelProps={{ shrink: true }}
          inputProps={{ max: latest }}
          value={fromMonth}
          onChange={(e) => setFromMonth(e.target.value)}
        />
        <TextField
          size="small"
          type="month"
          label="To"
          InputLabelProps={{ shrink: true }}
          inputProps={{ max: latest }}
          value={toMonth}
          onChange={(e) => setToMonth(e.target.value)}
        />
        <Button
          variant="contained"
          disabled={disabled || submitting || !qboId || monthCount === 0}
          onClick={submit}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {monthCount > 1 ? `Pull ${monthCount} months` : 'Pull month'}
        </Button>
      </Box>
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {errorText(error)}
        </Alert>
      )}
    </Paper>
  );
}

function ActiveJob({ job, error }) {
  if (!job) return error ? <Alert severity="warning" sx={{ mb: 3 }}>Checking progress: {errorText(error)}</Alert> : null;
  const { succeeded, failed, stalled } = job.taskCounts;
  const total = Object.values(job.taskCounts).reduce((a, b) => a + b, 0);
  const done = succeeded + failed + stalled;
  const failedTasks = (job.tasks || []).filter((t) => t.status === 'Failed' || t.status === 'Stalled');

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }} data-testid="active-job">
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="body2">
          {job.qboName}: {formatMonth(job.fromMonth)}
          {job.toMonth !== job.fromMonth ? ` – ${formatMonth(job.toMonth)}` : ''}
        </Typography>
        <Chip size="small" label={job.status} color={STATUS_COLORS[job.status] || 'default'} />
      </Box>
      <LinearProgress variant="determinate" value={total ? (done / total) * 100 : 0} sx={{ mb: 1 }} />
      <Typography variant="caption" color="text.secondary">
        {done} of {total} months done · {job.lineCount.toLocaleString()} lines stored
      </Typography>
      {failedTasks.map((t) => (
        <Alert key={t.taskId} severity="error" sx={{ mt: 1 }}>
          {formatMonth(t.month)}: {t.error || t.status}
        </Alert>
      ))}
    </Paper>
  );
}

export default function ControllerOverview() {
  const navigate = useNavigate();
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [overview, setOverview] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeJobId, setActiveJobId] = useState(null);

  const load = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    setError(null);
    try {
      const [ov, recentJobs] = await Promise.all([getControllerOverview(groupId), listControllerJobs(groupId)]);
      setOverview(ov);
      setJobs(recentJobs);
      setActiveJobId((current) => current || recentJobs.find(isJobActive)?.jobId || null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    setOverview(null);
    setJobs([]);
    setActiveJobId(null);
    load();
  }, [load]);

  const { job: activeJob, error: jobError } = useControllerJob(groupId, activeJobId, load);

  const months = useMemo(() => (overview ? gridMonths(overview.snapshots) : []), [overview]);
  const index = useMemo(() => (overview ? indexSnapshots(overview.snapshots) : new Map()), [overview]);

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Controller
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />

      {!groupId && !groupsError && (
        <Typography color="text.secondary">Select a Group to get started.</Typography>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
      {loading && !overview && <CircularProgress size={24} />}

      {overview && (
        <>
          <PullForm
            qbos={overview.qbos}
            groupId={groupId}
            disabled={isJobActive(activeJob)}
            onStarted={(started) => setActiveJobId(started.jobId)}
          />
          {activeJobId && <ActiveJob job={activeJob} error={jobError} />}

          <Typography variant="h6" sx={{ mb: 1 }}>
            Stored months
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Line count of the latest pull or upload. Click a month to browse it. A dot means the latest
            snapshot differs from the one before it.
          </Typography>
          <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ minWidth: 180 }}>QBO file</TableCell>
                  {months.map((m) => (
                    <TableCell key={m} align="center" sx={{ whiteSpace: 'nowrap' }}>
                      {formatMonth(m)}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {overview.qbos.map((q) => {
                  const conn = connectionState(q);
                  return (
                    <TableRow key={q.qboId}>
                      <TableCell>
                        <Typography variant="body2">{q.qboName}</Typography>
                        <Chip size="small" variant="outlined" label={conn.label} color={conn.color} sx={{ mt: 0.5 }} />
                      </TableCell>
                      {months.map((m) => {
                        const cell = index.get(`${q.qboId}|${m}`);
                        if (!cell?.latest) {
                          return (
                            <TableCell key={m} align="center" sx={{ color: 'text.disabled' }}>
                              —
                            </TableCell>
                          );
                        }
                        const s = cell.latest;
                        return (
                          <TableCell
                            key={m}
                            align="center"
                            onClick={() => navigate(`/controller/ledger?qboId=${q.qboId}&month=${m}`)}
                            sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                          >
                            <Tooltip
                              title={`${cell.pulls} snapshot${cell.pulls === 1 ? '' : 's'}, latest ${s.source === 'Upload' ? 'uploaded' : 'pulled'} ${new Date(s.pulledAt).toLocaleString()}`}
                            >
                              <span>
                                {s.lineCount.toLocaleString()}
                                {s.changedFromPrevious && (
                                  <Box component="span" sx={{ color: 'warning.main', ml: 0.5 }} aria-label="changed since previous pull">
                                    ●
                                  </Box>
                                )}
                              </span>
                            </Tooltip>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>

          <Typography variant="h6" sx={{ mb: 1 }}>
            Recent pulls
          </Typography>
          {jobs.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No pulls yet.
            </Typography>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Started</TableCell>
                    <TableCell>QBO file</TableCell>
                    <TableCell>Months</TableCell>
                    <TableCell align="right">Lines</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {jobs.map((j) => (
                    <TableRow key={j.jobId} hover onClick={() => setActiveJobId(j.jobId)} sx={{ cursor: 'pointer' }}>
                      <TableCell>{new Date(j.createdDate).toLocaleString()}</TableCell>
                      <TableCell>{j.qboName}</TableCell>
                      <TableCell>
                        {formatMonth(j.fromMonth)}
                        {j.toMonth !== j.fromMonth ? ` – ${formatMonth(j.toMonth)}` : ''}
                      </TableCell>
                      <TableCell align="right">{j.lineCount.toLocaleString()}</TableCell>
                      <TableCell>
                        <Chip size="small" label={j.status} color={STATUS_COLORS[j.status] || 'default'} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}
    </Box>
  );
}

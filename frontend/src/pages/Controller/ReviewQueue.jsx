import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Link,
  ListItemText,
  Menu,
  MenuItem,
  OutlinedInput,
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
import MoreVertIcon from '@mui/icons-material/MoreVert';
import CheckIcon from '@mui/icons-material/Check';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import {
  getControllerOverview,
  getReviewSettings,
  listReviewLines,
  listReviewRuns,
  saveReviewDecisions,
  saveReviewSettings,
  startReviewRun,
} from '../../api/controller';
import { addMonths, currentMonth, formatMonth } from '../../utils/months';
import { formatCurrency } from '../../utils/format';

const PAGE_SIZE = 100;
const DEBOUNCE_MS = 350;
export const STATUS_INFO = {
  Conflict: { label: 'Conflict', color: 'error' },
  LikelyMisclassified: { label: 'Likely misclassified', color: 'warning' },
  Unclassified: { label: 'Unclassified', color: 'warning' },
  NeedsEvidence: { label: 'Needs evidence', color: 'default' },
  Confirmed: { label: 'Confirmed', color: 'success' },
};
const ACCOUNT_TYPES = ['Expense', 'Revenue', 'Asset', 'Liability', 'Equity', 'Unknown'];
const ACTION_TEXT = {
  Approve: 'Approve recommendation',
  Keep: 'Keep current class',
  Reassign: 'Set entity',
};

const errorText = (err) => err?.response?.data?.message || err?.message;

function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function confidenceLabel(confidence, threshold, mediumThreshold) {
  if (!confidence) return null;
  const level = confidence >= threshold ? 'High' : confidence >= mediumThreshold ? 'Medium' : 'Low';
  return `${level} ${Math.round(confidence * 100)}%`;
}

// Split amounts from a vendor's percentage template, in cents so they add
// up exactly to the line (any rounding remainder goes on the last entity).
export function splitFromTemplate(template, amount) {
  const totalCents = Math.round(Math.abs(amount) * 100);
  if (!template?.length) return [];
  let used = 0;
  return template.map((t, i) => {
    const cents = i === template.length - 1 ? totalCents - used : Math.round((totalCents * t.percent) / 100);
    used += cents;
    return { entityId: t.entityId, amount: (cents / 100).toFixed(2) };
  });
}

export function describeDecision(decision, entityName) {
  if (!decision) return null;
  if (decision.action === 'Split') {
    return `Split: ${decision.allocations.map((a) => `${entityName(a.entityId)} ${formatCurrency(a.amount)}`).join(', ')}`;
  }
  const verb = { Approve: 'Approved', Keep: 'Kept', Reassign: 'Set to' }[decision.action] || decision.action;
  return `${verb}: ${entityName(decision.entityId)}`;
}

function SettingsDialog({ open, groupId, onClose }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    getReviewSettings(groupId)
      .then((s) => setForm({ threshold: Math.round(s.threshold * 100), mediumThreshold: Math.round(s.mediumThreshold * 100), historyMonths: s.historyMonths }))
      .catch(setError);
  }, [open, groupId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveReviewSettings(groupId, {
        threshold: Number(form.threshold) / 100,
        mediumThreshold: Number(form.mediumThreshold) / 100,
        historyMonths: Number(form.historyMonths),
      });
      onClose(true);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };
  const field = (key, label, helperText) => (
    <TextField
      fullWidth
      size="small"
      type="number"
      label={label}
      helperText={helperText}
      value={form?.[key] ?? ''}
      onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      sx={{ mb: 2 }}
    />
  );

  return (
    <Dialog open={open} onClose={() => onClose(false)} fullWidth maxWidth="xs">
      <DialogTitle>Review settings</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
        {form && (
          <Box sx={{ mt: 1 }}>
            {field('threshold', 'High confidence threshold (%)', 'At or above this, a line is Confirmed or Likely misclassified.')}
            {field('mediumThreshold', 'Medium confidence from (%)', 'Below this, confidence shows as Low.')}
            {field('historyMonths', 'Months of history', 'How many earlier months the engine learns from (1–36).')}
            <Typography variant="caption" color="text.secondary">
              Changes apply the next time you run a review.
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={!form || saving}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function EntityDialog({ open, title, entities, onClose, onSave }) {
  const [entityId, setEntityId] = useState('');
  useEffect(() => {
    if (open) setEntityId('');
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Select fullWidth size="small" displayEmpty value={entityId} onChange={(e) => setEntityId(e.target.value)} sx={{ mt: 1 }} inputProps={{ 'aria-label': 'Entity' }}>
          <MenuItem value="" disabled>
            Choose an entity
          </MenuItem>
          {entities.map((e) => (
            <MenuItem key={e.entityId} value={e.entityId}>
              {e.entityName}
            </MenuItem>
          ))}
        </Select>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!entityId} onClick={() => onSave(entityId)}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function SplitDialog({ line, entities, onClose, onSave }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!line) return;
    const fromTemplate = splitFromTemplate(line.splitTemplate, line.amount);
    setRows(fromTemplate.length ? fromTemplate : [{ entityId: '', amount: '' }, { entityId: '', amount: '' }]);
  }, [line]);
  if (!line) return null;

  const target = Math.round(Math.abs(line.amount) * 100);
  const total = rows.reduce((s, r) => s + Math.round((Number(r.amount) || 0) * 100), 0);
  const ids = rows.map((r) => r.entityId).filter(Boolean);
  const valid = rows.length >= 2 && ids.length === rows.length && new Set(ids).size === ids.length && total === target && rows.every((r) => Number(r.amount) > 0);
  const setRow = (i, key, value) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: value } : r)));

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Split {formatCurrency(Math.abs(line.amount))}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          {line.vendorName || line.payeeName} · {line.txnDate} · {line.memo}
        </DialogContentText>
        {rows.map((r, i) => (
          <Box key={i} sx={{ display: 'flex', gap: 1, mb: 1 }}>
            <Select size="small" displayEmpty value={r.entityId} onChange={(e) => setRow(i, 'entityId', e.target.value)} sx={{ flex: 1 }} inputProps={{ 'aria-label': `Split entity ${i + 1}` }}>
              <MenuItem value="" disabled>
                Entity
              </MenuItem>
              {entities.map((e) => (
                <MenuItem key={e.entityId} value={e.entityId}>
                  {e.entityName}
                </MenuItem>
              ))}
            </Select>
            <TextField size="small" type="number" label="Amount" value={r.amount} onChange={(e) => setRow(i, 'amount', e.target.value)} sx={{ width: 140 }} inputProps={{ 'aria-label': `Split amount ${i + 1}`, step: '0.01' }} />
            <Button size="small" disabled={rows.length <= 2} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </Box>
        ))}
        <Button size="small" onClick={() => setRows((rs) => [...rs, { entityId: '', amount: '' }])}>
          Add entity
        </Button>
        <Typography variant="body2" color={total === target ? 'success.main' : 'warning.main'} sx={{ mt: 1 }}>
          {total === target ? 'Adds up to the line amount.' : `${formatCurrency((target - total) / 100)} left to assign`}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid} onClick={() => onSave(rows.map((r) => ({ entityId: r.entityId, amount: Number(r.amount) })))}>
          Save split
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ReviewQueue() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [overview, setOverview] = useState(null);
  const [qboId, setQboId] = useState('');
  const [month, setMonth] = useState(addMonths(currentMonth(), -1));
  const [runsInfo, setRunsInfo] = useState(null);
  const [data, setData] = useState(null);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState({ status: [], reviewState: 'open', accountType: ['Expense'], entityId: '' });
  const [text, setText] = useState({ account: '', vendor: '', search: '' });
  const debouncedText = useDebounced(JSON.stringify(text), DEBOUNCE_MS);
  const [selected, setSelected] = useState(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [menu, setMenu] = useState({ anchor: null, line: null });
  const [entityDialog, setEntityDialog] = useState(null); // { lineIds } | { bulk: true }
  const [splitLine, setSplitLine] = useState(null);
  const [confirmBulk, setConfirmBulk] = useState(null); // action
  const [settingsOpen, setSettingsOpen] = useState(false);

  const classFiles = useMemo(() => (overview?.qbos || []).filter((q) => q.isClassBased), [overview]);
  const run = runsInfo?.runs?.[0] || null;

  useEffect(() => {
    setOverview(null);
    setQboId('');
    if (!groupId) return;
    getControllerOverview(groupId)
      .then((ov) => {
        setOverview(ov);
        const files = ov.qbos.filter((q) => q.isClassBased);
        if (files.length === 1) setQboId(files[0].qboId);
      })
      .catch(setError);
  }, [groupId]);

  const loadRuns = useCallback(async () => {
    if (!groupId || !qboId || !month) return;
    setRunsInfo(null);
    setData(null);
    try {
      setRunsInfo(await listReviewRuns(groupId, qboId, month));
    } catch (err) {
      setError(err);
    }
  }, [groupId, qboId, month]);
  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const queryParams = useMemo(() => {
    const t = JSON.parse(debouncedText);
    return {
      ...(filters.status.length ? { status: filters.status.join(',') } : {}),
      reviewState: filters.reviewState,
      ...(filters.accountType.length ? { accountType: filters.accountType.join(',') } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(t.account.trim() ? { account: t.account.trim() } : {}),
      ...(t.vendor.trim() ? { vendor: t.vendor.trim() } : {}),
      ...(t.search.trim() ? { search: t.search.trim() } : {}),
    };
  }, [filters, debouncedText]);

  const loadLines = useCallback(async () => {
    if (!run) return;
    setBusy((b) => b || 'lines');
    try {
      setData(await listReviewLines(groupId, { runId: run.runId, ...queryParams, limit: PAGE_SIZE, offset: page * PAGE_SIZE }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy((b) => (b === 'lines' ? null : b));
    }
  }, [groupId, run, queryParams, page]);
  useEffect(() => {
    loadLines();
  }, [loadLines]);

  // A new filter or page clears the selection.
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [queryParams, page, run]);
  useEffect(() => setPage(0), [queryParams]);

  const entities = data?.entities || [];
  const entityName = useCallback((id) => entities.find((e) => e.entityId === id)?.entityName || '—', [entities]);

  const runReview = async () => {
    setBusy('run');
    setError(null);
    try {
      const result = await startReviewRun(groupId, qboId, month);
      setNotice(`Reviewed ${result.lineCount.toLocaleString()} lines.`);
      await loadRuns();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const decide = async (body, label) => {
    setBusy('decide');
    setError(null);
    try {
      const result = await saveReviewDecisions(groupId, { runId: run.runId, ...body });
      const s = result.skipped;
      const skippedText = [
        s.alreadyDecided && `${s.alreadyDecided} already decided`,
        s.watchMode && `${s.watchMode} from watch-mode vendors`,
        s.nothingToApply && `${s.nothingToApply} with nothing to apply`,
      ].filter(Boolean);
      setNotice(`${label}: ${result.decided} line${result.decided === 1 ? '' : 's'}${skippedText.length ? ` (skipped ${skippedText.join(', ')})` : ''}.`);
      setSelected(new Set());
      setAllMatching(false);
      await loadLines();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const bulk = (action, entityId) => {
    const body = allMatching
      ? { action, filter: queryParams, expectedCount: data.total, ...(entityId ? { entityId } : {}) }
      : { action, lineIds: [...selected], ...(entityId ? { entityId } : {}) };
    return decide(body, ACTION_TEXT[action]);
  };

  const pageIds = (data?.lines || []).map((l) => l.lineId);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectionCount = allMatching ? data?.total || 0 : selected.size;
  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleStatus = (status) =>
    setFilters((f) => ({ ...f, status: f.status.includes(status) ? f.status.filter((s) => s !== status) : [...f.status, status] }));

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h1">Review</Typography>
        {groupId && (
          <Button startIcon={<SettingsOutlinedIcon />} onClick={() => setSettingsOpen(true)}>
            Settings
          </Button>
        )}
      </Box>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{errorText(error)}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}

      {overview && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          {classFiles.length === 0 ? (
            <Typography color="text.secondary">No class-based QBO file in this Group.</Typography>
          ) : (
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
              <Select size="small" displayEmpty value={qboId} onChange={(e) => setQboId(e.target.value)} sx={{ minWidth: 220 }} inputProps={{ 'aria-label': 'QBO file' }}>
                <MenuItem value="" disabled>
                  Select a QBO file
                </MenuItem>
                {classFiles.map((q) => (
                  <MenuItem key={q.qboId} value={q.qboId}>
                    {q.qboName}
                  </MenuItem>
                ))}
              </Select>
              <TextField size="small" type="month" label="Month" InputLabelProps={{ shrink: true }} value={month} onChange={(e) => setMonth(e.target.value)} />
              <Button
                variant="contained"
                disabled={!qboId || !month || Boolean(busy) || !runsInfo?.latestSnapshot}
                onClick={runReview}
                startIcon={busy === 'run' ? <CircularProgress size={16} color="inherit" /> : null}
              >
                {run ? 'Run review again' : 'Run review'}
              </Button>
              {runsInfo && !runsInfo.latestSnapshot && (
                <Typography variant="body2" color="text.secondary">
                  No General Ledger stored for {formatMonth(month)}. Pull or upload it first.
                </Typography>
              )}
              {run && (
                <Typography variant="body2" color="text.secondary">
                  Last run {new Date(run.runDate).toLocaleString()} · {run.lineCount.toLocaleString()} lines
                </Typography>
              )}
            </Box>
          )}
          {run?.isStale && (
            <Alert severity="info" sx={{ mt: 2 }}>
              A newer pull or upload of {formatMonth(month)} exists. Run the review again to include it; your decisions carry over.
            </Alert>
          )}
        </Paper>
      )}

      {data && (
        <>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
            {Object.entries(STATUS_INFO).map(([status, info]) => {
              const s = data.summary[status];
              const on = filters.status.includes(status);
              return (
                <Chip
                  key={status}
                  color={info.color}
                  variant={on ? 'filled' : 'outlined'}
                  onClick={() => toggleStatus(status)}
                  label={`${info.label}: ${s.open.toLocaleString()} open of ${s.count.toLocaleString()} · ${formatCurrency(s.amount)}`}
                />
              );
            })}
          </Box>

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
            <Select size="small" value={filters.reviewState} onChange={(e) => setFilters((f) => ({ ...f, reviewState: e.target.value }))} inputProps={{ 'aria-label': 'Review state' }}>
              <MenuItem value="open">Open</MenuItem>
              <MenuItem value="decided">Decided</MenuItem>
              <MenuItem value="all">All lines</MenuItem>
            </Select>
            <Select
              size="small"
              multiple
              displayEmpty
              value={filters.accountType}
              onChange={(e) => setFilters((f) => ({ ...f, accountType: e.target.value }))}
              input={<OutlinedInput />}
              renderValue={(v) => (v.length ? v.join(', ') : 'All account types')}
              sx={{ minWidth: 180 }}
              inputProps={{ 'aria-label': 'Account type' }}
            >
              {ACCOUNT_TYPES.map((t) => (
                <MenuItem key={t} value={t}>
                  <Checkbox size="small" checked={filters.accountType.includes(t)} />
                  <ListItemText primary={t} />
                </MenuItem>
              ))}
            </Select>
            <TextField size="small" label="Account" value={text.account} onChange={(e) => setText((t) => ({ ...t, account: e.target.value }))} />
            <TextField size="small" label="Vendor" value={text.vendor} onChange={(e) => setText((t) => ({ ...t, vendor: e.target.value }))} />
            <TextField size="small" label="Memo contains" value={text.search} onChange={(e) => setText((t) => ({ ...t, search: e.target.value }))} />
            <Select size="small" displayEmpty value={filters.entityId} onChange={(e) => setFilters((f) => ({ ...f, entityId: e.target.value }))} sx={{ minWidth: 160 }} inputProps={{ 'aria-label': 'Entity filter' }}>
              <MenuItem value="">All entities</MenuItem>
              {entities.map((e) => (
                <MenuItem key={e.entityId} value={e.entityId}>
                  {e.entityName}
                </MenuItem>
              ))}
            </Select>
          </Box>

          <Paper variant="outlined" sx={{ p: 1, mb: 1, display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }} data-testid="bulk-bar">
            <Typography variant="body2" sx={{ mx: 1 }}>
              {data.total.toLocaleString()} matching · {formatCurrency(data.totalAmount)}
              {selectionCount > 0 && ` · ${selectionCount.toLocaleString()} selected`}
            </Typography>
            {allPageSelected && !allMatching && data.total > pageIds.length && (
              <Link component="button" variant="body2" onClick={() => setAllMatching(true)}>
                Select all {data.total.toLocaleString()} matching lines
              </Link>
            )}
            <Box sx={{ flex: 1 }} />
            <Button size="small" variant="contained" disabled={!selectionCount || Boolean(busy)} onClick={() => (allMatching ? setConfirmBulk('Approve') : bulk('Approve'))}>
              Approve recommendation
            </Button>
            <Button size="small" disabled={!selectionCount || Boolean(busy)} onClick={() => (allMatching ? setConfirmBulk('Keep') : bulk('Keep'))}>
              Keep current class
            </Button>
            <Button size="small" disabled={!selectionCount || Boolean(busy)} onClick={() => setEntityDialog({ bulk: true })}>
              Set entity…
            </Button>
          </Paper>

          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={allPageSelected}
                      inputProps={{ 'aria-label': 'Select page' }}
                      onChange={() => {
                        setAllMatching(false);
                        setSelected(allPageSelected ? new Set() : new Set(pageIds));
                      }}
                    />
                  </TableCell>
                  <TableCell>Date</TableCell>
                  <TableCell>Vendor</TableCell>
                  <TableCell>Memo</TableCell>
                  <TableCell>Account</TableCell>
                  <TableCell align="right">Amount</TableCell>
                  <TableCell>Class now</TableCell>
                  <TableCell>Suggested</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Decision</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {data.lines.map((l) => (
                  <TableRow key={l.lineId} hover selected={allMatching || selected.has(l.lineId)}>
                    <TableCell padding="checkbox">
                      <Checkbox size="small" checked={allMatching || selected.has(l.lineId)} disabled={allMatching} onChange={() => toggle(l.lineId)} inputProps={{ 'aria-label': `Select line ${l.lineId}` }} />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{l.txnDate}</TableCell>
                    <TableCell>
                      {l.vendorName || l.payeeName || '—'}
                      {l.watchMode && (
                        <Tooltip title="Watch mode: decide these one at a time">
                          <VisibilityOutlinedIcon fontSize="inherit" sx={{ ml: 0.5, verticalAlign: 'middle' }} aria-label="watch mode" />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 240 }}>{l.memo}</TableCell>
                    <TableCell>
                      {[l.accountCode, l.accountName].filter(Boolean).join(' ')}
                      <Typography variant="caption" color="text.secondary" display="block">
                        {l.accountType}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{formatCurrency(l.amount)}</TableCell>
                    <TableCell>{l.className || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</TableCell>
                    <TableCell>
                      {l.suggestedEntityId ? entityName(l.suggestedEntityId) : '—'}
                      {l.confidence > 0 && (
                        <Typography variant="caption" color="text.secondary" display="block">
                          {confidenceLabel(l.confidence, data.run.threshold, data.run.mediumThreshold)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Tooltip title={<Box component="ul" sx={{ m: 0, pl: 2 }}>{l.reasons.map((r) => <li key={r}>{r}</li>)}</Box>}>
                        <Chip size="small" variant="outlined" color={STATUS_INFO[l.status].color} label={STATUS_INFO[l.status].label} />
                      </Tooltip>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 200 }}>{describeDecision(l.decision, entityName)}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Tooltip title="Approve recommendation">
                        <span>
                          <IconButton size="small" aria-label={`Approve ${l.lineId}`} disabled={Boolean(busy) || (!l.suggestedEntityId && !l.currentEntityId)} onClick={() => decide({ action: 'Approve', lineIds: [l.lineId] }, ACTION_TEXT.Approve)}>
                            <CheckIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <IconButton size="small" aria-label={`More actions for ${l.lineId}`} onClick={(e) => setMenu({ anchor: e.currentTarget, line: l })}>
                        <MoreVertIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
                {data.lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} sx={{ color: 'text.secondary' }}>
                      No lines match these filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination component="div" count={data.total} page={page} rowsPerPage={PAGE_SIZE} rowsPerPageOptions={[PAGE_SIZE]} onPageChange={(_, p) => setPage(p)} />
        </>
      )}

      <Menu anchorEl={menu.anchor} open={Boolean(menu.anchor)} onClose={() => setMenu({ anchor: null, line: null })}>
        {menu.line && [
          <MenuItem key="keep" disabled={!menu.line.currentEntityId} onClick={() => { decide({ action: 'Keep', lineIds: [menu.line.lineId] }, ACTION_TEXT.Keep); setMenu({ anchor: null, line: null }); }}>
            Keep current class
          </MenuItem>,
          <MenuItem key="set" onClick={() => { setEntityDialog({ lineIds: [menu.line.lineId] }); setMenu({ anchor: null, line: null }); }}>
            Set entity…
          </MenuItem>,
          <MenuItem key="split" onClick={() => { setSplitLine(menu.line); setMenu({ anchor: null, line: null }); }}>
            Split…
          </MenuItem>,
          <MenuItem key="undo" disabled={!menu.line.decision} onClick={() => { decide({ action: 'Undo', lineIds: [menu.line.lineId] }, 'Undone'); setMenu({ anchor: null, line: null }); }}>
            Undo decision
          </MenuItem>,
        ]}
      </Menu>

      <EntityDialog
        open={Boolean(entityDialog)}
        title={entityDialog?.bulk ? `Set entity on ${selectionCount.toLocaleString()} lines` : 'Set entity'}
        entities={entities}
        onClose={() => setEntityDialog(null)}
        onSave={(entityId) => {
          const target = entityDialog;
          setEntityDialog(null);
          if (target.bulk) bulk('Reassign', entityId);
          else decide({ action: 'Reassign', entityId, lineIds: target.lineIds }, ACTION_TEXT.Reassign);
        }}
      />
      <SplitDialog
        line={splitLine}
        entities={entities}
        onClose={() => setSplitLine(null)}
        onSave={(allocations) => {
          const line = splitLine;
          setSplitLine(null);
          decide({ action: 'Split', lineIds: [line.lineId], allocations }, 'Split');
        }}
      />
      <Dialog open={Boolean(confirmBulk)} onClose={() => setConfirmBulk(null)}>
        <DialogTitle>{ACTION_TEXT[confirmBulk]}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Apply to all {data?.total.toLocaleString()} matching lines? Lines you have already decided and lines from watch-mode vendors are skipped.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmBulk(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              const action = confirmBulk;
              setConfirmBulk(null);
              bulk(action);
            }}
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
      {groupId && (
        <SettingsDialog
          open={settingsOpen}
          groupId={groupId}
          onClose={(saved) => {
            setSettingsOpen(false);
            if (saved) setNotice('Settings saved. Run the review again to apply them.');
          }}
        />
      )}
    </Box>
  );
}

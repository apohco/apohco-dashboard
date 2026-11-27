import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Autocomplete,
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
  FormControlLabel,
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
import { AiPassStatus, AiSettingsFields, AiSuggestion } from '../../components/controller/AiMatching';
import { EvidenceCell, EvidenceDrawer, EvidenceJobProgress } from '../../components/controller/Evidence';
import {
  getControllerOverview,
  getReviewAccounts,
  getReviewSettings,
  listReviewLines,
  listReviewRuns,
  saveDueToFromAccount,
  saveReviewDecisions,
  saveReviewSettings,
  startReviewRun,
  findEvidence,
  startEvidenceSearch,
} from '../../api/controller';
import { addMonths, currentMonth, formatMonth, isMonth } from '../../utils/months';
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
  AcceptAi: 'Accept AI suggestion',
  Keep: 'Keep current class',
  Reassign: 'Set entity',
  Reclassify: 'Reclassify',
  DueToFrom: 'Due To/From',
};
// Class review: the management file (class -> entity). Account review:
// files without classes (right account, or another entity's).
const keepText = (kind) => (kind === 'Account' ? 'Keep as is' : 'Keep current class');

export const formatAccount = (a) => (a ? [a.code, a.name].filter(Boolean).join(' ') : '—');
const sameAccount = (a, b) => Boolean(a && b) && (a.code || null) === (b.code || null) && a.name === b.name;

// What an account-review suggestion would do, in words.
export function describeSuggestion(line, entityName) {
  if (line.suggestedAction === 'Keep') return `Keep in ${formatAccount({ code: line.accountCode, name: line.accountName })}`;
  if (line.suggestedAction === 'Reclassify') return `Reclassify to ${formatAccount(line.suggestedAccount)}`;
  if (line.suggestedAction === 'DueToFrom') return `Due To/From ${entityName(line.suggestedEntityId)}`;
  return '—';
}

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
  if (decision.action === 'Reclassify') return `Reclassified to ${formatAccount(decision.targetAccount)}`;
  if (decision.action === 'DueToFrom') {
    return `Due To/From ${entityName(decision.counterpartyEntityId)} (${formatAccount(decision.targetAccount)})`;
  }
  if (decision.action === 'Keep' && !decision.entityId) return 'Kept as is';
  const verb = { Approve: 'Approved', Keep: 'Kept', Reassign: 'Set to' }[decision.action] || decision.action;
  return `${verb}: ${entityName(decision.entityId)}`;
}

function AccountPicker({ accounts, value, onChange, label = 'Account' }) {
  return (
    <Autocomplete
      size="small"
      options={accounts}
      value={value}
      onChange={(_, v) => onChange(v)}
      getOptionLabel={formatAccount}
      isOptionEqualToValue={sameAccount}
      groupBy={(a) => a.type}
      renderInput={(params) => <TextField {...params} label={label} />}
      sx={{ mt: 1 }}
    />
  );
}

function ReclassifyDialog({ open, title, accounts, onClose, onSave }) {
  const [account, setAccount] = useState(null);
  useEffect(() => {
    if (open) setAccount(null);
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <AccountPicker accounts={accounts} value={account} onChange={setAccount} label="Move to account" />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!account} onClick={() => onSave(account)}>
          Reclassify
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// The saved Due To/From account for an entity, and the one found by name.
const savedDue = (info, id) => info?.dueToFrom?.find((d) => d.entityId === id)?.account || null;
const detectedDue = (info, id) => info?.detectedDueToFrom?.find((d) => d.entityId === id)?.account || null;

// Pick the other entity; its Due To/From account in this file is filled in
// (saved default, else the account named for it). A different account is
// used for these lines, and becomes the default if "Make this the default"
// is ticked.
function DueToFromDialog({ open, title, entities, accountsInfo, onClose, onSave }) {
  const [entityId, setEntityId] = useState('');
  const [account, setAccount] = useState(null);
  const [remember, setRemember] = useState(true);
  useEffect(() => {
    if (open) {
      setEntityId('');
      setAccount(null);
    }
  }, [open]);
  const saved = (id) => savedDue(accountsInfo, id);
  const others = entities.filter((e) => e.entityId !== accountsInfo?.ownerEntityId);
  const changed = entityId && account && !sameAccount(account, saved(entityId));
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Select
          fullWidth
          size="small"
          displayEmpty
          value={entityId}
          onChange={(e) => {
            const id = e.target.value;
            setEntityId(id);
            setAccount(saved(id) || detectedDue(accountsInfo, id));
            setRemember(!saved(id));
          }}
          sx={{ mt: 1 }}
          inputProps={{ 'aria-label': 'Other entity' }}
        >
          <MenuItem value="" disabled>
            Which entity does this belong to?
          </MenuItem>
          {others.map((e) => (
            <MenuItem key={e.entityId} value={e.entityId}>
              {e.entityName}
            </MenuItem>
          ))}
        </Select>
        {entityId && (
          <>
            <AccountPicker accounts={accountsInfo?.accounts || []} value={account} onChange={setAccount} label="Due To/From account in this file" />
            {changed ? (
              <FormControlLabel
                control={<Checkbox size="small" checked={remember} onChange={(e) => setRemember(e.target.checked)} />}
                label="Make this the default Due To/From account for this entity"
              />
            ) : (
              <Typography variant="caption" color="text.secondary">
                The default Due To/From account for this entity in this file.
              </Typography>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!entityId || !account}
          onClick={() => onSave({ counterpartyEntityId: entityId, ...(changed ? { account, rememberAccount: remember } : {}) })}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Every other entity's Due To/From account in one file.
function DueToFromSetupDialog({ open, groupId, qboId, qboName, entities, accountsInfo, onClose }) {
  const [form, setForm] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const saved = useCallback((id) => savedDue(accountsInfo, id), [accountsInfo]);
  const others = entities.filter((e) => e.entityId !== accountsInfo?.ownerEntityId);
  useEffect(() => {
    if (open) {
      setError(null);
      // Unsaved entities start with the account named for them, if any.
      setForm(Object.fromEntries(entities.map((e) => [e.entityId, saved(e.entityId) || detectedDue(accountsInfo, e.entityId)])));
    }
  }, [open, entities, saved, accountsInfo]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const e of others) {
        const next = form[e.entityId] || null;
        const prev = saved(e.entityId);
        if (!(next === prev || sameAccount(next, prev))) {
          await saveDueToFromAccount(groupId, qboId, e.entityId, next ? { code: next.code, name: next.name } : null);
        }
      }
      onClose(true);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => onClose(false)} fullWidth maxWidth="sm">
      <DialogTitle>Due To/From accounts in {qboName}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
        <DialogContentText sx={{ mb: 1 }}>
          For each other entity, the account in this file that holds what is due to or from it. Accounts named
          &quot;Due from/to &lt;entity&gt;&quot; are filled in for you; Save keeps them.
        </DialogContentText>
        {others.map((e) => (
          <AccountPicker
            key={e.entityId}
            accounts={accountsInfo?.accounts || []}
            value={form[e.entityId] || null}
            onChange={(v) => setForm((f) => ({ ...f, [e.entityId]: v }))}
            label={e.entityName}
          />
        ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function SettingsDialog({ open, groupId, onClose }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    getReviewSettings(groupId)
      .then((s) =>
        setForm({
          ...s,
          threshold: Math.round(s.threshold * 100),
          mediumThreshold: Math.round(s.mediumThreshold * 100),
          aiConfidenceCap: Math.round((s.aiConfidenceCap ?? 0.85) * 100),
          aiMonthlyBudget: s.aiMonthlyBudget ?? 25,
          aiEnabled: s.aiEnabled ?? true,
          aiRedactPatientInfo: s.aiRedactPatientInfo ?? true,
        })
      )
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
        splitShiftPoints: Number(form.splitShiftPoints),
        spikePercent: Number(form.spikePercent),
        spikeMinAmount: Number(form.spikeMinAmount),
        recurringMonths: Number(form.recurringMonths),
        baselineMonths: Number(form.baselineMonths),
        aiEnabled: Boolean(form.aiEnabled),
        aiConfidenceCap: Number(form.aiConfidenceCap) / 100,
        aiMonthlyBudget: Number(form.aiMonthlyBudget),
        aiRedactPatientInfo: Boolean(form.aiRedactPatientInfo),
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
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
              Changes apply the next time you run a review.
            </Typography>
            <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
              Trend checks
            </Typography>
            {field('splitShiftPoints', 'Split shift (percentage points)', "Flag a vendor when an entity's share moves this much vs its average.")}
            {field('spikePercent', 'Spend spike (%)', "Flag an entity's spend in an account this far above its average…")}
            {field('spikeMinAmount', 'Spend spike, at least ($)', '…and at least this many dollars above it.')}
            {field('recurringMonths', 'Recurring after (months)', 'A vendor charged in each of this many previous months is recurring (2–12).')}
            {field('baselineMonths', 'Average over (months)', 'How many earlier months the averages use (2–24).')}
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
              Trend checks use the new values right away.
            </Typography>
            <AiSettingsFields groupId={groupId} form={form} setForm={setForm} open={open} />
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
  // Drill-down links (Trends, Conflicts): ?qboId=&month=&vendor=&account=
  const [searchParams] = useSearchParams();
  const drill = { vendor: searchParams.get('vendor') || '', account: searchParams.get('account') || '' };
  const [overview, setOverview] = useState(null);
  const [qboId, setQboId] = useState('');
  const [month, setMonth] = useState(isMonth(searchParams.get('month')) ? searchParams.get('month') : addMonths(currentMonth(), -1));
  const [runsInfo, setRunsInfo] = useState(null);
  const [data, setData] = useState(null);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState({ status: [], reviewState: drill.vendor || drill.account ? 'all' : 'open', accountType: ['Expense'], entityId: '', ai: '', evidence: '' });
  const [aiRefresh, setAiRefresh] = useState(0);
  const [detailLine, setDetailLine] = useState(null);
  const [evidenceJobId, setEvidenceJobId] = useState(null);
  const [text, setText] = useState({ account: drill.account, vendor: drill.vendor, search: '' });
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
  const [accountsInfo, setAccountsInfo] = useState(null);
  const [reclassifyDialog, setReclassifyDialog] = useState(null); // { lineIds } | { bulk: true }
  const [dueDialog, setDueDialog] = useState(null); // { lineIds } | { bulk: true }
  const [dueSetupOpen, setDueSetupOpen] = useState(false);

  const files = useMemo(() => overview?.qbos || [], [overview]);
  const file = files.find((q) => q.qboId === qboId) || null;
  const run = runsInfo?.runs?.[0] || null;
  const kind = data?.run?.reviewKind || (file && !file.isClassBased ? 'Account' : 'Class');

  useEffect(() => {
    setOverview(null);
    setQboId('');
    if (!groupId) return;
    getControllerOverview(groupId)
      .then((ov) => {
        setOverview(ov);
        // Start on the management (class-based) file when there is one.
        const classFiles = ov.qbos.filter((q) => q.isClassBased);
        const wanted = ov.qbos.find((q) => q.qboId === searchParams.get('qboId'));
        if (wanted) setQboId(wanted.qboId);
        else if (classFiles.length === 1) setQboId(classFiles[0].qboId);
        else if (ov.qbos.length === 1) setQboId(ov.qbos[0].qboId);
      })
      .catch(setError);
  }, [groupId]);

  const loadAccounts = useCallback(async () => {
    setAccountsInfo(null);
    if (!groupId || !qboId) return;
    try {
      setAccountsInfo(await getReviewAccounts(groupId, qboId));
    } catch (err) {
      setError(err);
    }
  }, [groupId, qboId]);
  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

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
      ...(filters.ai ? { ai: filters.ai } : {}),
      ...(filters.evidence ? { evidence: filters.evidence } : {}),
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

  const entities = useMemo(() => data?.entities || [], [data]);
  const entityName = useCallback((id) => entities.find((e) => e.entityId === id)?.entityName || '—', [entities]);

  const runReview = async () => {
    setBusy('run');
    setError(null);
    try {
      const result = await startReviewRun(groupId, qboId, month);
      const ai = result.ai;
      const aiText = ai?.jobId
        ? ` The AI is looking at ${ai.lineCount.toLocaleString()} line${ai.lineCount === 1 ? '' : 's'} rules and history couldn't settle; suggestions appear as they arrive.`
        : ai?.skipped
          ? ` AI: ${ai.skipped}.`
          : '';
      setNotice(`Reviewed ${result.lineCount.toLocaleString()} lines.${aiText}`);
      await loadRuns();
      setAiRefresh((n) => n + 1);
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
        s.noDueToFromAccount && `${s.noDueToFromAccount} needing a Due To/From account`,
      ].filter(Boolean);
      setNotice(`${label}: ${result.decided} line${result.decided === 1 ? '' : 's'}${skippedText.length ? ` (skipped ${skippedText.join(', ')})` : ''}.`);
      setSelected(new Set());
      setAllMatching(false);
      // A Due To/From decision with an account also saves that account.
      if (body.account && body.action === 'DueToFrom' && body.rememberAccount !== false) await loadAccounts();
      await loadLines();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  // extra: { entityId } | { account } | { counterpartyEntityId, account? }
  const bulk = (action, extra = {}) => {
    const body = allMatching
      ? { action, filter: queryParams, expectedCount: data.total, ...extra }
      : { action, lineIds: [...selected], ...extra };
    return decide(body, action === 'Keep' ? keepText(kind) : ACTION_TEXT[action]);
  };
  // A line dialog's target: the selection (bulk) or the given lines.
  const applyTo = (target, action, extra) =>
    target.bulk ? bulk(action, extra) : decide({ action, lineIds: target.lineIds, ...extra }, ACTION_TEXT[action]);
  const closeMenu = () => setMenu({ anchor: null, line: null });
  const canApprove = (l) => (kind === 'Account' ? Boolean(l.suggestedAction) : Boolean(l.suggestedEntityId || l.currentEntityId));
  const canAcceptAi = (l) => Boolean(l.ai && l.ai.action !== 'Unsure') && !busy;

  // Evidence: "Find Evidence" (one line, right away) and "Search All" (the
  // selection, or every matching line, in the background).
  const findOne = async (l) => {
    setBusy('evidence');
    setError(null);
    try {
      const r = await findEvidence(groupId, run.runId, l.lineId);
      setNotice(r.candidates.length ? `Found ${r.candidates.length} possible match${r.candidates.length === 1 ? '' : 'es'}.` : 'No evidence found in the opted-in mailboxes.');
      await loadLines();
      if (r.candidates.length) setDetailLine(l);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  const searchAll = async () => {
    setError(null);
    try {
      const body = selectionCount && !allMatching
        ? { runId: run.runId, lineIds: [...selected] }
        : { runId: run.runId, filter: queryParams, expectedCount: data.total };
      const r = await startEvidenceSearch(groupId, body);
      setNotice(`Searching ${r.lineCount.toLocaleString()} line${r.lineCount === 1 ? '' : 's'} for evidence${r.skipped ? ` (the ${r.lineCount} largest; ${r.skipped} more can be searched next)` : ''}.`);
      setEvidenceJobId(r.jobId);
    } catch (err) {
      setError(err);
    }
  };
  const onEvidenceDone = useCallback(
    (job) => {
      setEvidenceJobId(null);
      setNotice(`Evidence search finished for ${job.lineCount.toLocaleString()} lines.${job.errors?.length ? ` Some searches failed: ${job.errors[0]}` : ''}`);
      loadLines();
    },
    [loadLines]
  );

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
          {files.length === 0 ? (
            <Typography color="text.secondary">No QBO file in this Group.</Typography>
          ) : (
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
              <Select size="small" displayEmpty value={qboId} onChange={(e) => setQboId(e.target.value)} sx={{ minWidth: 260 }} inputProps={{ 'aria-label': 'QBO file' }}>
                <MenuItem value="" disabled>
                  Select a QBO file
                </MenuItem>
                {files.map((q) => (
                  <MenuItem key={q.qboId} value={q.qboId}>
                    {q.qboName} ({q.isClassBased ? 'class review' : 'account review'})
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
              <Box sx={{ flex: 1 }} />
              {qboId && accountsInfo && (
                <Button size="small" onClick={() => setDueSetupOpen(true)} disabled={!entities.length}>
                  Due To/From accounts
                </Button>
              )}
            </Box>
          )}
          {file && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              {file.isClassBased
                ? 'Class review: which entity each line belongs to. You can also reclassify lines or mark them Due To/From another entity.'
                : 'Account review: whether each line is in the right account, or belongs to another entity (Due To/From).'}
            </Typography>
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
          {kind === 'Class' && data.summary.Conflict?.open > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {data.summary.Conflict.open} conflict{data.summary.Conflict.open === 1 ? '' : 's'} between a vendor rule and history.{' '}
              <Link component={RouterLink} to={`/controller/conflicts?qboId=${qboId}&month=${month}`}>
                Resolve in Conflicts
              </Link>{' '}
              to see the rule and history side by side.
            </Alert>
          )}
          <AiPassStatus
            groupId={groupId}
            runId={run?.runId}
            qboId={qboId}
            month={month}
            entityName={entityName}
            onAnswers={loadLines}
            refreshKey={aiRefresh}
          />
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
            {Object.entries(STATUS_INFO).filter(([status]) => !(kind === 'Account' && status === 'Unclassified')).map(([status, info]) => {
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
            <Select size="small" displayEmpty value={filters.ai} onChange={(e) => setFilters((f) => ({ ...f, ai: e.target.value }))} sx={{ minWidth: 160 }} inputProps={{ 'aria-label': 'AI filter' }}>
              <MenuItem value="">Any AI answer</MenuItem>
              <MenuItem value="suggested">AI suggested</MenuItem>
              <MenuItem value="unsure">AI unsure</MenuItem>
              <MenuItem value="none">Not asked</MenuItem>
            </Select>
            <Select size="small" displayEmpty value={filters.evidence} onChange={(e) => setFilters((f) => ({ ...f, evidence: e.target.value }))} sx={{ minWidth: 170 }} inputProps={{ 'aria-label': 'Evidence filter' }}>
              <MenuItem value="">Any evidence</MenuItem>
              <MenuItem value="found">Evidence found</MenuItem>
              <MenuItem value="none">Searched, none found</MenuItem>
              <MenuItem value="unsearched">Not searched</MenuItem>
              <MenuItem value="saved">Supported (saved)</MenuItem>
            </Select>
          </Box>
          <EvidenceJobProgress groupId={groupId} jobId={evidenceJobId} onDone={onEvidenceDone} />

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
            <Button size="small" variant="outlined" disabled={!selectionCount || Boolean(busy)} onClick={() => (allMatching ? setConfirmBulk('AcceptAi') : bulk('AcceptAi'))}>
              Accept AI suggestions
            </Button>
            <Button size="small" variant="outlined" disabled={Boolean(busy) || Boolean(evidenceJobId) || !data.total} onClick={searchAll}>
              {selectionCount && !allMatching ? 'Search selected for evidence' : 'Search All'}
            </Button>
            <Button size="small" disabled={!selectionCount || Boolean(busy)} onClick={() => (allMatching ? setConfirmBulk('Keep') : bulk('Keep'))}>
              {keepText(kind)}
            </Button>
            {kind === 'Class' && (
              <Button size="small" disabled={!selectionCount || Boolean(busy)} onClick={() => setEntityDialog({ bulk: true })}>
                Set entity…
              </Button>
            )}
            <Button size="small" disabled={!selectionCount || Boolean(busy) || !accountsInfo} onClick={() => setReclassifyDialog({ bulk: true })}>
              Reclassify…
            </Button>
            <Button size="small" disabled={!selectionCount || Boolean(busy) || !accountsInfo} onClick={() => setDueDialog({ bulk: true })}>
              Due To/From…
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
                  {kind === 'Class' && <TableCell>Class now</TableCell>}
                  <TableCell>Suggested</TableCell>
                  <TableCell>AI</TableCell>
                  <TableCell>Evidence</TableCell>
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
                    {kind === 'Class' && <TableCell>{l.className || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</TableCell>}
                    <TableCell>
                      {kind === 'Account' ? describeSuggestion(l, entityName) : l.suggestedEntityId ? entityName(l.suggestedEntityId) : '—'}
                      {l.confidence > 0 && (
                        <Typography variant="caption" color="text.secondary" display="block">
                          {confidenceLabel(l.confidence, data.run.threshold, data.run.mediumThreshold)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 200 }}>
                      <AiSuggestion
                        ai={l.ai}
                        entityName={entityName}
                        canAccept={canAcceptAi(l)}
                        busy={Boolean(busy)}
                        onAccept={() => decide({ action: 'AcceptAi', lineIds: [l.lineId] }, ACTION_TEXT.AcceptAi)}
                      />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <EvidenceCell
                        evidence={l.evidence}
                        entityName={entityName}
                        busy={Boolean(busy)}
                        onOpen={() => setDetailLine(l)}
                        onFind={() => findOne(l)}
                      />
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
                          <IconButton size="small" aria-label={`Approve ${l.lineId}`} disabled={Boolean(busy) || !canApprove(l)} onClick={() => decide({ action: 'Approve', lineIds: [l.lineId] }, ACTION_TEXT.Approve)}>
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
                    <TableCell colSpan={13} sx={{ color: 'text.secondary' }}>
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
          <MenuItem key="keep" disabled={kind === 'Class' && !menu.line.currentEntityId} onClick={() => { decide({ action: 'Keep', lineIds: [menu.line.lineId] }, keepText(kind)); closeMenu(); }}>
            {keepText(kind)}
          </MenuItem>,
          kind === 'Class' && (
            <MenuItem key="set" onClick={() => { setEntityDialog({ lineIds: [menu.line.lineId] }); closeMenu(); }}>
              Set entity…
            </MenuItem>
          ),
          kind === 'Class' && (
            <MenuItem key="split" onClick={() => { setSplitLine(menu.line); closeMenu(); }}>
              Split…
            </MenuItem>
          ),
          <MenuItem key="reclassify" disabled={!accountsInfo} onClick={() => { setReclassifyDialog({ lineIds: [menu.line.lineId] }); closeMenu(); }}>
            Reclassify…
          </MenuItem>,
          <MenuItem key="due" disabled={!accountsInfo} onClick={() => { setDueDialog({ lineIds: [menu.line.lineId] }); closeMenu(); }}>
            Due To/From…
          </MenuItem>,
          <MenuItem key="detail" onClick={() => { setDetailLine(menu.line); closeMenu(); }}>
            Line detail and evidence
          </MenuItem>,
          <MenuItem key="undo" disabled={!menu.line.decision} onClick={() => { decide({ action: 'Undo', lineIds: [menu.line.lineId] }, 'Undone'); closeMenu(); }}>
            Undo decision
          </MenuItem>,
        ].filter(Boolean)}
      </Menu>

      <EntityDialog
        open={Boolean(entityDialog)}
        title={entityDialog?.bulk ? `Set entity on ${selectionCount.toLocaleString()} lines` : 'Set entity'}
        entities={entities}
        onClose={() => setEntityDialog(null)}
        onSave={(entityId) => {
          const target = entityDialog;
          setEntityDialog(null);
          applyTo(target, 'Reassign', { entityId });
        }}
      />
      <ReclassifyDialog
        open={Boolean(reclassifyDialog)}
        title={reclassifyDialog?.bulk ? `Reclassify ${selectionCount.toLocaleString()} lines` : 'Reclassify'}
        accounts={accountsInfo?.accounts || []}
        onClose={() => setReclassifyDialog(null)}
        onSave={(account) => {
          const target = reclassifyDialog;
          setReclassifyDialog(null);
          applyTo(target, 'Reclassify', { account: { code: account.code, name: account.name } });
        }}
      />
      <DueToFromDialog
        open={Boolean(dueDialog)}
        title={dueDialog?.bulk ? `Due To/From for ${selectionCount.toLocaleString()} lines` : 'Due To/From another entity'}
        entities={entities}
        accountsInfo={accountsInfo}
        onClose={() => setDueDialog(null)}
        onSave={({ counterpartyEntityId, account, rememberAccount }) => {
          const target = dueDialog;
          setDueDialog(null);
          applyTo(target, 'DueToFrom', {
            counterpartyEntityId,
            ...(account ? { account: { code: account.code, name: account.name }, rememberAccount } : {}),
          });
        }}
      />
      {qboId && (
        <DueToFromSetupDialog
          open={dueSetupOpen}
          groupId={groupId}
          qboId={qboId}
          qboName={file?.qboName}
          entities={entities}
          accountsInfo={accountsInfo}
          onClose={(saved) => {
            setDueSetupOpen(false);
            if (saved) {
              setNotice('Due To/From accounts saved. Run the review again to use them in suggestions.');
              loadAccounts();
            }
          }}
        />
      )}
      {run && (
        <EvidenceDrawer
          groupId={groupId}
          runId={run.runId}
          line={detailLine}
          entityName={entityName}
          onClose={() => setDetailLine(null)}
          onChanged={loadLines}
        />
      )}
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
        <DialogTitle>{confirmBulk === 'Keep' ? keepText(kind) : ACTION_TEXT[confirmBulk]}</DialogTitle>
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMore from '@mui/icons-material/ExpandMore';
import ExpandLess from '@mui/icons-material/ExpandLess';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import {
  checkAjePosted,
  exportAjeReport,
  getAjeDraft,
  getAjeOverview,
  getAjeReport,
  getSavedEvidenceDownload,
  publishAjeReport,
  saveAjeSettings,
} from '../../api/controller';
import { formatMonth, isMonth } from '../../utils/months';
import { formatCurrency } from '../../utils/format';

const errorText = (err) => err?.response?.data?.message || err?.message;
const acct = (code, name) => [code, name].filter(Boolean).join(' ');
const pad = (n, w) => String(n).padStart(w, '0');

// "MGMT-2026-10-AJE-003": the number the next report will get.
export function nextReportNumber(fileCode, month, reports, qboId) {
  const seqs = reports.filter((r) => r.qboId === qboId && r.month === month).map((r) => r.seq);
  return `${fileCode}-${month}-AJE-${pad((seqs.length ? Math.max(...seqs) : 0) + 1, 3)}`;
}

// A state ([{ code, name, className, amount }]) in a few words.
export function describeState(state) {
  if (!state || !state.length) return '—';
  return state.map((p) => `${acct(p.code, p.name)}${p.className ? ` · ${p.className}` : ''}`).join(' / ');
}

// Posted status of a report, for the list.
export function postedLabel(report) {
  if (!report.entryCount) return '—';
  if (report.postedCount >= report.entryCount) return 'All posted';
  if (!report.postedCount) return 'Not seen in GL';
  return `${report.postedCount} of ${report.entryCount} posted`;
}

// The report a file and month can revise: its latest one still in force.
export function revisableReportId(reports, report) {
  const live = reports.filter((r) => r.qboId === report.qboId && r.month === report.month && r.status === 'Published');
  if (!live.length) return null;
  return live.reduce((a, b) => (b.seq > a.seq ? b : a)).reportId;
}

function EntryLinesTable({ lines }) {
  return (
    <Table size="small" sx={{ mb: 1 }}>
      <TableHead>
        <TableRow>
          <TableCell>Account</TableCell>
          <TableCell>Class</TableCell>
          <TableCell align="right">Debit</TableCell>
          <TableCell align="right">Credit</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {lines.map((l, i) => (
          <TableRow key={i}>
            <TableCell>{acct(l.accountCode, l.accountName)}</TableCell>
            <TableCell>{l.className || ''}</TableCell>
            <TableCell align="right">{l.debit ? formatCurrency(l.debit) : ''}</TableCell>
            <TableCell align="right">{l.credit ? formatCurrency(l.credit) : ''}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BackupTable({ sources }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Date</TableCell>
          <TableCell>Payee</TableCell>
          <TableCell>Memo</TableCell>
          <TableCell align="right">Amount</TableCell>
          <TableCell>From</TableCell>
          <TableCell>To</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sources.map((s) => (
          <TableRow key={`${s.side}-${s.sourceQboId}-${s.fingerprint}`}>
            <TableCell>{s.txnDate}</TableCell>
            <TableCell>{s.payeeName}</TableCell>
            <TableCell sx={{ maxWidth: 220 }}>{s.memo}</TableCell>
            <TableCell align="right">{formatCurrency(s.amount)}</TableCell>
            <TableCell>{s.side === 'Mirror' ? 'Other entity\'s file' : describeState(s.from)}</TableCell>
            <TableCell>{describeState(s.to)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SupportLinks({ groupId, support, onError }) {
  if (!support.length) return <Typography variant="body2" color="text.secondary">No saved support.</Typography>;
  const open = async (s) => {
    try {
      const { url } = await getSavedEvidenceDownload(groupId, s.savedId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      onError(err);
    }
  };
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      {support.map((s) => (
        <Chip key={s.savedId} size="small" variant="outlined" label={s.fileName || s.title || 'Support'} onClick={() => open(s)} />
      ))}
    </Stack>
  );
}

function DraftEntry({ entry, groupId, checked, onToggle, memo, onMemo, onError }) {
  const [open, setOpen] = useState(false);
  const blocked = entry.issues.length > 0;
  return (
    <>
      <TableRow hover>
        <TableCell padding="checkbox">
          <Checkbox checked={checked} disabled={blocked} onChange={onToggle} inputProps={{ 'aria-label': `Include ${entry.vendor || 'entry'}` }} />
        </TableCell>
        <TableCell>
          <Chip size="small" label={entry.kindLabel} color={entry.kind === 'Reversal' ? 'warning' : 'default'} />
        </TableCell>
        <TableCell>{entry.vendor || 'No payee'}</TableCell>
        <TableCell align="right">{formatCurrency(entry.amount)}</TableCell>
        <TableCell>{entry.sources.length}</TableCell>
        <TableCell>{entry.support.length ? <Chip size="small" color="success" variant="outlined" label={`${entry.support.length} saved`} /> : '—'}</TableCell>
        <TableCell sx={{ minWidth: 320 }}>
          <TextField size="small" fullWidth multiline maxRows={3} value={memo} onChange={(e) => onMemo(e.target.value)} inputProps={{ 'aria-label': 'Memo', maxLength: 1000 }} />
          {entry.issues.map((m) => <Alert key={m} severity="error" sx={{ mt: 0.5, py: 0 }}>{m}</Alert>)}
          {entry.warnings.map((m) => <Typography key={m} variant="caption" color="text.secondary" display="block">{m}</Typography>)}
        </TableCell>
        <TableCell>
          <IconButton size="small" onClick={() => setOpen((v) => !v)} aria-label="Details">
            {open ? <ExpandLess /> : <ExpandMore />}
          </IconButton>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={8} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
          <Collapse in={open} unmountOnExit>
            <Box sx={{ py: 1 }}>
              <EntryLinesTable lines={entry.lines} />
              <BackupTable sources={entry.sources} />
              <Box sx={{ mt: 1 }}>
                <SupportLinks groupId={groupId} support={entry.support} onError={onError} />
              </Box>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

function ReportDialog({ groupId, reportId, onClose, onRevise, canRevise, onError }) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    if (!reportId) return;
    try {
      setReport(await getAjeReport(groupId, reportId));
    } catch (err) {
      onError(err);
    }
  }, [groupId, reportId, onError]);
  useEffect(() => {
    setReport(null);
    setMessage(null);
    load();
  }, [load]);

  const download = async (format) => {
    setBusy(format);
    try {
      const { url, supportIncluded } = await exportAjeReport(groupId, reportId, format);
      window.open(url, '_blank', 'noopener');
      if (format === 'pdf') setMessage(`PDF ready${supportIncluded ? ` with ${supportIncluded} support file${supportIncluded === 1 ? '' : 's'} attached` : ''}.`);
    } catch (err) {
      onError(err);
    } finally {
      setBusy('');
    }
  };

  const checkGl = async () => {
    setBusy('check');
    try {
      const r = await checkAjePosted(groupId, report.qboId);
      setMessage(`Checked ${r.snapshotsChecked} stored month${r.snapshotsChecked === 1 ? '' : 's'}: ${r.newlyPosted} entr${r.newlyPosted === 1 ? 'y' : 'ies'} newly seen as posted.`);
      await load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy('');
    }
  };

  const copy = (text) => navigator.clipboard?.writeText(text);

  return (
    <Dialog open={Boolean(reportId)} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>{report ? report.reportNumber : 'Report'}</DialogTitle>
      <DialogContent dividers>
        {!report && <CircularProgress size={24} />}
        {report && (
          <>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {report.qboName} · {formatMonth(report.month)} · {report.entryCount} entr{report.entryCount === 1 ? 'y' : 'ies'} · {formatCurrency(report.totalAmount)} ·{' '}
              {report.grouping === 'PerLine' ? 'Per line' : 'Grouped'}
              {report.supersedes ? ` · Replaces ${report.supersedes}` : ''}
            </Typography>
            {report.status === 'Superseded' && <Alert severity="warning" sx={{ mb: 1 }}>Superseded by {report.supersededBy}.</Alert>}
            {report.note && <Typography variant="body2" sx={{ mb: 1 }}>Note: {report.note}</Typography>}
            {message && <Alert severity="info" sx={{ mb: 1 }} onClose={() => setMessage(null)}>{message}</Alert>}
            <Alert severity="info" sx={{ mb: 2 }}>
              Recommendations only — nothing is posted to QuickBooks from here. Type each entry&apos;s QBO Num in the journal entry&apos;s Num field (QuickBooks
              allows 21 characters) and paste its memo; the next GL pull marks it posted.
            </Alert>
            {report.entries.map((e) => (
              <Paper key={e.entryId} variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                  <Typography fontWeight={600}>{e.entryNumber}</Typography>
                  <Chip size="small" label={e.kindLabel} />
                  {e.vendor && <Typography variant="body2">{e.vendor}</Typography>}
                  <Typography variant="body2" color="text.secondary">Date {e.entryDate}</Typography>
                  <Typography variant="body2">
                    QBO Num <b>{e.qboNum}</b>
                  </Typography>
                  <Tooltip title="Copy QBO Num">
                    <IconButton size="small" onClick={() => copy(e.qboNum)} aria-label={`Copy ${e.qboNum}`}><ContentCopyIcon fontSize="inherit" /></IconButton>
                  </Tooltip>
                  {e.posted ? (
                    <Chip size="small" color="success" label={`Posted (seen in ${formatMonth(e.posted.month)} GL)`} />
                  ) : (
                    <Chip size="small" variant="outlined" label="Not seen in GL yet" />
                  )}
                </Stack>
                <EntryLinesTable lines={e.lines} />
                <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 1 }}>
                  <Typography variant="body2" sx={{ flex: 1 }}>Memo: {e.memo}</Typography>
                  <Tooltip title="Copy memo">
                    <IconButton size="small" onClick={() => copy(e.memo)} aria-label="Copy memo"><ContentCopyIcon fontSize="inherit" /></IconButton>
                  </Tooltip>
                </Stack>
                {e.warnings.map((w) => <Typography key={w} variant="caption" color="text.secondary" display="block">{w}</Typography>)}
                <BackupTable sources={e.sources} />
                <Box sx={{ mt: 1 }}>
                  <SupportLinks groupId={groupId} support={e.support} onError={onError} />
                </Box>
              </Paper>
            ))}
          </>
        )}
      </DialogContent>
      <DialogActions>
        {report && canRevise && <Button onClick={() => onRevise(report)}>Revise…</Button>}
        <Button onClick={checkGl} disabled={!report || Boolean(busy)}>{busy === 'check' ? 'Checking…' : 'Check GL now'}</Button>
        <Button onClick={() => download('xlsx')} disabled={!report || Boolean(busy)}>{busy === 'xlsx' ? 'Preparing…' : 'Excel'}</Button>
        <Button onClick={() => download('pdf')} disabled={!report || Boolean(busy)} variant="contained">{busy === 'pdf' ? 'Preparing…' : 'PDF with support'}</Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function SettingsDialog({ open, overview, onClose, onSave }) {
  const [codes, setCodes] = useState({});
  const [grouping, setGrouping] = useState('Grouped');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open || !overview) return;
    setCodes(Object.fromEntries(overview.files.map((f) => [f.qboId, f.fileCode])));
    setGrouping(overview.defaultGrouping);
    setError(null);
  }, [open, overview]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ defaultGrouping: grouping, files: Object.entries(codes).map(([qboId, fileCode]) => ({ qboId, fileCode })) });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>AJE settings</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Each file&apos;s code starts its report numbers (MGMT-2026-10-AJE-001). Published numbers never change, even if the code does.
        </Typography>
        {overview?.files.map((f) => (
          <Stack key={f.qboId} direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
            <Typography sx={{ flex: 1 }}>{f.qboName}</Typography>
            <TextField
              size="small"
              value={codes[f.qboId] || ''}
              onChange={(e) => setCodes((c) => ({ ...c, [f.qboId]: e.target.value.toUpperCase() }))}
              inputProps={{ 'aria-label': `Code for ${f.qboName}`, maxLength: 6 }}
              sx={{ width: 120 }}
              helperText={f.codeSaved ? 'In use' : 'Suggested'}
            />
          </Stack>
        ))}
        <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>Default grouping</Typography>
        <ToggleButtonGroup size="small" exclusive value={grouping} onChange={(_, v) => v && setGrouping(v)}>
          <ToggleButton value="Grouped">Grouped</ToggleButton>
          <ToggleButton value="PerLine">Per line</ToggleButton>
        </ToggleButtonGroup>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function AjeReports() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);
  const [qboId, setQboId] = useState('');
  const [month, setMonth] = useState('');
  const [grouping, setGrouping] = useState('');
  const [revise, setRevise] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [included, setIncluded] = useState({});
  const [memos, setMemos] = useState({});
  const [note, setNote] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(null);
  const [openReport, setOpenReport] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loadOverview = useCallback(async () => {
    if (!groupId) return;
    try {
      const o = await getAjeOverview(groupId);
      setOverview(o);
      setGrouping((g) => g || o.defaultGrouping);
      setQboId((q) => q || o.files[0]?.qboId || '');
      setMonth((m) => m || o.activity[0]?.month || '');
    } catch (err) {
      setError(err);
    }
  }, [groupId]);
  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const loadDraft = useCallback(async () => {
    if (!groupId || !qboId || !isMonth(month) || !grouping) return;
    setDraftLoading(true);
    try {
      const d = await getAjeDraft(groupId, { qboId, month, grouping, reviseReportId: revise?.reportId });
      setDraft(d);
      setIncluded(Object.fromEntries(d.entries.map((e) => [e.key, e.issues.length === 0])));
      setMemos(Object.fromEntries(d.entries.map((e) => [e.key, e.memo])));
    } catch (err) {
      setDraft(null);
      setError(err);
    } finally {
      setDraftLoading(false);
    }
  }, [groupId, qboId, month, grouping, revise]);
  useEffect(() => {
    loadDraft();
  }, [loadDraft]);

  const files = useMemo(() => overview?.files || [], [overview]);
  const reports = useMemo(() => overview?.reports || [], [overview]);
  const file = files.find((f) => f.qboId === qboId);
  const fileMonths = (overview?.activity || []).filter((a) => a.qboId === qboId);
  const chosen = draft ? draft.entries.filter((e) => included[e.key]) : [];
  const total = chosen.reduce((s, e) => s + e.amount, 0);

  const publish = async () => {
    setPublishing(true);
    setError(null);
    try {
      const r = await publishAjeReport(groupId, {
        qboId,
        month,
        grouping,
        expectedKeys: draft.entries.map((e) => e.key),
        include: chosen.map((e) => ({ key: e.key, ...(memos[e.key] !== e.memo ? { memo: memos[e.key] } : {}) })),
        ...(revise ? { reviseReportId: revise.reportId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setPublished(r);
      setRevise(null);
      setNote('');
      await loadOverview();
      await loadDraft();
    } catch (err) {
      setError(err);
    } finally {
      setPublishing(false);
    }
  };

  const startRevise = (report) => {
    setOpenReport(null);
    setQboId(report.qboId);
    setMonth(report.month);
    setRevise({ reportId: report.reportId, reportNumber: report.reportNumber });
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h1">AJE reports</Typography>
        <Button onClick={() => setSettingsOpen(true)} disabled={!overview}>Settings</Button>
      </Stack>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{errorText(error)}</Alert>}
      {published && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setPublished(null)}
          action={<Button color="inherit" size="small" onClick={() => setOpenReport(published.reportId)}>Open</Button>}>
          Published {published.reportNumber}: {published.entryCount} entr{published.entryCount === 1 ? 'y' : 'ies'}, {formatCurrency(published.totalAmount)}
          {published.supersedes ? `, replacing ${published.supersedes}` : ''}.
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>{revise ? `Revise ${revise.reportNumber}` : 'New report'}</Typography>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <Select size="small" value={qboId} onChange={(e) => { setQboId(e.target.value); setRevise(null); }} displayEmpty inputProps={{ 'aria-label': 'QBO file' }} sx={{ minWidth: 240 }} disabled={Boolean(revise)}>
            {files.map((f) => <MenuItem key={f.qboId} value={f.qboId}>{f.qboName} ({f.fileCode})</MenuItem>)}
          </Select>
          <TextField size="small" type="month" label="Month" InputLabelProps={{ shrink: true }} value={month} onChange={(e) => { setMonth(e.target.value); setRevise(null); }} disabled={Boolean(revise)} />
          <ToggleButtonGroup size="small" exclusive value={grouping} onChange={(_, v) => v && setGrouping(v)} aria-label="Grouping">
            <ToggleButton value="Grouped">Grouped</ToggleButton>
            <ToggleButton value="PerLine">Per line</ToggleButton>
          </ToggleButtonGroup>
          {revise && <Button size="small" onClick={() => setRevise(null)}>Cancel revision</Button>}
          {draftLoading && <CircularProgress size={20} />}
        </Stack>
        {fileMonths.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
            <Typography variant="body2" color="text.secondary">Months with decisions:</Typography>
            {fileMonths.slice(0, 12).map((a) => (
              <Chip key={a.month} size="small" label={`${formatMonth(a.month)} (${a.decidedLines})`} variant={a.month === month ? 'filled' : 'outlined'}
                onClick={() => { setMonth(a.month); setRevise(null); }} />
            ))}
          </Stack>
        )}

        {draft && file && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Entries dated {draft.entryDate}. Publishing numbers this report <b>{nextReportNumber(file.fileCode, month, reports, qboId)}</b>
              {revise ? `, replacing ${revise.reportNumber}` : ''}
              {draft.activeReports.length > 0 && !revise ? `. Already published for this month: ${draft.activeReports.map((r) => r.reportNumber).join(', ')} (their lines are left out here)` : ''}.
            </Typography>
            {draft.entries.length === 0 ? (
              <Alert severity="info">Nothing to recommend: no decision for {formatMonth(month)} changes this file&apos;s books beyond what is already published.</Alert>
            ) : (
              <>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox" />
                      <TableCell>Kind</TableCell>
                      <TableCell>Vendor</TableCell>
                      <TableCell align="right">Amount</TableCell>
                      <TableCell>Lines</TableCell>
                      <TableCell>Support</TableCell>
                      <TableCell>Memo (the entry number is added in front)</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {draft.entries.map((e) => (
                      <DraftEntry
                        key={e.key}
                        entry={e}
                        groupId={groupId}
                        checked={Boolean(included[e.key])}
                        onToggle={() => setIncluded((s) => ({ ...s, [e.key]: !s[e.key] }))}
                        memo={memos[e.key] ?? e.memo}
                        onMemo={(v) => setMemos((s) => ({ ...s, [e.key]: v }))}
                        onError={setError}
                      />
                    ))}
                  </TableBody>
                </Table>
                <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
                  <TextField size="small" label="Note for the accountant (optional)" value={note} onChange={(e) => setNote(e.target.value)} sx={{ minWidth: 320, flex: 1 }} />
                  <Typography variant="body2">{chosen.length} of {draft.entries.length} entries · {formatCurrency(total)}</Typography>
                  <Button variant="contained" onClick={publish} disabled={publishing || !chosen.length}>
                    {publishing ? 'Publishing…' : revise ? `Publish revision (${chosen.length})` : `Publish ${chosen.length} entr${chosen.length === 1 ? 'y' : 'ies'}`}
                  </Button>
                </Stack>
              </>
            )}
          </Box>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Published reports</Typography>
        {reports.length === 0 ? (
          <Typography variant="body2" color="text.secondary">None yet.</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Report</TableCell>
                <TableCell>File</TableCell>
                <TableCell>Month</TableCell>
                <TableCell align="right">Entries</TableCell>
                <TableCell align="right">Total</TableCell>
                <TableCell>Posted</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {reports.map((r) => (
                <TableRow key={r.reportId} hover sx={{ opacity: r.status === 'Superseded' ? 0.6 : 1 }}>
                  <TableCell>
                    <Link component="button" onClick={() => setOpenReport(r.reportId)}>{r.reportNumber}</Link>
                  </TableCell>
                  <TableCell>{r.qboName}</TableCell>
                  <TableCell>{formatMonth(r.month)}</TableCell>
                  <TableCell align="right">{r.entryCount}</TableCell>
                  <TableCell align="right">{formatCurrency(r.totalAmount)}</TableCell>
                  <TableCell>{postedLabel(r)}</TableCell>
                  <TableCell>{r.status === 'Superseded' ? `Superseded by ${r.supersededBy}` : r.supersedes ? `Replaces ${r.supersedes}` : 'Published'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <ReportDialog
        groupId={groupId}
        reportId={openReport}
        onClose={() => setOpenReport(null)}
        onRevise={startRevise}
        canRevise={Boolean(openReport) && revisableReportId(reports, reports.find((r) => r.reportId === openReport) || {}) === openReport}
        onError={setError}
      />
      <SettingsDialog
        open={settingsOpen}
        overview={overview}
        onClose={() => setSettingsOpen(false)}
        onSave={async (body) => setOverview(await saveAjeSettings(groupId, body))}
      />
    </Box>
  );
}

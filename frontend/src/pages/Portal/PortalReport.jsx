import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { addPortalComment, exportPortalReport, getPortalDoc, getPortalReport, setPortalEntryStatus } from '../../api/portal';
import { BackupTable, EntryLinesTable, EntryThread, PortalStatusChips, STATUS_OPTIONS, formatWhen } from '../../components/aje/AjeParts';
import { formatMonth } from '../../utils/months';
import { formatCurrency } from '../../utils/format';

const errorText = (err) => err?.response?.data?.message || err?.message;

function DeclineDialog({ entry, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [entry]);
  return (
    <Dialog open={Boolean(entry)} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Decline {entry?.entryNumber}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={3}
          label="Why is this entry declined?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          inputProps={{ maxLength: 2000 }}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" color="error" disabled={!reason.trim()} onClick={() => onConfirm(reason.trim())}>Decline</Button>
      </DialogActions>
    </Dialog>
  );
}

function PortalEntry({ entry, editable, onStatus, onComment, onOpenDoc }) {
  const copy = (text) => navigator.clipboard?.writeText(text);
  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Typography fontWeight={600}>{entry.entryNumber}</Typography>
        <Chip size="small" label={entry.kindLabel} />
        {entry.vendor && <Typography variant="body2">{entry.vendor}</Typography>}
        <Typography variant="body2" color="text.secondary">Date {entry.entryDate}</Typography>
        <Typography variant="body2">{formatCurrency(entry.amount)}</Typography>
        <Typography variant="body2">QBO Num <b>{entry.qboNum}</b></Typography>
        <Tooltip title="Copy QBO Num">
          <IconButton size="small" onClick={() => copy(entry.qboNum)} aria-label={`Copy ${entry.qboNum}`}><ContentCopyIcon fontSize="inherit" /></IconButton>
        </Tooltip>
        {entry.posted && <Chip size="small" color="success" variant="outlined" label={`Seen in ${formatMonth(entry.posted.month)} GL`} />}
        {entry.portal?.questionOpen && <Chip size="small" color="warning" label="Question open" />}
        <Box sx={{ flex: 1 }} />
        {editable ? (
          <TextField
            select
            size="small"
            label="Status"
            value={entry.portal.status}
            onChange={(e) => onStatus(entry, e.target.value)}
            sx={{ minWidth: 160 }}
            inputProps={{ 'aria-label': `Status of ${entry.entryNumber}` }}
          >
            {STATUS_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
        ) : (
          <PortalStatusChips portal={{ ...entry.portal, questionOpen: false }} />
        )}
      </Stack>
      {entry.portal?.status !== 'NotWorked' && entry.portal?.setBy && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          {entry.portal.statusLabel} by {entry.portal.setBy}, {formatWhen(entry.portal.setAt)}
          {entry.portal.reason ? `: ${entry.portal.reason}` : ''}
        </Typography>
      )}
      <EntryLinesTable lines={entry.lines} />
      <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 1 }}>
        <Typography variant="body2" sx={{ flex: 1 }}>Memo: {entry.memo}</Typography>
        <Tooltip title="Copy memo">
          <IconButton size="small" onClick={() => copy(entry.memo)} aria-label={`Copy memo of ${entry.entryNumber}`}><ContentCopyIcon fontSize="inherit" /></IconButton>
        </Tooltip>
      </Stack>
      {entry.warnings.map((w) => <Typography key={w} variant="caption" color="text.secondary" display="block">{w}</Typography>)}
      <BackupTable sources={entry.sources} />
      <Box sx={{ mt: 1 }}>
        {entry.support.length ? (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {entry.support.map((s) => (
              <Chip key={s.savedId} size="small" variant="outlined" label={s.fileName || s.title || 'Support'} onClick={() => onOpenDoc(s)} />
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">No supporting documents.</Typography>
        )}
      </Box>
      <EntryThread
        thread={entry.thread}
        entryNumber={entry.entryNumber}
        sendLabel={entry.thread.length ? 'Send' : 'Ask'}
        placeholder="Ask the controller a question about this entry"
        onSend={(body) => onComment(entry, body)}
      />
    </Paper>
  );
}

// One AJE report for the accountant: work each entry, ask questions, open support.
export default function PortalReport() {
  const { reportId } = useParams();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setReport(await getPortalReport(reportId));
    } catch (err) {
      setError(errorText(err));
    }
  }, [reportId]);
  useEffect(() => {
    setReport(null);
    setError(null);
    load();
  }, [load]);

  const patchEntry = (entryId, patch) =>
    setReport((r) => ({ ...r, entries: r.entries.map((e) => (e.entryId === entryId ? { ...e, ...patch(e) } : e)) }));

  const saveStatus = async (entry, status, reason) => {
    try {
      const r = await setPortalEntryStatus(entry.entryId, status, reason);
      patchEntry(entry.entryId, (e) => ({ portal: { ...e.portal, ...r } }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const onStatus = (entry, status) => {
    if (status === 'Declined') setDeclining(entry);
    else saveStatus(entry, status);
  };

  const onComment = async (entry, body) => {
    try {
      const c = await addPortalComment(entry.entryId, body);
      patchEntry(entry.entryId, (e) => ({ thread: [...e.thread, c], portal: { ...e.portal, questionOpen: true, comments: e.portal.comments + 1 } }));
    } catch (err) {
      setError(errorText(err));
      throw err;
    }
  };

  const onOpenDoc = async (s) => {
    try {
      const { url } = await getPortalDoc(reportId, s.savedId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(errorText(err));
    }
  };

  const download = async (format) => {
    setBusy(format);
    try {
      const { url, supportIncluded } = await exportPortalReport(reportId, format);
      window.open(url, '_blank', 'noopener');
      if (format === 'pdf') setMessage(`PDF ready${supportIncluded ? ` with ${supportIncluded} support file${supportIncluded === 1 ? '' : 's'} attached` : ''}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const editable = report?.status === 'Published';
  const worked = report ? report.entries.filter((e) => e.portal.status !== 'NotWorked').length : 0;

  return (
    <Box>
      <Link component={RouterLink} to="/portal" variant="body2">← All reports</Link>
      {error && <Alert severity="error" sx={{ my: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {!report && !error && <Box sx={{ mt: 2 }}><CircularProgress size={24} /></Box>}
      {report && (
        <>
          <Stack direction="row" alignItems="center" spacing={2} sx={{ mt: 1, mb: 1 }} flexWrap="wrap" useFlexGap>
            <Typography variant="h5">{report.reportNumber}</Typography>
            <Box sx={{ flex: 1 }} />
            <Button onClick={() => download('xlsx')} disabled={Boolean(busy)}>{busy === 'xlsx' ? 'Preparing…' : 'Excel'}</Button>
            <Button onClick={() => download('pdf')} disabled={Boolean(busy)} variant="contained">{busy === 'pdf' ? 'Preparing…' : 'PDF with support'}</Button>
          </Stack>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {report.qboName} · {formatMonth(report.month)} · {report.entryCount} entr{report.entryCount === 1 ? 'y' : 'ies'} · {formatCurrency(report.totalAmount)}
            {report.supersedes ? ` · Replaces ${report.supersedes}` : ''} · {worked} of {report.entryCount} worked
          </Typography>
          {report.status === 'Superseded' && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              This report was replaced by {report.supersededBy}. Work the newer report instead; this one is kept for reference.
            </Alert>
          )}
          {report.note && <Alert severity="info" sx={{ mb: 1 }}>Note from the controller: {report.note}</Alert>}
          {message && <Alert severity="success" sx={{ mb: 1 }} onClose={() => setMessage(null)}>{message}</Alert>}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            In QuickBooks, type each entry&apos;s QBO Num in the journal entry&apos;s Num field and paste its memo, so the next GL pull can confirm it.
          </Typography>
          {report.entries.map((e) => (
            <PortalEntry key={e.entryId} entry={e} editable={editable} onStatus={onStatus} onComment={onComment} onOpenDoc={onOpenDoc} />
          ))}
        </>
      )}
      <DeclineDialog
        entry={declining}
        onClose={() => setDeclining(null)}
        onConfirm={async (reason) => {
          const entry = declining;
          setDeclining(null);
          await saveStatus(entry, 'Declined', reason);
        }}
      />
    </Box>
  );
}

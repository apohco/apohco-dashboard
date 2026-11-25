// Controller Phase 4: evidence in the Review queue. Candidates are linked,
// not copied: a preview fetches the email on demand (as plain text).
import { useEffect, useRef, useState } from 'react';
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
  Divider,
  Drawer,
  LinearProgress,
  Link,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { findEvidence, getEvidenceJob, getEvidencePreview, getLineEvidence } from '../../api/controller';
import { formatCurrency } from '../../utils/format';

export const EVIDENCE_POLL_MS = 4000;
const errorText = (err) => err?.response?.data?.message || err?.message;
const pct = (n) => `${Math.round(n * 100)}%`;
const day = (d) => (d ? new Date(d).toLocaleDateString() : '');

// The evidence cell of a review line.
export function EvidenceCell({ evidence, entityName, onOpen, onFind, busy }) {
  const e = evidence || {};
  if (e.count > 0) {
    return (
      <Box>
        <Link component="button" variant="body2" onClick={onOpen}>
          {e.count} found · best {pct(e.best)}
        </Link>
        {e.entityHintId && (
          <Typography variant="caption" color="text.secondary" display="block">
            Names {entityName(e.entityHintId)}
          </Typography>
        )}
      </Box>
    );
  }
  return (
    <Box>
      {e.searchedAt && (
        <Typography variant="caption" color="text.secondary" display="block">
          None found
        </Typography>
      )}
      <Button size="small" sx={{ p: 0, minWidth: 0 }} disabled={busy} onClick={onFind}>
        Find Evidence
      </Button>
    </Box>
  );
}

// What matched, as chips.
export function signalLabels(signals, entityName, entityHintId) {
  const out = [];
  if (signals.amount) out.push('Amount matches');
  if (signals.vendor) out.push('Vendor matches');
  if (signals.days !== null && signals.days !== undefined) out.push(signals.days === 0 ? 'Same day' : `${signals.days} day${signals.days === 1 ? '' : 's'} apart`);
  if (entityHintId) out.push(`Names ${entityName(entityHintId)}${signals.entityTerm ? ` ("${signals.entityTerm}")` : ''}`);
  return out;
}

function PreviewDialog({ groupId, candidateId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setData(null);
    setError(null);
    if (!candidateId) return;
    getEvidencePreview(groupId, candidateId).then(setData).catch(setError);
  }, [groupId, candidateId]);
  return (
    <Dialog open={Boolean(candidateId)} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{data?.subject || 'Email'}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error">{errorText(error)}</Alert>}
        {!data && !error && <CircularProgress size={24} />}
        {data && (
          <Box data-testid="email-preview">
            <Typography variant="body2" color="text.secondary">
              From {data.from}
              {data.to ? ` · To ${data.to}` : ''} · {day(data.sentAt)} · Mailbox {data.mailbox}
            </Typography>
            {data.attachments.length > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Attachments: {data.attachments.map((a) => a.name).join(', ')}
              </Typography>
            )}
            <Divider sx={{ my: 1.5 }} />
            <Typography component="pre" variant="body2" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', m: 0 }}>
              {data.text || '(no text)'}
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

// Line detail: the line and its evidence candidates. onChanged() after a
// new search, so the queue can refresh the line.
export function EvidenceDrawer({ groupId, runId, line, entityName, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [previewId, setPreviewId] = useState(null);
  useEffect(() => {
    setData(null);
    setError(null);
    if (!line) return;
    getLineEvidence(groupId, runId, line.lineId).then(setData).catch(setError);
  }, [groupId, runId, line]);

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await findEvidence(groupId, runId, line.lineId));
      onChanged?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer anchor="right" open={Boolean(line)} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 520 } } }}>
      {line && (
        <Box sx={{ p: 2 }} data-testid="line-detail">
          <Typography variant="h6">{line.vendorName || line.payeeName || 'No payee'}</Typography>
          <Typography variant="body2" color="text.secondary">
            {line.txnDate} · {formatCurrency(line.amount)} · {[line.accountCode, line.accountName].filter(Boolean).join(' ')}
          </Typography>
          {line.memo && <Typography variant="body2" sx={{ mt: 0.5 }}>{line.memo}</Typography>}
          {line.reasons?.length > 0 && (
            <Box component="ul" sx={{ pl: 2, my: 1 }}>
              {line.reasons.map((r) => (
                <li key={r}>
                  <Typography variant="caption" color="text.secondary">{r}</Typography>
                </li>
              ))}
            </Box>
          )}
          <Divider sx={{ my: 1.5 }} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
              Evidence
            </Typography>
            <Button size="small" variant="outlined" onClick={find} disabled={busy} startIcon={busy ? <CircularProgress size={14} /> : null}>
              Find Evidence
            </Button>
          </Box>
          {error && <Alert severity="error" sx={{ mb: 1 }}>{errorText(error)}</Alert>}
          {data?.lastSearch && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              Last searched {new Date(data.lastSearch.at).toLocaleString()} in {data.lastSearch.sources} mailbox
              {data.lastSearch.sources === 1 ? '' : 'es'}
              {data.lastSearch.error ? ` · ${data.lastSearch.error}` : ''}
            </Typography>
          )}
          {!data && !error && <CircularProgress size={20} />}
          {data && data.candidates.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              {data.lastSearch ? 'Nothing matched in the opted-in mailboxes.' : 'Not searched yet.'}
            </Typography>
          )}
          <Stack spacing={1}>
            {data?.candidates.map((c) => (
              <Paper key={c.candidateId} variant="outlined" sx={{ p: 1.5 }}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                  <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
                    {c.title || '(no subject)'}
                  </Typography>
                  <Chip size="small" label={pct(c.score)} color={c.score >= 0.7 ? 'success' : 'default'} variant="outlined" />
                </Box>
                <Typography variant="caption" color="text.secondary" display="block">
                  {c.sender} · {day(c.sentAt)} · {c.account}
                </Typography>
                {c.snippet && <Typography variant="body2" sx={{ mt: 0.5 }}>{c.snippet}</Typography>}
                {c.attachmentNames.length > 0 && (
                  <Typography variant="caption" color="text.secondary" display="block">
                    Attachments: {c.attachmentNames.join(', ')}
                  </Typography>
                )}
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                  {signalLabels(c.signals, entityName, c.entityHintId).map((s) => (
                    <Chip key={s} size="small" label={s} />
                  ))}
                </Box>
                <Button size="small" sx={{ mt: 0.5 }} onClick={() => setPreviewId(c.candidateId)}>
                  Preview
                </Button>
              </Paper>
            ))}
          </Stack>
        </Box>
      )}
      <PreviewDialog groupId={groupId} candidateId={previewId} onClose={() => setPreviewId(null)} />
    </Drawer>
  );
}

// Progress of a "Search All" job; onDone() once when it finishes.
export function EvidenceJobProgress({ groupId, jobId, onDone }) {
  const [job, setJob] = useState(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    setJob(null);
    if (!jobId) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      try {
        const j = await getEvidenceJob(groupId, jobId);
        if (cancelled) return;
        setJob(j);
        if (j.finished) onDoneRef.current?.(j);
        else timer = setTimeout(poll, EVIDENCE_POLL_MS);
      } catch {
        if (!cancelled) timer = setTimeout(poll, EVIDENCE_POLL_MS);
      }
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [groupId, jobId]);
  if (!job || job.finished) return null;
  const done = job.batches.Succeeded + job.batches.Failed + job.batches.Stalled;
  return (
    <Box sx={{ mb: 1 }} data-testid="evidence-progress">
      <LinearProgress variant="determinate" value={job.batchCount ? (done / job.batchCount) * 100 : 0} />
      <Typography variant="caption" color="text.secondary">
        Searching for evidence: {Math.min(job.lineCount, done * 10)} of {job.lineCount} lines
      </Typography>
    </Box>
  );
}

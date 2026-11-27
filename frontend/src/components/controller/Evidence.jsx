// Controller Phase 4: evidence in the Review queue. Candidates are linked,
// not copied: an email preview fetches it on demand (as plain text); a
// folder file shows its indexed text. "Save as support" stores a confirmed
// one in the evidence bucket and files a copy in the admin's Drive.
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { confirmEvidence, findEvidence, getEvidenceJob, getEvidencePreview, getLineEvidence, getSavedEvidenceDownload } from '../../api/controller';
import { formatCurrency } from '../../utils/format';

export const EVIDENCE_POLL_MS = 4000;
const errorText = (err) => err?.response?.data?.message || err?.message;
const pct = (n) => `${Math.round(n * 100)}%`;
const day = (d) => (d ? new Date(d).toLocaleDateString() : '');
const SOURCE_LABEL = { Gmail: 'Email', Drive: 'Drive file' };

// The evidence cell of a review line.
export function EvidenceCell({ evidence, entityName, onOpen, onFind, busy }) {
  const e = evidence || {};
  if (e.count > 0 || e.saved > 0) {
    return (
      <Box>
        {e.saved > 0 && <Chip size="small" color="success" label="Supported" sx={{ mb: 0.5 }} />}
        {e.count > 0 && (
          <Link component="button" variant="body2" onClick={onOpen} display="block">
            {e.count} found · best {pct(e.best)}
          </Link>
        )}
        {e.saved > 0 && !e.count && (
          <Link component="button" variant="body2" onClick={onOpen} display="block">
            View support
          </Link>
        )}
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
      <DialogTitle>{data?.subject || 'Preview'}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error">{errorText(error)}</Alert>}
        {!data && !error && <CircularProgress size={24} />}
        {data && (
          <Box data-testid="evidence-preview">
            {data.source === 'Drive' ? (
              <Typography variant="body2" color="text.secondary">
                {data.folder} · {data.from} · modified {day(data.sentAt)}
                {data.link && (
                  <>
                    {' · '}
                    <Link href={data.link} target="_blank" rel="noopener noreferrer">
                      Open in Drive
                    </Link>
                  </>
                )}
                {data.readBy === 'ocr' && ' · text read from a scan'}
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary">
                From {data.from}
                {data.to ? ` · To ${data.to}` : ''} · {day(data.sentAt)} · Mailbox {data.mailbox}
              </Typography>
            )}
            {data.attachments?.length > 0 && (
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

// Line detail: the line, its evidence candidates and its saved support.
// onChanged() after a new search or save, so the queue can refresh.
export function EvidenceDrawer({ groupId, runId, line, entityName, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const reload = useCallback(async () => {
    if (!line) return;
    try {
      setData(await getLineEvidence(groupId, runId, line.lineId));
    } catch (err) {
      setError(err);
    }
  }, [groupId, runId, line]);
  useEffect(() => {
    setData(null);
    setError(null);
    reload();
  }, [reload]);

  // While a save is in progress, check again until it finishes.
  const saving = (data?.saved || []).some((s) => s.status === 'Saving');
  useEffect(() => {
    if (!saving) return undefined;
    const t = setTimeout(async () => {
      await reload();
      onChangedRef.current?.();
    }, EVIDENCE_POLL_MS);
    return () => clearTimeout(t);
  }, [saving, data, reload]);

  const act = async (name, fn) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  const find = () =>
    act('find', async () => {
      setData(await findEvidence(groupId, runId, line.lineId));
      onChanged?.();
    });
  const confirm = (c) =>
    act(`confirm-${c.candidateId}`, async () => {
      await confirmEvidence(groupId, runId, line.lineId, c.candidateId);
      await reload();
    });
  const download = (s) =>
    act(`download-${s.savedId}`, async () => {
      const { url } = await getSavedEvidenceDownload(groupId, s.savedId);
      window.open(url, '_blank', 'noopener');
    });

  return (
    <Drawer anchor="right" open={Boolean(line)} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 560 } } }}>
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
          {error && <Alert severity="error" sx={{ my: 1 }} onClose={() => setError(null)}>{errorText(error)}</Alert>}

          {data?.saved?.length > 0 && (
            <>
              <Divider sx={{ my: 1.5 }} />
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                Saved support
              </Typography>
              <Stack spacing={1} data-testid="saved-support">
                {data.saved.map((s) => (
                  <Paper key={s.savedId} variant="outlined" sx={{ p: 1.5 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
                        {s.fileName || s.title}
                      </Typography>
                      {s.status === 'Saving' && <Chip size="small" icon={<CircularProgress size={12} />} label="Saving…" />}
                      {s.status === 'Saved' && <Chip size="small" color="success" label="Saved" />}
                      {s.status === 'Failed' && <Chip size="small" color="error" label="Failed" />}
                    </Box>
                    {s.drivePath && (
                      <Typography variant="caption" color="text.secondary" display="block">
                        Filed in Drive: {s.drivePath}
                      </Typography>
                    )}
                    {s.error && (
                      <Typography variant="caption" color={s.status === 'Failed' ? 'error' : 'warning.main'} display="block">
                        {s.error}
                      </Typography>
                    )}
                    {s.status === 'Saved' && (
                      <Button size="small" sx={{ mt: 0.5 }} disabled={Boolean(busy)} onClick={() => download(s)}>
                        Download
                      </Button>
                    )}
                  </Paper>
                ))}
              </Stack>
            </>
          )}

          <Divider sx={{ my: 1.5 }} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
              Evidence
            </Typography>
            <Button size="small" variant="outlined" onClick={find} disabled={Boolean(busy)} startIcon={busy === 'find' ? <CircularProgress size={14} /> : null}>
              Find Evidence
            </Button>
          </Box>
          {data?.lastSearch && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              Last searched {new Date(data.lastSearch.at).toLocaleString()} in {data.lastSearch.sources} source
              {data.lastSearch.sources === 1 ? '' : 's'}
              {data.lastSearch.error ? ` · ${data.lastSearch.error}` : ''}
            </Typography>
          )}
          {!data && !error && <CircularProgress size={20} />}
          {data && data.candidates.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              {data.lastSearch ? 'Nothing matched in the opted-in mailboxes and invoice folders.' : 'Not searched yet.'}
            </Typography>
          )}
          <Stack spacing={1}>
            {data?.candidates.map((c) => (
              <Paper key={c.candidateId} variant="outlined" sx={{ p: 1.5 }}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                  <Chip size="small" label={SOURCE_LABEL[c.source] || c.source} variant="outlined" />
                  <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
                    {c.title || '(no subject)'}
                  </Typography>
                  <Chip size="small" label={pct(c.score)} color={c.score >= 0.7 ? 'success' : 'default'} variant="outlined" />
                </Box>
                <Typography variant="caption" color="text.secondary" display="block">
                  {c.source === 'Drive' ? `${c.path || ''} · ${c.sender || ''} · ${day(c.sentAt)}` : `${c.sender} · ${day(c.sentAt)} · ${c.account}`}
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
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 0.5 }}>
                  <Button size="small" onClick={() => setPreviewId(c.candidateId)}>
                    Preview
                  </Button>
                  {c.source === 'Drive' && c.link && (
                    <Link href={c.link} target="_blank" rel="noopener noreferrer" variant="body2">
                      Open in Drive
                    </Link>
                  )}
                  <Box sx={{ flex: 1 }} />
                  {c.saved?.status === 'Saved' ? (
                    <Chip size="small" color="success" label="Saved as support" />
                  ) : (
                    <Button
                      size="small"
                      variant="contained"
                      disabled={Boolean(busy) || c.saved?.status === 'Saving'}
                      onClick={() => confirm(c)}
                      startIcon={busy === `confirm-${c.candidateId}` ? <CircularProgress size={14} color="inherit" /> : null}
                    >
                      {c.saved?.status === 'Saving' ? 'Saving…' : 'Save as support'}
                    </Button>
                  )}
                </Box>
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

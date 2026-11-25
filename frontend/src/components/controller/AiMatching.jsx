// Controller Phase 3: AI matching in the UI. The AI only suggests; every
// line is still decided by the user (Accept AI records the suggestion as a
// decision, like Approve does for the rules + history engine).
import { useEffect, useRef, useState } from 'react';
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
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { getAiJob, getAiStatus, getAiUsage, startAiJob } from '../../api/controller';
import { formatCurrency } from '../../utils/format';

export const AI_POLL_MS = 5000;
const errorText = (err) => err?.response?.data?.message || err?.message;
const pct = (n) => `${Math.round(n * 100)}%`;
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const formatAccount = (a) => (a ? [a.code, a.name].filter(Boolean).join(' ') : '');

// An AI answer in words.
export function describeAi(ai, entityName) {
  if (!ai) return null;
  switch (ai.action) {
    case 'Assign':
      return entityName(ai.entityId);
    case 'Keep':
      return 'Keep as is';
    case 'Reclassify':
      return `Reclassify to ${formatAccount(ai.account)}`;
    case 'DueToFrom':
      return `Due To/From ${entityName(ai.entityId)}`;
    default:
      return 'Unsure';
  }
}

// An outcome key from the job results ('entity:<id>', 'keep', 'acct:<key>',
// 'due:<id>', 'split') in words.
export function describeOutcome(key, entityName) {
  if (!key) return '—';
  if (key === 'keep') return 'Keep as is';
  if (key === 'split') return 'Split';
  if (key.startsWith('entity:')) return entityName(key.slice(7));
  if (key.startsWith('due:')) return `Due To/From ${entityName(key.slice(4))}`;
  if (key.startsWith('acct:')) return key.slice(5).replace(/^(code|name):/, '');
  return key;
}

// The AI cell of a review line.
export function AiSuggestion({ ai, entityName, canAccept, onAccept, busy }) {
  if (!ai) return <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>;
  const unsure = ai.action === 'Unsure';
  return (
    <Box>
      <Tooltip title={ai.reason}>
        <Box component="span" sx={{ color: unsure ? 'text.secondary' : 'text.primary' }}>
          {describeAi(ai, entityName)}
        </Box>
      </Tooltip>
      <Typography variant="caption" color="text.secondary" display="block">
        {unsure ? 'AI unsure' : `AI ${pct(ai.confidence)}`}
        {ai.usedRule && ' · by rule'}
        {ai.redacted && ' · payee/memo withheld'}
      </Typography>
      {!unsure && canAccept && (
        <Button size="small" sx={{ p: 0, minWidth: 0 }} disabled={busy} onClick={onAccept}>
          Accept AI
        </Button>
      )}
    </Box>
  );
}

// Polls an AI job (rule test / backtest) until it has finished.
export function useAiJob(groupId, jobId) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setJob(null);
    if (!groupId || !jobId) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      try {
        const latest = await getAiJob(groupId, jobId);
        if (cancelled) return;
        setJob(latest);
        setError(null);
        if (!latest.finished) timer = setTimeout(poll, AI_POLL_MS);
      } catch (err) {
        if (cancelled) return;
        setError(err);
        timer = setTimeout(poll, AI_POLL_MS);
      }
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [groupId, jobId]);
  return { job, error };
}

function JobProgress({ job }) {
  if (!job || job.finished) return null;
  const done = job.batches.Succeeded + job.batches.Failed + job.batches.Skipped + job.batches.Stalled;
  return (
    <Box sx={{ my: 1 }}>
      <LinearProgress variant="determinate" value={job.batchCount ? (done / job.batchCount) * 100 : 0} />
      <Typography variant="caption" color="text.secondary">
        Asking the AI: {done} of {job.batchCount} batch{job.batchCount === 1 ? '' : 'es'}
      </Typography>
    </Box>
  );
}

// The run's AI pass: progress, answers so far, this month's spend; start it
// again for lines without an answer; check accuracy on decided lines.
// onAnswers() is called whenever more answers have arrived.
export function AiPassStatus({ groupId, runId, qboId, month, entityName, onAnswers, refreshKey }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [accuracyOpen, setAccuracyOpen] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const answered = useRef(null);
  const onAnswersRef = useRef(onAnswers);
  onAnswersRef.current = onAnswers;

  useEffect(() => {
    if (!groupId || !runId) {
      setStatus(null);
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      try {
        const s = await getAiStatus(groupId, runId);
        if (cancelled) return;
        setStatus(s);
        setError(null);
        if (answered.current !== null && s.answered !== answered.current) onAnswersRef.current?.();
        answered.current = s.answered;
        if (s.job && !s.job.finished) timer = setTimeout(poll, AI_POLL_MS);
      } catch (err) {
        if (!cancelled) setError(err);
      }
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [groupId, runId, refreshKey, pollKey]);
  // A different run starts from scratch.
  useEffect(() => {
    setStatus(null);
    answered.current = null;
  }, [runId]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await startAiJob(groupId, { kind: 'Review', runId });
      setPollKey((k) => k + 1); // poll the new job
    } catch (err) {
      setError(err);
    } finally {
      setStarting(false);
    }
  };

  if (!status && !error) return null;
  const job = status?.job;
  const running = job && !job.finished;
  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }} data-testid="ai-pass">
      {error && <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>{errorText(error)}</Alert>}
      {status && (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            AI matching
          </Typography>
          {!status.enabled && <Chip size="small" label="Off in Settings" />}
          <Typography variant="body2" color="text.secondary">
            {status.answered
              ? `${status.suggested.toLocaleString()} suggestion${status.suggested === 1 ? '' : 's'}, ${(status.answered - status.suggested).toLocaleString()} unsure`
              : running
                ? 'Working on the lines rules and history could not settle…'
                : 'No AI answers for this run yet.'}
            {' · '}This month {money(status.monthSpend)} of {money(status.monthlyBudget)}
          </Typography>
          {running && <CircularProgress size={14} />}
          <Box sx={{ flex: 1 }} />
          {!running && status.enabled && (
            <Button size="small" disabled={starting} onClick={start}>
              {status.answered ? 'Ask AI about remaining lines' : 'Run AI pass'}
            </Button>
          )}
          {qboId && (
            <Button size="small" onClick={() => setAccuracyOpen(true)}>
              Check AI accuracy
            </Button>
          )}
        </Box>
      )}
      <JobProgress job={job} />
      {job?.errors?.length > 0 && job.finished && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          Some batches did not finish: {job.errors.join('; ')}
        </Alert>
      )}
      {status && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          AI confidence is capped at {pct(status.confidenceCap)}, so every AI suggestion waits for your decision.
        </Typography>
      )}
      <AccuracyDialog open={accuracyOpen} groupId={groupId} qboId={qboId} month={month} entityName={entityName} onClose={() => setAccuracyOpen(false)} />
    </Paper>
  );
}

// Backtest: re-ask the AI about up to 50 lines already decided (without
// showing it the decisions) and compare.
export function AccuracyDialog({ open, groupId, qboId, month, entityName, onClose }) {
  const [jobId, setJobId] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const { job, error: pollError } = useAiJob(groupId, jobId);
  useEffect(() => {
    if (!open) {
      setJobId(null);
      setError(null);
    }
  }, [open]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const r = await startAiJob(groupId, { kind: 'Backtest', qboId, month });
      setJobId(r.jobId);
    } catch (err) {
      setError(err);
    } finally {
      setStarting(false);
    }
  };
  const s = job?.summary;
  const name = (id) => job?.entities?.find((e) => e.entityId === id)?.entityName || entityName?.(id) || '—';
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Check AI accuracy</DialogTitle>
      <DialogContent>
        {(error || pollError) && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error || pollError)}</Alert>}
        {!jobId && (
          <Typography variant="body2">
            The AI is asked again about up to 50 lines of this file you have already decided (in the latest month with decisions, or the month
            shown), without seeing your decisions, and its answers are compared with yours. Nothing is changed. It costs a few cents.
          </Typography>
        )}
        <JobProgress job={job} />
        {s && job.finished && (
          <Box data-testid="accuracy">
            <Typography variant="body1" sx={{ mb: 1 }}>
              {s.agree + s.disagree
                ? `The AI agreed with you on ${s.agree} of ${s.agree + s.disagree} lines (${pct(s.agree / (s.agree + s.disagree))})`
                : 'The AI was unsure about every line'}
              {s.unsure ? `, and was unsure about ${s.unsure}.` : '.'} Cost {money(job.costUsd)}.
            </Typography>
            {s.byConfidence && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                By the AI's own confidence:{' '}
                {s.byConfidence
                  .filter((b) => b.lines)
                  .map((b) => `${b.level} ${b.agree} of ${b.lines}`)
                  .join(' · ')}
              </Typography>
            )}
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Vendor</TableCell>
                  <TableCell>Memo</TableCell>
                  <TableCell align="right">Amount</TableCell>
                  <TableCell>Your decision</TableCell>
                  <TableCell>AI</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {job.results.map((r) => (
                  <TableRow key={r.lineId} sx={r.aiOutcome && !r.matches ? { bgcolor: 'action.hover' } : undefined}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.txnDate}</TableCell>
                    <TableCell>{r.payeeName || '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 220 }}>{r.memo}</TableCell>
                    <TableCell align="right">{formatCurrency(r.amount)}</TableCell>
                    <TableCell>{describeOutcome(r.current, name)}</TableCell>
                    <TableCell>
                      <Tooltip title={r.ai.reason}>
                        <span>{r.aiOutcome ? `${describeOutcome(r.aiOutcome, name)} (${pct(r.ai.confidence)})` : 'Unsure'}</span>
                      </Tooltip>
                      {r.aiOutcome && (
                        <Typography variant="caption" display="block" color={r.matches ? 'text.secondary' : 'warning.main'}>
                          {r.matches ? 'Agrees' : 'Differs'}
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {!jobId && (
          <Button variant="contained" onClick={start} disabled={starting || !qboId}>
            Start check
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

// "Test with AI": the draft written rule, tried on the vendor's recent lines.
export function AiRuleTest({ groupId, vendorId, ruleText, entities }) {
  const [months, setMonths] = useState(3);
  const [jobId, setJobId] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const { job, error: pollError } = useAiJob(groupId, jobId);
  const name = (id) => entities.find((e) => e.entityId === id)?.entityName || 'Former entity';

  const start = async () => {
    setStarting(true);
    setError(null);
    setJobId(null);
    try {
      const r = await startAiJob(groupId, { kind: 'RuleTest', vendorId, ruleText, months });
      setJobId(r.jobId);
    } catch (err) {
      setError(err);
    } finally {
      setStarting(false);
    }
  };
  const s = job?.summary;
  const changes = job?.results?.filter((r) => r.aiOutcome && !r.matches) || [];
  return (
    <Box sx={{ mt: 1, p: 1.5, bgcolor: 'background.default', borderRadius: 1 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <Typography variant="body2" sx={{ flex: 1 }}>
          Test the written rule with the AI on this vendor's recent lines (up to 40). Nothing is saved.
        </Typography>
        <Select size="small" value={months} onChange={(e) => setMonths(e.target.value)} inputProps={{ 'aria-label': 'Months to test with AI' }}>
          {[1, 3, 6, 12].map((m) => (
            <MenuItem key={m} value={m}>
              Last {m} month{m === 1 ? '' : 's'}
            </MenuItem>
          ))}
        </Select>
        <Button size="small" variant="outlined" disabled={starting || !ruleText.trim() || (job && !job.finished)} onClick={start}>
          Test with AI
        </Button>
      </Box>
      {(error || pollError) && <Alert severity="error" sx={{ mt: 1 }}>{errorText(error || pollError)}</Alert>}
      <JobProgress job={job} />
      {s && job.finished && (
        <Box sx={{ mt: 1 }} data-testid="ai-rule-test">
          <Typography variant="body2">
            {s.lines
              ? `${s.lines} lines: with this rule the AI would label ${s.disagree} differently from now, ${s.agree} the same, and is unsure about ${s.unsure}. Cost ${money(job.costUsd)}.`
              : 'No answers came back.'}
          </Typography>
          {changes.length > 0 && (
            <Table size="small" sx={{ mt: 1 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Memo</TableCell>
                  <TableCell align="right">Amount</TableCell>
                  <TableCell>Now</TableCell>
                  <TableCell>With the rule</TableCell>
                  <TableCell>Why</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {changes.slice(0, 15).map((r) => (
                  <TableRow key={r.lineId}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.txnDate}</TableCell>
                    <TableCell>{r.memo}</TableCell>
                    <TableCell align="right">{formatCurrency(r.amount)}</TableCell>
                    <TableCell>{describeOutcome(r.current, name)}</TableCell>
                    <TableCell>{describeOutcome(r.aiOutcome, name)} ({pct(r.ai.confidence)})</TableCell>
                    <TableCell>{r.ai.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Box>
      )}
    </Box>
  );
}

// AI section of Review settings. form holds aiEnabled, aiConfidenceCap (%),
// aiMonthlyBudget ($), aiRedactPatientInfo.
export function AiSettingsFields({ groupId, form, setForm, open }) {
  const [usage, setUsage] = useState(null);
  useEffect(() => {
    if (!open || !groupId) return;
    getAiUsage(groupId).then(setUsage).catch(() => setUsage(null));
  }, [open, groupId]);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        AI matching
      </Typography>
      <FormControlLabel
        control={<Switch checked={Boolean(form.aiEnabled)} onChange={(e) => set('aiEnabled', e.target.checked)} />}
        label="Ask the AI about lines rules and history can't settle"
        sx={{ mb: 1 }}
      />
      <TextField
        fullWidth
        size="small"
        type="number"
        label="AI confidence cap (%)"
        helperText="AI suggestions never show above this. Below your high-confidence threshold, each one waits for your decision."
        value={form.aiConfidenceCap ?? ''}
        onChange={(e) => set('aiConfidenceCap', e.target.value)}
        sx={{ mb: 2 }}
      />
      <TextField
        fullWidth
        size="small"
        type="number"
        label="Monthly AI budget ($)"
        helperText={usage ? `Spent this month: ${money(usage.monthSpend)} (estimated). The AI stops when the budget is reached.` : 'The AI stops when the budget is reached.'}
        value={form.aiMonthlyBudget ?? ''}
        onChange={(e) => set('aiMonthlyBudget', e.target.value)}
        sx={{ mb: 1 }}
      />
      <FormControlLabel
        control={<Checkbox checked={Boolean(form.aiRedactPatientInfo)} onChange={(e) => set('aiRedactPatientInfo', e.target.checked)} />}
        label="Withhold payee and memo on refund and patient lines"
      />
      {usage?.agreement?.decided > 0 && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          Over the last 6 months you agreed with {usage.agreement.agreed} of {usage.agreement.decided} AI suggestions you decided (
          {pct(usage.agreement.agreeRate)}).
        </Typography>
      )}
    </Box>
  );
}

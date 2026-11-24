import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
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
  FormControlLabel,
  LinearProgress,
  Link,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import { getControllerOverview, listConflicts, listReviewRuns, previewRelabel, resolveConflict } from '../../api/controller';
import { addMonths, currentMonth, formatMonth, isMonth } from '../../utils/months';
import { formatCurrency } from '../../utils/format';

const errorText = (err) => err?.response?.data?.message || err?.message;
const pct = (share) => `${Math.round(share * 100)}%`;

export function describeResolution(decision, entityName) {
  if (!decision) return null;
  const label = { LineOnly: 'This transaction only', RuleWins: 'Rule wins', RuleWinsRelabel: 'Rule wins, history relabeled' }[decision.resolution];
  return `${label || 'Decided'}: ${entityName(decision.entityId)}`;
}

function RuleBox({ rule, entityName }) {
  if (!rule) return <Typography color="text.secondary">No rule</Typography>;
  return (
    <Box>
      <Typography variant="body2" fontWeight={600}>
        Rule v{rule.version} says {entityName(rule.entityId)}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block">
        {rule.matchedKeyword ? `Keyword "${rule.matchedKeyword}" in the memo` : 'Default entity for this vendor'}
      </Typography>
      {rule.text && (
        <Typography variant="body2" sx={{ mt: 1, fontStyle: 'italic' }}>
          “{rule.text}”
        </Typography>
      )}
    </Box>
  );
}

function HistoryBox({ history, entityName }) {
  if (!history) return <Typography color="text.secondary">No history</Typography>;
  return (
    <Box>
      <Typography variant="body2" fontWeight={600}>
        History says {entityName(history.shares[0].entityId)}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        {history.total} weighted past lines for this vendor{history.scope === 'account' ? ' and account' : ''} (your decisions count 3×)
      </Typography>
      {history.shares.slice(0, 4).map((s) => (
        <Box key={s.entityId || 'none'} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <Typography variant="caption" sx={{ width: 110 }} noWrap>
            {entityName(s.entityId)}
          </Typography>
          <LinearProgress variant="determinate" value={s.share * 100} sx={{ flex: 1, height: 6, borderRadius: 3 }} aria-label={`${entityName(s.entityId)} ${pct(s.share)}`} />
          <Typography variant="caption" sx={{ width: 36, textAlign: 'right' }}>
            {pct(s.share)}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

function LineOnlyDialog({ conflict, entities, onClose, onSave }) {
  const [entityId, setEntityId] = useState('');
  useEffect(() => {
    if (conflict) setEntityId(conflict.rule?.entityId || '');
  }, [conflict]);
  return (
    <Dialog open={Boolean(conflict)} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>This transaction only</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>Decide this line. The rule and history stay as they are.</DialogContentText>
        <Select fullWidth size="small" value={entityId} onChange={(e) => setEntityId(e.target.value)} inputProps={{ 'aria-label': 'Entity for this line' }}>
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

function RuleWinsDialog({ state, entityName, onClose, onConfirm }) {
  const [requestAje, setRequestAje] = useState(false);
  useEffect(() => setRequestAje(false), [state]);
  if (!state) return null;
  const { conflict, relabel, preview, loading, error } = state;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{relabel ? 'Rule wins and relabel history' : 'Rule wins from now on'}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          {conflict.vendorName}&apos;s rule (v{conflict.rule.version}, {entityName(conflict.rule.entityId)}) will take priority over history from now on.
          This month&apos;s open conflicts for {conflict.vendorName} follow the rule.
        </DialogContentText>
        {relabel && loading && <CircularProgress size={24} />}
        {relabel && error && <Alert severity="error">{errorText(error)}</Alert>}
        {relabel && preview && (
          <>
            <Alert severity={preview.count ? 'info' : 'success'} sx={{ mb: 2 }}>
              {preview.count
                ? `Relabel ${preview.count.toLocaleString()} earlier line${preview.count === 1 ? '' : 's'} across ${preview.months.length} month${preview.months.length === 1 ? '' : 's'}, ${formatCurrency(preview.amount)}.`
                : 'No earlier lines disagree with the rule; nothing to relabel.'}
              {preview.previouslyDecided > 0 && ` ${preview.previouslyDecided} of them had an earlier decision, which the relabel replaces.`}
              {preview.skippedSplits > 0 && ` ${preview.skippedSplits} split line${preview.skippedSplits === 1 ? ' is' : 's are'} left as split.`}
            </Alert>
            {preview.sample.length > 0 && (
              <Table size="small" sx={{ mb: 2 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell>
                    <TableCell>Memo</TableCell>
                    <TableCell>Account</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>From</TableCell>
                    <TableCell>To</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {preview.sample.map((s) => (
                    <TableRow key={s.lineId}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{s.txnDate}</TableCell>
                      <TableCell>{s.memo}</TableCell>
                      <TableCell>{s.account}</TableCell>
                      <TableCell align="right">{formatCurrency(s.amount)}</TableCell>
                      <TableCell>{entityName(s.fromEntityId)}</TableCell>
                      <TableCell>{entityName(s.toEntityId)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {preview.count > preview.sample.length && (
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                Showing the first {preview.sample.length} of {preview.count}.
              </Typography>
            )}
            {preview.count > 0 && (
              <FormControlLabel
                control={<Checkbox checked={requestAje} onChange={(e) => setRequestAje(e.target.checked)} />}
                label="Request adjusting journal entries for the relabeled lines"
              />
            )}
            <Typography variant="caption" color="text.secondary" display="block">
              Relabeling updates trends and future suggestions. Adjusting journal entries for earlier months are only recommended if you tick the box.
            </Typography>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={relabel && !preview} onClick={() => onConfirm({ requestAje, expectedRelabelCount: preview?.count })}>
          Confirm
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function Conflicts() {
  const [params] = useSearchParams();
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [files, setFiles] = useState([]);
  const [qboId, setQboId] = useState('');
  const [month, setMonth] = useState(isMonth(params.get('month')) ? params.get('month') : addMonths(currentMonth(), -1));
  const [run, setRun] = useState(undefined); // undefined: loading, null: none
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lineOnly, setLineOnly] = useState(null);
  const [ruleWins, setRuleWins] = useState(null); // { conflict, relabel, preview?, loading?, error? }

  useEffect(() => {
    setFiles([]);
    setQboId('');
    if (!groupId) return;
    getControllerOverview(groupId)
      .then((ov) => {
        const classFiles = ov.qbos.filter((q) => q.isClassBased);
        setFiles(classFiles);
        const wanted = classFiles.find((q) => q.qboId === params.get('qboId'));
        if (wanted) setQboId(wanted.qboId);
        else if (classFiles.length === 1) setQboId(classFiles[0].qboId);
      })
      .catch(setError);
    // Read the ?qboId= drill-down link only when the Group loads.
  }, [groupId]); // eslint-disable-line

  const load = useCallback(async () => {
    setData(null);
    if (!groupId || !qboId || !isMonth(month)) return;
    setRun(undefined);
    try {
      const runs = await listReviewRuns(groupId, qboId, month);
      const latest = runs.runs[0] || null;
      setRun(latest);
      if (latest) setData(await listConflicts(groupId, latest.runId));
    } catch (err) {
      setError(err);
    }
  }, [groupId, qboId, month]);
  useEffect(() => {
    load();
  }, [load]);

  const entities = useMemo(() => data?.entities || [], [data]);
  const entityName = useCallback((id) => (id ? entities.find((e) => e.entityId === id)?.entityName || 'Former entity' : 'Unassigned'), [entities]);
  const open = (data?.conflicts || []).filter((c) => !c.decision);
  const decided = (data?.conflicts || []).filter((c) => c.decision);

  const resolve = async (conflict, body, label) => {
    setBusy(true);
    setError(null);
    try {
      const r = await resolveConflict(groupId, run.runId, conflict.lineId, body);
      const parts = [`${r.decided} line${r.decided === 1 ? '' : 's'} decided`];
      if (r.relabeled) parts.push(`${r.relabeled} earlier line${r.relabeled === 1 ? '' : 's'} relabeled`);
      if (body.resolution !== 'LineOnly') parts.push(`rule v${r.ruleVersion} now takes priority`);
      setNotice(`${label}: ${parts.join(', ')}.`);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const openRuleWins = async (conflict, relabel) => {
    setRuleWins({ conflict, relabel, loading: relabel });
    if (!relabel) return;
    try {
      const preview = await previewRelabel(groupId, run.runId, conflict.lineId);
      setRuleWins((s) => s && { ...s, preview, loading: false });
    } catch (err) {
      setRuleWins((s) => s && { ...s, error: err, loading: false });
    }
  };

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Conflicts
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{errorText(error)}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}

      <Paper variant="outlined" sx={{ p: 2, mb: 2, display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select size="small" displayEmpty value={qboId} onChange={(e) => setQboId(e.target.value)} sx={{ minWidth: 220 }} inputProps={{ 'aria-label': 'QBO file' }}>
          <MenuItem value="" disabled>
            Select a class-based file
          </MenuItem>
          {files.map((q) => (
            <MenuItem key={q.qboId} value={q.qboId}>
              {q.qboName}
            </MenuItem>
          ))}
        </Select>
        <TextField size="small" type="month" label="Month" InputLabelProps={{ shrink: true }} value={month} onChange={(e) => setMonth(e.target.value)} />
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 240 }}>
          A conflict is a line where your vendor rule and strong history disagree. Practice-file lines are resolved in Review.
        </Typography>
      </Paper>

      {qboId && run === null && (
        <Alert severity="info">
          No review has been run for {formatMonth(month)} yet.{' '}
          <Link component={RouterLink} to="/controller/review">
            Run it in Review
          </Link>
          .
        </Alert>
      )}
      {data && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {open.length} open · {decided.length} resolved
          </Typography>
          {open.length === 0 && <Alert severity="success" sx={{ mb: 2 }}>No open conflicts for {formatMonth(month)}.</Alert>}
          {open.map((c) => (
            <Paper key={c.lineId} variant="outlined" sx={{ p: 2, mb: 2 }} data-testid="conflict">
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'baseline', mb: 2 }}>
                <Typography fontWeight={600}>{c.vendorName}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {c.txnDate} · {[c.accountCode, c.accountName].filter(Boolean).join(' ')} · class {c.className || 'none'}
                </Typography>
                <Typography variant="body2">{c.memo}</Typography>
                <Box sx={{ flex: 1 }} />
                <Typography fontWeight={600}>{formatCurrency(c.amount)}</Typography>
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 3, mb: 2 }}>
                <RuleBox rule={c.rule} entityName={entityName} />
                <HistoryBox history={c.history} entityName={entityName} />
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Button size="small" variant="outlined" disabled={busy} onClick={() => setLineOnly(c)}>
                  This transaction only…
                </Button>
                <Button size="small" variant="outlined" disabled={busy || !c.rule?.entityId} onClick={() => openRuleWins(c, false)}>
                  Rule wins from now on
                </Button>
                <Button size="small" variant="contained" disabled={busy || !c.rule?.entityId} onClick={() => openRuleWins(c, true)}>
                  Rule wins and relabel history…
                </Button>
              </Box>
            </Paper>
          ))}
          {decided.length > 0 && (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                Resolved
              </Typography>
              {decided.map((c) => (
                <Box key={c.lineId} sx={{ display: 'flex', gap: 2, alignItems: 'center', py: 0.5 }}>
                  <Typography variant="body2" sx={{ width: 100 }}>
                    {c.txnDate}
                  </Typography>
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {c.vendorName} · {c.memo}
                  </Typography>
                  <Typography variant="body2">{formatCurrency(c.amount)}</Typography>
                  <Chip size="small" color="success" variant="outlined" label={describeResolution(c.decision, entityName)} />
                </Box>
              ))}
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                Undo any of these from Review. Run the review again to see the rule apply to the rest of the month.
              </Typography>
            </Paper>
          )}
        </>
      )}

      <LineOnlyDialog
        conflict={lineOnly}
        entities={entities}
        onClose={() => setLineOnly(null)}
        onSave={(entityId) => {
          const c = lineOnly;
          setLineOnly(null);
          resolve(c, { resolution: 'LineOnly', entityId }, 'This transaction only');
        }}
      />
      <RuleWinsDialog
        state={ruleWins}
        entityName={entityName}
        onClose={() => setRuleWins(null)}
        onConfirm={({ requestAje, expectedRelabelCount }) => {
          const { conflict, relabel } = ruleWins;
          setRuleWins(null);
          resolve(
            conflict,
            relabel ? { resolution: 'RuleWinsRelabel', requestAje, expectedRelabelCount } : { resolution: 'RuleWins' },
            relabel ? 'Rule wins and history relabeled' : 'Rule wins from now on'
          );
        }}
      />
    </Box>
  );
}

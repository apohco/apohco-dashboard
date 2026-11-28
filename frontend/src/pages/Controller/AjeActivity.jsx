import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import { getAjeRollup, replyToAjeEntry } from '../../api/controller';
import { EntryThread, formatWhen } from '../../components/aje/AjeParts';
import { formatMonth } from '../../utils/months';

const errorText = (err) => err?.response?.data?.message || err?.message;

function Tile({ label, value, color }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, minWidth: 150 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="h5" color={value && color ? `${color}.main` : 'text.primary'}>{value}</Typography>
    </Paper>
  );
}

export function activityText(a) {
  if (a.kind === 'status') return `${a.who} marked ${a.entryNumber} ${a.statusLabel}${a.reason ? `: ${a.reason}` : ''}`;
  return `${a.who}${a.authorRole === 'Controller' ? ' (you)' : ''} on ${a.entryNumber}: ${a.body}`;
}

// Controller > Accountant activity: what the accountants have booked,
// declined or asked, across every report still in force.
export default function AjeActivity() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!groupId) return;
    try {
      setData(await getAjeRollup(groupId));
    } catch (err) {
      setError(errorText(err));
    }
  }, [groupId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const reply = async (q, body) => {
    try {
      await replyToAjeEntry(groupId, q.entryId, body);
      await load();
    } catch (err) {
      setError(errorText(err));
      throw err;
    }
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 1 }}>Accountant activity</Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {groupId && !data && !error && <CircularProgress size={24} />}
      {data && (
        <>
          {!data.accountants.length && (
            <Alert severity="info" sx={{ mb: 2 }}>
              No accountant has access yet. <Link component={RouterLink} to="/controller/accountants">Add one in Accountants</Link>.
            </Alert>
          )}
          <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
            <Tile label="Open questions" value={data.totals.openQuestions} color="warning" />
            <Tile label="Not worked" value={data.totals.notWorked} />
            <Tile label="Booked" value={data.totals.booked} color="success" />
            <Tile label="Booked, not yet seen in GL" value={data.totals.bookedUnconfirmed} color="warning" />
            <Tile label="Declined" value={data.totals.declined} color="error" />
          </Stack>

          <Typography variant="h6" sx={{ mb: 1 }}>Questions waiting for you</Typography>
          {!data.openQuestions.length ? (
            <Typography color="text.secondary" sx={{ mb: 2 }}>None.</Typography>
          ) : (
            data.openQuestions.map((q) => (
              <Paper key={q.entryId} variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
                <Typography variant="body2" fontWeight={600}>{q.entryNumber} · {q.qboName}</Typography>
                <EntryThread
                  thread={[{ commentId: `${q.entryId}-last`, authorName: q.authorName, authorRole: 'Accountant', body: q.body, createdAt: q.askedAt }]}
                  entryNumber={q.entryNumber}
                  sendLabel="Reply"
                  placeholder="Answer the accountant"
                  onSend={(body) => reply(q, body)}
                />
              </Paper>
            ))
          )}

          <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>Reports in force</Typography>
          {!data.reports.length ? (
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              No published reports. Publish one from <Link component={RouterLink} to="/controller/aje">AJE reports</Link>.
            </Typography>
          ) : (
            <Paper variant="outlined" sx={{ mb: 2 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Report</TableCell>
                    <TableCell>File</TableCell>
                    <TableCell>Month</TableCell>
                    <TableCell align="right">Entries</TableCell>
                    <TableCell align="right">Not worked</TableCell>
                    <TableCell align="right">Booked</TableCell>
                    <TableCell align="right">Booked, not in GL</TableCell>
                    <TableCell align="right">Declined</TableCell>
                    <TableCell align="right">Questions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.reports.map((r) => (
                    <TableRow key={r.reportId}>
                      <TableCell>
                        {r.reportNumber}
                        {r.status === 'Superseded' && <Chip size="small" label="Superseded" sx={{ ml: 1 }} />}
                      </TableCell>
                      <TableCell>{r.qboName}</TableCell>
                      <TableCell>{formatMonth(r.month)}</TableCell>
                      <TableCell align="right">{r.entryCount}</TableCell>
                      <TableCell align="right">{r.counts.notWorked}</TableCell>
                      <TableCell align="right">{r.counts.booked}</TableCell>
                      <TableCell align="right">{r.counts.bookedUnconfirmed || '—'}</TableCell>
                      <TableCell align="right">{r.counts.declined || '—'}</TableCell>
                      <TableCell align="right">{r.counts.openQuestions ? <Chip size="small" color="warning" label={r.counts.openQuestions} /> : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            &quot;Booked, not in GL&quot; means the accountant marked it booked but no stored GL shows its number yet; the next GL pull checks again.
          </Typography>

          <Typography variant="h6" sx={{ mb: 1 }}>Recent activity</Typography>
          {!data.activity.length ? (
            <Typography color="text.secondary">Nothing yet.</Typography>
          ) : (
            <Paper variant="outlined">
              <Table size="small">
                <TableBody>
                  {data.activity.map((a, i) => (
                    <TableRow key={i}>
                      <TableCell sx={{ whiteSpace: 'nowrap', width: 190 }}>{formatWhen(a.at)}</TableCell>
                      <TableCell>{activityText(a)}</TableCell>
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

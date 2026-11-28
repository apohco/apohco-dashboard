import { useState } from 'react';
import { Box, Button, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { formatCurrency } from '../../utils/format';

// Pieces shared by the Controller's AJE reports page and the accountant portal.

export const acct = (code, name) => [code, name].filter(Boolean).join(' ');

// A state ([{ code, name, className, amount }]) in a few words.
export function describeState(state) {
  if (!state || !state.length) return '—';
  return state.map((p) => `${acct(p.code, p.name)}${p.className ? ` · ${p.className}` : ''}`).join(' / ');
}

export const STATUS_OPTIONS = [
  { value: 'NotWorked', label: 'Not worked' },
  { value: 'Booked', label: 'Booked' },
  { value: 'Declined', label: 'Declined' },
];
const STATUS_COLORS = { NotWorked: 'default', Booked: 'success', Declined: 'error' };

const when = (value) => {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
export { when as formatWhen };

export function EntryLinesTable({ lines }) {
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

export function BackupTable({ sources }) {
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
        {sources.map((s, i) => (
          <TableRow key={s.fingerprint ? `${s.side}-${s.sourceQboId}-${s.fingerprint}` : i}>
            <TableCell>{s.txnDate}</TableCell>
            <TableCell>{s.payeeName}</TableCell>
            <TableCell sx={{ maxWidth: 220 }}>{s.memo}</TableCell>
            <TableCell align="right">{formatCurrency(s.amount)}</TableCell>
            <TableCell>{s.side === 'Mirror' ? "Other entity's file" : describeState(s.from)}</TableCell>
            <TableCell>{describeState(s.to)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// The accountant's status of an entry, plus "Question open".
export function PortalStatusChips({ portal }) {
  if (!portal) return null;
  return (
    <>
      <Chip size="small" color={STATUS_COLORS[portal.status]} variant={portal.status === 'NotWorked' ? 'outlined' : 'filled'} label={`Accountant: ${portal.statusLabel}`} />
      {portal.questionOpen && <Chip size="small" color="warning" label="Question open" />}
    </>
  );
}

// A question thread with a box to add to it. onSend(text) should report
// its own errors and reject on failure (the text is then kept).
export function EntryThread({ thread, onSend, sendLabel = 'Send', placeholder = 'Write a comment', disabled = false, entryNumber }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onSend(text.trim());
      setText('');
    } catch {
      // The caller shows the error; keep the text so it can be sent again.
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box sx={{ mt: 1 }}>
      {thread.map((c) => (
        <Paper
          key={c.commentId}
          variant="outlined"
          sx={{ p: 1, mb: 0.75, bgcolor: c.authorRole === 'Controller' ? 'grey.50' : 'background.paper', ml: c.authorRole === 'Controller' ? 3 : 0 }}
        >
          <Typography variant="caption" color="text.secondary">
            {c.authorName}{c.authorRole === 'Controller' ? ' (controller)' : ''} · {when(c.createdAt)}
          </Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{c.body}</Typography>
        </Paper>
      ))}
      {onSend && (
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <TextField
            size="small"
            fullWidth
            multiline
            maxRows={6}
            placeholder={placeholder}
            value={text}
            disabled={disabled || busy}
            onChange={(e) => setText(e.target.value)}
            inputProps={{ maxLength: 4000, 'aria-label': entryNumber ? `Comment on ${entryNumber}` : 'Comment' }}
          />
          <Button onClick={send} disabled={disabled || busy || !text.trim()} variant="outlined">{busy ? 'Sending…' : sendLabel}</Button>
        </Stack>
      )}
    </Box>
  );
}

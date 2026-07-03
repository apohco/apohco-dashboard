import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Typography,
  Select,
  MenuItem,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
  Button,
  Alert,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useAuth } from '../../context/AuthContext';
import {
  listQBOs,
  listChartOfAccounts,
  saveChartOfAccounts,
  listAccountGroupings,
  createAccountGrouping,
} from '../../api/settings';

const CREATE_NEW = '__create_new__';

const PL_CLASSIFICATIONS = new Set(['Revenue', 'Expense']);

function CopyGroupingsDialog({ open, onClose, groupId, currentQboId, qbos, accounts, onApply }) {
  const [sourceQboId, setSourceQboId] = useState('');
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setSourceQboId('');
      setError(null);
    }
  }, [open]);

  const otherQbos = qbos.filter((q) => q.qboid !== currentQboId);

  const handleCopy = async () => {
    setCopying(true);
    setError(null);
    try {
      const sourceAccounts = await listChartOfAccounts(groupId, sourceQboId);
      const sourceByCode = new Map(
        sourceAccounts.filter((a) => a.accountcode).map((a) => [a.accountcode, a.groupingid])
      );

      const updates = {};
      let matched = 0;
      for (const account of accounts) {
        if (account.accountcode && sourceByCode.has(account.accountcode)) {
          updates[account.mappingid] = sourceByCode.get(account.accountcode) || null;
          matched += 1;
        }
      }

      onApply(updates, matched, accounts.length);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setCopying(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Copy Groupings from another QBO</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error.response?.data?.message || error.message}
          </Alert>
        )}
        <DialogContentText sx={{ mb: 2 }}>
          This overwrites the Grouping selection shown below for any account whose Account Code
          matches one in the source QBO. Account Name and Type are not affected, and accounts with
          no matching code in the source are left as-is. Nothing is saved to the database until you
          click Save on the main page — you can review or undo before then.
        </DialogContentText>
        <Select
          fullWidth
          size="small"
          displayEmpty
          value={sourceQboId}
          onChange={(e) => setSourceQboId(e.target.value)}
        >
          <MenuItem value="" disabled>
            Copy Groupings from...
          </MenuItem>
          {otherQbos.map((q) => (
            <MenuItem key={q.qboid} value={q.qboid}>
              {q.qboname}
            </MenuItem>
          ))}
        </Select>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!sourceQboId || copying} onClick={handleCopy}>
          {copying ? 'Copying...' : 'Copy Groupings'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ChartOfAccountsSetup() {
  const { groupId } = useAuth();
  const [qbos, setQbos] = useState([]);
  const [qboId, setQboId] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [groupings, setGroupings] = useState([]);
  const [pendingGroupingByMapping, setPendingGroupingByMapping] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);

  useEffect(() => {
    if (!groupId) return;
    listQBOs(groupId).then(setQbos).catch(setError);
    listAccountGroupings(groupId).then(setGroupings).catch(setError);
  }, [groupId]);

  const refreshAccounts = () => {
    if (!groupId || !qboId) return;
    listChartOfAccounts(groupId, qboId).then((rows) => {
      setAccounts(rows);
      setPendingGroupingByMapping({});
    });
  };

  useEffect(refreshAccounts, [groupId, qboId]);

  const groupingOptionsFor = (classification) => {
    const accountType = PL_CLASSIFICATIONS.has(classification) ? 'PL' : 'BalanceSheet';
    return groupings.filter((g) => g.accounttype === accountType);
  };

  const currentGroupingId = (row) =>
    Object.prototype.hasOwnProperty.call(pendingGroupingByMapping, row.mappingid)
      ? pendingGroupingByMapping[row.mappingid]
      : row.groupingid;

  const handleGroupingChange = async (row, value) => {
    if (value === CREATE_NEW) {
      const name = window.prompt('New Grouping name:');
      if (!name) return;
      const accountType = PL_CLASSIFICATIONS.has(row.classification) ? 'PL' : 'BalanceSheet';
      const created = await createAccountGrouping(groupId, name, accountType);
      setGroupings((prev) => [...prev, created]);
      setPendingGroupingByMapping((prev) => ({ ...prev, [row.mappingid]: created.groupingid }));
      return;
    }
    setPendingGroupingByMapping((prev) => ({ ...prev, [row.mappingid]: value || null }));
  };

  const handleCopyApplied = (updates, matched, total) => {
    setPendingGroupingByMapping((prev) => ({ ...prev, ...updates }));
    setMessage(`Copied groupings for ${matched} of ${total} account(s). Review below, then Save.`);
  };

  const dirtyCount = Object.keys(pendingGroupingByMapping).length;

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const mappings = Object.entries(pendingGroupingByMapping).map(([mappingId, groupingId]) => ({
        mappingId,
        groupingId,
      }));
      await saveChartOfAccounts(groupId, mappings);
      setMessage(`Saved ${mappings.length} account grouping assignment(s).`);
      refreshAccounts();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => (a.accountcode || '').localeCompare(b.accountcode || '')),
    [accounts]
  );

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Chart of Accounts
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2 }}>
        <Select
          size="small"
          displayEmpty
          value={qboId}
          onChange={(e) => setQboId(e.target.value)}
          sx={{ minWidth: 280 }}
        >
          <MenuItem value="" disabled>
            Select a QBO
          </MenuItem>
          {qbos.map((q) => (
            <MenuItem key={q.qboid} value={q.qboid}>
              {q.qboname}
            </MenuItem>
          ))}
        </Select>

        {qboId && qbos.length > 1 && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<ContentCopyIcon />}
            onClick={() => setCopyDialogOpen(true)}
          >
            Copy Groupings from another QBO
          </Button>
        )}
      </Box>

      {message && <Alert severity="success" sx={{ mb: 2 }}>{message}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error.response?.data?.message || error.message}</Alert>}

      {qboId && (
        <>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Account Code</TableCell>
                  <TableCell>Account Name</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Grouping</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedAccounts.map((row) => (
                  <TableRow key={row.mappingid}>
                    <TableCell>{row.accountcode}</TableCell>
                    <TableCell>{row.accountname}</TableCell>
                    <TableCell>{row.classification || '—'}</TableCell>
                    <TableCell sx={{ minWidth: 220 }}>
                      <Select
                        size="small"
                        fullWidth
                        displayEmpty
                        value={currentGroupingId(row) || ''}
                        onChange={(e) => handleGroupingChange(row, e.target.value)}
                      >
                        <MenuItem value="">
                          <em>Unassigned</em>
                        </MenuItem>
                        {groupingOptionsFor(row.classification).map((g) => (
                          <MenuItem key={g.groupingid} value={g.groupingid}>
                            {g.groupingname}
                          </MenuItem>
                        ))}
                        <Divider />
                        <MenuItem value={CREATE_NEW}>+ Create new Grouping</MenuItem>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
                {sortedAccounts.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>
                      No accounts found for this QBO yet. Run a QBO Data Sync first.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>

          <Button
            variant="contained"
            sx={{ mt: 2 }}
            disabled={dirtyCount === 0 || saving}
            onClick={handleSave}
          >
            {saving ? 'Saving...' : `Save${dirtyCount ? ` (${dirtyCount} changed)` : ''}`}
          </Button>

          <CopyGroupingsDialog
            open={copyDialogOpen}
            onClose={() => setCopyDialogOpen(false)}
            groupId={groupId}
            currentQboId={qboId}
            qbos={qbos}
            accounts={accounts}
            onApply={handleCopyApplied}
          />
        </>
      )}
    </Box>
  );
}

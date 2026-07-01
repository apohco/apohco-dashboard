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
} from '@mui/material';
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

      <Select
        size="small"
        displayEmpty
        value={qboId}
        onChange={(e) => setQboId(e.target.value)}
        sx={{ mb: 2, minWidth: 280 }}
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
        </>
      )}
    </Box>
  );
}

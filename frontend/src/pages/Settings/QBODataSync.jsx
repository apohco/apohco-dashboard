import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import {
  Box,
  Typography,
  Paper,
  Select,
  MenuItem,
  TextField,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material';
import useEffectiveGroup from '../../hooks/useEffectiveGroup';
import { listQBOs, syncQBOData } from '../../api/settings';

export default function QBODataSync() {
  const { groupId, needsGroupSelector, groups, groupsError, selectedGroupId, setSelectedGroupId } =
    useEffectiveGroup();
  const [qbos, setQbos] = useState([]);
  const [qboId, setQboId] = useState('');
  const [startDate, setStartDate] = useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [endDate, setEndDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setQboId('');
    if (!groupId) {
      setQbos([]);
      return;
    }
    listQBOs(groupId).then(setQbos).catch(setError);
  }, [groupId]);

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    setResult(null);
    try {
      const data = await syncQBOData(qboId, startDate, endDate);
      setResult(data);
    } catch (err) {
      setError(err);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        QBO Data Sync
      </Typography>

      {needsGroupSelector && (
        <Select
          size="small"
          displayEmpty
          value={selectedGroupId}
          onChange={(e) => setSelectedGroupId(e.target.value)}
          sx={{ mb: 2, minWidth: 280 }}
        >
          <MenuItem value="" disabled>
            Select a Group
          </MenuItem>
          {groups.map((g) => (
            <MenuItem key={g.groupid} value={g.groupid}>
              {g.groupname}
            </MenuItem>
          ))}
        </Select>
      )}
      {groupsError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Couldn't load Groups: {groupsError.response?.data?.message || groupsError.message}
        </Alert>
      )}

      {needsGroupSelector && !groupId ? (
        <Typography color="text.secondary">Select a Group above to sync its QBO data.</Typography>
      ) : (
        <Paper variant="outlined" sx={{ p: 3, maxWidth: 480 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Pulls Chart of Accounts, Classes, and General Ledger transactions for the selected date
            range, overwriting existing data for that QBO and range.
          </Typography>

          <Select
            fullWidth
            size="small"
            displayEmpty
            value={qboId}
            onChange={(e) => setQboId(e.target.value)}
            sx={{ mb: 2 }}
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

          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <TextField
              fullWidth
              size="small"
              type="date"
              label="From"
              InputLabelProps={{ shrink: true }}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <TextField
              fullWidth
              size="small"
              type="date"
              label="To"
              InputLabelProps={{ shrink: true }}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Box>

          <Button
            variant="contained"
            disabled={!qboId || syncing}
            onClick={handleSync}
            startIcon={syncing ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {syncing ? 'Syncing...' : 'Sync Now'}
          </Button>

          {result && (
            <Alert severity="success" sx={{ mt: 2 }}>
              Synced {result.transactionsSynced} transactions for{' '}
              {result.dateRange.startDate} – {result.dateRange.endDate}.
            </Alert>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error.response?.data?.message || error.message}
            </Alert>
          )}
        </Paper>
      )}
    </Box>
  );
}

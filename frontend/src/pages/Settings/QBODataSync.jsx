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
  Tabs,
  Tab,
} from '@mui/material';
import useEffectiveGroup from '../../hooks/useEffectiveGroup';
import ManualUploadForm from '../../components/reports/ManualUploadForm';
import { listQBOs, syncQBOData } from '../../api/settings';

function ApiSyncForm({ qbos, startDate, endDate, onStartDateChange, onEndDateChange }) {
  const [qboId, setQboId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

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
          onChange={(e) => onStartDateChange(e.target.value)}
        />
        <TextField
          fullWidth
          size="small"
          type="date"
          label="To"
          InputLabelProps={{ shrink: true }}
          value={endDate}
          onChange={(e) => onEndDateChange(e.target.value)}
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
    </Box>
  );
}

export default function QBODataSync() {
  const { groupId, needsGroupSelector, groups, groupsError, selectedGroupId, setSelectedGroupId } =
    useEffectiveGroup();
  const [qbos, setQbos] = useState([]);
  const [qbosError, setQbosError] = useState(null);
  const [mode, setMode] = useState('api');
  const [startDate, setStartDate] = useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [endDate, setEndDate] = useState(dayjs().format('YYYY-MM-DD'));

  useEffect(() => {
    if (!groupId) {
      setQbos([]);
      return;
    }
    listQBOs(groupId).then(setQbos).catch(setQbosError);
  }, [groupId]);

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
      {qbosError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {qbosError.response?.data?.message || qbosError.message}
        </Alert>
      )}

      {needsGroupSelector && !groupId ? (
        <Typography color="text.secondary">Select a Group above to sync its QBO data.</Typography>
      ) : (
        <Paper variant="outlined" sx={{ p: 3, maxWidth: 640 }}>
          <Tabs value={mode} onChange={(e, v) => setMode(v)} sx={{ mb: 2 }}>
            <Tab label="API Sync" value="api" />
            <Tab label="Manual Upload (CSV/Excel)" value="manual" />
          </Tabs>

          {mode === 'api' ? (
            <ApiSyncForm
              qbos={qbos}
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={setStartDate}
              onEndDateChange={setEndDate}
            />
          ) : (
            <ManualUploadForm
              qbos={qbos}
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={setStartDate}
              onEndDateChange={setEndDate}
            />
          )}
        </Paper>
      )}
    </Box>
  );
}

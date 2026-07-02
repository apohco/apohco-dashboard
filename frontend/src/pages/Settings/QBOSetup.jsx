import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  List,
  ListItem,
  ListItemText,
  Chip,
  TextField,
  FormControlLabel,
  Checkbox,
  Button,
  Alert,
  IconButton,
  Select,
  MenuItem,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import useEffectiveGroup from '../../hooks/useEffectiveGroup';
import { listQBOs, deleteQBO, startQBOConnect } from '../../api/settings';

export default function QBOSetup() {
  const { groupId, needsGroupSelector, groups, groupsError, selectedGroupId, setSelectedGroupId } =
    useEffectiveGroup();
  const [searchParams] = useSearchParams();
  const [qbos, setQbos] = useState([]);
  const [error, setError] = useState(null);
  const [newQboName, setNewQboName] = useState('');
  const [newIsClassBased, setNewIsClassBased] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const refresh = () => {
    if (!groupId) {
      setQbos([]);
      return;
    }
    listQBOs(groupId).then(setQbos).catch(setError);
  };

  useEffect(refresh, [groupId]);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const { authUrl } = await startQBOConnect(groupId, newQboName, newIsClassBased);
      window.location.href = authUrl; // hand off to Intuit's OAuth consent screen
    } catch (err) {
      setError(err);
      setConnecting(false);
    }
  };

  const handleDelete = async (qboId) => {
    if (!window.confirm('Remove this QBO connection? Synced data for it will also be deleted.')) return;
    await deleteQBO(qboId, groupId);
    refresh();
  };

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        QBO API Setup
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

      {searchParams.get('connected') && (
        <Alert severity="success" sx={{ mb: 2 }}>
          QBO connected successfully.
        </Alert>
      )}
      {searchParams.get('error') && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {searchParams.get('error')}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error.response?.data?.message || error.message}
        </Alert>
      )}

      {needsGroupSelector && !groupId ? (
        <Typography color="text.secondary">Select a Group above to manage its QBO connections.</Typography>
      ) : (
        <>
          <Paper variant="outlined" sx={{ mb: 3 }}>
            <List dense>
              {qbos.map((q) => (
                <ListItem
                  key={q.qboid}
                  secondaryAction={
                    <IconButton edge="end" onClick={() => handleDelete(q.qboid)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  }
                >
                  <ListItemText
                    primary={q.qboname}
                    secondary={`Realm ${q.realmid}${q.classes?.length ? ` • ${q.classes.length} classes` : ''}`}
                  />
                  {q.isclassbased && <Chip size="small" label="Class-based" sx={{ mr: 2 }} />}
                </ListItem>
              ))}
              {qbos.length === 0 && (
                <ListItem>
                  <ListItemText secondary="No QBOs connected yet." />
                </ListItem>
              )}
            </List>
          </Paper>

          <Paper variant="outlined" sx={{ p: 3, maxWidth: 480 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Connect a new QBO
            </Typography>
            <TextField
              fullWidth
              size="small"
              label="QBO Name"
              placeholder="e.g. APOHCO Parent"
              value={newQboName}
              onChange={(e) => setNewQboName(e.target.value)}
              sx={{ mb: 2 }}
            />
            <FormControlLabel
              control={
                <Checkbox checked={newIsClassBased} onChange={(e) => setNewIsClassBased(e.target.checked)} />
              }
              label="This QBO uses Classes for locations"
              sx={{ mb: 2, display: 'block' }}
            />
            <Button variant="contained" disabled={!newQboName || connecting} onClick={handleConnect}>
              {connecting ? 'Redirecting to QuickBooks...' : 'Connect to QuickBooks'}
            </Button>
          </Paper>
        </>
      )}
    </Box>
  );
}

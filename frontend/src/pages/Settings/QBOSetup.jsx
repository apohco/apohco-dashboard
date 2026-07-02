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
import AddIcon from '@mui/icons-material/Add';
import useEffectiveGroup from '../../hooks/useEffectiveGroup';
import { listQBOs, deleteQBO, startQBOConnect, createQBOManually } from '../../api/settings';

export default function QBOSetup() {
  const { groupId, needsGroupSelector, groups, groupsError, selectedGroupId, setSelectedGroupId } =
    useEffectiveGroup();
  const [searchParams] = useSearchParams();
  const [qbos, setQbos] = useState([]);
  const [error, setError] = useState(null);

  const [newQboName, setNewQboName] = useState('');
  const [newIsClassBased, setNewIsClassBased] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const [manualQboName, setManualQboName] = useState('');
  const [manualIsClassBased, setManualIsClassBased] = useState(false);
  const [manualClassNames, setManualClassNames] = useState(['']);
  const [creatingManual, setCreatingManual] = useState(false);
  const [manualSuccess, setManualSuccess] = useState(null);

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

  const handleCreateManual = async () => {
    setCreatingManual(true);
    setError(null);
    setManualSuccess(null);
    try {
      const classNames = manualIsClassBased ? manualClassNames.map((c) => c.trim()).filter(Boolean) : [];
      const qbo = await createQBOManually(groupId, manualQboName, manualIsClassBased, classNames);
      setManualSuccess(`Created "${qbo.qboname}" — available for Manual Upload.`);
      setManualQboName('');
      setManualIsClassBased(false);
      setManualClassNames(['']);
      refresh();
    } catch (err) {
      setError(err);
    } finally {
      setCreatingManual(false);
    }
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
                    secondary={
                      q.isapiconnected
                        ? `Realm ${q.realmid}${q.classes?.length ? ` • ${q.classes.length} classes` : ''}`
                        : `No API connection${q.classes?.length ? ` • ${q.classes.length} classes` : ''}`
                    }
                  />
                  <Chip
                    size="small"
                    label={q.isapiconnected ? 'API Connected' : 'Manual'}
                    color={q.isapiconnected ? 'success' : 'default'}
                    sx={{ mr: 1 }}
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

          <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            <Paper variant="outlined" sx={{ p: 3, maxWidth: 480, flex: 1, minWidth: 320 }}>
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

            <Paper variant="outlined" sx={{ p: 3, maxWidth: 480, flex: 1, minWidth: 320 }}>
              <Typography variant="h6" sx={{ mb: 1 }}>
                Create QBO Manually
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                No OAuth connection — use this for a QBO whose data you'll bring in via Manual
                Upload instead of the API.
              </Typography>
              {manualSuccess && (
                <Alert severity="success" sx={{ mb: 2 }}>
                  {manualSuccess}
                </Alert>
              )}
              <TextField
                fullWidth
                size="small"
                label="QBO Name"
                placeholder="e.g. Lawrenceberg"
                value={manualQboName}
                onChange={(e) => setManualQboName(e.target.value)}
                sx={{ mb: 2 }}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={manualIsClassBased}
                    onChange={(e) => setManualIsClassBased(e.target.checked)}
                  />
                }
                label="This QBO uses Classes for locations"
                sx={{ mb: 1, display: 'block' }}
              />

              {manualIsClassBased && (
                <Box sx={{ mb: 2, pl: 2 }}>
                  {manualClassNames.map((name, i) => (
                    <Box key={i} sx={{ display: 'flex', gap: 1, mb: 1 }}>
                      <TextField
                        size="small"
                        fullWidth
                        placeholder={`Class ${i + 1} name`}
                        value={name}
                        onChange={(e) => {
                          const next = [...manualClassNames];
                          next[i] = e.target.value;
                          setManualClassNames(next);
                        }}
                      />
                      <IconButton
                        size="small"
                        disabled={manualClassNames.length === 1}
                        onClick={() => setManualClassNames(manualClassNames.filter((_, idx) => idx !== i))}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  ))}
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={() => setManualClassNames([...manualClassNames, ''])}
                  >
                    Add Class
                  </Button>
                </Box>
              )}

              <Button
                variant="contained"
                disabled={!manualQboName || creatingManual}
                onClick={handleCreateManual}
              >
                {creatingManual ? 'Creating...' : 'Create QBO'}
              </Button>
            </Paper>
          </Box>
        </>
      )}
    </Box>
  );
}

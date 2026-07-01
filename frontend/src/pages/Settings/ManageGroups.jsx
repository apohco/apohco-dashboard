import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  IconButton,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Alert,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { useAuth } from '../../context/AuthContext';
import { listGroups, createGroup, renameGroup, deleteGroup } from '../../api/settings';

function GroupDialog({ open, onClose, onSaved, editing }) {
  const [groupName, setGroupName] = useState('');
  const [initialOwnerUserId, setInitialOwnerUserId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setGroupName(editing?.groupname || '');
    setInitialOwnerUserId('');
    setError(null);
  }, [open, editing]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await renameGroup(editing.groupid, groupName);
      } else {
        await createGroup(groupName, initialOwnerUserId || undefined);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{editing ? 'Rename Group' : 'New Group'}</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error.response?.data?.message || error.message}
          </Alert>
        )}
        <TextField
          fullWidth
          autoFocus
          size="small"
          label="Group Name"
          placeholder="e.g. APOHCO"
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          sx={{ mt: 1, mb: editing ? 0 : 2 }}
        />
        {!editing && (
          <TextField
            fullWidth
            size="small"
            label="Initial Owner User ID (optional)"
            placeholder="UserId of a user who has already signed in once"
            helperText="Leave blank if you'll invite the Owner via Cognito with custom:groupId set instead (see SETUP.md)."
            value={initialOwnerUserId}
            onChange={(e) => setInitialOwnerUserId(e.target.value)}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!groupName || saving} onClick={handleSave}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ManageGroups() {
  const { role } = useAuth();
  const [groups, setGroups] = useState([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // { group, warning }

  const refresh = () => {
    listGroups().then(setGroups).catch(setError);
  };

  useEffect(refresh, []);

  if (role !== 'SoftwareAdmin') {
    return (
      <Alert severity="error">You don't have access to this page.</Alert>
    );
  }

  const handleDelete = async (group) => {
    try {
      await deleteGroup(group.groupid, false);
      refresh();
    } catch (err) {
      if (err.response?.status === 409) {
        setPendingDelete({ group, warning: err.response.data });
      } else {
        setError(err);
      }
    }
  };

  const confirmForceDelete = async () => {
    const group = pendingDelete.group;
    setPendingDelete(null);
    await deleteGroup(group.groupid, true);
    refresh();
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h1">Manage Groups</Typography>
        <Button
          variant="contained"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          New Group
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error.response?.data?.message || error.message}
        </Alert>
      )}

      {pendingDelete && (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={confirmForceDelete}>
              Delete Anyway
            </Button>
          }
          onClose={() => setPendingDelete(null)}
        >
          {pendingDelete.warning.message} ({pendingDelete.warning.qboCount} QBO(s),{' '}
          {pendingDelete.warning.userCount} user(s))
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Group Name</TableCell>
              <TableCell>Created</TableCell>
              <TableCell align="right">QBOs</TableCell>
              <TableCell align="right">Users</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {groups.map((g) => (
              <TableRow key={g.groupid}>
                <TableCell>{g.groupname}</TableCell>
                <TableCell>{dayjs(g.createddate).format('MMM D, YYYY')}</TableCell>
                <TableCell align="right">{g.qbocount}</TableCell>
                <TableCell align="right">{g.usercount}</TableCell>
                <TableCell align="right">
                  <IconButton
                    size="small"
                    onClick={() => {
                      setEditing(g);
                      setDialogOpen(true);
                    }}
                  >
                    <EditOutlinedIcon fontSize="small" />
                  </IconButton>
                  <IconButton size="small" onClick={() => handleDelete(g)}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
            {groups.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>No Groups yet.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <GroupDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={refresh}
        editing={editing}
      />
    </Box>
  );
}

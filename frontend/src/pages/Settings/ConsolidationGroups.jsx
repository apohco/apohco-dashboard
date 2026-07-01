import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  List,
  ListItem,
  ListItemText,
  IconButton,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Chip,
  Alert,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { useAuth } from '../../context/AuthContext';
import {
  listQBOs,
  listConsolidationGroups,
  createConsolidationGroup,
  updateConsolidationGroup,
  deleteConsolidationGroup,
} from '../../api/settings';

function membershipKey(qboId, qboClassId) {
  return `${qboId}::${qboClassId || 'whole'}`;
}

function ConsolidationGroupDialog({ open, onClose, onSaved, groupId, qbos, editing }) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.consolidationgroupname || '');
    setSelected(
      new Set((editing?.qbos || []).map((m) => membershipKey(m.qboid, m.qboclassid)))
    );
    setError(null);
  }, [open, editing]);

  const toggle = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const membershipQbos = [...selected].map((key) => {
      const [qboId, classPart] = key.split('::');
      return { qboId, qboClassId: classPart === 'whole' ? null : classPart };
    });

    try {
      if (editing) {
        await updateConsolidationGroup(editing.consolidationgroupid, groupId, name, membershipQbos);
      } else {
        await createConsolidationGroup(groupId, name, membershipQbos);
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
      <DialogTitle>{editing ? 'Edit Consolidation Group' : 'New Consolidation Group'}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error.response?.data?.message || error.message}</Alert>}
        <TextField
          fullWidth
          autoFocus
          size="small"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          sx={{ my: 1 }}
        />
        <Typography variant="body2" sx={{ mt: 2, mb: 1 }} color="text.secondary">
          Include:
        </Typography>
        <FormGroup>
          {qbos.map((q) => (
            <Box key={q.qboid} sx={{ mb: 1 }}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={selected.has(membershipKey(q.qboid, null))}
                    onChange={() => toggle(membershipKey(q.qboid, null))}
                  />
                }
                label={`${q.qboname} (whole QBO)`}
              />
              {q.classes?.map((c) => (
                <Box key={c.qboclassid} sx={{ pl: 4 }}>
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={selected.has(membershipKey(q.qboid, c.qboclassid))}
                        onChange={() => toggle(membershipKey(q.qboid, c.qboclassid))}
                      />
                    }
                    label={`${q.qboname} — ${c.classname}`}
                  />
                </Box>
              ))}
            </Box>
          ))}
        </FormGroup>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!name || saving} onClick={handleSave}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ConsolidationGroups() {
  const { groupId } = useAuth();
  const [qbos, setQbos] = useState([]);
  const [groups, setGroups] = useState([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  const refresh = () => {
    if (!groupId) return;
    listConsolidationGroups(groupId).then(setGroups).catch(setError);
  };

  useEffect(() => {
    if (!groupId) return;
    listQBOs(groupId).then(setQbos).catch(setError);
    refresh();
  }, [groupId]);

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this Consolidation Group?')) return;
    await deleteConsolidationGroup(id, groupId);
    refresh();
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h1">Consolidation Groups</Typography>
        <Button
          variant="contained"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          New Consolidation Group
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error.response?.data?.message || error.message}</Alert>}

      <Paper variant="outlined">
        <List dense>
          {groups.map((g) => (
            <ListItem
              key={g.consolidationgroupid}
              secondaryAction={
                <>
                  <IconButton
                    edge="end"
                    onClick={() => {
                      setEditing(g);
                      setDialogOpen(true);
                    }}
                  >
                    <EditOutlinedIcon fontSize="small" />
                  </IconButton>
                  <IconButton edge="end" onClick={() => handleDelete(g.consolidationgroupid)}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </>
              }
            >
              <ListItemText
                primary={g.consolidationgroupname}
                secondary={
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                    {(g.qbos || []).map((m) => (
                      <Chip
                        key={m.id}
                        size="small"
                        label={m.classname ? `${m.qboname} — ${m.classname}` : m.qboname}
                      />
                    ))}
                  </Box>
                }
              />
            </ListItem>
          ))}
          {groups.length === 0 && (
            <ListItem>
              <ListItemText secondary="No Consolidation Groups yet." />
            </ListItem>
          )}
        </List>
      </Paper>

      <ConsolidationGroupDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={refresh}
        groupId={groupId}
        qbos={qbos}
        editing={editing}
      />
    </Box>
  );
}

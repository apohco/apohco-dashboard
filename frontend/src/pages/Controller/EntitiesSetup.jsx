import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  ListSubheader,
  MenuItem,
  Paper,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import {
  createControllerEntity,
  deleteControllerEntity,
  listControllerEntities,
  updateControllerEntity,
} from '../../api/controller';

const errorText = (err) => err?.response?.data?.message || err?.message;

const EMPTY_FORM = {
  entityName: '',
  practiceQboId: '',
  managementQboClassId: '',
  consolidationGroupId: '',
  aliases: '',
  keywords: '',
  isActive: true,
};

// "a, b ,, c" -> ["a", "b", "c"]
export const splitList = (text) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function toForm(entity) {
  if (!entity) return EMPTY_FORM;
  return {
    entityName: entity.entityName,
    practiceQboId: entity.practiceQboId || '',
    managementQboClassId: entity.managementQboClassId || '',
    consolidationGroupId: entity.consolidationGroupId || '',
    aliases: entity.aliases.join(', '),
    keywords: entity.keywords.join(', '),
    isActive: entity.isActive,
  };
}

export function toPayload(form) {
  return {
    entityName: form.entityName.trim(),
    practiceQboId: form.practiceQboId || null,
    managementQboClassId: form.managementQboClassId || null,
    consolidationGroupId: form.consolidationGroupId || null,
    aliases: splitList(form.aliases),
    keywords: splitList(form.keywords),
    isActive: form.isActive,
  };
}

function EntityDialog({ open, entity, options, onClose, onSave }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setForm(toForm(entity));
      setError(null);
    }
  }, [open, entity]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: field === 'isActive' ? e.target.checked : e.target.value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(toPayload(form));
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  // Classes grouped by the QBO file they belong to.
  const classItems = [];
  let lastQbo = null;
  for (const c of options.classes) {
    if (c.qboId !== lastQbo) {
      classItems.push(<ListSubheader key={`h-${c.qboId}`}>{c.qboName}</ListSubheader>);
      lastQbo = c.qboId;
    }
    classItems.push(
      <MenuItem key={c.qboClassId} value={c.qboClassId}>
        {c.className}
      </MenuItem>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{entity ? 'Edit entity' : 'Add entity'}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
        <TextField fullWidth size="small" label="Name" value={form.entityName} onChange={set('entityName')} sx={{ mt: 1, mb: 2 }} autoFocus />
        <TextField
          select
          fullWidth
          size="small"
          label="Class in the management company file"
          value={form.managementQboClassId}
          onChange={set('managementQboClassId')}
          sx={{ mb: 2 }}
        >
          <MenuItem value="">None</MenuItem>
          {classItems}
        </TextField>
        <TextField select fullWidth size="small" label="Practice's own QBO file" value={form.practiceQboId} onChange={set('practiceQboId')} sx={{ mb: 2 }}>
          <MenuItem value="">None</MenuItem>
          {options.qbos.map((q) => (
            <MenuItem key={q.qboId} value={q.qboId}>
              {q.qboName}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          fullWidth
          size="small"
          label="Matching Consolidation Group (optional)"
          value={form.consolidationGroupId}
          onChange={set('consolidationGroupId')}
          sx={{ mb: 2 }}
        >
          <MenuItem value="">None</MenuItem>
          {options.consolidationGroups.map((g) => (
            <MenuItem key={g.consolidationGroupId} value={g.consolidationGroupId}>
              {g.consolidationGroupName}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          size="small"
          label="Other names (comma-separated)"
          helperText="How this practice appears on invoices and in memos, e.g. Lebanon Dental, LEB"
          value={form.aliases}
          onChange={set('aliases')}
          sx={{ mb: 2 }}
        />
        <TextField
          fullWidth
          size="small"
          label="Keywords (comma-separated)"
          helperText="Street address, doctor names or other words that point to this practice"
          value={form.keywords}
          onChange={set('keywords')}
          sx={{ mb: 1 }}
        />
        <FormControlLabel control={<Switch checked={form.isActive} onChange={set('isActive')} />} label="Active" />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving || !form.entityName.trim()}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function EntitiesSetup() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState({ open: false, entity: null });

  const load = useCallback(() => {
    if (!groupId) return;
    setError(null);
    listControllerEntities(groupId).then(setData).catch(setError);
  }, [groupId]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const save = async (payload) => {
    if (dialog.entity) await updateControllerEntity(groupId, dialog.entity.entityId, payload);
    else await createControllerEntity(groupId, payload);
    setDialog({ open: false, entity: null });
    load();
  };

  const remove = async (entity) => {
    if (!window.confirm(`Delete ${entity.entityName}?`)) return;
    try {
      await deleteControllerEntity(groupId, entity.entityId);
      load();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h1">Entities</Typography>
        <Button variant="contained" disabled={!data} onClick={() => setDialog({ open: true, entity: null })}>
          Add entity
        </Button>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        The dental homes and companies expenses get assigned to. Link each one to its class in the management
        company file and to its own QBO file.
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
      {groupId && !data && !error && <CircularProgress size={24} />}

      {data && data.entities.length === 0 && (
        <Typography color="text.secondary">No entities yet. Add one for each dental home.</Typography>
      )}

      {data && data.entities.length > 0 && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Management file class</TableCell>
                <TableCell>Practice QBO file</TableCell>
                <TableCell>Other names</TableCell>
                <TableCell>Keywords</TableCell>
                <TableCell>Status</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {data.entities.map((e) => (
                <TableRow key={e.entityId}>
                  <TableCell>{e.entityName}</TableCell>
                  <TableCell>{e.managementClassName ? `${e.managementClassName} (${e.managementQboName})` : '—'}</TableCell>
                  <TableCell>{e.practiceQboName || '—'}</TableCell>
                  <TableCell>{e.aliases.join(', ')}</TableCell>
                  <TableCell>{e.keywords.join(', ')}</TableCell>
                  <TableCell>
                    <Chip size="small" label={e.isActive ? 'Active' : 'Inactive'} color={e.isActive ? 'success' : 'default'} variant="outlined" />
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <IconButton size="small" aria-label={`Edit ${e.entityName}`} onClick={() => setDialog({ open: true, entity: e })}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                    <IconButton size="small" aria-label={`Delete ${e.entityName}`} onClick={() => remove(e)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {data && (
        <EntityDialog
          open={dialog.open}
          entity={dialog.entity}
          options={data.options}
          onClose={() => setDialog({ open: false, entity: null })}
          onSave={save}
        />
      )}
    </Box>
  );
}

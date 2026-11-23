import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Select,
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
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import { listVendors, mergeVendor, updateVendor } from '../../api/controller';

const errorText = (err) => err?.response?.data?.message || err?.message;

// Vendor -> editable form.
export function toForm(vendor) {
  return {
    displayName: vendor.displayName,
    watchMode: vendor.watchMode,
    defaultEntityId: vendor.rule?.defaultEntityId || '',
    keywords: (vendor.rule?.keywords || []).map((k) => ({ ...k })),
    ruleText: vendor.rule?.ruleText || '',
    split: (vendor.splitTemplate || []).map((s) => ({ entityId: s.entityId, percent: String(s.percent) })),
  };
}

// Form -> API body. Blank keyword/split rows are dropped.
export function toBody(form) {
  const split = form.split.filter((s) => s.entityId || s.percent);
  return {
    displayName: form.displayName.trim(),
    watchMode: form.watchMode,
    splitTemplate: split.length ? split.map((s) => ({ entityId: s.entityId, percent: Number(s.percent) })) : null,
    rule: {
      defaultEntityId: form.defaultEntityId || null,
      keywords: form.keywords.filter((k) => k.keyword.trim()).map((k) => ({ keyword: k.keyword.trim(), entityId: k.entityId })),
      ruleText: form.ruleText,
    },
  };
}

function EntitySelect({ value, onChange, entities, label, allowNone }) {
  return (
    <Select size="small" displayEmpty value={value} onChange={(e) => onChange(e.target.value)} sx={{ minWidth: 180 }} inputProps={{ 'aria-label': label }}>
      <MenuItem value="" disabled={!allowNone}>
        {allowNone ? 'None' : 'Entity'}
      </MenuItem>
      {entities.map((e) => (
        <MenuItem key={e.entityId} value={e.entityId}>
          {e.entityName}
        </MenuItem>
      ))}
    </Select>
  );
}

function VendorDialog({ vendor, vendors, entities, groupId, onClose }) {
  const [form, setForm] = useState(() => toForm(vendor));
  const [mergeFrom, setMergeFrom] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const setRow = (list, i, key, value) => set(list, form[list].map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  const splitTotal = form.split.reduce((s, r) => s + (Number(r.percent) || 0), 0);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await updateVendor(groupId, vendor.vendorId, toBody(form));
      onClose(result.ruleVersion ? `Saved ${form.displayName} (rule version ${result.ruleVersion}).` : `Saved ${form.displayName}.`);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };
  const merge = async () => {
    setSaving(true);
    setError(null);
    try {
      await mergeVendor(groupId, vendor.vendorId, mergeFrom);
      onClose(`Merged ${vendors.find((v) => v.vendorId === mergeFrom)?.displayName} into ${vendor.displayName}.`);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={() => onClose(null)} fullWidth maxWidth="md">
      <DialogTitle>{vendor.displayName}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Payee names: {vendor.aliases.join(', ') || '—'}
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}>
          <TextField size="small" label="Name" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} />
          <FormControlLabel control={<Switch checked={form.watchMode} onChange={(e) => set('watchMode', e.target.checked)} />} label="Watch mode (always decide one at a time)" />
        </Box>

        <Typography variant="subtitle2">Rule</Typography>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', my: 1 }}>
          <Typography variant="body2">Default entity</Typography>
          <EntitySelect value={form.defaultEntityId} onChange={(v) => set('defaultEntityId', v)} entities={entities} label="Default entity" allowNone />
        </Box>
        <Typography variant="body2" sx={{ mt: 1 }}>
          Keywords (in the memo or payee) that point to an entity:
        </Typography>
        {form.keywords.map((k, i) => (
          <Box key={i} sx={{ display: 'flex', gap: 1, my: 1 }}>
            <TextField size="small" label="Keyword" value={k.keyword} onChange={(e) => setRow('keywords', i, 'keyword', e.target.value)} />
            <EntitySelect value={k.entityId || ''} onChange={(v) => setRow('keywords', i, 'entityId', v)} entities={entities} label={`Keyword entity ${i + 1}`} />
            <Button size="small" onClick={() => set('keywords', form.keywords.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </Box>
        ))}
        <Button size="small" onClick={() => set('keywords', [...form.keywords, { keyword: '', entityId: '' }])}>
          Add keyword
        </Button>
        <TextField
          fullWidth
          multiline
          minRows={2}
          size="small"
          label="Written rule"
          helperText="Plain English, e.g. where the invoices are and what decides the practice. Stored and versioned now; the AI reads it from Phase 3."
          value={form.ruleText}
          onChange={(e) => set('ruleText', e.target.value)}
          sx={{ mt: 2 }}
        />
        {vendor.rule && (
          <Typography variant="caption" color="text.secondary">
            Current rule: version {vendor.rule.version}, saved {new Date(vendor.rule.createdDate).toLocaleDateString()}. Saving a change adds a new version.
          </Typography>
        )}

        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2">Default split</Typography>
        <Typography variant="body2" color="text.secondary">
          For vendors that serve several homes: percentages that prefill a line&apos;s Split.
        </Typography>
        {form.split.map((s, i) => (
          <Box key={i} sx={{ display: 'flex', gap: 1, my: 1 }}>
            <EntitySelect value={s.entityId} onChange={(v) => setRow('split', i, 'entityId', v)} entities={entities} label={`Split entity ${i + 1}`} />
            <TextField size="small" type="number" label="%" value={s.percent} onChange={(e) => setRow('split', i, 'percent', e.target.value)} sx={{ width: 100 }} />
            <Button size="small" onClick={() => set('split', form.split.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </Box>
        ))}
        <Button size="small" onClick={() => set('split', [...form.split, { entityId: '', percent: '' }])}>
          Add entity
        </Button>
        {form.split.length > 0 && (
          <Typography variant="body2" color={Math.abs(splitTotal - 100) < 0.01 ? 'success.main' : 'warning.main'}>
            Total {splitTotal}%
          </Typography>
        )}

        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2">Merge</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Bring another vendor&apos;s payee names into this one (for example &quot;AMZN Mktp&quot; into Amazon).
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Select size="small" displayEmpty value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} sx={{ minWidth: 260 }} inputProps={{ 'aria-label': 'Vendor to merge in' }}>
            <MenuItem value="" disabled>
              Vendor to merge in
            </MenuItem>
            {vendors
              .filter((v) => v.vendorId !== vendor.vendorId)
              .map((v) => (
                <MenuItem key={v.vendorId} value={v.vendorId}>
                  {v.displayName}
                </MenuItem>
              ))}
          </Select>
          <Button disabled={!mergeFrom || saving} onClick={merge}>
            Merge
          </Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(null)}>Cancel</Button>
        <Button variant="contained" disabled={saving || !form.displayName.trim()} onClick={save}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function Vendors() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    if (!groupId) return;
    try {
      setData(await listVendors(groupId));
    } catch (err) {
      setError(err);
    }
  }, [groupId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const entityName = (id) => data?.entities.find((e) => e.entityId === id)?.entityName || '—';
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!data) return [];
    if (!q) return data.vendors;
    return data.vendors.filter((v) => v.displayName.toLowerCase().includes(q) || v.aliases.some((a) => a.toLowerCase().includes(q)));
  }, [data, search]);

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Vendors
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{errorText(error)}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}
      {groupId && !data && !error && <CircularProgress size={24} />}

      {data && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            A profile is created for every payee the first time a review runs. Rules here are applied ahead of history.
          </Typography>
          <TextField size="small" label="Search vendors" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ mb: 2, width: 300 }} />
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Vendor</TableCell>
                  <TableCell>Payee names</TableCell>
                  <TableCell>Default entity</TableCell>
                  <TableCell>Keywords</TableCell>
                  <TableCell>Rule</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map((v) => (
                  <TableRow key={v.vendorId} hover>
                    <TableCell>
                      {v.displayName}
                      {v.watchMode && <Chip size="small" label="Watch" sx={{ ml: 1 }} />}
                      {v.splitTemplate && <Chip size="small" variant="outlined" label="Split" sx={{ ml: 1 }} />}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 260 }}>{v.aliases.join(', ')}</TableCell>
                    <TableCell>{v.rule?.defaultEntityId ? entityName(v.rule.defaultEntityId) : '—'}</TableCell>
                    <TableCell>{v.rule?.keywords.length || 0}</TableCell>
                    <TableCell>{v.rule ? `v${v.rule.version}` : '—'}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => setEditing(v)}>
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {visible.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} sx={{ color: 'text.secondary' }}>
                      {data.vendors.length ? 'No vendors match.' : 'No vendors yet. Run a review to create them.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      {editing && (
        <VendorDialog
          vendor={editing}
          vendors={data.vendors}
          entities={data.entities}
          groupId={groupId}
          onClose={(message) => {
            setEditing(null);
            if (message) {
              setNotice(message);
              load();
            }
          }}
        />
      )}
    </Box>
  );
}

import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
  Button,
  IconButton,
  Alert,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Select,
  MenuItem,
  FormControlLabel,
  Checkbox,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { useAuth } from '../../context/AuthContext';
import { listAccountGroupings, getReportLayout, saveReportLayout } from '../../api/settings';

const STATEMENTS = [
  { value: 'PL', label: 'Profit & Loss' },
  { value: 'BalanceSheet', label: 'Balance Sheet' },
  { value: 'CashFlow', label: 'Cash Flow' },
];

let tempIdCounter = 0;
function newTempId() {
  tempIdCounter += 1;
  return `new-${Date.now()}-${tempIdCounter}`;
}

function accountTypesFor(statement) {
  if (statement === 'PL') return ['PL'];
  if (statement === 'BalanceSheet') return ['BalanceSheet'];
  return ['PL', 'BalanceSheet'];
}

// Add mode: `earlierRows` is every row currently staged (new rows always
// append at the end, so all of them qualify). Edit mode (`editingRow` set):
// `earlierRows` must be pre-scoped by the caller to only the rows strictly
// above the row being edited, so a Total/Net can't be pointed at itself or
// at something after it. rowType is locked once editing an existing row --
// switching Total<->Net<->Grouping mid-edit would need very different
// fields, so that's just delete-and-re-add.
function RowDialog({ open, onClose, availableGroupings, earlierRows, editingRow, onSubmit }) {
  const [rowType, setRowType] = useState('Grouping');
  const [groupingId, setGroupingId] = useState('');
  const [label, setLabel] = useState('');
  const [componentIds, setComponentIds] = useState([]);
  const [netPositiveId, setNetPositiveId] = useState('');
  const [netNegativeId, setNetNegativeId] = useState('');

  useEffect(() => {
    if (!open) return;
    if (editingRow) {
      setRowType(editingRow.rowType);
      setGroupingId(editingRow.groupingId || '');
      setLabel(editingRow.label || '');
      setComponentIds(editingRow.rowType === 'Total' ? editingRow.componentTempIds || [] : []);
      setNetPositiveId(editingRow.rowType === 'Net' ? editingRow.componentTempIds?.[0] || '' : '');
      setNetNegativeId(editingRow.rowType === 'Net' ? editingRow.componentTempIds?.[1] || '' : '');
    } else {
      setRowType('Grouping');
      setGroupingId('');
      setLabel('');
      setComponentIds([]);
      setNetPositiveId('');
      setNetNegativeId('');
    }
  }, [open, editingRow]);

  const selectedGrouping = availableGroupings.find((g) => g.groupingid === groupingId);
  const canSubmit =
    (rowType === 'Grouping' && Boolean(groupingId)) ||
    (rowType === 'Total' && label.trim() && componentIds.length > 0) ||
    (rowType === 'Net' && label.trim() && netPositiveId && netNegativeId && netPositiveId !== netNegativeId);

  const handleSubmit = () => {
    if (!canSubmit) return;
    const tempId = editingRow ? editingRow.tempId : newTempId();
    if (rowType === 'Grouping') {
      onSubmit({ tempId, rowType: 'Grouping', label: label.trim() || selectedGrouping?.groupingname, groupingId });
    } else if (rowType === 'Total') {
      onSubmit({ tempId, rowType: 'Total', label: label.trim(), componentTempIds: componentIds });
    } else {
      onSubmit({ tempId, rowType: 'Net', label: label.trim(), componentTempIds: [netPositiveId, netNegativeId] });
    }
    onClose();
  };

  const toggleComponent = (tempId) => {
    setComponentIds((prev) => (prev.includes(tempId) ? prev.filter((id) => id !== tempId) : [...prev, tempId]));
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{editingRow ? 'Edit Row' : 'Add Row'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={rowType}
          onChange={(e, v) => v && setRowType(v)}
          disabled={Boolean(editingRow)}
        >
          <ToggleButton value="Grouping">Grouping</ToggleButton>
          <ToggleButton value="Total">Total</ToggleButton>
          <ToggleButton value="Net">Net</ToggleButton>
        </ToggleButtonGroup>

        {rowType === 'Grouping' && (
          <>
            <Select size="small" displayEmpty value={groupingId} onChange={(e) => setGroupingId(e.target.value)}>
              <MenuItem value="" disabled>
                Select a Grouping
              </MenuItem>
              {availableGroupings.map((g) => (
                <MenuItem key={g.groupingid} value={g.groupingid}>
                  {g.groupingname}
                  {g.accounttype ? ` (${g.accounttype === 'PL' ? 'P&L' : 'Balance Sheet'})` : ''}
                </MenuItem>
              ))}
              {availableGroupings.length === 0 && (
                <MenuItem value="" disabled>
                  No unused Groupings left
                </MenuItem>
              )}
            </Select>
            <TextField
              size="small"
              label="Label (optional override)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={selectedGrouping?.groupingname || ''}
            />
          </>
        )}

        {(rowType === 'Total' || rowType === 'Net') && (
          <TextField
            size="small"
            label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={rowType === 'Total' ? 'e.g. Team Expense' : 'e.g. Net Income'}
          />
        )}

        {rowType === 'Total' && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Include:
            </Typography>
            {earlierRows.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No earlier rows yet — add a Grouping first.
              </Typography>
            )}
            {earlierRows.map((r) => (
              <FormControlLabel
                key={r.tempId}
                control={
                  <Checkbox size="small" checked={componentIds.includes(r.tempId)} onChange={() => toggleComponent(r.tempId)} />
                }
                label={r.label}
                sx={{ display: 'block' }}
              />
            ))}
          </Box>
        )}

        {rowType === 'Net' && (
          <>
            <Select size="small" displayEmpty value={netPositiveId} onChange={(e) => setNetPositiveId(e.target.value)}>
              <MenuItem value="" disabled>
                First row (positive)
              </MenuItem>
              {earlierRows.map((r) => (
                <MenuItem key={r.tempId} value={r.tempId}>
                  {r.label}
                </MenuItem>
              ))}
            </Select>
            <Select size="small" displayEmpty value={netNegativeId} onChange={(e) => setNetNegativeId(e.target.value)}>
              <MenuItem value="" disabled>
                Minus this row
              </MenuItem>
              {earlierRows.map((r) => (
                <MenuItem key={r.tempId} value={r.tempId}>
                  {r.label}
                </MenuItem>
              ))}
            </Select>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!canSubmit} onClick={handleSubmit}>
          {editingRow ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ReportLayout() {
  const { groupId } = useAuth();
  const [statement, setStatement] = useState('PL');
  const [rows, setRows] = useState([]);
  const [groupings, setGroupings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);

  const refresh = () => {
    if (!groupId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      getReportLayout(groupId, statement),
      Promise.all(accountTypesFor(statement).map((t) => listAccountGroupings(groupId, t))),
    ])
      .then(([layout, groupingLists]) => {
        setRows(
          (layout.rows || []).map((r) => ({
            tempId: r.rowId,
            rowType: r.rowType,
            label: r.label,
            groupingId: r.groupingId,
            isSystemRow: r.isSystemRow,
            isRevenueBase: r.isRevenueBase,
            componentTempIds: r.componentRowIds || [],
          }))
        );
        setGroupings(groupingLists.flat());
      })
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(refresh, [groupId, statement]);

  const usedGroupingIds = new Set(rows.filter((r) => r.rowType === 'Grouping' && r.groupingId).map((r) => r.groupingId));
  const availableGroupings = groupings.filter((g) => !usedGroupingIds.has(g.groupingid));

  const canMoveUp = (index) => index > 0 && !rows[index].componentTempIds?.includes(rows[index - 1].tempId);
  const canMoveDown = (index) =>
    index < rows.length - 1 && !rows[index + 1].componentTempIds?.includes(rows[index].tempId);

  const moveRow = (index, direction) => {
    setRows((prev) => {
      const next = [...prev];
      const swapIndex = index + direction;
      [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
      return next;
    });
  };

  const isReferencedByLater = (tempId, index) => rows.slice(index + 1).some((r) => r.componentTempIds?.includes(tempId));

  const deleteRow = (index) => {
    const row = rows[index];
    if (row.isSystemRow) return;
    if (isReferencedByLater(row.tempId, index)) {
      setError(new Error(`"${row.label}" is used by a later Total/Net row — remove that row first.`));
      return;
    }
    setError(null);
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const toggleRevenueBase = (tempId) => {
    setRows((prev) => prev.map((r) => ({ ...r, isRevenueBase: r.tempId === tempId ? !r.isRevenueBase : false })));
  };

  const openAddDialog = () => {
    setEditingIndex(null);
    setDialogOpen(true);
  };

  const openEditDialog = (index) => {
    setEditingIndex(index);
    setDialogOpen(true);
  };

  const handleDialogSubmit = (rowData) => {
    if (editingIndex !== null) {
      setRows((prev) => prev.map((r, i) => (i === editingIndex ? rowData : r)));
    } else {
      setRows((prev) => [...prev, rowData]);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await saveReportLayout(groupId, statement, rows);
      setMessage('Report Layout saved.');
      refresh();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const editingRow = editingIndex !== null ? rows[editingIndex] : null;
  const earlierRowsForDialog = editingIndex !== null ? rows.slice(0, editingIndex) : rows;

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Report Layout
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Set the order and subtotals for each financial statement. Build rows top to bottom: a Grouping sums its
        assigned accounts, a Total sums one or more earlier rows, and a Net subtracts one earlier row from another.
      </Typography>

      <ToggleButtonGroup
        size="small"
        exclusive
        value={statement}
        onChange={(e, v) => v && setStatement(v)}
        sx={{ mb: 2 }}
      >
        {STATEMENTS.map((s) => (
          <ToggleButton key={s.value} value={s.value}>
            {s.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {message && <Alert severity="success" sx={{ mb: 2 }}>{message}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error.response?.data?.message || error.message}</Alert>}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Type</TableCell>
              <TableCell>Label</TableCell>
              <TableCell>Includes</TableCell>
              {statement === 'PL' && <TableCell>Revenue base</TableCell>}
              <TableCell align="right">Order</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={row.tempId}>
                <TableCell>
                  <Chip size="small" label={row.rowType} />
                </TableCell>
                <TableCell>
                  {row.label}
                  {row.isSystemRow ? ' (system)' : ''}
                </TableCell>
                <TableCell>
                  {row.componentTempIds?.length
                    ? row.componentTempIds
                        .map((id) => rows.find((r) => r.tempId === id)?.label || '?')
                        .join(row.rowType === 'Net' ? ' − ' : ' + ')
                    : '—'}
                </TableCell>
                {statement === 'PL' && (
                  <TableCell>
                    {row.rowType === 'Grouping' && (
                      <IconButton size="small" onClick={() => toggleRevenueBase(row.tempId)}>
                        {row.isRevenueBase ? (
                          <StarIcon fontSize="small" color="warning" />
                        ) : (
                          <StarBorderIcon fontSize="small" />
                        )}
                      </IconButton>
                    )}
                  </TableCell>
                )}
                <TableCell align="right">
                  {row.rowType !== 'Grouping' && (
                    <IconButton size="small" onClick={() => openEditDialog(index)}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  )}
                  <IconButton size="small" disabled={!canMoveUp(index)} onClick={() => moveRow(index, -1)}>
                    <ArrowUpwardIcon fontSize="small" />
                  </IconButton>
                  <IconButton size="small" disabled={!canMoveDown(index)} onClick={() => moveRow(index, 1)}>
                    <ArrowDownwardIcon fontSize="small" />
                  </IconButton>
                  <IconButton size="small" disabled={row.isSystemRow} onClick={() => deleteRow(index)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={5}>No rows configured yet — add one below.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
        <Button variant="outlined" onClick={openAddDialog}>
          + Add Row
        </Button>
        <Button variant="contained" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </Box>

      <RowDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        availableGroupings={availableGroupings}
        earlierRows={earlierRowsForDialog}
        editingRow={editingRow}
        onSubmit={handleDialogSubmit}
      />
    </Box>
  );
}

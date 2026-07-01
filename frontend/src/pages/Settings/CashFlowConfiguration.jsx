import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
  Select,
  MenuItem,
  Button,
  Alert,
  Chip,
} from '@mui/material';
import { useAuth } from '../../context/AuthContext';
import { listCashFlowMappings, saveCashFlowMappings } from '../../api/settings';

const CATEGORIES = ['Operations', 'Investing', 'Financing'];

export default function CashFlowConfiguration() {
  const { groupId } = useAuth();
  const [rows, setRows] = useState([]);
  const [pending, setPending] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const refresh = () => {
    if (!groupId) return;
    listCashFlowMappings(groupId).then(setRows).catch(setError);
    setPending({});
  };

  useEffect(refresh, [groupId]);

  const currentCategory = (row) =>
    Object.prototype.hasOwnProperty.call(pending, row.groupingid)
      ? pending[row.groupingid]
      : row.cashflowcategory;

  const handleChange = (row, value) => {
    setPending((prev) => ({ ...prev, [row.groupingid]: value || null }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const mappings = Object.entries(pending).map(([groupingId, cashFlowCategory]) => ({
        groupingId,
        cashFlowCategory,
      }));
      await saveCashFlowMappings(groupId, mappings);
      setMessage(`Saved ${mappings.length} mapping(s).`);
      refresh();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const dirtyCount = Object.keys(pending).length;

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Cash Flow Configuration
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Assign each Grouping to the Cash Flow section it should contribute to.
      </Typography>

      {message && <Alert severity="success" sx={{ mb: 2 }}>{message}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error.response?.data?.message || error.message}</Alert>}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Grouping</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Cash Flow Category</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.groupingid}>
                <TableCell>{row.groupingname}</TableCell>
                <TableCell>
                  <Chip size="small" label={row.accounttype === 'PL' ? 'P&L' : 'Balance Sheet'} />
                </TableCell>
                <TableCell sx={{ minWidth: 200 }}>
                  <Select
                    size="small"
                    fullWidth
                    displayEmpty
                    value={currentCategory(row) || ''}
                    onChange={(e) => handleChange(row, e.target.value)}
                  >
                    <MenuItem value="">
                      <em>Unassigned</em>
                    </MenuItem>
                    {CATEGORIES.map((c) => (
                      <MenuItem key={c} value={c}>
                        {c}
                      </MenuItem>
                    ))}
                  </Select>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>No Groupings created yet.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Button variant="contained" sx={{ mt: 2 }} disabled={dirtyCount === 0 || saving} onClick={handleSave}>
        {saving ? 'Saving...' : `Save${dirtyCount ? ` (${dirtyCount} changed)` : ''}`}
      </Button>
    </Box>
  );
}

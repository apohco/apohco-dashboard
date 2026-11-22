import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  Link,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import {
  analyzeControllerUpload,
  createControllerUpload,
  getControllerOverview,
  importControllerUpload,
  listControllerUploads,
  putControllerUploadFile,
} from '../../api/controller';
import { formatMonth, monthsBetween } from '../../utils/months';
import { formatCurrency } from '../../utils/format';

const CLASSIFICATIONS = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];
const MAX_MONTHS = 36;
const MAPPING_SOURCE_TEXT = {
  detected: 'Columns were matched automatically from the headers. Check each one.',
  saved: 'Using the mapping from your last import of a file with these same columns.',
  custom: 'Using your column choices.',
};

const errorText = (err) => err?.response?.data?.message || err?.message;

// First non-blank value under a column, to show next to the mapping.
export function exampleValue(analysis, column) {
  if (column === null || column === undefined) return '';
  for (const row of analysis.rawPreview.slice(analysis.headerRow + 1)) {
    const value = (row[column] || '').trim();
    if (value) return value;
  }
  return '';
}

// Default import period: the first through last month that has lines.
export function defaultPeriod(months) {
  if (!months?.length) return { fromMonth: '', toMonth: '' };
  return { fromMonth: months[0].month, toMonth: months[months.length - 1].month };
}

function ColumnMapping({ analysis, onChange, disabled }) {
  const columnLabel = (i) => `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}: ${analysis.headers[i] || '(blank)'}`;
  const used = new Map(Object.entries(analysis.mapping).filter(([, v]) => v !== null).map(([k, v]) => [v, k]));

  return (
    <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Field</TableCell>
            <TableCell>Column in your file</TableCell>
            <TableCell>Example</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {analysis.fields.map((field) => {
            const value = analysis.mapping[field.key];
            return (
              <TableRow key={field.key}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  {field.label}
                  {field.required && ' *'}
                </TableCell>
                <TableCell>
                  <Select
                    size="small"
                    fullWidth
                    displayEmpty
                    disabled={disabled}
                    value={value === null ? '' : value}
                    onChange={(e) => onChange(field.key, e.target.value === '' ? null : Number(e.target.value))}
                    inputProps={{ 'aria-label': `Column for ${field.label}` }}
                  >
                    <MenuItem value="">
                      <em>{field.key === 'account' ? 'Not in file (use account heading rows)' : 'Not in file'}</em>
                    </MenuItem>
                    {analysis.headers.map((h, i) => (
                      <MenuItem key={i} value={i} disabled={used.has(i) && used.get(i) !== field.key}>
                        {columnLabel(i)}
                      </MenuItem>
                    ))}
                  </Select>
                </TableCell>
                <TableCell sx={{ color: 'text.secondary', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {exampleValue(analysis, value)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function NewAccounts({ accounts, classifications, onChange, disabled }) {
  if (!accounts.length) return null;
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Accounts this QBO file hasn&apos;t classified yet
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        QuickBooks shows Amount as positive when it increases the account, so each account&apos;s type decides
        whether its lines are debits or credits. Suggestions come from the account number; check each one.
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Account</TableCell>
              <TableCell align="right">Lines</TableCell>
              <TableCell>Type</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.accountKey}>
                <TableCell>{[a.accountCode, a.accountName].filter(Boolean).join(' ')}</TableCell>
                <TableCell align="right">{a.lineCount}</TableCell>
                <TableCell>
                  <Select
                    size="small"
                    displayEmpty
                    disabled={disabled}
                    value={classifications[a.accountKey] || ''}
                    onChange={(e) => onChange(a.accountKey, e.target.value)}
                    inputProps={{ 'aria-label': `Type for ${a.accountName || a.accountCode}` }}
                    sx={{ minWidth: 140 }}
                  >
                    <MenuItem value="" disabled>
                      Choose
                    </MenuItem>
                    {CLASSIFICATIONS.map((c) => (
                      <MenuItem key={c} value={c}>
                        {c}
                      </MenuItem>
                    ))}
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

function Summary({ analysis }) {
  const { totals } = analysis;
  const balanced = totals && Math.abs(totals.difference) < 0.005;
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {analysis.lineCount.toLocaleString()} lines ready
        {analysis.errorCount > 0 && ` · ${analysis.errorCount.toLocaleString()} rows with errors (left out)`}
        {analysis.skippedRows > 0 && ` · ${analysis.skippedRows.toLocaleString()} total/heading rows skipped`}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
        {analysis.months.map((m) => (
          <Chip key={m.month} size="small" variant="outlined" label={`${formatMonth(m.month)}: ${m.lineCount.toLocaleString()}`} />
        ))}
      </Box>
      {totals && analysis.lineCount > 0 && (
        <Alert severity={balanced ? 'success' : 'warning'} sx={{ mb: 1 }}>
          Debits {formatCurrency(totals.debit)} · Credits {formatCurrency(totals.credit)}
          {balanced
            ? ' · in balance.'
            : ` · out by ${formatCurrency(Math.abs(totals.difference))}. Fine if the file doesn't include every account; otherwise check the Amount setting and account types.`}
        </Alert>
      )}
      {analysis.errors.length > 0 && (
        <Box>
          {analysis.errors.map((e) => (
            <Typography key={e.row} variant="caption" display="block" color="text.secondary">
              Row {e.row}: {e.errors.join('; ')}
            </Typography>
          ))}
          {analysis.errorCount > analysis.errors.length && (
            <Typography variant="caption" color="text.secondary">
              …and {analysis.errorCount - analysis.errors.length} more
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}

function SampleLines({ lines }) {
  if (!lines.length) return null;
  return (
    <>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        How the first lines will be stored
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Row</TableCell>
              <TableCell>Date</TableCell>
              <TableCell>Account</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Description</TableCell>
              <TableCell>Split</TableCell>
              <TableCell>Class</TableCell>
              <TableCell align="right">Debit</TableCell>
              <TableCell align="right">Credit</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.sourceRow}>
                <TableCell>{l.sourceRow}</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{l.txnDate}</TableCell>
                <TableCell>{[l.accountCode, l.accountName].filter(Boolean).join(' ')}</TableCell>
                <TableCell>{l.txnType}</TableCell>
                <TableCell>{l.payeeName}</TableCell>
                <TableCell sx={{ maxWidth: 220 }}>{l.memo}</TableCell>
                <TableCell>{l.splitAccount}</TableCell>
                <TableCell>{l.className}</TableCell>
                <TableCell align="right">{l.debit ? formatCurrency(l.debit) : ''}</TableCell>
                <TableCell align="right">{l.credit ? formatCurrency(l.credit) : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}

export default function GlUpload() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [qbos, setQbos] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [qboId, setQboId] = useState('');
  const [file, setFile] = useState(null);
  const [uploadId, setUploadId] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [options, setOptions] = useState({ classifications: {} });
  const [newAccounts, setNewAccounts] = useState([]);
  const [period, setPeriod] = useState({ fromMonth: '', toMonth: '' });
  const [busy, setBusy] = useState(null); // 'upload' | 'analyze' | 'import'
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const requestSeq = useRef(0);

  const loadLists = useCallback(async () => {
    if (!groupId) return;
    try {
      const [overview, recent] = await Promise.all([getControllerOverview(groupId), listControllerUploads(groupId)]);
      setQbos(overview.qbos);
      setUploads(recent);
    } catch (err) {
      setError(err);
    }
  }, [groupId]);

  useEffect(() => {
    setQbos([]);
    setQboId('');
    loadLists();
  }, [loadLists]);

  const resetFile = () => {
    setUploadId(null);
    setAnalysis(null);
    setOptions({ classifications: {} });
    setNewAccounts([]);
    setResult(null);
  };

  // Runs analyze with the given options; ignores answers to superseded requests.
  const runAnalyze = async (id, nextOptions, { resetPeriod = false } = {}) => {
    const seq = ++requestSeq.current;
    setBusy('analyze');
    setError(null);
    try {
      const data = await analyzeControllerUpload(groupId, id, nextOptions);
      if (seq !== requestSeq.current) return;
      setAnalysis(data);
      setOptions({ ...nextOptions, headerRow: data.headerRow, mapping: data.mapping, amountConvention: data.amountConvention });
      if (resetPeriod) setPeriod(defaultPeriod(data.months));

      // Pre-fill suggested types for newly seen accounts, then re-check.
      const unseen = data.unknownAccounts.filter((a) => !(a.accountKey in (nextOptions.classifications || {})));
      if (unseen.length) {
        setNewAccounts((prev) => [...prev, ...unseen.filter((a) => !prev.some((p) => p.accountKey === a.accountKey))]);
        const suggested = Object.fromEntries(unseen.filter((a) => a.suggested).map((a) => [a.accountKey, a.suggested]));
        if (Object.keys(suggested).length) {
          runAnalyze(id, { ...nextOptions, mapping: data.mapping, headerRow: data.headerRow, classifications: { ...nextOptions.classifications, ...suggested } }, { resetPeriod });
          return;
        }
      }
    } catch (err) {
      if (seq === requestSeq.current) setError(err);
    } finally {
      if (seq === requestSeq.current) setBusy(null);
    }
  };

  const upload = async () => {
    resetFile();
    setBusy('upload');
    setError(null);
    try {
      const created = await createControllerUpload(groupId, qboId, file.name);
      await putControllerUploadFile(created.uploadUrl, file, created.contentType);
      setUploadId(created.uploadId);
      await runAnalyze(created.uploadId, { classifications: {} }, { resetPeriod: true });
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  const changeMapping = (key, column) => {
    runAnalyze(uploadId, { ...options, mapping: { ...options.mapping, [key]: column } });
  };
  const changeHeaderRow = (rowNumber) => {
    const headerRow = Number(rowNumber) - 1;
    if (!Number.isInteger(headerRow) || headerRow < 0) return;
    // A new header row means new headers: detect the mapping again.
    runAnalyze(uploadId, { classifications: options.classifications, amountConvention: options.amountConvention, headerRow }, { resetPeriod: true });
  };
  const changeConvention = (amountConvention) => runAnalyze(uploadId, { ...options, amountConvention });
  const changeClassification = (key, value) =>
    runAnalyze(uploadId, { ...options, classifications: { ...options.classifications, [key]: value } });

  const periodMonths =
    period.fromMonth && period.toMonth && period.toMonth >= period.fromMonth ? monthsBetween(period.fromMonth, period.toMonth).length : 0;
  const usesAmount = analysis && analysis.mapping.amount !== null && analysis.mapping.debit === null && analysis.mapping.credit === null;
  const canImport =
    analysis &&
    !busy &&
    analysis.problems.length === 0 &&
    analysis.unknownAccounts.length === 0 &&
    analysis.lineCount > 0 &&
    periodMonths > 0 &&
    periodMonths <= MAX_MONTHS;

  const doImport = async () => {
    setBusy('import');
    setError(null);
    try {
      const data = await importControllerUpload(groupId, uploadId, { ...options, ...period });
      setResult(data);
      setAnalysis(null);
      setUploadId(null);
      setFile(null);
      loadLists();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Upload General Ledger
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Upload a General Ledger export (CSV or Excel). Columns are matched by their headers, in any order, and
          each month is stored as a new snapshot beside any earlier pulls or uploads. Nothing is written to
          QuickBooks or to the dashboard&apos;s reports.
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Select
            size="small"
            displayEmpty
            value={qboId}
            disabled={!groupId}
            onChange={(e) => {
              setQboId(e.target.value);
              resetFile();
            }}
            sx={{ minWidth: 240 }}
            inputProps={{ 'aria-label': 'QBO file' }}
          >
            <MenuItem value="" disabled>
              Select a QBO file
            </MenuItem>
            {qbos.map((q) => (
              <MenuItem key={q.qboId} value={q.qboId}>
                {q.qboName}
              </MenuItem>
            ))}
          </Select>
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
            {file ? file.name : 'Choose CSV or Excel file'}
            <input
              type="file"
              accept=".csv,.xlsx"
              hidden
              data-testid="gl-file"
              onChange={(e) => {
                setFile(e.target.files[0] || null);
                resetFile();
              }}
            />
          </Button>
          <Button
            variant="contained"
            disabled={!qboId || !file || Boolean(busy)}
            onClick={upload}
            startIcon={busy === 'upload' ? <CircularProgress size={16} color="inherit" /> : null}
          >
            Upload and match columns
          </Button>
        </Box>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {errorText(error)}
        </Alert>
      )}

      {result && (
        <Alert severity="success" sx={{ mb: 3 }}>
          Stored {result.lineCount.toLocaleString()} lines as {result.snapshots.length} monthly snapshot
          {result.snapshots.length === 1 ? '' : 's'}
          {result.outsideRange > 0 && ` (${result.outsideRange.toLocaleString()} lines outside the chosen months were left out)`}.{' '}
          <Link component={RouterLink} to="/controller">
            See them on the Overview
          </Link>
          .
        </Alert>
      )}

      {analysis && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }} data-testid="analysis">
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
            <Typography variant="h6">Match columns: {analysis.fileName}</Typography>
            {busy === 'analyze' && <CircularProgress size={18} aria-label="Checking" />}
          </Box>
          {analysis.previousImport && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              This exact file was already imported on {new Date(analysis.previousImport.importedDate).toLocaleDateString()}.
              Importing it again adds another identical snapshot.
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {MAPPING_SOURCE_TEXT[analysis.mappingSource]}
          </Typography>

          <TextField
            size="small"
            type="number"
            label="Header row"
            value={analysis.headerRow + 1}
            onChange={(e) => changeHeaderRow(e.target.value)}
            inputProps={{ min: 1 }}
            helperText="The row in the file that holds the column names."
            sx={{ mb: 2, width: 200 }}
          />

          <ColumnMapping analysis={analysis} onChange={changeMapping} disabled={busy === 'import'} />

          {usesAmount && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2">Amount column</Typography>
              <RadioGroup row value={analysis.amountConvention} onChange={(e) => changeConvention(e.target.value)}>
                <FormControlLabel
                  value="natural"
                  control={<Radio size="small" />}
                  label="QuickBooks GL: positive increases the account"
                />
                <FormControlLabel value="debitPositive" control={<Radio size="small" />} label="Positive is a debit" />
              </RadioGroup>
            </Box>
          )}

          {analysis.problems.map((p) => (
            <Alert key={p} severity="error" sx={{ mb: 1 }}>
              {p}
            </Alert>
          ))}

          <NewAccounts
            accounts={newAccounts}
            classifications={options.classifications || {}}
            onChange={changeClassification}
            disabled={busy === 'import'}
          />
          {analysis.problems.length === 0 && <Summary analysis={analysis} />}
          <SampleLines lines={analysis.sample} />

          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
            <TextField
              size="small"
              type="month"
              label="From"
              InputLabelProps={{ shrink: true }}
              value={period.fromMonth}
              onChange={(e) => setPeriod((p) => ({ ...p, fromMonth: e.target.value }))}
            />
            <TextField
              size="small"
              type="month"
              label="To"
              InputLabelProps={{ shrink: true }}
              value={period.toMonth}
              onChange={(e) => setPeriod((p) => ({ ...p, toMonth: e.target.value }))}
            />
            <Button
              variant="contained"
              disabled={!canImport}
              onClick={doImport}
              startIcon={busy === 'import' ? <CircularProgress size={16} color="inherit" /> : null}
            >
              {periodMonths > 1 ? `Import ${periodMonths} months` : 'Import month'}
            </Button>
          </Box>
          {periodMonths > MAX_MONTHS && (
            <Typography variant="caption" color="error">
              An upload can cover at most {MAX_MONTHS} months.
            </Typography>
          )}
          {analysis.unknownAccounts.length > 0 && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              Choose a type for every new account above to import.
            </Typography>
          )}
        </Paper>
      )}

      <Typography variant="h6" sx={{ mb: 1 }}>
        Recent uploads
      </Typography>
      {uploads.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No files imported yet.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Imported</TableCell>
                <TableCell>QBO file</TableCell>
                <TableCell>File</TableCell>
                <TableCell>Months</TableCell>
                <TableCell align="right">Lines</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {uploads.map((u) => (
                <TableRow key={u.uploadId}>
                  <TableCell>{new Date(u.importedDate).toLocaleString()}</TableCell>
                  <TableCell>{u.qboName}</TableCell>
                  <TableCell>{u.fileName}</TableCell>
                  <TableCell>
                    {formatMonth(u.fromMonth)}
                    {u.toMonth !== u.fromMonth ? ` – ${formatMonth(u.toMonth)}` : ''}
                  </TableCell>
                  <TableCell align="right">{(u.lineCount || 0).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}

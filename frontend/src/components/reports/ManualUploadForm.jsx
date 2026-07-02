import { useState } from 'react';
import {
  Box,
  Typography,
  Select,
  MenuItem,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  presignManualUpload,
  uploadFileToS3,
  previewManualUpload,
  confirmManualUpload,
} from '../../api/settings';

const PREVIEW_COLUMNS = [
  'transactionDate',
  'accountCode',
  'accountName',
  'debit',
  'credit',
  'amount',
  'className',
];

export default function ManualUploadForm({ qbos, startDate, endDate, onStartDateChange, onEndDateChange }) {
  const [qboId, setQboId] = useState('');
  const [file, setFile] = useState(null);
  const [s3Key, setS3Key] = useState(null);
  const [preview, setPreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const reset = () => {
    setS3Key(null);
    setPreview(null);
    setResult(null);
  };

  const handleUpload = async () => {
    setUploading(true);
    setError(null);
    reset();
    try {
      const { uploadUrl, s3Key: key, contentType } = await presignManualUpload(qboId, file.name);
      await uploadFileToS3(uploadUrl, file, contentType);
      const previewData = await previewManualUpload(qboId, key);
      setS3Key(key);
      setPreview(previewData);
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setError(null);
    try {
      const data = await confirmManualUpload(qboId, s3Key, startDate, endDate);
      setResult(data);
      setPreview(null);
      setS3Key(null);
      setFile(null);
    } catch (err) {
      setError(err);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Upload a CSV or Excel export and import it directly into RawTransactions for the selected
        QBO and date range, overwriting any existing data for that range — same overwrite behavior
        as an API sync.
      </Typography>

      <Select
        fullWidth
        size="small"
        displayEmpty
        value={qboId}
        onChange={(e) => {
          setQboId(e.target.value);
          reset();
        }}
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

      <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} sx={{ mb: 2 }}>
        {file ? file.name : 'Choose CSV or Excel file'}
        <input
          type="file"
          accept=".csv,.xlsx"
          hidden
          onChange={(e) => {
            setFile(e.target.files[0] || null);
            reset();
          }}
        />
      </Button>

      <Box>
        <Button
          variant="contained"
          disabled={!qboId || !file || uploading}
          onClick={handleUpload}
          startIcon={uploading ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {uploading ? 'Uploading & Parsing...' : 'Upload and Parse'}
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error.response?.data?.message || error.message}
        </Alert>
      )}

      {preview && (
        <Box sx={{ mt: 3 }}>
          <Alert severity={preview.errorCount > 0 ? 'warning' : 'info'} sx={{ mb: 2 }}>
            Parsed {preview.totalRows} row(s): {preview.validRows} valid, {preview.errorCount} with
            errors (errors are skipped, not imported).
          </Alert>

          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Preview (first {preview.previewRows.length} rows)
          </Typography>
          <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {PREVIEW_COLUMNS.map((col) => (
                    <TableCell key={col}>{col}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {preview.previewRows.map((row, i) => (
                  <TableRow key={i}>
                    {PREVIEW_COLUMNS.map((col) => (
                      <TableCell key={col}>{row[col] ?? ''}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {preview.errors.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" color="error" sx={{ mb: 1 }}>
                Row errors (showing first {preview.errors.length} of {preview.errorCount})
              </Typography>
              {preview.errors.map((e) => (
                <Typography key={e.row} variant="caption" display="block" color="text.secondary">
                  Row {e.row}: {e.errors.join('; ')}
                </Typography>
              ))}
            </Box>
          )}

          <Button
            variant="contained"
            color="primary"
            disabled={confirming || preview.validRows === 0}
            onClick={handleConfirm}
            startIcon={confirming ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {confirming ? 'Importing...' : `Confirm Import (${preview.validRows} rows)`}
          </Button>
        </Box>
      )}

      {result && (
        <Alert severity="success" sx={{ mt: 2 }}>
          Imported {result.rowsImported} transaction(s) for {result.dateRange.startDate} –{' '}
          {result.dateRange.endDate}
          {result.rowsSkipped > 0 ? ` (${result.rowsSkipped} row(s) skipped due to errors)` : ''}.
        </Alert>
      )}
    </Box>
  );
}

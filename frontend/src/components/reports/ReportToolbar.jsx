import {
  Box,
  ToggleButton,
  ToggleButtonGroup,
  Select,
  MenuItem,
  Typography,
  Paper,
} from '@mui/material';

// Shared toolbar for P&L / Balance Sheet / Cash Flow reports: view mode
// (Single Month / Multi-Month / Compare), entity selector (QBO or
// Consolidation Group), and Detail/Summary toggle. Data wiring comes once
// the reports API exists (Phase 3).
export default function ReportToolbar({
  viewMode,
  onViewModeChange,
  entity,
  onEntityChange,
  entityOptions = [],
  detailLevel,
  onDetailLevelChange,
  lastSynced,
  extraControls,
}) {
  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, mb: 2, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}
    >
      <ToggleButtonGroup
        size="small"
        exclusive
        value={viewMode}
        onChange={(e, v) => v && onViewModeChange(v)}
      >
        <ToggleButton value="single">Single Month</ToggleButton>
        <ToggleButton value="multi">Multi-Month</ToggleButton>
        <ToggleButton value="compare">Compare</ToggleButton>
      </ToggleButtonGroup>

      <Select size="small" value={entity ?? ''} onChange={(e) => onEntityChange(e.target.value)} displayEmpty>
        <MenuItem value="" disabled>
          Select QBO or Consolidation Group
        </MenuItem>
        {entityOptions.map((opt) => (
          <MenuItem key={opt.id} value={opt.id}>
            {opt.label}
          </MenuItem>
        ))}
      </Select>

      <ToggleButtonGroup
        size="small"
        exclusive
        value={detailLevel}
        onChange={(e, v) => v && onDetailLevelChange(v)}
      >
        <ToggleButton value="summary">Summary</ToggleButton>
        <ToggleButton value="detail">Detail</ToggleButton>
      </ToggleButtonGroup>

      {extraControls}

      <Box sx={{ ml: 'auto' }}>
        <Typography variant="caption" color="text.secondary">
          Last Synced: {lastSynced ?? '—'}
        </Typography>
      </Box>
    </Paper>
  );
}

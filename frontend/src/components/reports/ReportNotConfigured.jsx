import { Box, Typography, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';

// Shown when a Statement's Report Layout hasn't been set up yet (see
// reportHelpers.getReportLayout / evaluateReportLayout on the backend --
// `configured: false` means no ReportLayoutRows exist for this Group +
// Statement). Distinct from the "no synced data yet" empty state, which
// only applies once a layout exists.
export default function ReportNotConfigured({ statementLabel }) {
  const navigate = useNavigate();
  return (
    <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
      <Typography variant="body1" sx={{ mb: 2 }}>
        {statementLabel}'s Report Layout hasn't been configured yet.
      </Typography>
      <Button variant="outlined" onClick={() => navigate('/settings/report-layout')}>
        Go to Settings &gt; Report Layout
      </Button>
    </Box>
  );
}

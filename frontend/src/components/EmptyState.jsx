import { Box, Typography, Button } from '@mui/material';
import SyncOutlinedIcon from '@mui/icons-material/SyncOutlined';

export default function EmptyState({ message = 'No data available for this period.', onSync }) {
  return (
    <Box
      sx={{
        textAlign: 'center',
        py: 8,
        color: 'text.secondary',
      }}
    >
      <Typography variant="body1" sx={{ mb: 2 }}>
        {message}
      </Typography>
      <Button variant="outlined" startIcon={<SyncOutlinedIcon />} onClick={onSync}>
        Run QBO Data Sync
      </Button>
    </Box>
  );
}

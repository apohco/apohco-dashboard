import { Box, Typography, List, ListItemButton, ListItemText, Paper } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const settingsSections = [
  { label: 'Manage Groups', path: '/settings/groups', roles: ['SoftwareAdmin'] },
  { label: 'QBO API Setup', path: '/settings/qbo-setup', roles: ['SoftwareAdmin', 'SoftwareRep'] },
  { label: 'Chart of Accounts', path: '/settings/chart-of-accounts', roles: ['Owner', 'Manager'] },
  { label: 'Consolidation Groups', path: '/settings/consolidation-groups', roles: ['Owner', 'Manager'] },
  { label: 'QBO Data Sync', path: '/settings/qbo-data-sync', roles: ['Owner', 'Manager', 'SoftwareRep', 'SoftwareAdmin'] },
  { label: 'Report Layout', path: '/settings/report-layout', roles: ['Owner', 'Manager'] },
];

export default function SettingsHome() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const visibleSections = settingsSections.filter((section) => section.roles.includes(role));

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Settings
      </Typography>
      <Paper variant="outlined">
        <List dense>
          {visibleSections.map((section) => (
            <ListItemButton key={section.path} onClick={() => navigate(section.path)}>
              <ListItemText primary={section.label} />
            </ListItemButton>
          ))}
          {visibleSections.length === 0 && (
            <ListItemButton disabled>
              <ListItemText secondary="No settings available for your role." />
            </ListItemButton>
          )}
        </List>
      </Paper>
    </Box>
  );
}

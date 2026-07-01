import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Menu,
  MenuItem,
  Avatar,
  Box,
  Divider,
} from '@mui/material';
import { useAuth } from '../../context/AuthContext';

export default function Header() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [anchorEl, setAnchorEl] = useState(null);

  const initials = user?.username ? user.username.slice(0, 2).toUpperCase() : 'U';

  return (
    <AppBar
      position="fixed"
      color="inherit"
      elevation={0}
      sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, borderBottom: '1px solid #E3E5E8' }}
    >
      <Toolbar sx={{ justifyContent: 'space-between' }}>
        <Typography variant="h6" sx={{ color: 'primary.main', fontWeight: 700 }}>
          APOHCO
        </Typography>
        <Box>
          <IconButton onClick={(e) => setAnchorEl(e.currentTarget)} size="small">
            <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 14 }}>
              {initials}
            </Avatar>
          </IconButton>
          <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
            <MenuItem
              onClick={() => {
                setAnchorEl(null);
                navigate('/settings');
              }}
            >
              Settings
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={async () => {
                setAnchorEl(null);
                await signOut();
                navigate('/login');
              }}
            >
              Logout
            </MenuItem>
          </Menu>
        </Box>
      </Toolbar>
    </AppBar>
  );
}

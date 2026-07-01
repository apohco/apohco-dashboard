import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Collapse,
  Toolbar,
  Box,
} from '@mui/material';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import AssessmentOutlinedIcon from '@mui/icons-material/AssessmentOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined';
import SwapVertOutlinedIcon from '@mui/icons-material/SwapVertOutlined';

export const SIDEBAR_WIDTH = 240;

const financialItems = [
  { label: 'Profit & Loss', path: '/financial/profit-and-loss', icon: <DescriptionOutlinedIcon fontSize="small" /> },
  { label: 'Balance Sheet', path: '/financial/balance-sheet', icon: <AccountBalanceOutlinedIcon fontSize="small" /> },
  { label: 'Cash Flow', path: '/financial/cash-flow', icon: <SwapVertOutlinedIcon fontSize="small" /> },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [financialOpen, setFinancialOpen] = useState(true);

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        [`& .MuiDrawer-paper`]: {
          width: SIDEBAR_WIDTH,
          boxSizing: 'border-box',
          borderRight: '1px solid #E3E5E8',
          backgroundColor: '#FFFFFF',
        },
      }}
    >
      <Toolbar />
      <Box sx={{ overflow: 'auto', py: 1 }}>
        <List component="nav" dense>
          <ListItemButton onClick={() => setFinancialOpen((v) => !v)}>
            <ListItemIcon sx={{ minWidth: 32 }}>
              <AssessmentOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Financial" />
            {financialOpen ? <ExpandLess /> : <ExpandMore />}
          </ListItemButton>
          <Collapse in={financialOpen} timeout="auto" unmountOnExit>
            <List component="div" disablePadding dense>
              {financialItems.map((item) => (
                <ListItemButton
                  key={item.path}
                  selected={location.pathname === item.path}
                  onClick={() => navigate(item.path)}
                  sx={{ pl: 4 }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}>{item.icon}</ListItemIcon>
                  <ListItemText primary={item.label} />
                </ListItemButton>
              ))}
            </List>
          </Collapse>
        </List>
      </Box>
    </Drawer>
  );
}

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
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import ApartmentOutlinedIcon from '@mui/icons-material/ApartmentOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import { useAuth } from '../../context/AuthContext';

export const SIDEBAR_WIDTH = 240;

const financialItems = [
  { label: 'Profit & Loss', path: '/financial/profit-and-loss', icon: <DescriptionOutlinedIcon fontSize="small" /> },
  { label: 'Balance Sheet', path: '/financial/balance-sheet', icon: <AccountBalanceOutlinedIcon fontSize="small" /> },
  { label: 'Cash Flow', path: '/financial/cash-flow', icon: <SwapVertOutlinedIcon fontSize="small" /> },
];

// Shown only to the ControllerOwner (the API enforces the same rule).
const controllerItems = [
  { label: 'Overview', path: '/controller', icon: <DashboardOutlinedIcon fontSize="small" /> },
  { label: 'Ledger Browser', path: '/controller/ledger', icon: <ListAltOutlinedIcon fontSize="small" /> },
  { label: 'Upload GL', path: '/controller/upload', icon: <UploadFileOutlinedIcon fontSize="small" /> },
  { label: 'Review', path: '/controller/review', icon: <RuleOutlinedIcon fontSize="small" /> },
  { label: 'Vendors', path: '/controller/vendors', icon: <StorefrontOutlinedIcon fontSize="small" /> },
  { label: 'Entities', path: '/controller/entities', icon: <ApartmentOutlinedIcon fontSize="small" /> },
];

function NavSection({ label, icon, items, open, onToggle }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <ListItemButton onClick={onToggle}>
        <ListItemIcon sx={{ minWidth: 32 }}>{icon}</ListItemIcon>
        <ListItemText primary={label} />
        {open ? <ExpandLess /> : <ExpandMore />}
      </ListItemButton>
      <Collapse in={open} timeout="auto" unmountOnExit>
        <List component="div" disablePadding dense>
          {items.map((item) => (
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
    </>
  );
}

export default function Sidebar() {
  const { isControllerOwner } = useAuth();
  const [financialOpen, setFinancialOpen] = useState(true);
  const [controllerOpen, setControllerOpen] = useState(true);

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
          <NavSection
            label="Financial"
            icon={<AssessmentOutlinedIcon fontSize="small" />}
            items={financialItems}
            open={financialOpen}
            onToggle={() => setFinancialOpen((v) => !v)}
          />
          {isControllerOwner && (
            <NavSection
              label="Controller"
              icon={<FactCheckOutlinedIcon fontSize="small" />}
              items={controllerItems}
              open={controllerOpen}
              onToggle={() => setControllerOpen((v) => !v)}
            />
          )}
        </List>
      </Box>
    </Drawer>
  );
}

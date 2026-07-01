import { createTheme } from '@mui/material/styles';

// Palette modeled after the QuickBooks Online aesthetic:
// QBO green accent, white surfaces, dark slate text, light sidebar.
const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#2CA01C',
      dark: '#1B7A0F',
      light: '#4CB83F',
      contrastText: '#FFFFFF',
    },
    secondary: {
      main: '#0077C5',
    },
    background: {
      default: '#F5F6F8',
      paper: '#FFFFFF',
    },
    text: {
      primary: '#393A3D',
      secondary: '#6B6C72',
    },
    divider: '#E3E5E8',
  },
  typography: {
    fontFamily: [
      'Avenir Next',
      'Helvetica Neue',
      'Segoe UI',
      'Roboto',
      'Arial',
      'sans-serif',
    ].join(','),
    fontSize: 13,
    h1: { fontSize: '1.75rem', fontWeight: 600 },
    h2: { fontSize: '1.5rem', fontWeight: 600 },
    h6: { fontSize: '1rem', fontWeight: 600 },
    body1: { fontSize: '0.875rem' },
    body2: { fontSize: '0.8125rem' },
  },
  shape: {
    borderRadius: 4,
  },
  components: {
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderColor: '#E3E5E8',
        },
      },
    },
  },
});

export default theme;

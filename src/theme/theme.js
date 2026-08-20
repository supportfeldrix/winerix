import { createTheme, alpha } from '@mui/material/styles';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Design System
// Premium vineyard-management platform theme
// ─────────────────────────────────────────────────────────────────────────────

// Brand Colours
const vineyard = {
  green: '#1B4D3E',
  greenLight: '#2A6B56',
  greenDark: '#123529',
  red: '#7A122B',
  redLight: '#9B1E3C',
  redDark: '#5C0D20',
  gold: '#D4AF37',
  goldLight: '#E2C766',
  goldDark: '#A8882C',
  cream: '#F8F6F1',
  creamDark: '#F0EDE5',
  white: '#FFFFFF',
  charcoal: '#2C2C2C',
  charcoalLight: '#5A5A5A',
  charcoalMuted: '#8A8A8A',
};

// Status Colours
const status = {
  success: '#2E7D4A',
  warning: '#D4890A',
  error: '#C62828',
  info: '#1B4D3E',
};

const theme = createTheme({
  // ─── Palette ────────────────────────────────────────────────────────────────
  palette: {
    mode: 'light',
    primary: {
      main: vineyard.green,
      light: vineyard.greenLight,
      dark: vineyard.greenDark,
      contrastText: '#FFFFFF',
    },
    secondary: {
      main: vineyard.red,
      light: vineyard.redLight,
      dark: vineyard.redDark,
      contrastText: '#FFFFFF',
    },
    accent: {
      main: vineyard.gold,
      light: vineyard.goldLight,
      dark: vineyard.goldDark,
      contrastText: '#2C2C2C',
    },
    background: {
      default: vineyard.cream,
      paper: vineyard.white,
      subtle: vineyard.creamDark,
    },
    text: {
      primary: vineyard.charcoal,
      secondary: vineyard.charcoalLight,
      disabled: vineyard.charcoalMuted,
    },
    success: {
      main: status.success,
      contrastText: '#FFFFFF',
    },
    warning: {
      main: status.warning,
      contrastText: '#FFFFFF',
    },
    error: {
      main: status.error,
      contrastText: '#FFFFFF',
    },
    info: {
      main: status.info,
      contrastText: '#FFFFFF',
    },
    divider: alpha(vineyard.charcoal, 0.1),
  },

  // ─── Typography ─────────────────────────────────────────────────────────────
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica Neue", Arial, sans-serif',
    h1: {
      fontFamily: '"Playfair Display", Georgia, serif',
      fontWeight: 700,
      fontSize: '2.25rem',
      lineHeight: 1.2,
      letterSpacing: '-0.01em',
      color: vineyard.charcoal,
    },
    h2: {
      fontFamily: '"Playfair Display", Georgia, serif',
      fontWeight: 600,
      fontSize: '1.875rem',
      lineHeight: 1.25,
      letterSpacing: '-0.005em',
      color: vineyard.charcoal,
    },
    h3: {
      fontFamily: '"Playfair Display", Georgia, serif',
      fontWeight: 600,
      fontSize: '1.5rem',
      lineHeight: 1.3,
      color: vineyard.charcoal,
    },
    h4: {
      fontFamily: '"Playfair Display", Georgia, serif',
      fontWeight: 600,
      fontSize: '1.25rem',
      lineHeight: 1.35,
      color: vineyard.charcoal,
    },
    h5: {
      fontFamily: '"Inter", "Roboto", "Helvetica Neue", Arial, sans-serif',
      fontWeight: 600,
      fontSize: '1.1rem',
      lineHeight: 1.4,
      color: vineyard.charcoal,
    },
    h6: {
      fontFamily: '"Inter", "Roboto", "Helvetica Neue", Arial, sans-serif',
      fontWeight: 600,
      fontSize: '1rem',
      lineHeight: 1.4,
      color: vineyard.charcoal,
    },
    subtitle1: {
      fontWeight: 500,
      fontSize: '1rem',
      lineHeight: 1.5,
      color: vineyard.charcoalLight,
    },
    subtitle2: {
      fontWeight: 500,
      fontSize: '0.875rem',
      lineHeight: 1.5,
      color: vineyard.charcoalLight,
    },
    body1: {
      fontSize: '0.9375rem',
      lineHeight: 1.6,
      color: vineyard.charcoal,
    },
    body2: {
      fontSize: '0.8125rem',
      lineHeight: 1.5,
      color: vineyard.charcoalLight,
    },
    button: {
      fontWeight: 600,
      fontSize: '0.875rem',
      textTransform: 'none',
      letterSpacing: '0.02em',
    },
    caption: {
      fontSize: '0.75rem',
      lineHeight: 1.4,
      color: vineyard.charcoalMuted,
      letterSpacing: '0.01em',
    },
    overline: {
      fontSize: '0.6875rem',
      fontWeight: 600,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: vineyard.charcoalMuted,
    },
  },

  // ─── Shape ──────────────────────────────────────────────────────────────────
  shape: {
    borderRadius: 8,
  },

  // ─── Shadows ────────────────────────────────────────────────────────────────
  shadows: [
    'none',
    '0px 1px 3px rgba(44, 44, 44, 0.04), 0px 1px 2px rgba(44, 44, 44, 0.06)',
    '0px 2px 4px rgba(44, 44, 44, 0.04), 0px 1px 3px rgba(44, 44, 44, 0.08)',
    '0px 4px 8px rgba(44, 44, 44, 0.04), 0px 2px 4px rgba(44, 44, 44, 0.06)',
    '0px 6px 12px rgba(44, 44, 44, 0.05), 0px 3px 6px rgba(44, 44, 44, 0.06)',
    '0px 8px 16px rgba(44, 44, 44, 0.05), 0px 4px 8px rgba(44, 44, 44, 0.06)',
    '0px 12px 24px rgba(44, 44, 44, 0.06), 0px 6px 12px rgba(44, 44, 44, 0.05)',
    '0px 16px 32px rgba(44, 44, 44, 0.06), 0px 8px 16px rgba(44, 44, 44, 0.04)',
    '0px 20px 40px rgba(44, 44, 44, 0.07), 0px 10px 20px rgba(44, 44, 44, 0.05)',
    ...Array(16).fill('0px 20px 40px rgba(44, 44, 44, 0.07), 0px 10px 20px rgba(44, 44, 44, 0.05)'),
  ],

  // ─── Breakpoints ────────────────────────────────────────────────────────────
  breakpoints: {
    values: {
      xs: 0,
      sm: 600,
      md: 900,
      lg: 1200,
      xl: 1536,
    },
  },

  // ─── Component Overrides ────────────────────────────────────────────────────
  components: {
    // CssBaseline
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: vineyard.cream,
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
        },
        '::selection': {
          backgroundColor: alpha(vineyard.green, 0.15),
          color: vineyard.charcoal,
        },
      },
    },

    // Buttons
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          borderRadius: 6,
          padding: '10px 20px',
          fontWeight: 600,
          minHeight: 42,
        },
        containedPrimary: {
          backgroundColor: vineyard.green,
          '&:hover': {
            backgroundColor: vineyard.greenLight,
          },
        },
        containedSecondary: {
          backgroundColor: vineyard.red,
          '&:hover': {
            backgroundColor: vineyard.redLight,
          },
        },
        outlinedPrimary: {
          borderColor: vineyard.green,
          color: vineyard.green,
          '&:hover': {
            backgroundColor: alpha(vineyard.green, 0.05),
            borderColor: vineyard.greenLight,
          },
        },
        outlinedSecondary: {
          borderColor: vineyard.red,
          color: vineyard.red,
          '&:hover': {
            backgroundColor: alpha(vineyard.red, 0.05),
            borderColor: vineyard.redLight,
          },
        },
        textPrimary: {
          color: vineyard.green,
          '&:hover': {
            backgroundColor: alpha(vineyard.green, 0.05),
          },
        },
        sizeSmall: {
          padding: '6px 14px',
          fontSize: '0.8125rem',
          minHeight: 34,
        },
        sizeLarge: {
          padding: '12px 28px',
          fontSize: '0.9375rem',
          minHeight: 48,
        },
      },
    },

    // Icon Buttons
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          '&:hover': {
            backgroundColor: alpha(vineyard.green, 0.06),
          },
        },
      },
    },

    // Cards
    MuiCard: {
      defaultProps: {
        elevation: 1,
      },
      styleOverrides: {
        root: {
          borderRadius: 10,
          border: `1px solid ${alpha(vineyard.charcoal, 0.06)}`,
          transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
          '&:hover': {
            borderColor: alpha(vineyard.charcoal, 0.12),
          },
        },
      },
    },

    MuiCardHeader: {
      styleOverrides: {
        root: {
          padding: '16px 20px 8px',
        },
        title: {
          fontSize: '1rem',
          fontWeight: 600,
        },
        subheader: {
          fontSize: '0.8125rem',
          color: vineyard.charcoalLight,
        },
      },
    },

    MuiCardContent: {
      styleOverrides: {
        root: {
          padding: '12px 20px 20px',
          '&:last-child': {
            paddingBottom: 20,
          },
        },
      },
    },

    // Paper
    MuiPaper: {
      defaultProps: {
        elevation: 1,
      },
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
        rounded: {
          borderRadius: 10,
        },
      },
    },

    // AppBar
    MuiAppBar: {
      defaultProps: {
        elevation: 0,
      },
      styleOverrides: {
        root: {
          backgroundColor: vineyard.white,
          color: vineyard.charcoal,
          borderBottom: `1px solid ${alpha(vineyard.charcoal, 0.08)}`,
        },
      },
    },

    // Toolbar
    MuiToolbar: {
      styleOverrides: {
        root: {
          minHeight: '56px !important',
          '@media (min-width: 600px)': {
            minHeight: '64px !important',
          },
        },
      },
    },

    // Drawer
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: vineyard.white,
          borderRight: `1px solid ${alpha(vineyard.charcoal, 0.08)}`,
        },
      },
    },

    // Text Fields / Inputs
    MuiTextField: {
      defaultProps: {
        variant: 'outlined',
        size: 'small',
      },
    },

    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: alpha(vineyard.green, 0.4),
          },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: vineyard.green,
            borderWidth: '2px',
          },
        },
        notchedOutline: {
          borderColor: alpha(vineyard.charcoal, 0.15),
        },
        input: {
          padding: '12px 14px',
        },
      },
    },

    MuiInputLabel: {
      styleOverrides: {
        root: {
          fontSize: '0.875rem',
          color: vineyard.charcoalLight,
          '&.Mui-focused': {
            color: vineyard.green,
          },
        },
      },
    },

    // Select
    MuiSelect: {
      styleOverrides: {
        select: {
          padding: '12px 14px',
        },
      },
    },

    // Chip
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          fontWeight: 500,
          fontSize: '0.8125rem',
        },
        colorPrimary: {
          backgroundColor: alpha(vineyard.green, 0.1),
          color: vineyard.green,
        },
        colorSecondary: {
          backgroundColor: alpha(vineyard.red, 0.1),
          color: vineyard.red,
        },
      },
    },

    // Table
    MuiTableHead: {
      styleOverrides: {
        root: {
          backgroundColor: vineyard.creamDark,
          '& .MuiTableCell-root': {
            fontWeight: 600,
            fontSize: '0.8125rem',
            color: vineyard.charcoalLight,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            borderBottom: `1px solid ${alpha(vineyard.charcoal, 0.1)}`,
          },
        },
      },
    },

    MuiTableCell: {
      styleOverrides: {
        root: {
          padding: '12px 16px',
          fontSize: '0.875rem',
          borderBottom: `1px solid ${alpha(vineyard.charcoal, 0.06)}`,
        },
      },
    },

    MuiTableRow: {
      styleOverrides: {
        root: {
          '&:hover': {
            backgroundColor: alpha(vineyard.green, 0.02),
          },
        },
      },
    },

    // Tabs
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          fontSize: '0.875rem',
          minHeight: 44,
        },
      },
    },

    MuiTabs: {
      styleOverrides: {
        indicator: {
          backgroundColor: vineyard.green,
          height: 3,
          borderRadius: '3px 3px 0 0',
        },
      },
    },

    // Dialog
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 12,
        },
      },
    },

    MuiDialogTitle: {
      styleOverrides: {
        root: {
          fontFamily: '"Playfair Display", Georgia, serif',
          fontWeight: 600,
          fontSize: '1.25rem',
          padding: '20px 24px 12px',
        },
      },
    },

    // Tooltip
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: vineyard.charcoal,
          fontSize: '0.75rem',
          borderRadius: 4,
          padding: '6px 12px',
        },
      },
    },

    // Alert
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          fontSize: '0.875rem',
        },
        standardSuccess: {
          backgroundColor: alpha(status.success, 0.08),
          color: status.success,
        },
        standardWarning: {
          backgroundColor: alpha(status.warning, 0.08),
          color: status.warning,
        },
        standardError: {
          backgroundColor: alpha(status.error, 0.08),
          color: status.error,
        },
        standardInfo: {
          backgroundColor: alpha(vineyard.green, 0.08),
          color: vineyard.green,
        },
      },
    },

    // List Items
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          marginBottom: 2,
          '&.Mui-selected': {
            backgroundColor: alpha(vineyard.green, 0.08),
            color: vineyard.green,
            '&:hover': {
              backgroundColor: alpha(vineyard.green, 0.12),
            },
            '& .MuiListItemIcon-root': {
              color: vineyard.green,
            },
          },
          '&:hover': {
            backgroundColor: alpha(vineyard.charcoal, 0.04),
          },
        },
      },
    },

    // Avatar
    MuiAvatar: {
      styleOverrides: {
        root: {
          backgroundColor: alpha(vineyard.green, 0.12),
          color: vineyard.green,
          fontWeight: 600,
        },
      },
    },

    // Badge
    MuiBadge: {
      styleOverrides: {
        colorPrimary: {
          backgroundColor: vineyard.green,
        },
        colorSecondary: {
          backgroundColor: vineyard.red,
        },
      },
    },

    // Linear Progress
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          height: 6,
          backgroundColor: alpha(vineyard.green, 0.1),
        },
        barColorPrimary: {
          backgroundColor: vineyard.green,
        },
      },
    },

    // Switch
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          '&.Mui-checked': {
            color: vineyard.green,
            '& + .MuiSwitch-track': {
              backgroundColor: vineyard.green,
              opacity: 0.5,
            },
          },
        },
      },
    },

    // Fab
    MuiFab: {
      styleOverrides: {
        primary: {
          backgroundColor: vineyard.green,
          '&:hover': {
            backgroundColor: vineyard.greenLight,
          },
        },
      },
    },
  },
});

export default theme;

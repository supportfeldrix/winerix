import { Box } from '@mui/material';

/**
 * Consistent content wrapper for pages rendered inside the Winerix shell.
 *
 * Applies responsive padding and a comfortable max width so page content is
 * aligned across the application. Prevents horizontal overflow on small
 * screens.
 *
 * @param {React.ReactNode} children - Page content.
 * @param {number|string} [maxWidth=1440] - Maximum content width in px.
 * @param {object} [sx] - Additional MUI sx overrides.
 */
function PageContainer({ children, maxWidth = 1440, sx = {} }) {
  return (
    <Box
      sx={{
        width: '100%',
        maxWidth,
        mx: 'auto',
        px: { xs: 2, sm: 3, md: 4 },
        py: { xs: 2.5, sm: 3, md: 4 },
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

export default PageContainer;

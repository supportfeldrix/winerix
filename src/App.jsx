import { CssBaseline, ThemeProvider } from '@mui/material';
import { Box, Typography, Paper, Divider, Stack } from '@mui/material';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { GiGrapes, GiFarmTractor } from 'react-icons/gi';
import { TbChartBarPopular } from 'react-icons/tb';
import theme from './theme/theme';
import winerixLogo from './assets/logo/WineRix main logo.png';
import vineyardBg from './assets/images/Background_farm.png';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Vineyards from './pages/Vineyards';
import VineyardProfile from './components/vineyards/VineyardProfile';
import Blocks from './pages/Blocks';
import BlockProfile from './components/blocks/BlockProfile';
import Operations from './pages/Operations';
import OperationProfile from './components/operations/OperationProfile';
import Irrigation from './pages/Irrigation';
import IrrigationProfile from './components/irrigation/IrrigationProfile';
import SprayProgramme from './pages/SprayProgramme';
import SprayProgrammeProfile from './components/spray/SprayProgrammeProfile';
import Harvest from './pages/Harvest';
import HarvestProfile from './components/harvest/HarvestProfile';
import Machinery from './pages/Machinery';
import MachineryProfile from './components/machinery/MachineryProfile';
import Finance from './pages/Finance';
import FinanceProfile from './components/finance/FinanceProfile';
import Planner from './pages/Planner';
import PlannerProfile from './components/planner/PlannerProfile';
import Reports from './pages/Reports';
import AIIntelligence from './pages/AIIntelligence';
import Account from './pages/Account';
import ProtectedRoute from './components/auth/ProtectedRoute';

// Landing page (existing brand shell)
function LandingPage() {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        px: 2,
        py: 4,
        position: 'relative',
        backgroundImage: `url(${vineyardBg})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundAttachment: { md: 'fixed' },
      }}
    >
      {/* Subtle overlay for readability */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(248, 246, 241, 0.25)',
          pointerEvents: 'none',
        }}
      />

      {/* Brand Card */}
      <Paper
        elevation={0}
        sx={{
          position: 'relative',
          width: '100%',
          maxWidth: 500,
          px: { xs: 3, sm: 5 },
          py: { xs: 4, sm: 5 },
          textAlign: 'center',
          borderTop: '4px solid',
          borderTopColor: 'primary.main',
          backgroundColor: 'rgba(255, 255, 255, 0.82)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid rgba(255, 255, 255, 0.5)',
          borderTopWidth: '4px',
          borderTopStyle: 'solid',
          boxShadow: '0 8px 40px rgba(44, 44, 44, 0.12), 0 2px 12px rgba(44, 44, 44, 0.06)',
        }}
      >
        {/* Winerix Logo */}
        <Box
          component="img"
          src={winerixLogo}
          alt="Winerix — Vineyard Intelligence"
          sx={{
            width: '100%',
            maxWidth: 280,
            height: 'auto',
            mx: 'auto',
            mb: 2,
            display: 'block',
          }}
        />

        {/* Gold Divider */}
        <Divider
          sx={{
            my: 2.5,
            mx: 'auto',
            width: 60,
            borderColor: 'accent.main',
            borderBottomWidth: 2,
          }}
        />

        {/* Statement */}
        <Typography
          sx={{
            fontFamily: '"Playfair Display", Georgia, serif',
            fontStyle: 'italic',
            fontSize: '1rem',
            color: 'text.secondary',
            maxWidth: 340,
            mx: 'auto',
            lineHeight: 1.7,
          }}
        >
          Intelligent management for modern vineyards.
        </Typography>

        {/* Capability Indicators */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 1.5, sm: 2 }}
          justifyContent="center"
          alignItems="stretch"
          sx={{ mt: 4 }}
        >
          <CapabilityItem
            icon={<GiFarmTractor />}
            label="Vineyard Management"
            color="#1B4D3E"
          />
          <CapabilityItem
            icon={<TbChartBarPopular />}
            label="Intelligent Operations"
            color="#7A122B"
          />
          <CapabilityItem
            icon={<GiGrapes />}
            label="Harvest Insights"
            color="#D4AF37"
          />
        </Stack>
      </Paper>

      {/* Footer */}
      <Typography
        variant="caption"
        sx={{
          mt: 4,
          color: 'rgba(255, 255, 255, 0.85)',
          letterSpacing: '0.02em',
          position: 'relative',
          textShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
        }}
      >
        winerix.feldrix.com
      </Typography>
    </Box>
  );
}

function CapabilityItem({ icon, label, color }) {
  return (
    <Box
      sx={{
        flex: 1,
        px: 2,
        py: 2,
        borderRadius: 1.5,
        bgcolor: 'rgba(248, 246, 241, 0.6)',
        border: '1px solid rgba(27, 77, 62, 0.1)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        transition: 'border-color 0.2s ease',
        '&:hover': {
          borderColor: 'rgba(27, 77, 62, 0.25)',
        },
      }}
    >
      <Box
        sx={{
          fontSize: '1.75rem',
          color: color,
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </Box>
      <Typography
        sx={{
          fontFamily: '"Playfair Display", Georgia, serif',
          fontWeight: 700,
          fontSize: '0.65rem',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'text.primary',
          textAlign: 'center',
          lineHeight: 1.4,
        }}
      >
        {label}
      </Typography>
    </Box>
  );
}

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* Protected application shell */}
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/vineyards" element={<Vineyards />} />
            <Route path="/vineyards/:id" element={<VineyardProfile />} />
            <Route path="/blocks" element={<Blocks />} />
            <Route path="/blocks/:id" element={<BlockProfile />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="/operations/:id" element={<OperationProfile />} />
            <Route path="/irrigation" element={<Irrigation />} />
            <Route path="/irrigation/:id" element={<IrrigationProfile />} />
            <Route path="/spray-programme" element={<SprayProgramme />} />
            <Route path="/spray-programme/:id" element={<SprayProgrammeProfile />} />
            <Route path="/harvest" element={<Harvest />} />
            <Route path="/harvest/:id" element={<HarvestProfile />} />
            <Route path="/machinery" element={<Machinery />} />
            <Route path="/machinery/:id" element={<MachineryProfile />} />
            <Route path="/finance" element={<Finance />} />
            <Route path="/finance/:id" element={<FinanceProfile />} />
            <Route path="/planner" element={<Planner />} />
            <Route path="/planner/:id" element={<PlannerProfile />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/ai-intelligence" element={<AIIntelligence />} />
            <Route path="/account" element={<Account />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;

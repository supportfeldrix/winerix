// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Application Navigation
// Central definition of sidebar navigation destinations.
// These are navigation targets for the application shell. Only /dashboard is
// implemented at this stage; the remaining destinations are placeholders for
// future phases.
// ─────────────────────────────────────────────────────────────────────────────

import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import SanitizerOutlinedIcon from '@mui/icons-material/SanitizerOutlined';
import AgricultureOutlinedIcon from '@mui/icons-material/AgricultureOutlined';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import AssessmentOutlinedIcon from '@mui/icons-material/AssessmentOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';

// Primary application navigation
export const MAIN_NAV = [
  { label: 'Dashboard', path: '/dashboard', icon: DashboardOutlinedIcon },
  { label: 'Vineyards', path: '/vineyards', icon: TerrainOutlinedIcon },
  { label: 'Blocks', path: '/blocks', icon: GridViewOutlinedIcon },
  { label: 'Operations', path: '/operations', icon: HandymanOutlinedIcon },
  { label: 'Irrigation', path: '/irrigation', icon: WaterDropOutlinedIcon },
  { label: 'Spray Programme', path: '/spray-programme', icon: SanitizerOutlinedIcon },
  { label: 'Harvest', path: '/harvest', icon: AgricultureOutlinedIcon },
  { label: 'Machinery', path: '/machinery', icon: PrecisionManufacturingOutlinedIcon },
  { label: 'Finance', path: '/finance', icon: PaymentsOutlinedIcon },
  { label: 'Planner', path: '/planner', icon: EventNoteOutlinedIcon },
  { label: 'Weather', path: '/weather', icon: CloudOutlinedIcon },
  { label: 'Reports', path: '/reports', icon: AssessmentOutlinedIcon },
  { label: 'AI Intelligence', path: '/ai-intelligence', icon: AutoAwesomeOutlinedIcon },
];

// Secondary navigation (account and personal settings)
export const SECONDARY_NAV = [
  { label: 'Account', path: '/account', icon: PersonOutlineOutlinedIcon },
];

// Width of the permanent desktop sidebar / temporary mobile drawer
export const SIDEBAR_WIDTH = 264;

// Resolve a friendly page title from the current pathname.
export function getPageTitle(pathname) {
  const all = [...MAIN_NAV, ...SECONDARY_NAV];
  const match = all.find(
    (item) => pathname === item.path || pathname.startsWith(`${item.path}/`)
  );
  return match ? match.label : 'Winerix';
}

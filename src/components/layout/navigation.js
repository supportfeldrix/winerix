// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Application Navigation
// Central definition of sidebar navigation destinations, grouped by business
// area (Farm, Field Operations, Cellar, Laboratory, Inventory, Machinery &
// Finance, Planning & Intelligence) plus a secondary Account section. Grouping
// is presentation only — every route and icon is unchanged. MAIN_NAV is derived
// flat from the groups so existing consumers keep one authoritative list.
// ─────────────────────────────────────────────────────────────────────────────

import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import LocalBarOutlinedIcon from '@mui/icons-material/LocalBarOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import SanitizerOutlinedIcon from '@mui/icons-material/SanitizerOutlined';
import AgricultureOutlinedIcon from '@mui/icons-material/AgricultureOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import WaterOutlinedIcon from '@mui/icons-material/WaterOutlined';
import PropaneTankOutlinedIcon from '@mui/icons-material/PropaneTankOutlined';
import LiquorOutlinedIcon from '@mui/icons-material/LiquorOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';
import MoveToInboxOutlinedIcon from '@mui/icons-material/MoveToInboxOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import BiotechOutlinedIcon from '@mui/icons-material/BiotechOutlined';
import ColorizeOutlinedIcon from '@mui/icons-material/ColorizeOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import AssessmentOutlinedIcon from '@mui/icons-material/AssessmentOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';

// Primary application navigation, grouped by business area. Each group has a
// short, non-clickable section label and the same item objects (unchanged
// labels, routes and icons). The grouping is presentation only — routes and
// functionality are identical to the previous flat list.
export const MAIN_NAV_GROUPS = [
  {
    label: 'Farm',
    items: [
      { label: 'Dashboard', path: '/dashboard', icon: DashboardOutlinedIcon },
      { label: 'Vineyards', path: '/vineyards', icon: TerrainOutlinedIcon },
      { label: 'Blocks', path: '/blocks', icon: GridViewOutlinedIcon },
      { label: 'Cultivars', path: '/cultivars', icon: LocalBarOutlinedIcon },
    ],
  },
  {
    label: 'Field Operations',
    items: [
      { label: 'Operations', path: '/operations', icon: HandymanOutlinedIcon },
      { label: 'Irrigation', path: '/irrigation', icon: WaterDropOutlinedIcon },
      { label: 'Spray Programme', path: '/spray-programme', icon: SanitizerOutlinedIcon },
      { label: 'Harvest', path: '/harvest', icon: AgricultureOutlinedIcon },
    ],
  },
  {
    label: 'Cellar',
    items: [
      { label: 'Wine Batches', path: '/wine-batches', icon: ScienceOutlinedIcon },
      { label: 'Wine Lots', path: '/wine-lots', icon: WaterOutlinedIcon },
      { label: 'Vessels', path: '/vessels', icon: PropaneTankOutlinedIcon },
      { label: 'Bottling Runs', path: '/bottling-runs', icon: LiquorOutlinedIcon },
    ],
  },
  {
    label: 'Laboratory',
    items: [
      { label: 'Lab Analytes', path: '/lab/analytes', icon: BiotechOutlinedIcon },
      { label: 'Lab Samples', path: '/lab/samples', icon: ColorizeOutlinedIcon },
      { label: 'Lab Specifications', path: '/lab/specifications', icon: RuleOutlinedIcon },
      { label: 'Lab Alerts', path: '/lab/alerts', icon: WarningAmberOutlinedIcon },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Finished Products', path: '/finished-products', icon: Inventory2OutlinedIcon },
      { label: 'Stock Locations', path: '/stock-locations', icon: WarehouseOutlinedIcon },
      { label: 'Receive Finished Goods', path: '/receive-finished-goods', icon: MoveToInboxOutlinedIcon },
      { label: 'Stock Transfers', path: '/stock/transfers', icon: SwapHorizOutlinedIcon },
      { label: 'Stock Adjustments', path: '/stock/adjustments', icon: TuneOutlinedIcon },
    ],
  },
  {
    label: 'Commercial',
    items: [
      { label: 'Customers', path: '/customers', icon: StorefrontOutlinedIcon },
      { label: 'Sales Orders', path: '/sales-orders', icon: ReceiptLongOutlinedIcon },
    ],
  },
  {
    label: 'Machinery & Finance',
    items: [
      { label: 'Machinery', path: '/machinery', icon: PrecisionManufacturingOutlinedIcon },
      { label: 'Finance', path: '/finance', icon: PaymentsOutlinedIcon },
    ],
  },
  {
    label: 'Planning & Intelligence',
    items: [
      { label: 'Planner', path: '/planner', icon: EventNoteOutlinedIcon },
      { label: 'Weather', path: '/weather', icon: CloudOutlinedIcon },
      { label: 'AI Intelligence', path: '/ai-intelligence', icon: AutoAwesomeOutlinedIcon },
      { label: 'Reports', path: '/reports', icon: AssessmentOutlinedIcon },
    ],
  },
];

// Flat primary navigation — derived from the grouped structure so existing
// consumers (e.g. getPageTitle) keep a single, authoritative list. Order
// matches the grouped order. Do not maintain this list by hand.
export const MAIN_NAV = MAIN_NAV_GROUPS.flatMap((group) => group.items);

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

import WbSunnyOutlinedIcon from '@mui/icons-material/WbSunnyOutlined';
import FilterDramaOutlinedIcon from '@mui/icons-material/FilterDramaOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import GrainOutlinedIcon from '@mui/icons-material/GrainOutlined';
import AcUnitOutlinedIcon from '@mui/icons-material/AcUnitOutlined';
import ThunderstormOutlinedIcon from '@mui/icons-material/ThunderstormOutlined';
import BlurOnOutlinedIcon from '@mui/icons-material/BlurOnOutlined';

const MAP = {
  sunny: WbSunnyOutlinedIcon,
  partly: FilterDramaOutlinedIcon,
  cloudy: CloudOutlinedIcon,
  rain: GrainOutlinedIcon,
  snow: AcUnitOutlinedIcon,
  storm: ThunderstormOutlinedIcon,
  fog: BlurOnOutlinedIcon,
};

/**
 * Renders the MUI icon for a weather icon key (from weatherCodeInfo).
 * Sunny/storm tinted with the accent (gold) colour; others use text.secondary
 * unless a colour is provided.
 */
function WeatherIcon({ iconKey, sx, color }) {
  const Icon = MAP[iconKey] || CloudOutlinedIcon;
  const resolvedColor = color || (iconKey === 'sunny' ? 'accent.main' : 'text.secondary');
  return <Icon sx={{ color: resolvedColor, ...sx }} />;
}

export default WeatherIcon;

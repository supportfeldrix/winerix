import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardActionArea, CardContent, Box, Typography, Skeleton, Divider } from '@mui/material';
import { alpha } from '@mui/material/styles';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import AirOutlinedIcon from '@mui/icons-material/AirOutlined';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';
import WeatherIcon from '../weather/WeatherIcon';
import {
  getVineyardLocations,
  geocodeLocation,
  getWeather,
  weatherCodeInfo,
} from '../../services/weatherService';

/**
 * Compact Dashboard weather card. Resolves the user's first vineyard location
 * to real Open-Meteo weather. Shows loading / error / unavailable states and
 * links to the full Weather page. No fabricated values.
 */
function WeatherCard() {
  const navigate = useNavigate();
  const [state, setState] = useState('loading'); // loading | ready | unavailable | error
  const [placeName, setPlaceName] = useState('');
  const [weather, setWeather] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setState('loading');
      const vineyards = await getVineyardLocations();
      if (!active) return;

      if (vineyards.length === 0) {
        setState('unavailable');
        return;
      }

      const geo = await geocodeLocation(vineyards[0].location);
      if (!active) return;
      if (geo.error || !geo.data) {
        setState('unavailable');
        return;
      }

      const w = await getWeather(geo.data.lat, geo.data.lon);
      if (!active) return;
      if (w.error || !w.data) {
        setState('error');
        return;
      }

      setPlaceName(geo.data.name);
      setWeather(w.data);
      setState('ready');
    })();
    return () => {
      active = false;
    };
  }, []);

  const header = (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
      <Typography variant="h6" component="h3">Weather</Typography>
      <ArrowForwardOutlinedIcon sx={{ fontSize: '1.1rem', color: 'text.disabled' }} />
    </Box>
  );

  const body = () => {
    if (state === 'loading') {
      return (
        <Box>
          <Skeleton width="55%" height={44} />
          <Skeleton width="70%" height={20} sx={{ mt: 1 }} />
        </Box>
      );
    }
    if (state === 'unavailable') {
      return (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Add a vineyard with a location to see local weather.
        </Typography>
      );
    }
    if (state === 'error') {
      return (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Weather is unavailable right now. Tap to try again.
        </Typography>
      );
    }
    const info = weatherCodeInfo(weather.current.weatherCode);
    const t = weather.current.temperature;
    return (
      <>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box
            sx={{
              width: 52, height: 52, borderRadius: 2.5, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              bgcolor: (th) => alpha(th.palette.primary.main, 0.1),
            }}
          >
            <WeatherIcon iconKey={info.icon} sx={{ fontSize: '1.8rem' }} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              component="p"
              sx={{ fontFamily: '"Playfair Display", Georgia, serif', fontWeight: 700, fontSize: '2rem', lineHeight: 1 }}
            >
              {Math.round(t)}°C
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }} noWrap>
              {info.label}
            </Typography>
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1.5, color: 'text.secondary' }}>
          <LocationOnOutlinedIcon sx={{ fontSize: '1rem' }} />
          <Typography variant="body2" noWrap>{placeName}</Typography>
        </Box>

        <Divider sx={{ my: 1.5 }} />

        <Box sx={{ display: 'flex', gap: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <WaterDropOutlinedIcon sx={{ fontSize: '1.1rem', color: 'primary.main' }} />
            <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>
              {Math.round(weather.current.humidity)}%
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <AirOutlinedIcon sx={{ fontSize: '1.1rem', color: 'primary.main' }} />
            <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>
              {Math.round(weather.current.windSpeed)} km/h
            </Typography>
          </Box>
        </Box>
      </>
    );
  };

  return (
    <Card>
      <CardActionArea onClick={() => navigate('/weather')}>
        <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
          {header}
          <Divider sx={{ mb: 1.5 }} />
          {body()}
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default WeatherCard;

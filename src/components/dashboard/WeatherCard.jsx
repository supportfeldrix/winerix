import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardActionArea, CardContent, Box, Typography, Skeleton, Divider } from '@mui/material';
import { alpha } from '@mui/material/styles';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import AirOutlinedIcon from '@mui/icons-material/AirOutlined';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';
import WeatherIcon from '../weather/WeatherIcon';
import { weatherBackground } from '../weather/weatherBackground';
import {
  getVineyardLocations,
  geocodeLocation,
  getWeather,
  weatherCodeInfo,
} from '../../services/weatherService';

/**
 * Compact Dashboard weather card. Resolves the user's first vineyard location
 * to real Open-Meteo weather and renders a dynamic vineyard background based on
 * the current condition + day/night. Text stays readable via a dark/green
 * gradient overlay. Loading / error / unavailable states use the plain card.
 * No fabricated values; existing typography (serif temperature) preserved.
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

  // ── Plain (non-image) states ────────────────────────────────────────────
  if (state !== 'ready') {
    return (
      <Card>
        <CardActionArea onClick={() => navigate('/weather')}>
          <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="h6" component="h3">Weather</Typography>
              <ArrowForwardOutlinedIcon sx={{ fontSize: '1.1rem', color: 'text.disabled' }} />
            </Box>
            <Divider sx={{ mb: 1.5 }} />
            {state === 'loading' ? (
              <Box>
                <Skeleton width="55%" height={44} />
                <Skeleton width="70%" height={20} sx={{ mt: 1 }} />
              </Box>
            ) : state === 'unavailable' ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Add a vineyard with a location to see local weather.
              </Typography>
            ) : (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Weather is unavailable right now. Tap to try again.
              </Typography>
            )}
          </CardContent>
        </CardActionArea>
      </Card>
    );
  }

  // ── Ready state — dynamic vineyard background ────────────────────────────
  const info = weatherCodeInfo(weather.current.weatherCode);
  const bg = weatherBackground(weather.current.weatherCode, weather.current.isDay);

  return (
    <Card sx={{ position: 'relative', overflow: 'hidden' }}>
      <CardActionArea onClick={() => navigate('/weather')}>
        {/* Background image */}
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url(${bg})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
        {/* Readability overlay: deep vineyard-green, stronger at the base */}
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            background: (t) =>
              `linear-gradient(180deg, ${alpha(t.palette.primary.dark, 0.35)} 0%, ${alpha(t.palette.primary.dark, 0.55)} 55%, ${alpha(t.palette.primary.dark, 0.82)} 100%)`,
          }}
        />

        <CardContent sx={{ position: 'relative', p: { xs: 2.5, md: 3 }, color: 'common.white' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="h6" component="h3" sx={{ color: 'common.white' }}>Weather</Typography>
            <ArrowForwardOutlinedIcon sx={{ fontSize: '1.1rem', color: (t) => alpha(t.palette.common.white, 0.85) }} />
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 2 }}>
            <Box
              sx={{
                width: 52, height: 52, borderRadius: 2.5, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                bgcolor: (t) => alpha(t.palette.common.white, 0.18),
                backdropFilter: 'blur(2px)',
              }}
            >
              <WeatherIcon iconKey={info.icon} sx={{ fontSize: '1.8rem' }} color="common.white" />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography
                component="p"
                sx={{
                  fontFamily: '"Playfair Display", Georgia, serif',
                  fontWeight: 700,
                  fontSize: '2rem',
                  lineHeight: 1,
                  color: 'common.white',
                  textShadow: '0 1px 8px rgba(0,0,0,0.35)',
                }}
              >
                {Math.round(weather.current.temperature)}°C
              </Typography>
              <Typography variant="body2" noWrap sx={{ color: (t) => alpha(t.palette.common.white, 0.92) }}>
                {info.label}
              </Typography>
            </Box>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1.5, color: (t) => alpha(t.palette.common.white, 0.9) }}>
            <LocationOnOutlinedIcon sx={{ fontSize: '1rem' }} />
            <Typography variant="body2" noWrap>{placeName}</Typography>
          </Box>

          <Divider sx={{ my: 1.5, borderColor: (t) => alpha(t.palette.common.white, 0.25) }} />

          <Box sx={{ display: 'flex', gap: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <WaterDropOutlinedIcon sx={{ fontSize: '1.1rem', color: 'common.white' }} />
              <Typography variant="body2" sx={{ color: 'common.white', fontWeight: 600 }}>
                {Math.round(weather.current.humidity)}%
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <AirOutlinedIcon sx={{ fontSize: '1.1rem', color: 'common.white' }} />
              <Typography variant="body2" sx={{ color: 'common.white', fontWeight: 600 }}>
                {Math.round(weather.current.windSpeed)} km/h
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default WeatherCard;

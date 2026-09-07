import { useEffect, useState, useCallback } from 'react';
import {
  Box, Grid, Card, CardContent, Paper, Typography, TextField, MenuItem, InputAdornment,
  Button, Skeleton, Alert, Divider, Link, Stack,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import ThermostatOutlinedIcon from '@mui/icons-material/ThermostatOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import AirOutlinedIcon from '@mui/icons-material/AirOutlined';
import UmbrellaOutlinedIcon from '@mui/icons-material/UmbrellaOutlined';
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined';
import PageContainer from '../components/layout/PageContainer';
import WeatherIcon from '../components/weather/WeatherIcon';
import {
  getVineyardLocations, geocodeLocation, getWeather, weatherCodeInfo, friendlyWeatherError,
} from '../services/weatherService';

const MANUAL = '__manual__';

function formatDay(dateStr, index) {
  if (index === 0) return 'Today';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}
function formatFullDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function round(v) {
  return v == null || Number.isNaN(Number(v)) ? '—' : Math.round(Number(v));
}

function Metric({ icon: Icon, label, value }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
      <Box
        sx={{
          width: 40, height: 40, borderRadius: 2, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'primary.main', bgcolor: (t) => alpha(t.palette.primary.main, 0.1),
        }}
      >
        <Icon fontSize="small" />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="overline" sx={{ display: 'block', lineHeight: 1.3 }}>{label}</Typography>
        <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>{value}</Typography>
      </Box>
    </Box>
  );
}

function Weather() {
  const [vineyards, setVineyards] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const [status, setStatus] = useState('loading'); // loading | ready | unavailable | error
  const [errorKind, setErrorKind] = useState('');
  const [resolved, setResolved] = useState(null); // { name, admin1, country }
  const [weather, setWeather] = useState(null);

  // Resolve a location-text query → geocode → weather.
  const loadForQuery = useCallback(async (query) => {
    setStatus('loading');
    setErrorKind('');
    const geo = await geocodeLocation(query);
    if (geo.error || !geo.data) {
      setResolved(null);
      setWeather(null);
      setErrorKind(geo.error || 'notfound');
      setStatus('unavailable');
      return;
    }
    const w = await getWeather(geo.data.lat, geo.data.lon);
    if (w.error || !w.data) {
      setResolved(geo.data);
      setWeather(null);
      setErrorKind(w.error || 'forecast');
      setStatus('error');
      return;
    }
    setResolved(geo.data);
    setWeather(w.data);
    setStatus('ready');
  }, []);

  // Initial load: default to the first vineyard location.
  useEffect(() => {
    let active = true;
    (async () => {
      const vs = await getVineyardLocations();
      if (!active) return;
      setVineyards(vs);
      if (vs.length > 0) {
        setSelectedId(vs[0].id);
        loadForQuery(vs[0].location);
      } else {
        // No vineyard locations — wait for manual search.
        setStatus('unavailable');
        setErrorKind('novineyard');
      }
    })();
    return () => { active = false; };
  }, [loadForQuery]);

  const handleVineyardChange = (e) => {
    const id = e.target.value;
    setSelectedId(id);
    if (id === MANUAL) return;
    const v = vineyards.find((x) => x.id === id);
    if (v) loadForQuery(v.location);
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    const q = searchInput.trim();
    if (!q) return;
    setSelectedId(MANUAL);
    loadForQuery(q);
  };

  const resolvedLabel = resolved
    ? [resolved.name, resolved.admin1, resolved.country].filter(Boolean).join(', ')
    : '';

  return (
    <PageContainer maxWidth={1320} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      {/* Header */}
      <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>
        Weather
      </Typography>
      <Typography variant="body1" sx={{ color: 'text.secondary', mb: 3 }}>
        Current conditions and a seven-day forecast for your vineyard location.
      </Typography>

      {/* Location controls */}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 3, maxWidth: { sm: 720 } }}>
        {vineyards.length > 0 && (
          <TextField
            select
            label="Vineyard location"
            value={selectedId}
            onChange={handleVineyardChange}
            fullWidth
            sx={{ maxWidth: { sm: 280 } }}
          >
            {vineyards.map((v) => (
              <MenuItem key={v.id} value={v.id}>
                {v.name} — {v.location}
              </MenuItem>
            ))}
            <MenuItem value={MANUAL}><em>Custom search…</em></MenuItem>
          </TextField>
        )}
        <Box component="form" onSubmit={handleSearchSubmit} sx={{ display: 'flex', gap: 1, flexGrow: 1 }}>
          <TextField
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search a town or place"
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment>
              ),
            }}
          />
          <Button type="submit" variant="contained" color="primary" sx={{ flexShrink: 0 }}>
            Search
          </Button>
        </Box>
      </Stack>

      {/* Resolved location */}
      {status === 'ready' && resolvedLabel && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 2, color: 'text.secondary' }}>
          <LocationOnOutlinedIcon sx={{ fontSize: '1.1rem' }} />
          <Typography variant="body2">
            Showing weather for <strong>{resolvedLabel}</strong>
          </Typography>
        </Box>
      )}

      {/* States */}
      {status === 'loading' && (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          <Grid item xs={12} md={5}><Card><CardContent><Skeleton width="60%" height={40} /><Skeleton width="40%" height={64} sx={{ mt: 1 }} /></CardContent></Card></Grid>
          <Grid item xs={12} md={7}><Card><CardContent><Skeleton height={120} /></CardContent></Card></Grid>
        </Grid>
      )}

      {status === 'unavailable' && (
        <Paper
          variant="outlined"
          sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 6 }, textAlign: 'center' }}
        >
          <Box sx={{ width: 60, height: 60, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
            <CloudOffOutlinedIcon sx={{ fontSize: '1.9rem' }} />
          </Box>
          <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>Location unavailable</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto' }}>
            {errorKind === 'novineyard'
              ? 'Add a vineyard with a location, or search for a town above to see local weather.'
              : friendlyWeatherError(errorKind)}
          </Typography>
        </Paper>
      )}

      {status === 'error' && (
        <Alert severity="error">{friendlyWeatherError(errorKind)}</Alert>
      )}

      {status === 'ready' && weather && (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {/* Current conditions */}
          <Grid item xs={12} md={5}>
            <Card sx={{ height: '100%' }}>
              <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                <Typography variant="h6" component="h2" sx={{ mb: 1.5 }}>Current Conditions</Typography>
                <Divider sx={{ mb: 2 }} />
                {(() => {
                  const info = weatherCodeInfo(weather.current.weatherCode);
                  return (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5, mb: 2.5 }}>
                      <Box
                        sx={{
                          width: 72, height: 72, borderRadius: 3, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          bgcolor: (t) => alpha(t.palette.primary.main, 0.1),
                        }}
                      >
                        <WeatherIcon iconKey={info.icon} sx={{ fontSize: '2.4rem' }} />
                      </Box>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography
                          component="p"
                          sx={{ fontFamily: '"Playfair Display", Georgia, serif', fontWeight: 700, fontSize: '3rem', lineHeight: 1 }}
                        >
                          {round(weather.current.temperature)}°C
                        </Typography>
                        <Typography variant="body1" sx={{ color: 'text.secondary' }}>{info.label}</Typography>
                      </Box>
                    </Box>
                  );
                })()}
                <Grid container spacing={2}>
                  <Grid item xs={6}><Metric icon={ThermostatOutlinedIcon} label="Feels like" value={`${round(weather.current.apparentTemperature)}°C`} /></Grid>
                  <Grid item xs={6}><Metric icon={WaterDropOutlinedIcon} label="Humidity" value={`${round(weather.current.humidity)}%`} /></Grid>
                  <Grid item xs={6}><Metric icon={AirOutlinedIcon} label="Wind" value={`${round(weather.current.windSpeed)} km/h`} /></Grid>
                  <Grid item xs={6}><Metric icon={UmbrellaOutlinedIcon} label="Precipitation" value={`${weather.current.precipitation ?? 0} mm`} /></Grid>
                </Grid>
              </CardContent>
            </Card>
          </Grid>

          {/* 7-day forecast */}
          <Grid item xs={12} md={7}>
            <Card sx={{ height: '100%' }}>
              <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                <Typography variant="h6" component="h2" sx={{ mb: 1.5 }}>7-Day Forecast</Typography>
                <Divider sx={{ mb: 1 }} />
                <Box>
                  {weather.daily.map((day, i) => {
                    const info = weatherCodeInfo(day.weatherCode);
                    return (
                      <Box
                        key={day.date}
                        sx={{
                          display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 2 }, py: 1.25,
                          borderBottom: i < weather.daily.length - 1 ? '1px solid' : 'none',
                          borderColor: 'divider',
                        }}
                      >
                        <Box sx={{ width: { xs: 44, sm: 56 }, flexShrink: 0 }}>
                          <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{formatDay(day.date, i)}</Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{formatFullDate(day.date)}</Typography>
                        </Box>
                        <WeatherIcon iconKey={info.icon} sx={{ fontSize: '1.4rem', flexShrink: 0 }} />
                        <Typography variant="body2" sx={{ color: 'text.secondary', flexGrow: 1, minWidth: 0, display: { xs: 'none', sm: 'block' } }} noWrap>
                          {info.label}
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4, flexShrink: 0, color: 'primary.main' }}>
                          <UmbrellaOutlinedIcon sx={{ fontSize: '0.95rem' }} />
                          <Typography variant="body2">{round(day.precipProbability)}%</Typography>
                        </Box>
                        <Box sx={{ width: 74, flexShrink: 0, textAlign: 'right' }}>
                          <Typography component="span" variant="body2" sx={{ fontWeight: 700, color: 'text.primary' }}>{round(day.tempMax)}°</Typography>
                          <Typography component="span" variant="body2" sx={{ color: 'text.disabled', ml: 0.75 }}>{round(day.tempMin)}°</Typography>
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {/* Open-Meteo attribution (required) */}
      <Typography variant="caption" sx={{ display: 'block', color: 'text.disabled', mt: 3 }}>
        Weather data by{' '}
        <Link href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer" underline="hover" sx={{ color: 'text.secondary' }}>
          Open-Meteo.com
        </Link>
      </Typography>
    </PageContainer>
  );
}

export default Weather;

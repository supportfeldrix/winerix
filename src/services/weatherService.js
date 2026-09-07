import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Weather Service
// Real weather data via Open-Meteo (open-meteo.com) — free, no API key, CORS
// enabled, called directly from the browser. Geocoding uses Open-Meteo's free
// geocoding endpoint to resolve vineyard location text to coordinates.
//
// No fabricated weather values or fallback forecasts: if the location cannot be
// resolved or the API fails, callers receive an error and show an appropriate
// state.
//
// Attribution required by Open-Meteo — displayed on the Weather page.
// ─────────────────────────────────────────────────────────────────────────────

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO weather interpretation codes → { label, icon } (icon = MUI icon key).
const WEATHER_CODES = {
  0: { label: 'Clear sky', icon: 'sunny' },
  1: { label: 'Mainly clear', icon: 'partly' },
  2: { label: 'Partly cloudy', icon: 'partly' },
  3: { label: 'Overcast', icon: 'cloudy' },
  45: { label: 'Fog', icon: 'fog' },
  48: { label: 'Depositing rime fog', icon: 'fog' },
  51: { label: 'Light drizzle', icon: 'rain' },
  53: { label: 'Moderate drizzle', icon: 'rain' },
  55: { label: 'Dense drizzle', icon: 'rain' },
  56: { label: 'Light freezing drizzle', icon: 'rain' },
  57: { label: 'Dense freezing drizzle', icon: 'rain' },
  61: { label: 'Slight rain', icon: 'rain' },
  63: { label: 'Moderate rain', icon: 'rain' },
  65: { label: 'Heavy rain', icon: 'rain' },
  66: { label: 'Light freezing rain', icon: 'rain' },
  67: { label: 'Heavy freezing rain', icon: 'rain' },
  71: { label: 'Slight snow', icon: 'snow' },
  73: { label: 'Moderate snow', icon: 'snow' },
  75: { label: 'Heavy snow', icon: 'snow' },
  77: { label: 'Snow grains', icon: 'snow' },
  80: { label: 'Slight rain showers', icon: 'rain' },
  81: { label: 'Moderate rain showers', icon: 'rain' },
  82: { label: 'Violent rain showers', icon: 'rain' },
  85: { label: 'Slight snow showers', icon: 'snow' },
  86: { label: 'Heavy snow showers', icon: 'snow' },
  95: { label: 'Thunderstorm', icon: 'storm' },
  96: { label: 'Thunderstorm with slight hail', icon: 'storm' },
  99: { label: 'Thunderstorm with heavy hail', icon: 'storm' },
};

/**
 * Human-friendly label + icon key for a WMO weather code.
 * @param {number} code
 * @returns {{ label: string, icon: string }}
 */
export function weatherCodeInfo(code) {
  return WEATHER_CODES[code] || { label: 'Unknown', icon: 'cloudy' };
}

/**
 * Friendly, non-technical error message.
 * @param {'geocode'|'notfound'|'forecast'|'network'|string} kind
 */
export function friendlyWeatherError(kind) {
  switch (kind) {
    case 'notfound':
      return 'We couldn\u2019t find that location. Try a nearby town or a more specific place name.';
    case 'geocode':
      return 'We couldn\u2019t look up that location right now. Please try again in a moment.';
    case 'forecast':
      return 'We couldn\u2019t load the weather right now. Please try again in a moment.';
    case 'network':
      return 'Network error. Please check your connection and try again.';
    default:
      return 'Something went wrong loading the weather. Please try again.';
  }
}

/**
 * Resolve a place-name string to coordinates via Open-Meteo geocoding.
 * @param {string} name
 * @returns {Promise<{ data: { name, lat, lon, country, admin1 }|null, error: string|null }>}
 */
export async function geocodeLocation(name) {
  const q = (name || '').trim();
  if (!q) return { data: null, error: 'notfound' };

  let res;
  try {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
    res = await fetch(url);
  } catch {
    return { data: null, error: 'network' };
  }
  if (!res.ok) return { data: null, error: 'geocode' };

  let json;
  try {
    json = await res.json();
  } catch {
    return { data: null, error: 'geocode' };
  }

  const first = json?.results?.[0];
  if (!first) return { data: null, error: 'notfound' };

  return {
    data: {
      name: first.name,
      lat: first.latitude,
      lon: first.longitude,
      country: first.country || '',
      admin1: first.admin1 || '',
    },
    error: null,
  };
}

/**
 * Fetch current conditions + a 7-day daily forecast for coordinates.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{ data: object|null, error: string|null }>}
 */
export async function getWeather(lat, lon) {
  if (lat == null || lon == null) return { data: null, error: 'forecast' };

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,relative_humidity_2m_max',
    timezone: 'auto',
    forecast_days: '7',
    wind_speed_unit: 'kmh',
    temperature_unit: 'celsius',
    precipitation_unit: 'mm',
  });

  let res;
  try {
    res = await fetch(`${FORECAST_URL}?${params.toString()}`);
  } catch {
    return { data: null, error: 'network' };
  }
  if (!res.ok) return { data: null, error: 'forecast' };

  let json;
  try {
    json = await res.json();
  } catch {
    return { data: null, error: 'forecast' };
  }

  const c = json.current || {};
  const d = json.daily || {};
  const days = (d.time || []).map((date, i) => ({
    date,
    weatherCode: d.weather_code?.[i],
    tempMax: d.temperature_2m_max?.[i],
    tempMin: d.temperature_2m_min?.[i],
    precipProbability: d.precipitation_probability_max?.[i],
    windMax: d.wind_speed_10m_max?.[i],
    humidityMax: d.relative_humidity_2m_max?.[i],
  }));

  return {
    data: {
      current: {
        temperature: c.temperature_2m,
        apparentTemperature: c.apparent_temperature,
        humidity: c.relative_humidity_2m,
        precipitation: c.precipitation,
        windSpeed: c.wind_speed_10m,
        weatherCode: c.weather_code,
        time: c.time,
      },
      daily: days,
      units: {
        temperature: json.current_units?.temperature_2m || '°C',
        wind: json.current_units?.wind_speed_10m || 'km/h',
        humidity: json.current_units?.relative_humidity_2m || '%',
        precipitation: json.current_units?.precipitation || 'mm',
      },
    },
    error: null,
  };
}

/**
 * Load the authenticated user's vineyards that have a non-empty location, for
 * the Weather page selector. RLS-scoped. Returns [] on any error (the page
 * still works via manual search).
 * @returns {Promise<Array<{ id, name, location }>>}
 */
export async function getVineyardLocations() {
  const { data, error } = await supabase
    .from('vineyards')
    .select('id, name, location')
    .order('created_at', { ascending: true });

  if (error) return [];
  return (data || []).filter((v) => v.location && v.location.trim());
}

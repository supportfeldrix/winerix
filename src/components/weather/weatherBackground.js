// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Weather background mapping
// Maps a WMO weather code + day/night to one of the eight premium vineyard
// background images. Uses individual local assets only (no external URLs, no
// reference-grid image). Vite bundles each import.
// ─────────────────────────────────────────────────────────────────────────────

import sunny from '../../assets/images/weather-sunny.jpg';
import partlyCloudy from '../../assets/images/weather-partly-cloudy.jpg';
import cloudy from '../../assets/images/weather-cloudy.jpg';
import rainy from '../../assets/images/weather-rainy.jpg';
import thunderstorm from '../../assets/images/weather-thunderstorm.jpg';
import foggy from '../../assets/images/weather-foggy.jpg';
import clearNight from '../../assets/images/weather-clear-night.jpg';
import partlyCloudyNight from '../../assets/images/weather-night-partly-cloudy.jpg';

/**
 * Resolve the background image for a weather code and day/night state.
 *
 * @param {number} code - WMO weather interpretation code from Open-Meteo.
 * @param {boolean} [isDay=true] - Day/night from Open-Meteo `is_day`.
 * @returns {string} Bundled image URL.
 */
export function weatherBackground(code, isDay = true) {
  const c = Number(code);

  // Clear
  if (c === 0) return isDay ? sunny : clearNight;

  // Partly cloudy / mainly clear
  if (c === 1 || c === 2) return isDay ? partlyCloudy : partlyCloudyNight;

  // Overcast
  if (c === 3) return cloudy;

  // Fog
  if (c === 45 || c === 48) return foggy;

  // Thunderstorm
  if (c === 95 || c === 96 || c === 99) return thunderstorm;

  // Rain / drizzle / showers
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return rainy;

  // Snow — no dedicated asset; use the neutral cloudy vineyard scene.
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return cloudy;

  // Fallback
  return cloudy;
}

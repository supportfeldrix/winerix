import { Box, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';

/**
 * Accurate, dependency-free horizontal proportion bars driven by real values.
 * Each segment width is proportional to its value over the total. No fabricated
 * data — if all values are 0, a neutral empty track is shown.
 *
 * @param {Array<{ label: string, value: number, color: string, display?: string }>} items
 *   `color` is a theme palette path (e.g. 'success.main') or a CSS colour.
 * @param {boolean} [showLegend=true]
 */
function ProportionBar({ items = [], showLegend = true }) {
  const total = items.reduce((s, i) => s + (Number(i.value) || 0), 0);

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          width: '100%',
          height: 12,
          borderRadius: 6,
          overflow: 'hidden',
          bgcolor: (t) => alpha(t.palette.text.primary, 0.06),
        }}
      >
        {total > 0 &&
          items.map((item) => {
            const pct = ((Number(item.value) || 0) / total) * 100;
            if (pct <= 0) return null;
            return (
              <Box
                key={item.label}
                sx={{
                  width: `${pct}%`,
                  bgcolor: item.color,
                  transition: 'width 0.4s ease',
                }}
              />
            );
          })}
      </Box>

      {showLegend && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: { xs: 1.5, sm: 3 }, mt: 1.5 }}>
          {items.map((item) => (
            <Box key={item.label} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: item.color, flexShrink: 0 }} />
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {item.label}
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>
                {item.display != null ? item.display : item.value}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

export default ProportionBar;

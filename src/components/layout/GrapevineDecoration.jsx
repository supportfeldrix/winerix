import { Box } from '@mui/material';
import { useTheme, alpha } from '@mui/material/styles';

/**
 * Decorative grapevine illustration for the Sidebar footer.
 *
 * Refined inline SVG (no external asset, resolves reliably, scales crisply)
 * using the Winerix palette — a delicate vineyard-green vine with fine leaves,
 * curling tendrils and a soft gradient grape cluster. Anchored to the lower-left
 * and gently faded so it reads as an elegant background flourish, matching the
 * premium banner. Purely decorative: aria-hidden + pointer-events none.
 */
function GrapevineDecoration() {
  const theme = useTheme();
  const green = theme.palette.primary.main;
  const greenDark = theme.palette.primary.dark;
  const greenLight = theme.palette.primary.light;
  const gold = theme.palette.accent.main;
  const goldLight = theme.palette.accent.light;
  const wine = theme.palette.secondary.main;

  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        left: 0,
        bottom: 0,
        width: 190,
        maxWidth: '100%',
        height: 150,
        pointerEvents: 'none',
        // Soft fade toward the upper-right so it dissolves into the cream sidebar.
        maskImage: 'linear-gradient(to top right, black 30%, transparent 88%)',
        WebkitMaskImage: 'linear-gradient(to top right, black 30%, transparent 88%)',
      }}
    >
      <Box
        component="svg"
        viewBox="0 0 190 150"
        sx={{ width: '100%', height: '100%', display: 'block' }}
      >
        <defs>
          <linearGradient id="wx-grape" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={goldLight} />
            <stop offset="100%" stopColor={gold} />
          </linearGradient>
          <linearGradient id="wx-grape-wine" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={theme.palette.secondary.light} />
            <stop offset="100%" stopColor={wine} />
          </linearGradient>
          <linearGradient id="wx-leaf" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={greenLight} />
            <stop offset="100%" stopColor={greenDark} />
          </linearGradient>
        </defs>

        {/* Graceful main vine, sweeping up from the lower-left corner */}
        <path
          d="M2 148 C 14 120, 20 104, 30 90 C 42 72, 50 58, 68 44 C 80 34, 92 30, 104 24"
          fill="none"
          stroke={green}
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.8"
        />

        {/* Curling tendrils */}
        <path d="M30 90 C 44 88, 50 78, 46 68 C 43 61, 48 57, 54 59" fill="none" stroke={greenLight} strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
        <path d="M68 44 C 80 46, 86 38, 82 30" fill="none" stroke={greenLight} strokeWidth="1.3" strokeLinecap="round" opacity="0.55" />

        {/* Fine, elegant leaves along the vine */}
        <g opacity="0.9">
          <path d="M96 26 C 108 12, 130 12, 138 24 C 130 38, 108 40, 96 26 Z" fill="url(#wx-leaf)" opacity="0.85" />
          <path d="M62 46 C 74 32, 94 34, 100 46 C 92 60, 72 60, 62 46 Z" fill="url(#wx-leaf)" opacity="0.7" />
          <path d="M34 78 C 44 66, 62 68, 66 80 C 59 92, 42 92, 34 78 Z" fill={green} opacity="0.55" />
        </g>
        {/* Delicate leaf veins */}
        <g stroke={alpha('#ffffff', 0.35)} strokeWidth="0.7" fill="none">
          <path d="M117 26 L 104 19 M117 26 L 104 33 M117 26 L 131 19 M117 26 L 131 33 M117 26 L 96 26 M117 26 L 138 24" />
          <path d="M81 46 L 70 40 M81 46 L 70 52 M81 46 L 92 40 M81 46 L 92 52" />
        </g>

        {/* Grape cluster near the lower-left — soft, gradient-filled */}
        <g>
          {[
            [20, 120, 'g'], [34, 118, 'w'], [48, 122, 'g'],
            [15, 132, 'w'], [29, 132, 'g'], [43, 132, 'w'],
            [22, 144, 'g'], [36, 144, 'w'],
            [29, 150, 'g'],
          ].map(([cx, cy, kind], i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r="7"
              fill={kind === 'w' ? 'url(#wx-grape-wine)' : 'url(#wx-grape)'}
              opacity="0.82"
            />
          ))}
          {/* Soft highlights for a rounded, dewy feel */}
          <circle cx="17.5" cy="117.5" r="1.9" fill={alpha('#ffffff', 0.55)} />
          <circle cx="31.5" cy="115.5" r="1.9" fill={alpha('#ffffff', 0.5)} />
          <circle cx="45.5" cy="119.5" r="1.6" fill={alpha('#ffffff', 0.45)} />
        </g>
      </Box>
    </Box>
  );
}

export default GrapevineDecoration;

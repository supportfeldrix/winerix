import { Box } from '@mui/material';
import { useTheme, alpha } from '@mui/material/styles';

/**
 * Decorative grapevine illustration for the Sidebar footer.
 *
 * Rendered as an inline SVG (no external asset, resolves reliably, scales
 * crisply) using the Winerix palette — vineyard-green leaves/vine with soft
 * gold-and-wine grapes. Anchored to the lower-left and softly faded so it reads
 * as a tasteful background flourish, never a clickable element.
 *
 * Purely decorative: aria-hidden + pointer-events none.
 */
function GrapevineDecoration() {
  const theme = useTheme();
  const green = theme.palette.primary.main;
  const greenLight = theme.palette.primary.light;
  const gold = theme.palette.accent.main;
  const wine = theme.palette.secondary.main;

  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        left: 0,
        bottom: 0,
        width: 168,
        height: 132,
        pointerEvents: 'none',
        opacity: 0.9,
        // Soft fade toward the upper/right so it blends into the cream sidebar.
        maskImage: 'linear-gradient(to top right, black 40%, transparent 92%)',
        WebkitMaskImage: 'linear-gradient(to top right, black 40%, transparent 92%)',
      }}
    >
      <Box
        component="svg"
        viewBox="0 0 168 132"
        sx={{ width: '100%', height: '100%', display: 'block' }}
      >
        {/* Main vine stem rising from the lower-left corner */}
        <path
          d="M4 130 C 10 104, 22 92, 34 78 C 46 64, 54 48, 66 34"
          fill="none"
          stroke={green}
          strokeWidth="2.4"
          strokeLinecap="round"
          opacity="0.85"
        />
        {/* Tendrils */}
        <path d="M34 78 C 48 76, 54 66, 50 56" fill="none" stroke={greenLight} strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
        <path d="M22 100 C 34 100, 40 92, 38 82" fill="none" stroke={greenLight} strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />

        {/* Vine leaves (rounded, stylised) */}
        <g fill={green} opacity="0.9">
          <path d="M60 40 C 74 26, 96 26, 104 40 C 96 52, 74 54, 60 40 Z" opacity="0.85" />
          <path d="M42 66 C 54 52, 74 54, 80 68 C 72 80, 52 80, 42 66 Z" fill={greenLight} opacity="0.8" />
          <path d="M22 96 C 32 84, 50 86, 54 98 C 47 108, 30 108, 22 96 Z" fill={green} opacity="0.7" />
        </g>
        {/* Leaf veins */}
        <g stroke={alpha('#ffffff', 0.4)} strokeWidth="0.8" fill="none">
          <path d="M82 40 L 70 34 M82 40 L 70 46 M82 40 L 96 34 M82 40 L 96 46" />
        </g>

        {/* Grape cluster near the lower-left */}
        <g>
          {[
            [16, 112], [28, 112], [40, 112],
            [22, 122], [34, 122],
            [12, 122], [46, 122],
            [28, 130],
          ].map(([cx, cy], i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r="6.5"
              fill={i % 3 === 0 ? wine : gold}
              opacity={i % 3 === 0 ? 0.75 : 0.7}
            />
          ))}
          {/* Highlights */}
          <circle cx="14" cy="110" r="1.8" fill={alpha('#ffffff', 0.6)} />
          <circle cx="26" cy="110" r="1.8" fill={alpha('#ffffff', 0.6)} />
        </g>
      </Box>
    </Box>
  );
}

export default GrapevineDecoration;

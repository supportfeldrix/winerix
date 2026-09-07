import { Box } from '@mui/material';
import grapeImg from '../../assets/images/grape2.jpg';

/**
 * Decorative grapevine image for the Sidebar footer.
 *
 * Renders the supplied grape/leaf illustration filling the footer area. The
 * source art sits on a white background, so `mix-blend-mode: multiply` drops the
 * white out against the cream sidebar, leaving the green leaf and wine grapes.
 * Purely decorative — aria-hidden + pointer-events none — and fully contained by
 * the footer's `overflow: hidden`, so it never widens the sidebar or extends
 * into the main content.
 */
function GrapevineDecoration() {
  return (
    <Box
      aria-hidden
      component="img"
      src={grapeImg}
      alt=""
      sx={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        objectPosition: 'center bottom',
        p: 1.5,
        pointerEvents: 'none',
        userSelect: 'none',
        // Blend the white background into the cream sidebar surface.
        mixBlendMode: 'multiply',
        opacity: 0.95,
      }}
    />
  );
}

export default GrapevineDecoration;

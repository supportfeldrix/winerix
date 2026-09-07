import { Card, CardActionArea, CardContent, Box, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';

/**
 * Premium dashboard metric card.
 *
 * @param {React.ElementType} icon - MUI icon component.
 * @param {string} label - Metric label (overline).
 * @param {string|number} value - Large primary value.
 * @param {string} [hint] - Muted supporting text.
 * @param {'primary'|'secondary'|'accent'|'success'} [tone='primary'] - Accent colour.
 * @param {boolean} [featured=false] - Larger, tinted treatment for headline metrics.
 * @param {function} [onClick] - Makes the whole card a clickable link.
 */
function StatCard({ icon: Icon, label, value, hint, tone = 'primary', featured = false, onClick }) {
  const toneColor = tone === 'accent' ? 'accent.main' : `${tone}.main`;

  const content = (
    <CardContent
      sx={{
        p: { xs: 2.5, md: 3 },
        display: 'flex',
        flexDirection: 'column',
        gap: featured ? 1.5 : 1,
        height: '100%',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box
          sx={{
            width: featured ? 52 : 44,
            height: featured ? 52 : 44,
            borderRadius: 2.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: toneColor,
            bgcolor: (t) => alpha(t.palette[tone === 'accent' ? 'accent' : tone].main, 0.12),
          }}
        >
          <Icon fontSize={featured ? 'medium' : 'small'} />
        </Box>
        {onClick && (
          <ArrowForwardOutlinedIcon
            className="stat-arrow"
            sx={{ fontSize: '1.1rem', color: 'text.disabled', transition: 'transform 0.2s ease, color 0.2s ease' }}
          />
        )}
      </Box>

      <Box>
        <Typography variant="overline" sx={{ display: 'block', lineHeight: 1.4 }}>
          {label}
        </Typography>
        <Typography
          component="p"
          sx={{
            fontFamily: '"Playfair Display", Georgia, serif',
            fontWeight: 700,
            fontSize: featured ? { xs: '2.25rem', md: '2.75rem' } : { xs: '1.75rem', md: '2rem' },
            lineHeight: 1.05,
            color: featured ? toneColor : 'text.primary',
          }}
        >
          {value}
        </Typography>
        {hint && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }} noWrap>
            {hint}
          </Typography>
        )}
      </Box>
    </CardContent>
  );

  const featuredSx = featured
    ? {
        borderColor: (t) => alpha(t.palette[tone === 'accent' ? 'accent' : tone].main, 0.28),
        bgcolor: (t) => alpha(t.palette[tone === 'accent' ? 'accent' : tone].main, 0.04),
      }
    : {};

  return (
    <Card
      sx={{
        height: '100%',
        transition: 'box-shadow 0.2s ease, transform 0.2s ease, border-color 0.2s ease',
        ...featuredSx,
        '&:hover .stat-arrow': { transform: 'translateX(3px)', color: toneColor },
        ...(onClick && {
          '&:hover': { boxShadow: 4, transform: 'translateY(-2px)' },
        }),
      }}
    >
      {onClick ? (
        <CardActionArea onClick={onClick} sx={{ height: '100%' }}>
          {content}
        </CardActionArea>
      ) : (
        content
      )}
    </Card>
  );
}

export default StatCard;

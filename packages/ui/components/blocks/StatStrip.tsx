import React from 'react';

interface StatStripProps {
  blockId: string;
  body: string;
}

/**
 * Parses pipe-delimited lines into stat cards.
 * Format: `value | label` or `value | label | color`
 * Color is a semantic token: success, destructive, warning, primary (default).
 */
function parseStats(body: string): { value: string; label: string; color: string }[] {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('|').map(s => s.trim());
      return {
        value: parts[0] || '',
        label: parts[1] || '',
        color: parts[2] || 'primary',
      };
    });
}

/* Design-system spec: .stat-card with semantic color accents on border */
const COLOR_MAP: Record<string, { value: string; border: string }> = {
  success:     { value: 'text-success',     border: 'border-success/40' },
  destructive: { value: 'text-destructive', border: 'border-destructive/40' },
  warning:     { value: 'text-warning',     border: 'border-warning/40' },
  primary:     { value: 'text-primary',     border: 'border-primary/40' },
};

export const StatStrip: React.FC<StatStripProps> = ({ blockId, body }) => {
  const stats = parseStats(body);
  if (stats.length === 0) return null;

  return (
    <div
      className="directive-stats grid gap-4 my-8"
      style={{ gridTemplateColumns: `repeat(${Math.min(stats.length, 5)}, minmax(140px, 1fr))` }}
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="stats"
    >
      {stats.map((stat, i) => {
        const colors = COLOR_MAP[stat.color] || COLOR_MAP.primary;
        return (
          <div
            key={i}
            className={`rounded-lg bg-card text-center ${colors.border}`}
            style={{ border: '1.5px solid', padding: '16px 24px' }}
          >
            <span className={`block font-medium ${colors.value}`} style={{
              fontFamily: 'var(--font-display, ui-serif, Georgia, serif)',
              fontSize: '1.8rem',
            }}>
              {stat.value}
            </span>
            <span className="block mt-1 text-muted-foreground" style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
              {stat.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};

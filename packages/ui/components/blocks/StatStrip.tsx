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

const COLOR_MAP: Record<string, string> = {
  success: 'text-success border-success/30 bg-success/8',
  destructive: 'text-destructive border-destructive/30 bg-destructive/8',
  warning: 'text-warning border-warning/30 bg-warning/8',
  primary: 'text-primary border-primary/30 bg-primary/8',
};

export const StatStrip: React.FC<StatStripProps> = ({ blockId, body }) => {
  const stats = parseStats(body);
  if (stats.length === 0) return null;

  return (
    <div
      className="directive-stats grid gap-3 my-4"
      style={{ gridTemplateColumns: `repeat(${Math.min(stats.length, 5)}, 1fr)` }}
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="stats"
    >
      {stats.map((stat, i) => {
        const colors = COLOR_MAP[stat.color] || COLOR_MAP.primary;
        return (
          <div
            key={i}
            className={`rounded-lg border px-4 py-3 text-center ${colors}`}
          >
            <div className="text-2xl font-bold tracking-tight">{stat.value}</div>
            <div className="text-xs font-medium uppercase tracking-wide mt-1 opacity-80">
              {stat.label}
            </div>
          </div>
        );
      })}
    </div>
  );
};

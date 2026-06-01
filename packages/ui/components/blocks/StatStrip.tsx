import React from 'react';

interface StatStripProps {
  blockId: string;
  body: string;
}

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

const COLOR_VALUE: Record<string, string> = {
  success: 'text-success',
  destructive: 'text-destructive',
  warning: 'text-warning',
  primary: 'text-primary',
};

export const StatStrip: React.FC<StatStripProps> = ({ blockId, body }) => {
  const stats = parseStats(body);
  if (stats.length === 0) return null;

  return (
    <div
      className="directive-stats"
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="stats"
    >
      {stats.map((stat, i) => (
        <div key={i} className={`stat-card stat-card--${stat.color}`}>
          <span className={`stat-value ${COLOR_VALUE[stat.color] || COLOR_VALUE.primary}`}>
            {stat.value}
          </span>
          <span className="stat-label">{stat.label}</span>
        </div>
      ))}
    </div>
  );
};

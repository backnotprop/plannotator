import React from 'react';

interface SparklesIconProps {
  className?: string;
  animated?: boolean;
}

/**
 * Three-star sparkle icon adapted from the automations branch.
 * Uses currentColor for fill so it inherits from parent text color.
 */
export const SparklesIcon: React.FC<SparklesIconProps> = ({ className = 'w-3 h-3', animated = false }) => (
  <svg className={`${className} flex-shrink-0`} viewBox="0 0 128 128" fill="none">
    {animated && (
      <style>{`
        @keyframes sparkle-idle {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
      `}</style>
    )}
    <g style={animated ? { animation: 'sparkle-idle 2s infinite ease-in-out', animationDelay: '0.35s' } : undefined}>
      <path
        d="M121.59 60.83l-13.93-4.49c-8.91-2.94-14.13-10.15-16.58-19.21L84.95 7.27c-.16-.59-.55-1.38-1.75-1.38c-1.01 0-1.59.79-1.75 1.38l-6.13 29.87c-2.46 9.06-7.67 16.27-16.58 19.21l-13.93 4.49c-1.97.64-2 3.42-.04 4.09l14.03 4.83c8.88 2.95 14.06 10.15 16.52 19.17l6.14 29.53c.16.59.49 1.65 1.75 1.65c1.33 0 1.59-1.06 1.75-1.65l6.14-29.53c2.46-9.03 7.64-16.23 16.52-19.17l14.03-4.83c1.94-.68 1.91-3.46-.06-4.1z"
        fill="currentColor"
      />
      <path
        d="M122.91 62.08c-.22-.55-.65-1.03-1.32-1.25l-13.93-4.49c-8.91-2.94-14.13-10.15-16.58-19.21L84.95 7.27c-.09-.34-.41-.96-.78-1.14l1.98 29.97c1.47 13.68 2.73 20.12 13.65 22c9.38 1.62 20.23 3.48 23.11 3.98z"
        fill="currentColor" opacity={0.7}
      />
    </g>
    <g style={animated ? { animation: 'sparkle-idle 2s infinite ease-in-out', animationDelay: '0.15s' } : undefined}>
      <path
        d="M41.81 86.81c-8.33-2.75-9.09-5.85-10.49-11.08l-3.49-12.24c-.21-.79-2.27-.79-2.49 0L22.97 74.8c-1.41 5.21-4.41 9.35-9.53 11.04l-8.16 3.54c-1.13.37-1.15 1.97-.02 2.35l8.22 2.91c5.1 1.69 8.08 5.83 9.5 11.02l2.37 10.82c.22.79 2.27.79 2.48 0l2.78-10.77c1.41-5.22 3.57-9.37 10.5-11.07l7.72-2.91c1.13-.39 1.12-1.99-.02-2.36l-7-2.56z"
        fill="currentColor"
      />
    </g>
    <g style={animated ? { animation: 'sparkle-idle 2s infinite ease-in-out', animationDelay: '0.5s' } : undefined}>
      <path
        d="M59.74 28.14c.56-.19.54-.99-.03-1.15l-7.72-2.08a4.77 4.77 0 0 1-3.34-3.3L45.61 9.06c-.15-.61-1.02-.61-1.17.01l-2.86 12.5a4.734 4.734 0 0 1-3.4 3.37l-7.67 1.99c-.57.15-.61.95-.05 1.15l8.09 2.8c1.45.5 2.57 1.68 3.01 3.15l2.89 11.59c.15.6 1.01.61 1.16 0l2.99-11.63a4.773 4.773 0 0 1 3.04-3.13l8.1-2.72z"
        fill="currentColor" opacity={0.5}
      />
    </g>
  </svg>
);

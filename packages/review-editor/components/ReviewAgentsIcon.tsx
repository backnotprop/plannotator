import React from 'react';

interface ReviewAgentsIconProps {
  className?: string;
}

/**
 * Magnifying glass with cog — icon for the Review Agents tab.
 * Uses currentColor for stroke so it inherits from parent text color.
 */
export const ReviewAgentsIcon: React.FC<ReviewAgentsIconProps> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg className={`${className} flex-shrink-0`} viewBox="0 0 64 64" fill="none" stroke="currentColor">
    <path d="M40.5 40.5L55 55" strokeWidth={7} strokeLinecap="round" />
    <circle cx="27" cy="27" r="20" strokeWidth={4} />
    <path d="M27 14L29.2 14.3L30.2 17.2L32.6 18.6L35.5 17.5L37.2 19.2L36.1 22.1L37.5 24.5L40.4 25.5L40.7 27.7L40.4 29.9L37.5 30.9L36.1 33.3L37.2 36.2L35.5 37.9L32.6 36.8L30.2 38.2L29.2 41.1L27 41.4L24.8 41.1L23.8 38.2L21.4 36.8L18.5 37.9L16.8 36.2L17.9 33.3L16.5 30.9L13.6 29.9L13.3 27.7L13.6 25.5L16.5 24.5L17.9 22.1L16.8 19.2L18.5 17.5L21.4 18.6L23.8 17.2L24.8 14.3Z" strokeWidth={1.5} strokeLinejoin="round" />
    <circle cx="27" cy="27.7" r="7" strokeWidth={1.5} />
  </svg>
);

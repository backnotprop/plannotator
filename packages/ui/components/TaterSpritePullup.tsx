/// <reference path="../globals.d.ts" />
import React from 'react';
import spriteSheet from '../sprite_package_pulluphang/sprite.png';

// Sprite specs: 96x96 native, 24 frames, 3 seconds
const NATIVE_SIZE = 96;
const DISPLAY_SIZE = 56;
const FRAMES = 24;
const SCALE = DISPLAY_SIZE / NATIVE_SIZE;
const TOTAL_WIDTH = NATIVE_SIZE * FRAMES * SCALE;

export const TaterSpritePullup: React.FC = () => {
  return (
    <div
      className="absolute pointer-events-none hidden md:block -z-10"
      style={{
        bottom: -49, // Hangs off bottom of dialog
        left: 12,
        width: DISPLAY_SIZE,
        height: DISPLAY_SIZE,
        backgroundImage: `url(${spriteSheet})`,
        backgroundSize: `${TOTAL_WIDTH}px ${DISPLAY_SIZE}px`,
        animation: 'tater-pullup 3.5s steps(24) infinite',
        imageRendering: 'pixelated',
      }}
    >
      <style>{`
        @keyframes tater-pullup {
          to { background-position: -${TOTAL_WIDTH}px 0; }
        }
      `}</style>
    </div>
  );
};

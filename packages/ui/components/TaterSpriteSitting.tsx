/// <reference path="../globals.d.ts" />
import React from 'react';
import spriteSheet from '../sprite_package_new/sprite.png';

const NATIVE_SIZE = 96;
const DISPLAY_SIZE = 64;
const FRAMES = 12;
const SCALE = DISPLAY_SIZE / NATIVE_SIZE;
const TOTAL_WIDTH = NATIVE_SIZE * FRAMES * SCALE;

export const TaterSpriteSitting: React.FC = () => {
  return (
    <div
      className="hidden md:block absolute pointer-events-none z-10"
      style={{
        top: -40,
        right: -4,
        width: DISPLAY_SIZE,
        height: DISPLAY_SIZE,
        backgroundImage: `url(${spriteSheet})`,
        backgroundSize: `${TOTAL_WIDTH}px ${DISPLAY_SIZE}px`,
        backgroundPosition: 'left center',
        animation: 'tater-sit 3s steps(12) infinite',
        imageRendering: 'pixelated',
      }}
    >
      <style>{`
        @keyframes tater-sit {
          to {
            background-position: -${TOTAL_WIDTH}px 0;
          }
        }
      `}</style>
    </div>
  );
};

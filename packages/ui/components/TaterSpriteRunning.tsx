/// <reference path="../globals.d.ts" />
import React from 'react';
import spriteSheet from '../sprite_package_additional/sprite.png';

const NATIVE_WIDTH = 176;
const NATIVE_HEIGHT = 96;
const DISPLAY_HEIGHT = 64;
const SCALE = DISPLAY_HEIGHT / NATIVE_HEIGHT;
const DISPLAY_WIDTH = NATIVE_WIDTH * SCALE;
const FRAMES = 24;
const FRAME_DURATION = 5;
const TOTAL_SPRITE_WIDTH = NATIVE_WIDTH * FRAMES * SCALE;

const SCREEN_TRAVERSE_TIME = 18;

export const TaterSpriteRunning: React.FC = () => {
  return (
    <div
      className="fixed pointer-events-none hidden md:block"
      style={{
        bottom: 0,
        right: -DISPLAY_WIDTH,
        width: DISPLAY_WIDTH,
        height: DISPLAY_HEIGHT,
        zIndex: 5,
        backgroundImage: `url(${spriteSheet})`,
        backgroundSize: `${TOTAL_SPRITE_WIDTH}px ${DISPLAY_HEIGHT}px`,
        backgroundPosition: 'left center',
        imageRendering: 'pixelated',
        animation: `tater-run-sprite ${FRAME_DURATION}s steps(${FRAMES}) infinite, tater-run-across ${SCREEN_TRAVERSE_TIME}s linear infinite`,
      }}
    >
      <style>{`
        @keyframes tater-run-sprite {
          to {
            background-position: -${TOTAL_SPRITE_WIDTH}px 0;
          }
        }
        @keyframes tater-run-across {
          from {
            right: -${DISPLAY_WIDTH}px;
          }
          to {
            right: 100vw;
          }
        }
      `}</style>
    </div>
  );
};

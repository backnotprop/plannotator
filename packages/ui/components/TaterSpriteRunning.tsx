/// <reference path="../globals.d.ts" />
import React from 'react';
import spriteSheet from '../sprite_package_additional/sprite.png';

// Sprite: 176x96 native, 24 frames, 5 second animation cycle
// Running across screen should sync with animation speed
const NATIVE_WIDTH = 176;
const NATIVE_HEIGHT = 96;
const DISPLAY_HEIGHT = 64;
const SCALE = DISPLAY_HEIGHT / NATIVE_HEIGHT;
const DISPLAY_WIDTH = NATIVE_WIDTH * SCALE; // ~117px
const FRAMES = 24;
const FRAME_DURATION = 5; // seconds for full run cycle
const TOTAL_SPRITE_WIDTH = NATIVE_WIDTH * FRAMES * SCALE;

// Screen traverse: character runs across in ~12 seconds
// This gives ~2.4 run cycles per screen width, feels natural
const SCREEN_TRAVERSE_TIME = 18;

export const TaterSpriteRunning: React.FC = () => {
  return (
    <div
      className="fixed pointer-events-none hidden md:block"
      style={{
        bottom: 0,
        right: -DISPLAY_WIDTH, // Start off-screen right
        width: DISPLAY_WIDTH,
        height: DISPLAY_HEIGHT,
        zIndex: 5, // Above sidebars (z-auto) but below plan document (z-10)
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

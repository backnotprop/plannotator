import React, { Suspense, lazy, useEffect, useState } from 'react';
import { GLASS_COLOURS, glassDataUrl } from './glassArt';

const PowerUpGuyLive = lazy(() => import('./PowerUpGuyLive'));
const STILL_SRC = glassDataUrl(GLASS_COLOURS.find((colour) => colour.id === 'glass') ?? GLASS_COLOURS[0]!);
export const POWER_UP_GUY_REST_MS = 4_000;

export type PowerUpGuyState = 'alive' | 'still' | 'grey';

export const PowerUpGuy: React.FC<{ state: PowerUpGuyState; size?: number; wakeKey?: unknown; poke?: number }> = ({ state, size = 20, wakeKey, poke = 0 }) => {
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (state !== 'alive' || document.hidden) {
      setAwake(false);
      return;
    }
    setAwake(true);
    const timer = setTimeout(() => setAwake(false), POWER_UP_GUY_REST_MS);
    return () => clearTimeout(timer);
  }, [state, wakeKey, poke]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setAwake(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  const still = (
    <img
      src={STILL_SRC}
      alt=""
      draggable={false}
      width={size}
      height={size}
      style={{ display: 'block', width: size, height: size, filter: state === 'grey' ? 'grayscale(1) opacity(0.55)' : undefined }}
    />
  );
  return (
    <span
      data-power-up-guy={state === 'alive' ? (awake ? 'alive' : 'resting') : state}
      aria-hidden="true"
      style={{ display: 'inline-grid', placeItems: 'center', width: size, height: size, flex: 'none' }}
    >
      {awake ? (
        <Suspense fallback={still}>
          <PowerUpGuyLive size={size} />
        </Suspense>
      ) : (
        still
      )}
    </span>
  );
};

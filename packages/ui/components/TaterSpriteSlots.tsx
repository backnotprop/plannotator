import type { ComponentType } from 'react';

export interface TaterSprites {
  pullup: ComponentType;
  sitting: ComponentType;
}

let registered: TaterSprites | null = null;

export function registerTaterSprites(sprites: TaterSprites | null): void {
  registered = sprites;
}

export function TaterPullupSlot() {
  const Sprite = registered?.pullup;
  return Sprite ? <Sprite /> : null;
}

export function TaterSittingSlot() {
  const Sprite = registered?.sitting;
  return Sprite ? <Sprite /> : null;
}

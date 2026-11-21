// The scenes a drawn view holds: each `<div data-scene="id">` in the drawing
// plays `scenes[id]`. ShapeDrawn renders this only when a host passes scenes,
// and the player's code loads only when the drawing has a slot for one, so a
// board without scenes costs nothing and draws exactly as before.
//
// The scene's drawing is the agent's own SVG inside the slot (sanitized with
// the rest of the board). The player adds its caption and controls after it,
// in a shadow root of their own, so the agent's CSS never reaches them.
import { Component, Suspense, lazy, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ShapeScene } from '@plannotator/core/shape-scene';
import { sceneFrame } from './frame';

const ScenePlayer = lazy(() => import('./ScenePlayer'));

/** A player that cannot load or draw leaves the drawing as it is. */
class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface Slot {
  root: ShadowRoot;
  id: string;
}

export interface ScenePlayersProps {
  /** The drawing's `.board` (in its shadow root), drawn afresh each time `drawnKey` changes. */
  board: HTMLElement | null;
  drawnKey: number;
  scenes: Readonly<Record<string, ShapeScene>>;
  reduce: boolean;
  /** 'technical': every scene takes the technical look (look.ts). Absent: scenes play as drawn. */
  look?: 'technical';
}

export function ScenePlayers({ board, drawnKey, scenes, reduce, look }: ScenePlayersProps) {
  const [found, setFound] = useState<{ key: number; board: HTMLElement | null; slots: Slot[] }>({ key: -1, board: null, slots: [] });
  const current = useRef(scenes);
  current.current = scenes;
  const ids = Object.keys(scenes).join(' ');
  useLayoutEffect(() => {
    const slots: Slot[] = [];
    const hosts: HTMLElement[] = [];
    for (const el of board?.querySelectorAll<HTMLElement>('[data-scene]') ?? []) {
      const id = (el.getAttribute('data-scene') ?? '').trim();
      if (!Object.hasOwn(current.current, id)) continue;
      const host = el.ownerDocument.createElement('div');
      host.setAttribute('data-shape-player', 'scene');
      // Sticky: when a phone pans a wide drawing sideways inside the slot, the player under it stays put.
      host.style.cssText = 'display:block;width:100%;position:sticky;left:0;';
      el.appendChild(host);
      hosts.push(host);
      slots.push({ root: host.attachShadow({ mode: 'open' }), id });
    }
    setFound({ key: drawnKey, board, slots });
    return () => {
      for (const host of hosts) host.remove();
    };
  }, [board, drawnKey, ids]);
  const slots = found.key === drawnKey && found.board === board ? found.slots : [];
  return (
    <>
      {slots.map(({ root, id }, i) => {
        const scene = Object.hasOwn(scenes, id) ? scenes[id] : undefined;
        if (!scene) return null;
        // `plannotator shape frame`: this scene drawn still at one moment (frame.ts).
        const frame = sceneFrame();
        const at = frame && frame.scene === id ? Math.min(scene.end, frame.at) : undefined;
        return createPortal(
          <Contained>
            <Suspense fallback={null}>
              <ScenePlayer scene={scene} reduce={reduce} look={look} at={at} />
            </Suspense>
          </Contained>,
          root,
          `${drawnKey}:${i}`,
        );
      })}
    </>
  );
}

import { Component, Suspense, lazy, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ShapeScene } from '@plannotator/core/shape-scene';
import { sceneFrame } from './frame';

const ScenePlayer = lazy(() => import('./ScenePlayer'));

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
  board: HTMLElement | null;
  drawnKey: number;
  scenes: Readonly<Record<string, ShapeScene>>;
  reduce: boolean;
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

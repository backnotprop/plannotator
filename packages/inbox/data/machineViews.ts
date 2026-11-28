/**
 * Linked machines (docs/agent-guides/inbox-machines.md): every machine and its state, from the merged list, the
 * machines read and the stream's `machines` frames. Nothing draws from it while no machine is linked (machines.ts).
 *
 * The server sends a `machines` frame on every change of a machine's state, so a read that began before the latest
 * frame can carry an older state: a list read built while an update still said Failed lands after the frame that
 * said Updating, and no later frame corrects it until the state moves again. Such a read leaves the views as they are.
 */
import { useRef, useState } from 'react';
import type { MachineView } from '../api';

export interface MachineViewsGate {
  /** A `machines` frame: always the newest state. */
  frame(next: MachineView[]): void;
  /** Taken as a read starts; `read` gets it back with the read's answer. */
  mark(): number;
  /** A read's machines, kept only when no frame came while it ran. */
  read(mark: number, next: MachineView[]): void;
}

export function createMachineViewsGate(put: (next: MachineView[]) => void): MachineViewsGate {
  let frames = 0;
  return {
    frame(next) {
      frames += 1;
      put(next);
    },
    mark: () => frames,
    read(mark, next) {
      if (mark === frames) put(next);
    },
  };
}

export function useMachineViews(): [MachineView[] | null, MachineViewsGate] {
  const [views, setViews] = useState<MachineView[] | null>(null);
  const gate = useRef<MachineViewsGate | null>(null);
  // Every list read carries the machines; the same ones keep the same model, so a list read rebuilds nothing.
  gate.current ??= createMachineViewsGate((next) => setViews((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next)));
  return [views, gate.current];
}

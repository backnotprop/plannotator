import { expect, test } from 'bun:test';
import type { MachineView } from '../api';
import { createMachineViewsGate } from './machineViews';

const mini = (phase: string) => [{ id: 'mini', phase }] as unknown as MachineView[];

test('a read that began before a machines frame never puts back the older state it carries', () => {
  const shown: MachineView[][] = [];
  const gate = createMachineViewsGate((next) => shown.push(next));
  const mark = gate.mark();
  gate.frame(mini('updating'));
  gate.read(mark, mini('failed'));
  expect(shown).toEqual([mini('updating')]);
});

test('a read with no frame while it ran is kept, and so is the next read after a frame', () => {
  const shown: MachineView[][] = [];
  const gate = createMachineViewsGate((next) => shown.push(next));
  gate.read(gate.mark(), mini('ready'));
  gate.frame(mini('updating'));
  gate.read(gate.mark(), mini('restarting'));
  expect(shown).toEqual([mini('ready'), mini('updating'), mini('restarting')]);
});

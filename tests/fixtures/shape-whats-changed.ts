import type { ShapeBoard, ShapeChanged } from '../../packages/core/shape';

export const KETTLE_CHANGED: ShapeChanged = {
  summary: 'The kettle whistles once when it boils, then stays quiet.',
  items: [
    { id: 'whistle', kind: 'behaviour', title: 'When the water boils', was: 'Whistles until someone lifts it', now: 'One whistle, then quiet', code: ['src/kettle.ts:42'], step: 1 },
    { id: 'setting', kind: 'contract', title: 'The setting\'s name', was: '`whistle: boolean`', now: ['`whistle: "once" | "off"`', '`true` reads as `"once"`'], code: ['src/settings.ts:12', 'src/kettle.ts:8'], step: 2 },
    { id: 'timer', kind: 'moved', title: 'The boil timer', from: 'src/kettle.ts', to: 'src/timer.ts', lines: 31 },
    { id: 'beep', kind: 'removed', title: 'The second beep', was: ['`beepAgain()`', 'Its test'] },
    { id: 'lid', kind: 'check', title: 'An open lid still whistles', note: 'The lid sensor is read before the boil check, so an open lid whistles once too.', code: ['src/kettle.ts:57'] },
  ],
  flows: [
    {
      id: 'boil',
      title: 'Water reaches 100 °C',
      start: 'The sensor reads 100 °C',
      steps: [
        { call: 'onBoil()', is: 'same', at: 'src/kettle.ts:40' },
        { call: 'whistleOnce()', is: 'new', note: 'one short `tone()`', at: 'src/kettle.ts:42' },
      ],
      forks: [
        { when: 'Lid closed', steps: [{ call: 'beepAgain()', is: 'gone', at: 'src/kettle.ts:61' }], end: { was: 'Whistles until lifted', now: 'One whistle' } },
        { when: 'Lid open', end: { was: 'One whistle', now: 'One whistle' } },
      ],
    },
  ],
  also: 'Tests: 3 new cases in `kettle.test.ts`.',
};

export const KETTLE_OLD_BOARD: ShapeBoard = {
  title: 'The kettle whistles once',
  claim: 'Built. Nothing waits on you.',
  views: {
    picture: { html: '<p data-mark="kettle">One whistle</p>' },
    know: 'It whistles **once**, then stays quiet.',
  },
};

export function kettleBoard(changed: Partial<ShapeChanged> | Record<string, unknown> = {}): ShapeBoard {
  return {
    ...structuredClone(KETTLE_OLD_BOARD),
    views: { ...structuredClone(KETTLE_OLD_BOARD.views), changed: { ...structuredClone(KETTLE_CHANGED), ...(changed as Partial<ShapeChanged>) } },
  };
}

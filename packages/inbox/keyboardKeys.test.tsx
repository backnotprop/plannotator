/**
 * The keys of approval "inbox-keyboard-keys-2026-11-07" that live in one component (DOM_TESTS=1 for the DOM ones).
 * What would regress: an arrow in the Artifacts grid or on the Board landing on the wrong tile (or moving at all from
 * outside one); H opening the header clock's menu without focus in it, or
 * snoozing on its own; Shift+F10 on a message head not opening its ⋯ menu, or opening it from a text field.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GuideArtifact } from './artifacts';
import { gridStep, laneStep, type Box } from './gridMove';

const hasDom = typeof document !== 'undefined';
const { ArtifactsView } = (hasDom ? await import('./components/ArtifactsView') : {}) as typeof import('./components/ArtifactsView');
const { ThreadSnooze, MessageMenu } = (hasDom ? await import('./components/CopyMenus') : {}) as typeof import('./components/CopyMenus');

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: (() => void)[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const restore of restores.splice(0).reverse()) restore();
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const frames = () => act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

/** A 3-column grid of 100 × 80 boxes with a 10 px gap, in reading order. */
const grid = (n: number): Box[] => Array.from({ length: n }, (_, i) => ({ left: (i % 3) * 110, top: Math.floor(i / 3) * 90, width: 100, height: 80 }));

test('the Artifacts grid: ← → in reading order, ↑ ↓ by column, Home End the ends, nothing past an edge', () => {
  const boxes = grid(8); // rows: 0 1 2 / 3 4 5 / 6 7
  expect(gridStep(boxes, 4, 'ArrowRight')).toBe(5);
  expect(gridStep(boxes, 3, 'ArrowLeft')).toBe(2);
  expect(gridStep(boxes, 1, 'ArrowDown')).toBe(4);
  expect(gridStep(boxes, 4, 'ArrowUp')).toBe(1);
  // The last row is short: ↓ from the third column lands on the nearest tile below.
  expect(gridStep(boxes, 5, 'ArrowDown')).toBe(7);
  expect(gridStep(boxes, 0, 'Home')).toBeNull();
  expect(gridStep(boxes, 4, 'Home')).toBe(0);
  expect(gridStep(boxes, 4, 'End')).toBe(7);
  expect(gridStep(boxes, 0, 'ArrowLeft')).toBeNull();
  expect(gridStep(boxes, 7, 'ArrowRight')).toBeNull();
  expect(gridStep(boxes, 1, 'ArrowUp')).toBeNull();
  expect(gridStep(boxes, 6, 'ArrowDown')).toBeNull();
});

test('the Board: ↑ ↓ within a lane, ← → the nearest card in the next lane with cards, Home End the lane’s ends', () => {
  const lane = (x: number, n: number): Box[] => Array.from({ length: n }, (_, i) => ({ left: x, top: i * 100, width: 200, height: 90 }));
  const lanes = [lane(0, 3), lane(220, 0), lane(440, 5)];
  expect(laneStep(lanes, { lane: 0, card: 1 }, 'ArrowDown')).toEqual({ lane: 0, card: 2 });
  expect(laneStep(lanes, { lane: 0, card: 2 }, 'ArrowDown')).toBeNull();
  expect(laneStep(lanes, { lane: 0, card: 0 }, 'ArrowUp')).toBeNull();
  // The empty lane between is passed over; the card at the same height is the one.
  expect(laneStep(lanes, { lane: 0, card: 2 }, 'ArrowRight')).toEqual({ lane: 2, card: 2 });
  expect(laneStep(lanes, { lane: 2, card: 4 }, 'ArrowLeft')).toEqual({ lane: 0, card: 2 });
  expect(laneStep(lanes, { lane: 2, card: 0 }, 'ArrowRight')).toBeNull();
  expect(laneStep(lanes, { lane: 2, card: 2 }, 'End')).toEqual({ lane: 2, card: 4 });
  expect(laneStep(lanes, { lane: 2, card: 2 }, 'Home')).toEqual({ lane: 2, card: 0 });
});

function guide(i: number): GuideArtifact {
  return {
    type: 'guide',
    messageId: `msg_${i}`,
    sender: 'Claude Code',
    sentAt: '11:05 AM',
    at: `2026-11-07T11:0${i}:00.000Z`,
    fromPerson: false,
    host: 'claude-code',
    guide: { sha256: String(i).repeat(64).slice(0, 64), input_sha256: 'a'.repeat(64), bytes: 10, title: `Guide ${i}`, sections: 1, files: 1, additions: 1, deletions: 0 } as GuideArtifact['guide'],
  };
}

test.skipIf(!hasDom)('arrow keys move focus between the Artifacts tiles, and only from a tile', () => {
  const el = mount(<ArtifactsView artifacts={[0, 1, 2, 3, 4].map(guide)} annotationCounts={new Map()} openId={null} onOpen={() => {}} onOpenGuide={() => {}} />);
  const tiles = [...el.querySelectorAll<HTMLElement>('[data-artifact-tile]')];
  expect(tiles.length).toBe(5);
  // Lay the tiles out three to a row (happy-dom draws nothing).
  tiles.forEach((tile, i) => {
    const box = grid(5)[i]!;
    const rect = { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box };
    Object.defineProperty(tile, 'getBoundingClientRect', { configurable: true, value: () => rect });
  });
  act(() => tiles[0]!.focus());
  press(tiles[0]!, 'ArrowRight');
  expect(document.activeElement).toBe(tiles[1]!);
  press(tiles[1]!, 'ArrowDown');
  expect(document.activeElement).toBe(tiles[4]!);
  press(tiles[4]!, 'Home');
  expect(document.activeElement).toBe(tiles[0]!);
  press(tiles[0]!, 'End');
  expect(document.activeElement).toBe(tiles[4]!);
  // With a modifier, or from outside a tile (the heading), the arrows are the page's.
  press(tiles[4]!, 'ArrowLeft', { shiftKey: true });
  expect(document.activeElement).toBe(tiles[4]!);
  const heading = el.querySelector<HTMLElement>('#ib-art-h')!;
  act(() => heading.focus());
  press(heading, 'ArrowRight');
  expect(document.activeElement).toBe(heading);
});

test.skipIf(!hasDom)('H’s request opens the header clock’s menu with focus on the first time; nothing is snoozed until one is picked', async () => {
  const picked: string[] = [];
  const snooze = { snoozed: false, onPick: (until: string) => picked.push(until), onUnsnooze: () => {} };
  mount(<ThreadSnooze snooze={snooze} openRequest={0} />);
  expect(document.querySelector('[data-thread-snooze-menu]')).toBeNull();
  act(() => root!.render(<ThreadSnooze snooze={snooze} openRequest={1} />));
  await frames();
  const menu = document.querySelector('[data-thread-snooze-menu]');
  expect(menu).not.toBeNull();
  expect(document.activeElement).toBe(menu!.querySelector('[data-snooze-choice]'));
  expect(picked).toEqual([]);
});

test.skipIf(!hasDom)('Shift+F10 on a message’s head opens its ⋯ menu with focus in it', async () => {
  const message = { id: 'msg_1', author: { kind: 'agent', host: 'claude-code', name: 'Claude Code' }, created_at: '2026-11-07T11:00:00.000Z', body: 'Hi' } as never;
  const el = mount(
    <MessageMenu
      thread={{ thread_id: 'thr_1', subject: 'S', messages: [message] } as never}
      message={message}
      linkOf={() => 'http://x'}
      phone={false}
      head={(more) => (
        <div data-test-head="">
          <button type="button" data-fold-head="">
            Claude Code
          </button>
          {more}
        </div>
      )}
    />,
  );
  const head = el.querySelector<HTMLElement>('[data-fold-head]')!;
  act(() => head.focus());
  press(head, 'F10', { shiftKey: true });
  await frames();
  const menu = document.querySelector('[data-message-menu="msg_1"]');
  expect(menu).not.toBeNull();
  expect(menu!.contains(document.activeElement)).toBe(true);
});

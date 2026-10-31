import { describe, expect, test } from 'bun:test';
import { activeHeadingBinding, CONTENTS_ACTIVATION_OFFSET, type HeadingBinding } from './headingScrollSpy';

/** A scroll element as the spy reads it: its offset and its sizes. */
function viewportAt(scrollTop: number): HTMLElement {
  return { scrollTop, scrollHeight: 4000, clientHeight: 900 } as HTMLElement;
}

function binding(itemIndex: number, top: number): HeadingBinding {
  return { itemIndex, top, node: {} as HTMLElement };
}

describe('activeHeadingBinding', () => {
  // The Inbox e2e plan's headings: "Idempotency keys", then "Rollout" at a
  // fractional top. A pick of Rollout scrolls to 1522.22 - 80, which the
  // browser snaps to a whole pixel.
  const rollout = 1522.22;
  const bindings = [binding(0, 130), binding(3, 1433.05), binding(4, rollout), binding(5, 2061.31)];

  test('a picked heading left a fraction of a pixel below the line by the scroll snap is the current one', () => {
    expect(activeHeadingBinding(bindings, viewportAt(Math.round(rollout - CONTENTS_ACTIVATION_OFFSET)))?.itemIndex).toBe(4);
    expect(activeHeadingBinding(bindings, viewportAt(Math.floor(rollout - CONTENTS_ACTIVATION_OFFSET)))?.itemIndex).toBe(4);
  });

  test('a heading still clearly below the line is not current yet', () => {
    expect(activeHeadingBinding(bindings, viewportAt(rollout - CONTENTS_ACTIVATION_OFFSET - 4))?.itemIndex).toBe(3);
  });
});

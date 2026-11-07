/**
 * The Contents rail is a reading aid, not part of the document's critical
 * paint (moved from the Workspaces app's
 * test/dom/deferred-markdown-contents-rail.test.ts with the rail). Keep its
 * scheduler idle-first with a bounded fallback.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

const hasDom = typeof window !== 'undefined';
const { scheduleMarkdownContentsRail } = (hasDom ? await import('./DeferredMarkdownContentsRail') : {}) as typeof import('./DeferredMarkdownContentsRail');

const realIdle = hasDom ? (window as { requestIdleCallback?: unknown }).requestIdleCallback : undefined;
const realCancel = hasDom ? (window as { cancelIdleCallback?: unknown }).cancelIdleCallback : undefined;

afterEach(() => {
  if (!hasDom) return;
  (window as { requestIdleCallback?: unknown }).requestIdleCallback = realIdle;
  (window as { cancelIdleCallback?: unknown }).cancelIdleCallback = realCancel;
});

describe.if(hasDom)('the deferred Markdown Contents rail', () => {
  test('uses idle time with a two-second maximum wait', () => {
    const callback = mock(() => {});
    const idle = mock(() => 17);
    const cancel = mock(() => {});
    (window as { requestIdleCallback?: unknown }).requestIdleCallback = idle;
    (window as { cancelIdleCallback?: unknown }).cancelIdleCallback = cancel;

    const dispose = scheduleMarkdownContentsRail(callback);
    expect(idle).toHaveBeenCalledWith(callback, { timeout: 2000 });
    dispose();
    expect(cancel).toHaveBeenCalledWith(17);
  });

  test('defers to the next task when idle callbacks are unavailable', async () => {
    (window as { requestIdleCallback?: unknown }).requestIdleCallback = undefined;
    const callback = mock(() => {});

    const dispose = scheduleMarkdownContentsRail(callback);
    expect(callback).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(callback).toHaveBeenCalledTimes(1);
    dispose();
  });
});

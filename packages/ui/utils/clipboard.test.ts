/**
 * Unit tests for copyTextToClipboard (issue #1173).
 *
 * navigator.clipboard only exists in secure browser contexts. Remote-mode
 * Plannotator serves plain HTTP on a non-localhost host, so every bare
 * `navigator.clipboard.writeText(...)` call used to throw. These tests pin
 * the helper's contract: try the async Clipboard API, fall back to the
 * legacy copy-event / execCommand path, report success as a boolean, and
 * never throw.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test packages/ui/utils/clipboard.test.ts
 */
import { describe, test, expect, afterEach, mock } from 'bun:test';
import { copyTextToClipboard } from './clipboard';
import { ANNOTATION_SELECTORS } from '../components/PopoutDialog';

const hasDom = typeof document !== 'undefined';

type AnyRecord = Record<string, unknown>;

const restorers: Array<() => void> = [];

/** Override a property (saving whatever was there) and restore it afterEach. */
function override(target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restorers.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as AnyRecord)[key];
  });
}

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

describe('copyTextToClipboard', () => {
  test.skipIf(!hasDom)('navigator.clipboard undefined: falls back and returns the execCommand result', async () => {
    override(navigator, 'clipboard', undefined);
    const execCommand = mock(() => true);
    override(document, 'execCommand', execCommand);

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  test.skipIf(!hasDom)('navigator.clipboard undefined and execCommand reports failure: resolves false', async () => {
    override(navigator, 'clipboard', undefined);
    const execCommand = mock(() => false);
    override(document, 'execCommand', execCommand);

    await expect(copyTextToClipboard('hello')).resolves.toBe(false);
    // First the copy-event attempt, then the hidden-textarea retry.
    expect(execCommand.mock.calls.length).toBe(2);
  });

  test.skipIf(!hasDom)('writeText rejects: falls back to the legacy path', async () => {
    const writeText = mock(() => Promise.reject(new Error('insecure context')));
    override(navigator, 'clipboard', { writeText });
    const execCommand = mock(() => true);
    override(document, 'execCommand', execCommand);

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  test.skipIf(!hasDom)('writeText throws synchronously: falls back to the legacy path', async () => {
    const writeText = mock(() => {
      throw new Error('restricted embed');
    });
    override(navigator, 'clipboard', { writeText });
    const execCommand = mock(() => true);
    override(document, 'execCommand', execCommand);

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  test.skipIf(!hasDom)('writeText resolves: returns true without invoking the fallback', async () => {
    const writeText = mock(() => Promise.resolve());
    override(navigator, 'clipboard', { writeText });
    const execCommand = mock(() => true);
    override(document, 'execCommand', execCommand);

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCommand).not.toHaveBeenCalled();
  });

  test.skipIf(!hasDom)('everything fails: resolves false and never throws', async () => {
    const writeText = mock(() => Promise.reject(new Error('denied')));
    override(navigator, 'clipboard', { writeText });
    const execCommand = mock(() => {
      throw new Error('execCommand denied');
    });
    override(document, 'execCommand', execCommand);

    await expect(copyTextToClipboard('hello')).resolves.toBe(false);
  });

  test.skipIf(!hasDom)('fallback runs synchronously when navigator.clipboard is absent', () => {
    // execCommand('copy') is only honored inside the user-gesture window, so
    // the fallback must fire before the call returns its promise. An inserted
    // await ahead of the fallback would defer it past the gesture and
    // silently break every insecure-context copy. Pin the synchronicity:
    // assert the spy fired BEFORE the returned promise is awaited.
    override(navigator, 'clipboard', undefined);
    const execCommand = mock(() => true);
    override(document, 'execCommand', execCommand);

    const promise = copyTextToClipboard('sync payload');
    expect(execCommand).toHaveBeenCalledWith('copy');
    return promise.then((result) => expect(result).toBe(true));
  });

  test.skipIf(!hasDom)('copy event without clipboardData is not treated as success', async () => {
    override(navigator, 'clipboard', undefined);
    // Simulate a browser whose synthetic copy event has no clipboardData:
    // the handler must not preventDefault or flag success, so the helper
    // proceeds to the hidden-textarea retry (second execCommand call).
    let dispatched = 0;
    const execCommand = mock((command: string) => {
      if (command !== 'copy') return false;
      dispatched += 1;
      if (dispatched === 1) {
        const event = new Event('copy', { cancelable: true });
        document.dispatchEvent(event);
        // Native copy "succeeded", but our payload was never written.
        return !event.defaultPrevented;
      }
      return false; // textarea retry also fails
    });
    override(document, 'execCommand', execCommand);

    await expect(copyTextToClipboard('hello')).resolves.toBe(false);
    expect(execCommand.mock.calls.length).toBe(2);
  });

  test.skipIf(!hasDom)('fallback textarea is tagged for PopoutDialog focus-out guard', async () => {
    override(navigator, 'clipboard', undefined);
    // First execCommand call fails (copy-event path), forcing the textarea
    // path; the second call runs while the textarea is in the DOM, where we
    // assert it carries the marker PopoutDialog whitelists.
    let sawTaggedTextarea = false;
    let call = 0;
    const execCommand = mock(() => {
      call += 1;
      if (call === 1) return false;
      const textarea = document.querySelector('textarea[data-clipboard-fallback="true"]');
      sawTaggedTextarea = textarea !== null &&
        ANNOTATION_SELECTORS.some((sel) => textarea.closest(sel) !== null);
      return true;
    });
    override(document, 'execCommand', execCommand);

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(sawTaggedTextarea).toBe(true);
    // The transient textarea must be gone once the copy resolves.
    expect(document.querySelector('[data-clipboard-fallback="true"]')).toBeNull();
  });

  test.skipIf(!hasDom)('fallback copy event carries the text payload', async () => {
    override(navigator, 'clipboard', undefined);
    // Simulate a real execCommand('copy'): dispatch a copy event so the
    // helper's listener runs, then report success only if it set data.
    let captured: string | null = null;
    const execCommand = mock((command: string) => {
      if (command !== 'copy') return false;
      const event = new Event('copy', { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', {
        value: {
          setData: (_type: string, data: string) => {
            captured = data;
          },
        },
      });
      document.dispatchEvent(event);
      return captured !== null;
    });
    override(document, 'execCommand', execCommand);

    await expect(copyTextToClipboard('payload text')).resolves.toBe(true);
    expect(captured).toBe('payload text');
  });
});

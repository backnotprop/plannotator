import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane, CODE_ROW_BELOW_NOTE } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { COPY_FILE_FEEDBACK_MS, CopyFileButton } = (hasDom ? await import('./components/CopyFileButton') : {}) as typeof import('./components/CopyFileButton');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
let written: string[] = [];
let clipboardFails = false;
let hold: ((answer: () => void) => void) | null = null;
let restoreClipboard: (() => void) | null = null;
let restoreGlobals: (() => void) | null = null;

beforeEach(() => {
  if (!hasDom) return;
  written = [];
  clipboardFails = false;
  hold = null;
  const before = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        if (clipboardFails) return Promise.reject(new Error('denied'));
        written.push(text);
        if (hold) {
          const keep = hold;
          return new Promise<void>((resolve) => keep(resolve));
        }
        return Promise.resolve();
      },
    },
  });
  restoreClipboard = () => {
    if (before) Object.defineProperty(navigator, 'clipboard', before);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  restoreClipboard?.();
  restoreClipboard = null;
  restoreGlobals?.();
  restoreGlobals = null;
});

function file(id: string, name: string, kind: string, extra: Partial<InboxAttachmentState> = {}): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/standup/${name}`,
    named_path: null,
    kind: kind as InboxAttachmentState['kind'],
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-26T10:00:00.000Z',
    sent_mtime: '2026-10-26T10:00:00.000Z',
    message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-26T10:00:00.000Z' },
    changed_since_sent: false,
    unavailable: null,
    ...extra,
  };
}

const SENT = '# Slack app manifest\r\ndisplay_information:\r\n  name: Standup  \r\n\tfeatures: {}\r\n';
const CURRENT = '# Slack app manifest\ndisplay_information:\n  name: Standup bot\n';
const manifest = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'manifest.yaml', 'text');
const changed = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'manifest.yaml', 'text', { changed_since_sent: true, current: { sha256: 'b'.repeat(64), size: 900, mtime: '2026-10-26T11:00:00.000Z' } });

function stubViews() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const sent = url.includes('version=sent');
    const att = [manifest, changed].find((a) => url.includes(a.id)) ?? manifest;
    return new Response(JSON.stringify({ attachment: att, version: sent ? att.sent_sha256 : 'current', text: sent ? SENT : CURRENT, html: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

async function openPane(attachment: InboxAttachmentState, options: { version?: 'current' | 'sent'; full?: boolean; readOnly?: boolean } = {}) {
  stubViews();
  const noop = () => {};
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AttachmentPane
        attachment={attachment}
        attachments={[attachment]}
        records={[]}
        agent="Claude Code"
        projectName="standup"
        projectRoot="/work/standup"
        version={options.version ?? 'current'}
        onVersion={noop}
        full={options.full ?? false}
        onToggleFull={noop}
        focusId={null}
        readOnly={options.readOnly ?? false}
        onSaved={noop}
        onRemoved={noop}
        onOpenAt={noop}
        onClose={noop}
        strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      />,
    );
  });
  await act(async () => {
    for (let i = 0; i < 200 && !host!.querySelector('[data-code-view] diffs-container') && !host!.querySelector('[data-attachment-pane] img, [data-attachment-pane] video'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
}

const copyButton = () => host!.querySelector<HTMLButtonElement>('[data-copy-file]');
const live = () => host!.querySelector('[data-step-live]')?.textContent ?? '';
async function press(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

test.skipIf(!hasDom)("a code file's top row leads with Copy file, before how to comment", async () => {
  await openPane(manifest);
  const row = host!.querySelector('[data-code-view] [data-code-row]');
  expect(row).not.toBeNull();
  const first = row!.firstElementChild;
  expect(first?.matches('[data-copy-file]')).toBe(true);
  expect(first!.textContent).toBe('Copy file');
  expect(row!.textContent).toContain('Click a line number');
});

test.skipIf(!hasDom)('a read-only code file keeps Copy file, without the comment hint', async () => {
  await openPane(manifest, { readOnly: true });
  expect(copyButton()?.textContent).toBe('Copy file');
  expect(host!.querySelector('[data-code-row]')!.textContent).not.toContain('Click a line number');
});

test.skipIf(!hasDom)('images, videos and documents get no Copy file (a document keeps its own)', async () => {
  for (const other of [
    file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'checkout.png', 'image', { media_type: 'image/png', width: 1280, height: 800 }),
    file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'demo.mp4', 'video', { media_type: 'video/mp4', width: 1920, height: 1080, duration_ms: 61_000 }),
    file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'plan.md', 'markdown'),
  ]) {
    await openPane(other);
    expect(host!.querySelector('[data-attachment-pane]')).not.toBeNull();
    expect(copyButton()).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
});

test.skipIf(!hasDom)('Copy file puts the raw text of the version on screen on the clipboard', async () => {
  await openPane(changed, { version: 'sent' });
  await press(copyButton()!);
  expect(written).toEqual([SENT]);
  act(() => root?.unmount());
  host?.remove();
  await openPane(changed, { version: 'current' });
  await press(copyButton()!);
  expect(written).toEqual([SENT, CURRENT]);
});

test.skipIf(!hasDom)('a press says Copied with a check and tells the live region, then goes back to Copy file', async () => {
  await openPane(manifest);
  await press(copyButton()!);
  expect(copyButton()!.textContent).toBe('Copied');
  expect(copyButton()!.getAttribute('data-copy-file')).toBe('copied');
  expect(live()).toBe('Copied manifest.yaml.');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, COPY_FILE_FEEDBACK_MS + 100));
  });
  expect(copyButton()!.textContent).toBe('Copy file');
});

test.skipIf(!hasDom)('a copy the browser refuses says so and is never reported as copied', async () => {
  await openPane(manifest);
  clipboardFails = true;
  const exec = (document as unknown as { execCommand?: unknown }).execCommand;
  (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
  try {
    await press(copyButton()!);
  } finally {
    (document as unknown as { execCommand?: unknown }).execCommand = exec;
  }
  expect(written).toEqual([]);
  expect(copyButton()!.textContent).toBe('Not copied');
  expect(live()).toContain('manifest.yaml was not copied');
});

function layOut(noteBottom: number, codeTop: number) {
  const real = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.matches('[data-full-view-changed]')) return { x: 12, y: noteBottom - 34, top: noteBottom - 34, left: 12, right: 300, bottom: noteBottom, width: 288, height: 34, toJSON() {} } as DOMRect;
    if (this.matches('[data-code-view]')) return { x: 0, y: codeTop, top: codeTop, left: 0, right: 1280, bottom: 800, width: 1280, height: 800 - codeTop, toJSON() {} } as DOMRect;
    return real.call(this);
  };
  restoreGlobals = () => {
    Element.prototype.getBoundingClientRect = real;
  };
}

test.skipIf(!hasDom)("in full screen the code's top row starts below the changed note, as tall as the note is", async () => {
  layOut(80, 0);
  await openPane(changed, { full: true });
  expect(host!.querySelector('[data-full-view-changed]')).not.toBeNull();
  const row = host!.querySelector<HTMLElement>('[data-code-row]')!;
  expect(parseFloat(row.style.paddingTop)).toBe(80 + CODE_ROW_BELOW_NOTE);
});

test.skipIf(!hasDom)('with no note to clear (beside the thread, or a file unchanged) the row keeps its own padding', async () => {
  layOut(80, 0);
  await openPane(changed, { full: false });
  expect(host!.querySelector<HTMLElement>('[data-code-row]')!.style.paddingTop).toBe('');
  act(() => root?.unmount());
  host?.remove();
  await openPane(manifest, { full: true });
  expect(host!.querySelector('[data-full-view-changed]')).toBeNull();
  expect(host!.querySelector<HTMLElement>('[data-code-row]')!.style.paddingTop).toBe('');
});

function watchTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const started = new Set<unknown>();
  const cleared = new Set<unknown>();
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const id = realSet(fn, ms, ...rest);
    if (ms === COPY_FILE_FEEDBACK_MS) started.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (started.has(id)) cleared.add(id);
    return realClear(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  const restore = restoreGlobals;
  restoreGlobals = () => {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    restore?.();
  };
  return { started, pending: () => [...started].filter((id) => !cleared.has(id)).length };
}

async function renderButton(text: string, announced: string[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const draw = (t: string) => root!.render(<CopyFileButton text={t} name={t === CURRENT ? 'b.yaml' : 'a.yaml'} sent={false} announce={(line) => announced.push(line)} />);
  await act(async () => {
    root = createRoot(host!);
    draw(text);
  });
  return { draw: (t: string) => act(() => draw(t)), button: () => host!.querySelector<HTMLButtonElement>('[data-copy-file]')! };
}

test.skipIf(!hasDom)('closing the file while Copied shows clears its timer', async () => {
  const timers = watchTimers();
  const announced: string[] = [];
  const { button } = await renderButton(SENT, announced);
  await press(button());
  expect(button().textContent).toBe('Copied');
  expect(timers.pending()).toBe(1);
  act(() => root!.unmount());
  root = null;
  expect(timers.pending()).toBe(0);
});

test.skipIf(!hasDom)('a copy that answers after the file closed says nothing and starts no timer', async () => {
  const timers = watchTimers();
  let answer: (() => void) | null = null;
  hold = (resolve) => {
    answer = resolve;
  };
  const announced: string[] = [];
  const { button } = await renderButton(SENT, announced);
  await act(async () => {
    button().click();
  });
  act(() => root!.unmount());
  root = null;
  await act(async () => {
    answer!();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(written).toEqual([SENT]);
  expect(announced).toEqual([]);
  expect(timers.started.size).toBe(0);
});

test.skipIf(!hasDom)('another file: Copied and its timer do not carry over, and a late answer for the last file says nothing', async () => {
  const timers = watchTimers();
  const announced: string[] = [];
  const { button, draw } = await renderButton(SENT, announced);
  await press(button());
  expect(button().textContent).toBe('Copied');
  draw(CURRENT);
  expect(button().textContent).toBe('Copy file');
  expect(timers.pending()).toBe(0);
  let answer: (() => void) | null = null;
  hold = (resolve) => {
    answer = resolve;
  };
  await act(async () => {
    button().click();
  });
  draw(SENT);
  await act(async () => {
    answer!();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(button().textContent).toBe('Copy file');
  expect(announced).toEqual(['Copied a.yaml.']);
  expect(timers.pending()).toBe(0);
});

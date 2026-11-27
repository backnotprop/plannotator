/**
 * The `/` skill list in an image's and a film's comment row (the owner: "calling skills from floating comment box is
 * something I want"). The rows take the reply's field (`InboxComposerField`), against the REAL views:
 *
 * - `/` opens the list in the image row and in the video row; a pick puts the skill's name in the words, painted as
 *   a reference, and a human-only skill shows "Includes skill instructions" under the field.
 * - Escape closes the list first, even before a query is typed, then leaves the image row for the file's pane.
 * - The submit key still saves the comment, with the skill's name in its words (Send reads it from there).
 * - The video row still pauses the film and pins the moment as the words come, and on a phone's full-screen card as
 *   the field takes focus.
 * - The rows list what the thread's Send honours (`ThreadSkillFilter`): `/review-recheck` only once a review happened.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No Inbox is started.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import type { FullScreenComposerValue } from './components/FullScreenComposer';
import { inboxSkillFilter } from './skills';

const hasDom = typeof document !== 'undefined';
const { ImageAttachmentView } = (hasDom ? await import('./components/ImageAttachmentView') : {}) as typeof import('./components/ImageAttachmentView');
const { VideoAttachmentView } = (hasDom ? await import('./components/VideoAttachmentView') : {}) as typeof import('./components/VideoAttachmentView');
const { ThreadSkillFilter } = (hasDom ? await import('./components/ComposerField') : {}) as typeof import('./components/ComposerField');
const { FullScreenComposerContext } = (hasDom ? await import('./components/FullScreenComposer') : {}) as typeof import('./components/FullScreenComposer');
const catalog = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');
const { configStore } = (hasDom ? await import('@plannotator/ui/config/configStore') : {}) as typeof import('@plannotator/ui/config/configStore');

const SKILLS: SkillCatalogEntry[] = [
  { name: 'review-recheck', root: 'plannotator', description: 'Only what changed since your last review', humanOnly: true },
  { name: 'readback', root: 'claude', description: 'Read it back', humanOnly: false },
  { name: 'write-better', root: 'claude', description: 'Improve prose', humanOnly: true },
];

const base = {
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  sent_at: '2026-10-15T10:42:00.000Z',
  sent_mtime: '2026-10-15T10:42:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  changed_since_sent: false,
  unavailable: null,
};
const picture: InboxAttachmentState = {
  ...base,
  id: 'att_01K7IIIIIIIIIIIIIIIIIIIIII',
  name: 'harbor-checkout.png',
  path: '/work/harbor/checkout.png',
  kind: 'image',
  media_type: 'image/png',
  width: 1280,
  height: 800,
  size: 80_000,
  current: { sha256: 'a'.repeat(64), size: 80_000, mtime: base.sent_mtime },
};
const film: InboxAttachmentState = {
  ...base,
  id: 'att_01K7VVVVVVVVVVVVVVVVVVVVVV',
  name: 'fern-api-launch.mp4',
  path: '/work/fern-api/launch.mp4',
  kind: 'video',
  media_type: 'video/mp4',
  duration_ms: 60_000,
  width: 1920,
  height: 1080,
  size: 1_000_000,
  current: { sha256: 'a'.repeat(64), size: 1_000_000, mtime: base.sent_mtime },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: (() => void)[] = [];
let pauses = 0;
const saved: Annotation[] = [];

beforeEach(() => {
  if (!hasDom) return;
  pauses = 0;
  saved.length = 0;
  // happy-dom has no media: the film's pause is counted.
  const previous = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause');
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, writable: true, value: () => { pauses++; } });
  restores.push(() => (previous ? Object.defineProperty(HTMLMediaElement.prototype, 'pause', previous) : undefined));
  catalog.resetSkillCatalogCache();
  catalog.setSkillCatalogTransport(async () => SKILLS);
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const restore of restores.splice(0).reverse()) restore();
  catalog.resetSkillCatalogTransport();
  catalog.resetSkillCatalogCache();
  await act(async () => configStore.set('enterSavesComment', false));
  document.body.replaceChildren();
});

async function render(node: ReactNode): Promise<void> {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await act(async () => {}); // the catalog's fetch
}

const onSave = async (annotation: Annotation) => {
  saved.push(annotation);
  return true;
};

/** The image view beside the thread: in its pane, which the row's Escape hands focus to. */
const imageRow = (filter?: (entry: SkillCatalogEntry) => boolean) => {
  const view = (
    <div data-attachment-pane={picture.id} tabIndex={-1}>
      <ImageAttachmentView attachment={picture} version="current" annotations={[]} selectedId={null} readOnly={false} onSave={onSave} onError={() => {}} />
    </div>
  );
  return filter ? <ThreadSkillFilter.Provider value={filter}>{view}</ThreadSkillFilter.Provider> : view;
};

const videoRow = (extra: { phone?: boolean; composer?: FullScreenComposerValue } = {}) => {
  const view = <VideoAttachmentView attachment={film} version="current" annotations={[]} selectedId={null} onSelect={() => {}} readOnly={false} onSave={onSave} onError={() => {}} phone={extra.phone} />;
  return extra.composer ? <FullScreenComposerContext.Provider value={extra.composer}>{view}</FullScreenComposerContext.Provider> : view;
};

const skillList = () => document.querySelector('[data-skill-menu]');
const listed = () => [...document.querySelectorAll('[data-skill-item]')].map((row) => row.getAttribute('data-skill-item'));
const field = (scope: string) => {
  const el = document.querySelector<HTMLTextAreaElement>(`${scope} textarea`);
  if (!el) throw new Error(`no field in ${scope}`);
  return el;
};

const setter = () => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;

/** Keys typed as the browser types them: the value and the caret, then `input` with its `inputType`. */
async function typeKeys(el: HTMLTextAreaElement, keys: string) {
  for (const ch of keys) {
    const at = el.selectionStart;
    await act(async () => {
      setter().call(el, el.value.slice(0, at) + ch + el.value.slice(at));
      el.setSelectionRange(at + 1, at + 1);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      document.dispatchEvent(new Event('selectionchange'));
    });
  }
}

async function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

async function pick(name: string) {
  const row = document.querySelector(`[data-skill-item="${name}"]`);
  expect(row).not.toBeNull();
  await act(async () => {
    row!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function focus(el: HTMLElement) {
  await act(async () => el.focus());
}

const noop = () => {};
/** Full screen's card on a phone, holding the row in its Comment tab. */
const phoneCard: FullScreenComposerValue = {
  threadId: 'thr_ledger',
  phone: true,
  fileKey: `${film.id}:current`,
  reply: {
    to: 'Claude Code',
    value: '',
    onChange: noop,
    onLateVoice: noop,
    onSend: noop,
    sending: false,
    canSend: false,
    picks: 0,
    annotations: 0,
    comments: { records: [], attachments: [], onEdit: async () => {}, onRemove: async () => {}, onOpen: noop, editing: null, onEditing: noop, list: null, onList: noop } as unknown as FullScreenComposerValue['reply']['comments'],
    actions: 0,
    files: [],
    onFiles: noop,
    onDropFiles: noop,
    onPaste: noop,
    onRemoveFile: noop,
    onPutBack: noop,
    openQuestions: 0,
    openActions: 0,
    conflict: false,
    error: null,
    sentAt: null,
    onOpenThread: noop,
  },
};

describe.if(hasDom)('an image comment row', () => {
  test('/ opens the skill list; a pick puts the name in the words, painted, with the human-only line', async () => {
    await render(imageRow());
    const el = field('[data-image-composer]');
    await focus(el);
    await typeKeys(el, 'Crop it, ');
    expect(skillList()).toBeNull();
    await typeKeys(el, '/');
    expect(skillList()).not.toBeNull();
    // Outside a review, as the thread's Send: no /review-recheck.
    expect(listed()).toEqual(['readback', 'write-better']);
    await pick('write-better');
    expect(el.value).toBe('Crop it, /write-better ');
    expect(skillList()).toBeNull();
    expect(document.querySelector('[data-image-composer] [data-skill-ref-token="write-better"]')).not.toBeNull();
    expect(document.querySelector('[data-image-composer] [data-skill-human-only-notice]')?.textContent).toContain('Includes skill instructions');
  });

  test('Escape closes the list first, before any query, and then leaves the row for the pane', async () => {
    await render(imageRow());
    const el = field('[data-image-composer]');
    await focus(el);
    await typeKeys(el, '/');
    expect(skillList()).not.toBeNull();
    const first = await press(el, 'Escape');
    expect(first.defaultPrevented).toBe(true);
    expect(skillList()).toBeNull();
    expect(document.activeElement).toBe(el);
    await press(el, 'Escape');
    expect(document.activeElement).toBe(document.querySelector(`[data-attachment-pane="${picture.id}"]`));
    // The words stay.
    expect(el.value).toBe('/');
  });

  test('the submit key still saves, with the skill in the words', async () => {
    await render(imageRow());
    const el = field('[data-image-composer]');
    await focus(el);
    await typeKeys(el, '/rea');
    await pick('readback');
    await typeKeys(el, 'the label');
    // Mod+Enter with the list shut, and with it open (no row arrowed onto): both save.
    await press(el, 'Enter', { metaKey: true });
    await act(async () => {});
    expect(saved.map((a) => a.text)).toEqual(['/readback the label']);
    await typeKeys(el, 'and /');
    expect(skillList()).not.toBeNull();
    await press(el, 'Enter', { ctrlKey: true });
    await act(async () => {});
    expect(saved.map((a) => a.text)).toEqual(['/readback the label', 'and /']);
  });

  test("the list follows the thread's Send: /review-recheck only once a review happened", async () => {
    await render(imageRow(inboxSkillFilter(true)));
    const el = field('[data-image-composer]');
    await focus(el);
    await typeKeys(el, '/');
    expect(listed()).toEqual(['review-recheck', 'readback', 'write-better']);
  });
});

describe.if(hasDom)('a video comment row', () => {
  test('/ opens the skill list and a pick inserts the skill; typing pauses the film and pins the moment', async () => {
    await render(videoRow());
    const el = field('[data-video-composer]');
    await focus(el);
    expect(pauses).toBe(0);
    await typeKeys(el, '/');
    expect(skillList()).not.toBeNull();
    expect(pauses).toBe(1);
    expect(document.querySelector('[data-video-composer] [data-video-time]')?.hasAttribute('data-pinned')).toBe(true);
    await pick('readback');
    expect(el.value).toBe('/readback ');
    expect(document.querySelector('[data-video-composer] [data-skill-ref-token="readback"]')).not.toBeNull();
    // Escape closes the list and keeps the moment.
    await typeKeys(el, '/');
    await press(el, 'Escape');
    expect(skillList()).toBeNull();
    expect(document.querySelector('[data-video-composer] [data-video-time]')?.hasAttribute('data-pinned')).toBe(true);
    await press(el, 'Enter', { metaKey: true });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(saved.map((a) => a.text)).toEqual(['/readback /']);
  });

  test('the list spans the whole card, not the narrow field between the time chip, the frame and the buttons', async () => {
    // A laid-out row: the card 520 px wide, the field squeezed to 160 px inside it.
    const previous = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!;
    const own = previous.value as (this: Element) => DOMRect;
    const rect = (left: number, width: number) => ({ top: 600, bottom: 646, left, right: left + width, width, height: 46, x: left, y: 600, toJSON() {} }) as DOMRect;
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value(this: Element) {
        if (this.classList.contains('ib-ccard')) return rect(40, 520);
        if (this.classList.contains('ib-cfield')) return rect(150, 160);
        return own.call(this);
      },
    });
    restores.push(() => Object.defineProperty(Element.prototype, 'getBoundingClientRect', previous));
    await render(videoRow());
    const el = field('[data-video-composer]');
    await focus(el);
    await typeKeys(el, '/');
    expect(skillList()).not.toBeNull();
    const anchor = document.querySelector<HTMLElement>('[data-skill-menu-anchor]')!;
    expect(anchor.style.width).toBe('520px');
    expect(anchor.style.left).toBe('40px');
  });

  test("on a phone's full-screen card, the field taking focus pauses the film and pins the moment", async () => {
    await render(videoRow({ phone: true, composer: phoneCard }));
    const el = field('[data-fcomp] [data-video-composer]');
    expect(document.querySelector('[data-fcomp] [data-video-composer] [data-video-time]')?.hasAttribute('data-pinned')).toBe(false);
    await focus(el);
    expect(pauses).toBe(1);
    expect(document.querySelector('[data-fcomp] [data-video-composer] [data-video-time]')?.hasAttribute('data-pinned')).toBe(true);
    await typeKeys(el, '/');
    expect(skillList()).not.toBeNull();
  });
});

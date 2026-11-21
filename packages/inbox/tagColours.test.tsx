/**
 * Tag row colours in the window (approval "inbox-thread-tags", step 3, look C; the list ⋮'s "Show tag colors"). What
 * this catches: a row in a coloured tag left plain, or tinted with the wrong tag's colour, or naming no tag, in any of
 * the three row shapes; a tag's own list tinting every row with that tag; the switch off still tinting; the colour
 * menu unreachable by keyboard or losing its place; a pick not written to the linked machine that holds the tag; a
 * pick on the square lost or written once per arrow step; and a list read with the same colours drawing all 200+ rows
 * again (ListRow's memo). The pick-to-row mapping and its contrast: tagColourMap.test.ts.
 *
 * DOM-gated parts run under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { drawsDuring } from '../../tests/helpers/react-draws';
import { afterEach, expect, test } from 'bun:test';
import { inboxTagLookColour, type InboxInitiative, type InboxListRow, type InboxListSection, type InboxTagColours } from '@plannotator/core/inbox-types';
import type { MachinesModel } from './machines';
import type { ListTag } from './threadTags';
import { rowTint, rowTintTitle, tintAttrs } from './tagColours';
import type { ListTagColours, TagColourControls } from './useThreadTagsHost';
import { LIST_LOOK_DEFAULT } from './listLook';

const hasDom = typeof document !== 'undefined';
const { act, useMemo } = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { TidyMenu } = (hasDom ? await import('./components/Tidy') : {}) as typeof import('./components/Tidy');
const { TagsSection } = (hasDom ? await import('./components/TagsSection') : {}) as typeof import('./components/TagsSection');
const { useThreadTagsHost } = (hasDom ? await import('./useThreadTagsHost') : {}) as typeof import('./useThreadTagsHost');
const { tagsAcross } = (hasDom ? await import('./tagsAcross') : {}) as typeof import('./tagsAcross');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const SELF = 'ibx_self';
const MAC = 'ibx_mac';
const tag = (id: string, name: string, colour: string | null, machines?: Record<string, string>): ListTag =>
  ({
    id,
    name,
    created_at: '2026-11-12T09:00:00.000Z',
    created_by: { kind: 'person' },
    updated_at: '2026-11-12T09:00:00.000Z',
    deleted_at: null,
    look: { colour, by: 'auto', at: '2026-11-12T09:00:00.000Z' },
    ...(machines ? { machines } : {}),
  }) as ListTag;
const RELEASE = tag('ini_release', 'Release', 'green', { [SELF]: 'ini_release', [MAC]: 'ini_m_release' });
const DOCS = tag('ini_docs', 'Docs move', null);
const WINDOWS = tag('ini_windows', 'Windows', 'amber');
const TAGS = [RELEASE, DOCS, WINDOWS];
const colourIn = (tags: readonly ListTag[]) => (id: string) => tags.find((t) => t.id === id)?.look?.colour ?? null;

function row(id: string, tags: string[]): InboxListRow {
  return {
    thread_id: id,
    project_id: `prj_${id}`,
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-11-12T10:00:00.000Z',
    last_at: '2026-11-12T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: `prj_${id}`, name: 'app' },
    thread_name: null,
    section: 'new',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    tags,
  } as InboxListRow;
}

test('a row takes the colour of its first coloured tag by name; the others are named; the tag whose list it is steps aside', () => {
  const colourOf = colourIn(TAGS);
  expect(rowTint([WINDOWS.id, RELEASE.id], TAGS, colourOf, null)).toEqual({ colour: 'green', name: 'Release', also: ['Windows'] });
  // Another machine lists its tags in another order: the row still leads with the same tag.
  expect(rowTint([WINDOWS.id, RELEASE.id], [...TAGS].reverse(), colourOf, null)).toEqual({ colour: 'green', name: 'Release', also: ['Windows'] });
  // A tag set to None gives no colour and is not named.
  expect(rowTint([DOCS.id, WINDOWS.id], TAGS, colourOf, null)).toEqual({ colour: 'amber', name: 'Windows', also: [] });
  expect(rowTint([DOCS.id], TAGS, colourOf, null)).toBeNull();
  // In Release's own list every row has Release: the next coloured tag tints, or none.
  expect(rowTint([RELEASE.id, WINDOWS.id], TAGS, colourOf, RELEASE.id)).toEqual({ colour: 'amber', name: 'Windows', also: [] });
  expect(rowTint([RELEASE.id], TAGS, colourOf, RELEASE.id)).toBeNull();
  expect(rowTintTitle({ colour: 'green', name: 'Release', also: ['Windows'] })).toBe('Highlighted: Release, Green. Also in Windows');
  expect(rowTintTitle({ colour: '#ff6a00', name: 'Release', also: [] })).toBe('Highlighted: Release, Custom #ff6a00');
});

test('a colour is drawn by its stored value: a name keeps its name, a code its code', () => {
  expect(tintAttrs('green')).toEqual({ 'data-tint': 'green' });
  expect(tintAttrs('#ff6a00')).toEqual({ 'data-tint': '#ff6a00' });
});

/** The four fills the tint sheet holds for one stored colour. */
const sheetFills = (colour: string) => {
  const text = [...document.querySelectorAll('style[data-tag-tints], style[data-tag-tints-tried]')].map((el) => el.textContent).join('\n');
  const rule = new RegExp(`\\[data-tint="${colour}"\\]\\{([^}]*)\\}`).exec(text)?.[1] ?? '';
  return [0, 1, 2, 3].map((i) => new RegExp(`--ib-tint-${i}:(#[0-9a-f]{6})`).exec(rule)?.[1]);
};

test.skipIf(!hasDom)('the tint sheet holds each drawn colour’s four fills, a stored name as its hue’s calm colour, and rewrites them when the mode changes', async () => {
  const { INBOX_TAG_PRESET_HEX } = await import('@plannotator/core/inbox-types');
  const html = document.documentElement;
  const wasLight = html.classList.contains('light');
  try {
    html.classList.remove('light');
    tintAttrs('#ff6a00');
    tintAttrs('green');
    tintAttrs(INBOX_TAG_PRESET_HEX.green);
    const dark = sheetFills('#ff6a00');
    expect(dark.every(Boolean)).toBe(true);
    // Dark: each state a step lighter than the last.
    expect(new Set(dark).size).toBe(4);
    expect(sheetFills('green')).toEqual(sheetFills(INBOX_TAG_PRESET_HEX.green));
    html.classList.add('light');
    await new Promise((r) => setTimeout(r, 50));
    const light = sheetFills('#ff6a00');
    expect(light.every(Boolean)).toBe(true);
    expect(light).not.toEqual(dark);
  } finally {
    html.classList.toggle('light', wasLight);
  }
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
const savedFetch = globalThis.fetch;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
});

function draw(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 60; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

async function press(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to press');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const listColours = (tags: readonly ListTag[], listed: string | null = null): ListTagColours => ({
  show: true,
  setShow: () => {},
  tintOf: (r) => rowTint(r.tags ?? [], tags, colourIn(tags), listed),
});

function List(props: { rows: InboxListRow[]; colours?: ListTagColours; narrow?: boolean; phone?: boolean; selected?: string | null }) {
  const sections: InboxListSection[] = [{ id: 'new', label: 'New', threads: props.rows }];
  return (
    <SidebarProvider>
    <InboxList
      title="Inbox"
      path={null}
      sections={sections}
      filtered={false}
      narrow={props.narrow ?? false}
      selectedThreadId={props.selected ?? null}
      notice={null}
      onShowNew={() => {}}
      onOpen={() => {}}
      phone={props.phone ?? false}
      tagColours={props.colours}
    />
    </SidebarProvider>
  );
}

const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;

test.skipIf(!hasDom)('the tint sheet stays small: 300 colours tried on the square leave the stored colours and a few others; a colour no tag holds any more is dropped', async () => {
  const { keepTints, tintRuleCount, TRANSIENT_MAX } = await import('./tagTintSheet');
  keepTints([{ key: '#0b9488', hex: '#0b9488' }, { key: 'green', hex: '#8ed09c' }]);
  for (let i = 0; i < 300; i++) tintAttrs(`#${(0x103000 + i * 97).toString(16).padStart(6, '0')}`);
  expect(tintRuleCount()).toBeLessThanOrEqual(2 + TRANSIENT_MAX);
  expect(sheetFills('#0b9488').every(Boolean)).toBe(true);
  // The latest one tried still draws.
  expect(sheetFills(`#${(0x103000 + 299 * 97).toString(16).padStart(6, '0')}`).every(Boolean)).toBe(true);
  // A pick lands on the tag: its colour is kept; the one it replaced goes.
  keepTints([{ key: '#ff6a00', hex: '#ff6a00' }, { key: 'green', hex: '#8ed09c' }]);
  expect(sheetFills('#ff6a00').every(Boolean)).toBe(true);
  expect(sheetFills('#0b9488').some(Boolean)).toBe(false);
  expect(tintRuleCount()).toBeLessThanOrEqual(2 + TRANSIENT_MAX);
});

test.skipIf(!hasDom)('wide, three-line and phone rows: tinted whole with the tag’s name, before the time where the time is on line one; a plain row stays plain', async () => {
  const rows = [row('a', [RELEASE.id, WINDOWS.id]), row('b', [WINDOWS.id]), row('c', []), row('d', [DOCS.id])];
  for (const shape of ['wide', 'narrow', 'phone'] as const) {
    draw(<List rows={rows} colours={listColours(TAGS)} narrow={shape === 'narrow'} phone={shape === 'phone'} selected="a" />);
    expect(rowEl('a').getAttribute('data-tint')).toBe('green');
    expect(rowEl('b').getAttribute('data-tint')).toBe('amber');
    expect(rowEl('c').hasAttribute('data-tint')).toBe(false);
    expect(rowEl('d').hasAttribute('data-tint')).toBe(false);
    const name = rowEl('a').querySelector<HTMLElement>('[data-row-tag]')!;
    expect(name.textContent).toBe('Release +1');
    expect(name.title).toBe('Highlighted: Release, Green. Also in Windows');
    expect(rowEl('c').querySelector('[data-row-tag]')).toBeNull();
    if (shape === 'wide') expect(name.parentElement!.classList.contains('ib-cw')).toBe(true);
    else expect(name.nextElementSibling?.classList.contains('ib-t')).toBe(true);
    // The selection is still the row's own state (its class), the tint drawn under it.
    if (shape !== 'phone') expect(rowEl('a').classList.contains('ib-sel')).toBe(true);
    act(() => root!.unmount());
    host!.remove();
    root = null;
  }
});

test.skipIf(!hasDom)('an own colour on a row carries its code, and the sheet has its fills by its first paint; no colours (switch off, or an older Inbox) draws no tint and no name', () => {
  const own = [tag(RELEASE.id, 'Release', '#ff6b01'), DOCS, WINDOWS];
  draw(<List rows={[row('a', [RELEASE.id])]} colours={listColours(own)} />);
  expect(rowEl('a').getAttribute('data-tint')).toBe('#ff6b01');
  expect(sheetFills('#ff6b01').every(Boolean)).toBe(true);
  act(() => root!.render(<List rows={[row('a', [RELEASE.id])]} colours={{ ...listColours(own), show: false, tintOf: () => null }} />));
  expect(rowEl('a').hasAttribute('data-tint')).toBe(false);
  expect(rowEl('a').querySelector('[data-row-tag]')).toBeNull();
  act(() => root!.render(<List rows={[row('a', [RELEASE.id])]} />));
  expect(rowEl('a').hasAttribute('data-tint')).toBe(false);
});

test.skipIf(!hasDom)('220 rows: a list read with the same colours draws no row again; a tag’s new colour draws only its rows', async () => {
  const rows = Array.from({ length: 220 }, (_, i) => row(`r${i}`, i % 3 === 0 ? [RELEASE.id] : i % 3 === 1 ? [WINDOWS.id] : []));
  draw(<List rows={rows} colours={listColours(TAGS)} />);
  const same = await drawsDuring(() => act(() => root!.render(<List rows={rows.map((r) => ({ ...r }))} colours={listColours(TAGS.map((t) => ({ ...t })))} />)));
  expect(same.get('ListRow') ?? 0).toBe(0);
  const recoloured = [tag(RELEASE.id, 'Release', 'red'), DOCS, WINDOWS];
  const changed = await drawsDuring(() => act(() => root!.render(<List rows={rows} colours={listColours(recoloured)} />)));
  expect(changed.get('ListRow') ?? 0).toBeLessThanOrEqual(rows.filter((r) => r.tags?.includes(RELEASE.id)).length);
  expect(changed.get('ListRow') ?? 0).toBeGreaterThan(0);
});

test.skipIf(!hasDom)('the list ⋮ has "Show tag colors" in Rows, ticked while on; a tick turns it off and the menu stays open', async () => {
  const set: boolean[] = [];
  const tidy = { surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} } as never;
  draw(<TidyMenu tidy={tidy} phone={false} className="ib-lhead-more" onRefresh={() => {}} look={LIST_LOOK_DEFAULT} onLook={() => {}} tagColours={{ on: true, onChange: (on) => set.push(on) }} />);
  await press(host!.querySelector('[data-tidy-menu]'));
  await until(() => !!document.querySelector('[data-tag-colours-option]'), 'the ⋮ menu');
  const item = document.querySelector<HTMLElement>('[data-tag-colours-option]')!;
  expect(item.getAttribute('role')).toBe('menuitemcheckbox');
  expect(item.getAttribute('aria-checked')).toBe('true');
  expect(item.textContent).toBe('Show tag colors');
  expect(item.closest('[role="group"]')?.textContent).toContain('Rows');
  await press(item);
  expect(set).toEqual([false]);
  expect(document.querySelector('[data-tag-colours-option]')).not.toBeNull();
});

const tagRow = (id: string) => document.querySelector<HTMLElement>(`[data-tag-row="${id}"]`);
const tagMenu = () => document.querySelector<HTMLElement>('[data-tag-menu]');

function Section({ colours }: { colours: TagColourControls }) {
  return (
    <TagsSection
      tags={TAGS as InboxInitiative[]}
      waiting={new Map()}
      tagId={null}
      closed={false}
      onToggle={() => {}}
      header={<button type="button" data-sidebar-section="tags">Tags</button>}
      labelId="tags-l"
      bodyId="tags-b"
      phone={false}
      pick={(go) => go}
      onOpen={() => {}}
      onCreate={async () => null}
      onRename={async () => true}
      onDelete={() => {}}
      colours={colours}
    />
  );
}

/** The colour controls the sidebar gets, recording what is written: picks, Highlight rows, previews. */
function controlsOf(tags: readonly ListTag[], recent: string[] = []) {
  const picks: string[] = [];
  const highlights: boolean[] = [];
  const previews: (string | null | undefined)[] = [];
  // As the host does: a pick shows at once (and turns Highlight rows on).
  const picked = new Map<string, string>();
  const colours: TagColourControls = {
    show: true,
    colourOf: (id) => picked.get(id) ?? colourIn(tags)(id),
    pickOf: (id) => picked.get(id) ?? inboxTagLookColour(tags.find((t) => t.id === id)?.look) ?? '#14cc61',
    recent,
    set: (t, c) => {
      picks.push(c);
      picked.set(t.id, c);
    },
    highlight: (_t, on) => void highlights.push(on),
    preview: (_t, c) => void previews.push(c),
  };
  return { colours, picks, highlights, previews };
}

test.skipIf(!hasDom)('a sidebar tag wears its colour; its menu has Highlight rows (a checkbox, at once) and Color (the colour named); Color opens the picker in place: twelve swatches, own colours, square, strip, Hex, no None', async () => {
  const { colours, picks, highlights, previews } = controlsOf(TAGS, ['#0b1e4a']);
  draw(<Section colours={colours} />);
  expect(tagRow(RELEASE.id)!.getAttribute('data-tint')).toBe('green');
  expect(tagRow(DOCS.id)!.hasAttribute('data-tint')).toBe(false);
  await act(async () => {
    tagRow(RELEASE.id)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => !!tagMenu(), 'the tag menu');
  expect([...tagMenu()!.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map((el) => el.textContent?.trim())).toEqual(['Show threads', 'Rename', 'Highlight rows', 'ColorGreen', 'Delete tag']);
  const highlight = tagMenu()!.querySelector<HTMLElement>('[data-tag-action="highlight"]')!;
  expect(highlight.getAttribute('role')).toBe('menuitemcheckbox');
  expect(highlight.getAttribute('aria-checked')).toBe('true');
  // Highlight rows off: written at once, no submenu, the menu stays open.
  await press(highlight);
  expect(highlights).toEqual([false]);
  expect(tagMenu()).not.toBeNull();
  await press(tagMenu()!.querySelector('[data-tag-action="colour"]'));
  await until(() => !!tagMenu()?.querySelector('[data-tag-colour-list]'), 'the colours');
  const list = tagMenu()!.querySelector<HTMLElement>('[data-tag-colour-list]')!;
  expect(list.querySelector('[data-tag-colour-back]')!.textContent?.trim()).toBe('Color');
  expect(list.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Color for Release');
  const radios = [...list.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  // Twelve quick swatches (vivid, then calm); Release's stored "green" (an earlier Inbox's name) shows as its calm
  // colour among the own ones, named Green; then the recent own colour. No None: Highlight rows turns it off.
  expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Red', 'Amber', 'Green', 'Teal', 'Blue', 'Violet', 'Orange', 'Lime', 'Cyan', 'Indigo', 'Pink', 'Grey', 'Green', 'Custom #0b1e4a']);
  expect(list.querySelector('[data-colour="none"]')).toBeNull();
  const stored = list.querySelector<HTMLElement>('[data-colour="#8ed09c"]')!;
  expect(stored.getAttribute('aria-checked')).toBe('true');
  expect(list.querySelector('[data-tag-colour-caption]')!.textContent).toBe('Green: rows tagged Release');
  await until(() => document.activeElement === stored, 'focus on the colour that is on');
  // A pick is written and the menu stays open.
  await press(list.querySelector('[data-colour="#d6a20a"]'));
  expect(picks).toEqual(['#d6a20a']);
  expect(tagMenu()?.querySelector('[data-tag-colour-list]')).not.toBeNull();
  // By keyboard, past the square: Down from the last swatch to the strip, the Hex field, and back up. Moving focus
  // changes no colour: nothing is written and nothing is shown on the rows.
  const last = list.querySelector<HTMLElement>('[data-colour="#0b1e4a"]')!;
  const square = list.querySelector<HTMLElement>('[data-tag-colour-square]')!;
  const strip = list.querySelector<HTMLInputElement>('[data-tag-colour-hue]')!;
  const hex = list.querySelector<HTMLInputElement>('[data-tag-colour-hex]')!;
  act(() => last.focus());
  const before = { picks: picks.length, previews: previews.length, square: square.getAttribute('aria-valuetext'), hue: strip.value };
  await key(last, 'ArrowDown');
  expect(document.activeElement).toBe(strip);
  expect(strip.getAttribute('aria-label')).toBe('Hue');
  await key(strip, 'ArrowDown');
  expect(document.activeElement).toBe(hex);
  await key(hex, 'ArrowDown');
  expect(document.activeElement).toBe(hex);
  await key(hex, 'ArrowUp');
  expect(document.activeElement).toBe(strip);
  await key(strip, 'ArrowUp');
  expect(document.activeElement).toBe(last);
  expect({ picks: picks.length, previews: previews.length, square: square.getAttribute('aria-valuetext'), hue: strip.value }).toEqual(before);
  // The square is the Tab stop after the swatches (a swatch's Tab goes to it, not out of the menu), before the strip;
  // Shift+Tab from a swatch goes back round to the field. Reaching it changes nothing either.
  expect(square.tabIndex).toBe(0);
  expect(square.getAttribute('role')).toBe('slider');
  expect(square.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await key(last, 'Tab');
  expect(document.activeElement).toBe(square);
  act(() => last.focus());
  await act(async () => {
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(hex);
  expect({ picks: picks.length, previews: previews.length, square: square.getAttribute('aria-valuetext'), hue: strip.value }).toEqual(before);
  // A typed code, in any case, is kept on Enter.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(hex, '#FF6A00');
    hex.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await key(hex, 'Enter');
  expect(picks).toEqual(['#d6a20a', '#ff6a00']);
  // A screen reader's swipe moves the strip with no key and no pointer: written once it rests.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(strip, '200');
    strip.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(picks).toHaveLength(2);
  await until(() => picks.length === 3, 'the swipe kept');
  expect(picks.at(-1)).toMatch(/^#[0-9a-f]{6}$/);
  // A code pasted with spaces around it is trimmed (never cut short to "  #00FF") and kept; one without "#" too.
  const typeHex = (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(hex, text);
      hex.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await typeHex('  #00FF88  ');
  expect(hex.value).toBe('#00FF88');
  await key(hex, 'Enter');
  expect(picks.at(-1)).toBe('#00ff88');
  await typeHex(' 1a2b3c ');
  expect(hex.value).toBe('1a2b3c');
  await key(hex, 'Enter');
  expect(picks.at(-1)).toBe('#1a2b3c');
  // A key typed into the middle of a whole code is refused: it never pushes the last letter out.
  expect(hex.value).toBe('#1a2b3c');
  await typeHex('#1a2b93c');
  expect(hex.value).toBe('#1a2b3c');
  // Back: the menu again, focus on Color.
  await press(list.querySelector('[data-tag-colour-back]'));
  await until(() => document.activeElement === tagMenu()?.querySelector('[data-tag-action="colour"]'), 'focus back on Color');
});

async function openColours(colours: TagColourControls): Promise<HTMLElement> {
  draw(<Section colours={colours} />);
  await act(async () => {
    tagRow(RELEASE.id)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => !!tagMenu(), 'the tag menu');
  await press(tagMenu()!.querySelector('[data-tag-action="colour"]'));
  await until(() => !!tagMenu()?.querySelector('[data-tag-colour-list]'), 'the colours');
  return tagMenu()!.querySelector<HTMLElement>('[data-tag-colour-list]')!;
}

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

test.skipIf(!hasDom)('the square: its arrows move it by 1% and stay in it at its edges, shown at once and written once when the keys rest; a drag is written once, when let go; a tap that moves nothing writes nothing', async () => {
  const teal = [tag(RELEASE.id, 'Release', '#0b9488'), DOCS, WINDOWS];
  const { colours, picks, previews } = controlsOf(teal);
  const list = await openColours(colours);
  const square = list.querySelector<HTMLElement>('[data-tag-colour-square]')!;
  expect(square.getAttribute('aria-label')).toBe('Color');
  // #0b9488: saturation 93%, brightness 58%.
  expect(square.getAttribute('aria-valuetext')).toBe('Saturation 93%, brightness 58%');
  act(() => square.focus());
  await key(square, 'ArrowRight');
  expect(square.getAttribute('aria-valuetext')).toBe('Saturation 94%, brightness 58%');
  await key(square, 'ArrowUp');
  await key(square, 'ArrowLeft');
  await key(square, 'ArrowLeft');
  expect(square.getAttribute('aria-valuetext')).toBe('Saturation 92%, brightness 59%');
  // Each step shows on the rows at once; none is written yet, and focus stayed in the square.
  expect(previews.filter(Boolean)).toHaveLength(4);
  expect(picks).toEqual([]);
  expect(document.activeElement).toBe(square);
  await until(() => picks.length === 1, 'the square written once it rests');
  expect(picks[0]).toBe(previews.filter(Boolean).at(-1)!);
  // At the top edge Up stays in the square and changes nothing; so does Down at the bottom.
  for (let i = 0; i < 5; i++) await key(square, 'PageUp');
  expect(square.getAttribute('aria-valuetext')).toBe('Saturation 92%, brightness 100%');
  const shown = previews.length;
  await key(square, 'ArrowUp');
  expect(document.activeElement).toBe(square);
  expect(previews).toHaveLength(shown);
  await until(() => picks.length === 2, 'the edge move written once');
  for (let i = 0; i < 11; i++) await key(square, 'PageDown');
  await key(square, 'ArrowDown');
  expect(document.activeElement).toBe(square);
  expect(square.getAttribute('aria-valuetext')).toBe('Saturation 92%, brightness 0%');
  await until(() => picks.length === 3, 'the bottom move written once');
  expect(picks[2]).toBe('#000000');
  // A drag: the rows follow every move, and one colour is written, when let go (top right: the hue at full strength).
  square.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const pointer = (type: string, x: number, y: number) =>
    act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      square.dispatchEvent(event);
    });
  const dragFrom = previews.length;
  await pointer('pointerdown', 20, 80);
  for (const [x, y] of [[60, 60], [100, 40], [150, 20], [200, 0]] as const) await pointer('pointermove', x, y);
  expect(square.getAttribute('aria-valuetext')).toBe('Saturation 100%, brightness 100%');
  expect(previews.length - dragFrom).toBe(5);
  expect(picks).toHaveLength(3);
  await pointer('pointerup', 200, 0);
  expect(picks).toHaveLength(4);
  expect(picks.at(-1)).not.toBe('#000000');
  await wait(900);
  expect(picks).toHaveLength(4);
  // A tap on the thumb where it is: nothing written.
  await pointer('pointerdown', 200, 0);
  await pointer('pointerup', 200, 0);
  expect(picks).toHaveLength(4);
});

test.skipIf(!hasDom)('a swatch stays exactly itself: a tap on the hue thumb writes nothing, and the strip moved away and back by keys writes nothing (no Custom near-twin)', async () => {
  const teal = [tag(RELEASE.id, 'Release', '#0b9488'), DOCS, WINDOWS];
  const { colours, picks, previews } = controlsOf(teal);
  const list = await openColours(colours);
  const strip = list.querySelector<HTMLInputElement>('[data-tag-colour-hue]')!;
  const tap = (type: string) => act(async () => void strip.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })));
  await tap('pointerdown');
  await tap('pointerup');
  await wait(900);
  expect(picks).toEqual([]);
  // The rows went back to the tag's colour.
  expect(previews.at(-1)).toBeUndefined();
  const hue = Number(strip.value);
  const move = async (to: number) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(strip, String(to));
      strip.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await move(hue + 1);
  await move(hue);
  await wait(900);
  expect(picks).toEqual([]);
  expect(list.querySelector<HTMLInputElement>('[data-tag-colour-hex]')!.value).toBe('#0b9488');
});

test.skipIf(!hasDom)('with Highlight rows off, the Color item still names the tag’s colour and the picker checks it; picking turns it on (a pick, written), and so does the checked swatch pressed again', async () => {
  const off = [{ ...tag(RELEASE.id, 'Release', null), look: { colour: null, by: 'person', at: '2026-11-16T10:00:00.000Z', kept_colour: '#0b9488' } } as ListTag, DOCS, WINDOWS];
  const { colours, picks, highlights } = controlsOf(off);
  draw(<Section colours={colours} />);
  // The sidebar tag is plain while off.
  expect(tagRow(RELEASE.id)!.hasAttribute('data-tint')).toBe(false);
  await act(async () => {
    tagRow(RELEASE.id)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => !!tagMenu(), 'the tag menu');
  expect(tagMenu()!.querySelector('[data-tag-action="highlight"]')!.getAttribute('aria-checked')).toBe('false');
  expect(tagMenu()!.querySelector('[data-tag-action="colour"]')!.textContent?.trim()).toBe('ColorTeal');
  await press(tagMenu()!.querySelector('[data-tag-action="colour"]'));
  await until(() => !!tagMenu()?.querySelector('[data-tag-colour-list]'), 'the colours');
  const list = tagMenu()!.querySelector<HTMLElement>('[data-tag-colour-list]')!;
  expect(list.querySelector('[data-colour="#0b9488"]')!.getAttribute('aria-checked')).toBe('true');
  expect(list.querySelector('[data-tag-colour-caption]')!.textContent).toBe('Off: rows look as usual');
  await press(list.querySelector('[data-colour="#0b9488"]'));
  expect(picks).toEqual(['#0b9488']);
  await press(list.querySelector('[data-colour="#047df1"]'));
  expect(picks).toEqual(['#0b9488', '#047df1']);
  expect(highlights).toEqual([]);
});

test.skipIf(!hasDom)('"Show tag colors" off hides the sidebar tags’ colours too', () => {
  draw(<Section colours={{ ...controlsOf(TAGS).colours, show: false }} />);
  expect(tagRow(RELEASE.id)!.hasAttribute('data-tint')).toBe(false);
});

const MACHINES = { self: SELF, linked: [{ id: MAC, name: 'Mac', marks: ['tags', 'tag-colours'] }], names: new Map([[MAC, 'Mac']]), away: new Set<string>() } as unknown as MachinesModel;
let hosted: ReturnType<typeof useThreadTagsHost> | null = null;
function HostHarness({ tags, colours }: { tags: readonly ListTag[]; colours: InboxTagColours | null }) {
  const across = useMemo(() => tagsAcross(tags, MACHINES), [tags]);
  hosted = useThreadTagsHost({
    listTags: tags,
    across,
    routeTag: null,
    machines: MACHINES,
    windowRows: [],
    latestSections: [],
    rowOf: () => undefined,
    showError: () => {},
    showToast: () => {},
    dismissToast: () => {},
    refreshList: async () => {},
    openTag: () => {},
    tagGone: () => {},
    tagColours: colours,
  });
  return null;
}

test.skipIf(!hasDom)('the switch and a pick show at once and are written here and to the linked machine that takes them, by its id there', async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ tag_colours: { show: true, show_at: null, recent: [] }, look: { colour: null, by: 'person', at: '2026-11-13T10:00:00.000Z' } });
  }) as typeof fetch;
  draw(<HostHarness tags={TAGS} colours={{ show: true, show_at: null, recent: [] }} />);
  const tagged = row('a', [RELEASE.id]);
  expect(hosted!.listColours!.tintOf(tagged)?.colour).toBe('green');
  await act(async () => hosted!.listColours!.setShow!(false));
  await until(() => sent.length === 2, 'the switch written');
  expect(sent.map((s) => [s.url, s.body.show])).toEqual([
    ['/api/inbox/tag-colours', false],
    [`/api/inbox/m/${MAC}/tag-colours`, false],
  ]);
  sent.length = 0;
  await act(async () => hosted!.sidebarTags!.colours!.set(RELEASE, '#ff6a00'));
  await until(() => sent.length === 2, 'the pick written');
  expect(sent.map((s) => [s.url, s.body.tag, s.body.colour])).toEqual([
    ['/api/inbox/tag-colours', RELEASE.id, '#ff6a00'],
    [`/api/inbox/m/${MAC}/tag-colours`, 'ini_m_release', '#ff6a00'],
  ]);
  // Both carry the one time the person chose, so every machine settles on the same pick.
  expect(sent[0]!.body.at).toBe(sent[1]!.body.at as string);
});

test.skipIf(!hasDom)('Highlight rows off keeps the colour: written as off (null) with the colour kept, rows plain at once, the Color item still naming it; on again brings it back', async () => {
  const sent: Record<string, unknown>[] = [];
  // Each write waits until let through, so what the window shows meanwhile can be read.
  const gates: (() => void)[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (!String(url).includes('/m/')) sent.push(JSON.parse(String(init.body)));
    await new Promise<void>((r) => gates.push(r));
    return Response.json({ tag_colours: { show: true, show_at: null, recent: [] }, look: { colour: null, by: 'person', at: '2026-11-16T10:00:00.000Z' } });
  }) as typeof fetch;
  draw(<HostHarness tags={TAGS} colours={{ show: true, show_at: null, recent: [] }} />);
  const tagged = row('a', [RELEASE.id]);
  act(() => hosted!.sidebarTags!.colours!.highlight(RELEASE, false));
  expect(hosted!.listColours!.tintOf(tagged)).toBeNull();
  expect(hosted!.sidebarTags!.colours!.pickOf(RELEASE.id)).toBe('green');
  await until(() => sent.length === 1, 'off written');
  expect(sent[0]).toMatchObject({ tag: RELEASE.id, colour: null, kept_colour: 'green' });
  act(() => hosted!.sidebarTags!.colours!.highlight(RELEASE, true));
  expect(hosted!.listColours!.tintOf(tagged)?.colour).toBe('green');
  await until(() => sent.length === 2, 'on written');
  expect(sent[1]).toMatchObject({ tag: RELEASE.id, colour: 'green' });
  expect('kept_colour' in sent[1]!).toBe(false);
  await act(async () => gates.forEach((go) => go()));
});

test.skipIf(!hasDom)('a tag an earlier Inbox set to None (null, nothing kept) reads as Highlight rows off, its Color the one a new tag would get; a tag off with a colour kept names that one', () => {
  const kept = { ...tag('ini_kept', 'Kept', null), look: { colour: null, by: 'person', at: '2026-11-16T10:00:00.000Z', kept_colour: '#a454d7' } } as ListTag;
  draw(<HostHarness tags={[...TAGS, kept]} colours={{ show: true, show_at: null, recent: [] }} />);
  const c = hosted!.sidebarTags!.colours!;
  expect(c.colourOf(DOCS.id)).toBeNull();
  expect(hosted!.listColours!.tintOf(row('d', [DOCS.id]))).toBeNull();
  // Release shows green (Green's hue), Windows amber, Kept violet: the first of the twelve not shown is Indigo.
  expect(c.pickOf(DOCS.id)).toBe('#b1b7fd');
  expect(c.colourOf('ini_kept')).toBeNull();
  expect(c.pickOf('ini_kept')).toBe('#a454d7');
});

test.skipIf(!hasDom)('with the switch off from the list read, no row is tinted and the sidebar shows no colour', () => {
  draw(<HostHarness tags={TAGS} colours={{ show: false, show_at: '2026-11-13T10:00:00.000Z', recent: [] }} />);
  expect(hosted!.listColours!.show).toBe(false);
  expect(hosted!.listColours!.tintOf(row('a', [RELEASE.id]))).toBeNull();
  expect(hosted!.sidebarTags!.colours!.show).toBe(false);
});

test.skipIf(!hasDom)("a paired phone's list (no tag_colours, its keys fixed): rows tint by each tag's look, with no switch and no colour menu", () => {
  draw(<HostHarness tags={TAGS} colours={null} />);
  expect(hosted!.listColours!.tintOf(row('a', [RELEASE.id]))?.colour).toBe('green');
  expect(hosted!.listColours!.setShow).toBeUndefined();
  expect(hosted!.sidebarTags!.colours).toBeNull();
});

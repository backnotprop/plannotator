/**
 * Tag row colours in the window (approval "inbox-thread-tags", step 3, look C; the list ⋮'s "Show tag colors"). What
 * this catches: a row in a coloured tag left plain, or tinted with the wrong tag's colour, or naming no tag, in any of
 * the three row shapes; a tag's own list tinting every row with that tag; the switch off still tinting; the colour
 * menu unreachable by keyboard or losing its place; a pick not written to the linked machine that holds the tag; a
 * tint strong enough to make a row's quieter text hard to read; and a list read with the same colours drawing all
 * 200+ rows again (ListRow's memo).
 *
 * DOM-gated parts run under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { drawsDuring } from '../../tests/helpers/react-draws';
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxInitiative, InboxListRow, InboxListSection, InboxTagColours } from '@plannotator/core/inbox-types';
import type { MachinesModel } from './machines';
import type { ListTag } from './threadTags';
import { ownColour, rowTint, rowTintTitle, tintAttrs } from './tagColours';
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

test('an own colour keeps its hue at the theme’s lightness; one with no hue tints as Grey', () => {
  expect(tintAttrs('green')).toEqual({ 'data-tint': 'green' });
  const own = tintAttrs('#ff6a00');
  expect(own['data-tint']).toBe('custom');
  expect(own.style?.['--ib-tint-l']).toMatch(/^oklch\(0\.52 0\.180 /);
  expect(own.style?.['--ib-tint-d']).toMatch(/^oklch\(0\.72 0\.180 /);
  // A near-black navy keeps its hue, drawn at the theme's lightness, its chroma within the band.
  expect(ownColour('#0b1e4a')?.dark).toMatch(/^oklch\(0\.72 0\.(0[89]|1)\d* 263\.\d\)$/);
  expect(tintAttrs('#000000')).toEqual({ 'data-tint': 'grey' });
  expect(tintAttrs('#808080')).toEqual({ 'data-tint': 'grey' });
});

/** WCAG contrast of two OKLCH colours. */
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const lum = ([L, C, H]: [number, number, number]) => {
    const A = C * Math.cos((H * Math.PI) / 180);
    const B = C * Math.sin((H * Math.PI) / 180);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) => Math.max(0, Math.min(1, v)));
    return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('the strongest tint keeps a row’s quieter text at 4.5:1 on the default theme, for every preset and any own colour, light and dark', () => {
  const css = readFileSync(join(import.meta.dir, 'threadTags.css'), 'utf8');
  const theme = readFileSync(join(import.meta.dir, '../ui/themes/plannotator.css'), 'utf8');
  const block = (selector: string) => theme.slice(theme.indexOf(`${selector} {`), theme.indexOf('}', theme.indexOf(`${selector} {`)));
  const token = (text: string, name: string): [number, number, number] => {
    const m = new RegExp(`--${name}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`).exec(text);
    if (!m) throw new Error(`no ${name}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const strongest = (scope: string) => {
    const line = css.split('\n').find((l) => l.startsWith(scope) && l.includes('--ib-tint-sh'));
    return Number(/--ib-tint-sh: (\d+)%/.exec(line ?? '')?.[1]) / 100;
  };
  const toLab = ([L, C, H]: [number, number, number]) => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  const fromLab = ([L, A, B]: number[]): [number, number, number] => [L!, Math.hypot(A!, B!), ((Math.atan2(B!, A!) * 180) / Math.PI + 360) % 360];
  const mix = (tint: [number, number, number], card: [number, number, number], p: number) => {
    const [t, c] = [toLab(tint), toLab(card)];
    return fromLab(t.map((v, i) => v * p + c[i]! * (1 - p)));
  };
  for (const [mode, selector, scope, ownL] of [
    ['dark', '.theme-plannotator', '.pn-inbox, .ib-lightscope {', 0.72],
    ['light', '.theme-plannotator.light', ':root.light .pn-inbox', 0.52],
  ] as const) {
    const t = block(selector);
    const p = strongest(scope);
    expect(p).toBeGreaterThan(0.1);
    const card = token(t, 'card');
    const muted = token(t, 'muted-foreground');
    const tints: [number, number, number][] = ['primary', 'success', 'warning', 'destructive', 'muted-foreground'].map((name) => token(t, name));
    for (let h = 0; h < 360; h += 5) for (const c of [0.08, 0.13, 0.18]) tints.push([ownL, c, h]);
    const worst = Math.min(...tints.map((tint) => contrast(muted, mix(tint, card, p))));
    expect({ mode, ok: worst >= 4.5 }).toEqual({ mode, ok: true });
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

test.skipIf(!hasDom)('an own colour on a row carries its two theme colours; no colours (switch off, or an older Inbox) draws no tint and no name', () => {
  const own = [tag(RELEASE.id, 'Release', '#ff6a00'), DOCS, WINDOWS];
  draw(<List rows={[row('a', [RELEASE.id])]} colours={listColours(own)} />);
  expect(rowEl('a').getAttribute('data-tint')).toBe('custom');
  expect(rowEl('a').style.getPropertyValue('--ib-tint-d')).toMatch(/^oklch\(0\.72 /);
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

test.skipIf(!hasDom)('a sidebar tag wears its colour; Highlight rows opens the colours in place: presets, own colours, strip, Hex, None, by keyboard too', async () => {
  const picks: (string | null)[] = [];
  const colours: TagColourControls = { show: true, colourOf: colourIn(TAGS), recent: ['#0b1e4a'], set: (_t, c) => picks.push(c), preview: () => {} };
  draw(<Section colours={colours} />);
  expect(tagRow(RELEASE.id)!.getAttribute('data-tint')).toBe('green');
  expect(tagRow(DOCS.id)!.hasAttribute('data-tint')).toBe(false);
  await act(async () => {
    tagRow(RELEASE.id)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await until(() => !!tagMenu(), 'the tag menu');
  expect([...tagMenu()!.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())).toEqual(['Show threads', 'Rename', 'Highlight rowsGreen', 'Delete tag']);
  await press(tagMenu()!.querySelector('[data-tag-action="colour"]'));
  await until(() => !!tagMenu()?.querySelector('[data-tag-colour-list]'), 'the colours');
  const list = tagMenu()!.querySelector<HTMLElement>('[data-tag-colour-list]')!;
  expect(list.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Highlight colour for Release');
  const radios = [...list.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(radios.map((r) => r.getAttribute('aria-label') ?? r.textContent?.trim())).toEqual(['Accent', 'Green', 'Amber', 'Red', 'Grey', 'Custom #0b1e4a', 'None']);
  expect(list.querySelector('[data-colour="green"]')!.getAttribute('aria-checked')).toBe('true');
  expect(list.querySelector('[data-tag-colour-caption]')!.textContent).toBe('Green: rows tagged Release');
  await until(() => document.activeElement === list.querySelector('[data-colour="green"]'), 'focus on the colour that is on');
  // A pick is written and the menu stays open.
  await press(list.querySelector('[data-colour="amber"]'));
  expect(picks).toEqual(['amber']);
  expect(tagMenu()?.querySelector('[data-tag-colour-list]')).not.toBeNull();
  // By keyboard: Down from the last swatch to the strip, then the Hex field, then None; Up from None back to Hex.
  const last = list.querySelector<HTMLElement>('[data-colour="#0b1e4a"]')!;
  act(() => last.focus());
  await key(last, 'ArrowDown');
  const strip = list.querySelector<HTMLInputElement>('[data-tag-colour-hue]')!;
  expect(document.activeElement).toBe(strip);
  expect(strip.getAttribute('aria-label')).toBe('Colour, any hue');
  await key(strip, 'ArrowDown');
  const hex = list.querySelector<HTMLInputElement>('[data-tag-colour-hex]')!;
  expect(document.activeElement).toBe(hex);
  await key(hex, 'ArrowDown');
  expect(document.activeElement).toBe(list.querySelector('[data-colour="none"]'));
  await key(document.activeElement!, 'ArrowUp');
  expect(document.activeElement).toBe(hex);
  // A typed code, in any case, is kept on Enter.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(hex, '#FF6A00');
    hex.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await key(hex, 'Enter');
  expect(picks).toEqual(['amber', '#ff6a00']);
  await press(list.querySelector('[data-colour="none"]'));
  expect(picks).toEqual(['amber', '#ff6a00', null]);
  // Steps on the strip by key are kept once, when the keys rest: one colour, not one per step.
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      strip.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    });
  }
  expect(picks).toHaveLength(3);
  await until(() => picks.length === 4, 'the strip kept');
  expect(picks.at(-1)).toMatch(/^#[0-9a-f]{6}$/);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 900));
  });
  expect(picks).toHaveLength(4);
  // A screen reader's swipe moves the strip with no key and no pointer: kept once it rests too.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(strip, '200');
    strip.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await until(() => picks.length === 5, 'the swipe kept');
  expect(picks.at(-1)).not.toBe(picks.at(-2));
  // Back: the menu again, focus on Highlight rows.
  await press(list.querySelector('[data-tag-colour-back]'));
  await until(() => document.activeElement === tagMenu()?.querySelector('[data-tag-action="colour"]'), 'focus back on Highlight rows');
});

test.skipIf(!hasDom)('"Show tag colors" off hides the sidebar tags’ colours too', () => {
  draw(<Section colours={{ show: false, colourOf: colourIn(TAGS), recent: [], set: () => {}, preview: () => {} }} />);
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

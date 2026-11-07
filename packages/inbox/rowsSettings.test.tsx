/**
 * Settings → Rows (components/RowsSettings.tsx, approval "inbox-customize-rows"): presets, the choices and the
 * pictures, over the list's look (listLook.ts) with the server's save stubbed (its round trip through a real Inbox is
 * packages/server/inbox.test.ts's).
 * What this catches: a three-way choice that leaves its rival on (Compact and Roomy together, no preview and two
 * lines together, Dot without bold) or takes two saves to change; a preset that is not exactly its look, or that is
 * not shown as chosen when the look matches it, or that is a radio again (an arrow key would apply it); "Custom" missing once the look matches
 * none, or not tied to the presets for a screen reader; a Show switch without its words, or that reads
 * backwards; pictures that do not follow the look, or a phone that draws the full-width picture. Letter marks
 * (approval "inbox-letter-marks"): on by default anywhere, a Mark style picked while off that does nothing, a picture
 * switch that does nothing while project marks are off, Detailed not turning them on (Both, Avatar, no pictures).
 * The notes-list look (addendum 2026-11-07): Time position, Dividers or Status mark on by default, a choice that takes
 * two saves or turns another option, pictures that do not show it (the phone's included), a preset that keeps it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { RowsSection, ROWS_PRESETS, rowsSummary } = (hasDom ? await import('./components/RowsSettings') : {}) as typeof import('./components/RowsSettings');
const { LIST_LOOK_DEFAULT, LIST_LOOK_OFF, readListLook, resetListLookForTests } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const saves: unknown[][] = [];
const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  saves.length = 0;
  const stored = new Map<string, string>();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const rows = (JSON.parse(init?.body ?? '{}') as { rows: unknown[] }).rows;
    saves.push(rows);
    return new Response(JSON.stringify({ rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  resetListLookForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(phone = false): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<RowsSection phone={phone} />));
  return host;
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

/** Pick a choice by its words in a control row (`density`, `unread`…) or the presets (`preset`). */
async function pick(el: HTMLElement, control: string, words: string) {
  if (control === 'preset') {
    const button = [...el.querySelectorAll<HTMLButtonElement>('.ib-rws-presets button')].find((b) => b.textContent === words);
    if (!button) throw new Error(`preset: no "${words}"`);
    act(() => button.click());
    await settle();
    return;
  }
  const scope = el.querySelector(`[data-rows-control="${control}"]`)!;
  const label = [...scope.querySelectorAll('label')].find((l) => l.textContent === words);
  if (!label) throw new Error(`${control}: no "${words}"`);
  act(() => label.querySelector('input')!.click());
  await settle();
}

const chosen = (el: HTMLElement, control: string) => {
  if (control === 'preset') return [...el.querySelectorAll('.ib-rws-presets button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
  const scope = el.querySelector(`[data-rows-control="${control}"]`)!;
  return [...scope.querySelectorAll('label')].filter((l) => l.querySelector('input')!.checked).map((l) => l.textContent);
};

/** The defaults (smaller names on) with some options changed. */
const lookOf = (keys: Partial<typeof LIST_LOOK_OFF>) => ({ ...LIST_LOOK_DEFAULT, ...keys });

describe.if(hasDom)('Settings → Rows', () => {
  test('a browser with the defaults: Balanced, Bold unread names, every other choice at its first, both pictures, no "Custom"', () => {
    const el = render();
    expect(chosen(el, 'preset')).toEqual(['Balanced']);
    expect(el.querySelector('.ib-rws-custom')).toBeNull();
    expect(['density', 'first', 'names', 'unread', 'preview', 'time'].map((c) => chosen(el, c)[0])).toEqual(['Comfortable', 'Project', 'Plain', 'Bold', '1 line', 'Clock']);
    expect([...el.querySelectorAll('[data-rows-preview]')].map((p) => p.getAttribute('data-rows-preview'))).toEqual(['narrow', 'wide']);
  });

  test('Density: Compact and Roomy never together, each choice one save', async () => {
    const el = render();
    await pick(el, 'density', 'Roomy');
    expect(readListLook()).toEqual(lookOf({ roomy: true }));
    await pick(el, 'density', 'Compact');
    expect(readListLook()).toEqual(lookOf({ compact: true }));
    await pick(el, 'density', 'Comfortable');
    expect(readListLook()).toEqual(LIST_LOOK_DEFAULT);
    expect(saves).toEqual([['smallNames', 'roomy'], ['compact', 'smallNames'], ['smallNames']]);
  });

  test('Unread: Larger, Bold (the read size, bold), Dot (bold with a dot)', async () => {
    const el = render();
    await pick(el, 'unread', 'Dot');
    expect(readListLook()).toEqual(lookOf({ smallNames: true, unreadDot: true }));
    await pick(el, 'unread', 'Larger');
    expect(readListLook()).toEqual(LIST_LOOK_OFF);
    await pick(el, 'unread', 'Bold');
    expect(readListLook()).toEqual(LIST_LOOK_DEFAULT);
    expect(saves).toHaveLength(3);
  });

  test('Subject preview: None and 2 lines never together', async () => {
    const el = render();
    await pick(el, 'preview', '2 lines');
    expect(readListLook()).toEqual(lookOf({ previewTwo: true }));
    await pick(el, 'preview', 'None');
    expect(readListLook()).toEqual(lookOf({ hidePreview: true }));
    await pick(el, 'preview', '1 line');
    expect(readListLook()).toEqual(LIST_LOOK_DEFAULT);
  });

  test('the two-way choices and the Show switches (on is shown)', async () => {
    const el = render();
    await pick(el, 'first', 'Thread name');
    await pick(el, 'names', 'Highlighted');
    await pick(el, 'time', 'Relative');
    const agents = el.querySelector<HTMLElement>('[data-rows-control="hideAgents"] [role="switch"]')!;
    expect(agents.getAttribute('aria-checked')).toBe('true');
    act(() => agents.click());
    await settle();
    expect(agents.getAttribute('aria-checked')).toBe('false');
    expect(readListLook()).toEqual(lookOf({ titleFirst: true, highlight: true, relativeTime: true, hideAgents: true }));
  });

  test('each preset is exactly its look in one save; a change from it reads "Custom"; Balanced puts the defaults back', async () => {
    const el = render();
    for (const preset of ROWS_PRESETS) {
      await pick(el, 'preset', preset.label);
      expect(readListLook()).toEqual(preset.look);
      expect(chosen(el, 'preset')).toEqual([preset.label]);
      expect(rowsSummary(readListLook())).toBe(preset.label);
    }
    expect(saves).toHaveLength(ROWS_PRESETS.length);
    await pick(el, 'preset', 'Minimal');
    await pick(el, 'time', 'Clock');
    expect(chosen(el, 'preset')).toEqual([]);
    expect(el.querySelector('.ib-rws-custom')!.textContent).toBe('Custom');
    expect(rowsSummary(readListLook())).toBe('Custom');
    await pick(el, 'preset', 'Balanced');
    expect(readListLook()).toEqual(LIST_LOOK_DEFAULT);
    expect(el.querySelector('.ib-rws-custom')).toBeNull();
  });

  // Review of #2516: as radios, an arrow key in the presets chose the next one and wiped a Custom look unseen.
  // Buttons have no arrow-key choosing at all, so the guard is their shape: no radio, no radio group, each a button.
  test('the presets are buttons, never radios, so a key moves through them without choosing; "Custom" goes with them', async () => {
    const el = render();
    await pick(el, 'preset', 'Minimal');
    await pick(el, 'time', 'Clock');
    const group = el.querySelector<HTMLElement>('.ib-rws-presets [role="group"]')!;
    expect(el.querySelector('.ib-rws-presets :is(input, [role="radio"], [role="radiogroup"])')).toBeNull();
    expect([...group.children].map((b) => [b.tagName, (b as HTMLButtonElement).type, b.getAttribute('aria-pressed')])).toEqual([
      ['BUTTON', 'button', 'false'],
      ['BUTTON', 'button', 'false'],
      ['BUTTON', 'button', 'false'],
    ]);
    // "Custom" describes the group while the look matches no preset.
    const describedBy = group.getAttribute('aria-describedby')!;
    expect(el.querySelector(`#${describedBy}`)!.textContent).toBe('Custom');
    await pick(el, 'preset', 'Balanced');
    expect(group.getAttribute('aria-describedby')).toBeNull();
  });

  test("the Project switch's words describe it to a screen reader", () => {
    const el = render();
    const project = el.querySelector<HTMLElement>('[data-rows-control="hideProject"] [role="switch"]')!;
    expect(el.querySelector(`#${project.getAttribute('aria-describedby')}`)!.textContent).toBe('With its machine, when you link machines');
    expect(el.querySelector('[data-rows-control="hideAgents"] [role="switch"]')!.hasAttribute('aria-describedby')).toBe(false);
  });

  test('the pictures follow the look at once; a phone draws only its own rows', async () => {
    const el = render();
    await pick(el, 'density', 'Roomy');
    await pick(el, 'first', 'Thread name');
    for (const picture of el.querySelectorAll('[data-rows-preview] .ib-listcol')) expect(picture.className).toContain('ib-lk-roomy');
    expect(el.querySelectorAll('[data-rows-preview="narrow"] .ib-nrow .ib-l2-lead').length).toBe(3);
    act(() => root!.unmount());
    host!.remove();
    const phone = render(true);
    expect([...phone.querySelectorAll('[data-rows-preview]')].map((p) => p.getAttribute('data-rows-preview'))).toEqual(['phone']);
    expect(phone.querySelectorAll('[data-rows-preview] .ib-mrow').length).toBe(3);
  });

  test('letter marks: all off by default, no style picked; picking a style turns thread marks on in one save', async () => {
    const el = render();
    expect(chosen(el, 'markstyle')).toEqual([]);
    expect(chosen(el, 'marks')).toEqual(['Off']);
    for (const key of ['repoLogo', 'githubPictures']) expect(el.querySelector(`[data-rows-control="${key}"] [role="switch"]`)!.getAttribute('aria-checked')).toBe('false');
    // The pictures draw no mark while marks are off.
    expect(el.querySelectorAll('[data-rows-preview] :is(.ib-lm, .ib-lm-dot, .ib-lm-av)').length).toBe(0);
    await pick(el, 'markstyle', 'Dot');
    expect(chosen(el, 'markstyle')).toEqual(['Dot']);
    expect(chosen(el, 'marks')).toEqual(['Threads']);
    expect(saves).toEqual([['smallNames', 'marksThreads', 'markDot']]);
    expect(el.querySelectorAll('[data-rows-preview] .ib-lm-dot').length).toBeGreaterThan(0);
    // Off again, then on: the first style is Avatar.
    await pick(el, 'marks', 'Off');
    expect(chosen(el, 'markstyle')).toEqual([]);
    await pick(el, 'marks', 'Projects');
    expect(chosen(el, 'markstyle')).toEqual(['Avatar']);
  });

  test('a picture switch turned on while project marks are off turns them on: Off becomes Projects, Threads becomes Both', async () => {
    const el = render();
    const sw = (key: string) => el.querySelector<HTMLElement>(`[data-rows-control="${key}"] [role="switch"]`)!;
    act(() => sw('repoLogo').click());
    await settle();
    expect(chosen(el, 'marks')).toEqual(['Projects']);
    expect(sw('repoLogo').getAttribute('aria-checked')).toBe('true');
    await pick(el, 'marks', 'Threads');
    // Project marks gone: the switch reads off, as nothing it does shows.
    expect(sw('repoLogo').getAttribute('aria-checked')).toBe('false');
    act(() => sw('githubPictures').click());
    await settle();
    expect(chosen(el, 'marks')).toEqual(['Both']);
    expect(sw('githubPictures').getAttribute('aria-checked')).toBe('true');
  });

  test('Detailed turns marks on (Both, Avatar, both picture switches off); Minimal and Balanced keep them off', async () => {
    const el = render();
    await pick(el, 'preset', 'Detailed');
    expect(chosen(el, 'marks')).toEqual(['Both']);
    expect(chosen(el, 'markstyle')).toEqual(['Avatar']);
    for (const key of ['repoLogo', 'githubPictures']) expect(el.querySelector(`[data-rows-control="${key}"] [role="switch"]`)!.getAttribute('aria-checked')).toBe('false');
    // A picture switch on is no longer Detailed.
    act(() => el.querySelector<HTMLElement>('[data-rows-control="repoLogo"] [role="switch"]')!.click());
    await settle();
    expect(chosen(el, 'preset')).toEqual([]);
    for (const preset of ['Minimal', 'Balanced']) {
      await pick(el, 'preset', preset);
      expect(chosen(el, 'marks')).toEqual(['Off']);
      expect(chosen(el, 'markstyle')).toEqual([]);
    }
  });

  test('the notes-list look: off by default; Time position, Dividers and Status mark each one save of their own name', async () => {
    const el = render();
    const sw = (key: string) => el.querySelector<HTMLElement>(`[data-rows-control="${key}"] [role="switch"]`)!;
    expect(chosen(el, 'timeplace')).toEqual(['Top right']);
    for (const key of ['dividers', 'statusMark']) {
      expect(sw(key).getAttribute('aria-checked')).toBe('false');
      // Its words describe the switch to a screen reader.
      expect(el.querySelector(`#${sw(key).getAttribute('aria-describedby')}`)!.textContent!.length).toBeGreaterThan(0);
    }
    await pick(el, 'timeplace', 'Under the preview');
    act(() => sw('dividers').click());
    await settle();
    act(() => sw('statusMark').click());
    await settle();
    expect(chosen(el, 'timeplace')).toEqual(['Under the preview']);
    expect(sw('dividers').getAttribute('aria-checked')).toBe('true');
    expect(saves).toEqual([
      ['smallNames', 'timeBelow'],
      ['smallNames', 'timeBelow', 'dividers'],
      ['smallNames', 'timeBelow', 'dividers', 'statusMark'],
    ]);
    expect(readListLook()).toEqual(lookOf({ timeBelow: true, dividers: true, statusMark: true }));
    expect(chosen(el, 'preset')).toEqual([]);
    await pick(el, 'timeplace', 'Top right');
    expect(readListLook()).toEqual(lookOf({ dividers: true, statusMark: true }));
  });

  test("the pictures show the notes-list look at once, the phone's too; a preset turns it off", async () => {
    const el = render();
    expect(el.querySelectorAll('[data-rows-preview] :is(.ib-l4, .ib-stm)').length).toBe(0);
    await pick(el, 'timeplace', 'Under the preview');
    act(() => el.querySelector<HTMLElement>('[data-rows-control="statusMark"] [role="switch"]')!.click());
    await settle();
    act(() => el.querySelector<HTMLElement>('[data-rows-control="dividers"] [role="switch"]')!.click());
    await settle();
    expect(el.querySelectorAll('[data-rows-preview="narrow"] .ib-nrow > .ib-l4').length).toBe(3);
    // The samples: a stopped and a waiting thread wait on you, a quiet one is done; the wide picture too.
    for (const picture of ['narrow', 'wide']) {
      expect([...el.querySelectorAll(`[data-rows-preview="${picture}"] .ib-stm`)].map((m) => m.getAttribute('data-status'))).toEqual(['waiting', 'waiting', 'done']);
    }
    for (const picture of el.querySelectorAll('[data-rows-preview] .ib-listcol')) expect(picture.className).toContain('ib-lk-div');
    await pick(el, 'preset', 'Detailed');
    expect(el.querySelectorAll('[data-rows-preview] :is(.ib-l4, .ib-stm)').length).toBe(0);
    act(() => root!.unmount());
    host!.remove();
    const phone = render(true);
    await pick(phone, 'timeplace', 'Under the preview');
    act(() => phone.querySelector<HTMLElement>('[data-rows-control="statusMark"] [role="switch"]')!.click());
    await settle();
    expect(phone.querySelectorAll('[data-rows-preview="phone"] .ib-mrow > .ib-m4').length).toBe(3);
    expect(phone.querySelectorAll('[data-rows-preview="phone"] .ib-stm').length).toBe(3);
  });
});

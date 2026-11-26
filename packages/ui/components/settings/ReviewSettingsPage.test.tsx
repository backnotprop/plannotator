/**
 * Settings → Reviews (`ReviewSettingsPage`): one page for reading a review,
 * which replaced classic code review's Review, Editor, Semantic diffs and
 * Analysis tabs. Each section's controls still write their own setting's
 * existing key, or go through the host's writer when it passes one; the
 * master Semantic changes switch greys (never hides) what depends on it; a
 * host leaves out the rows it cannot honour; Power Up's key route is read
 * only once its section is on screen; and an outside link lands on Reviews at
 * the section it named.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '../../config';
import type { SettingName } from '../../config/settings';
import type { PackageChangesSetting } from '../../hooks/usePackageChangesSetting';
import { resetStorageBackend, setStorageBackend } from '../../utils/storage';
import { Settings } from '../Settings';
import { ReviewSettingsPage } from './ReviewSettingsPage';
import { CLASSIC_REVIEW_SETTINGS_CONTROLS } from './reviewSettingsControls';

const hasDom = typeof document !== 'undefined';
const realFetch = globalThis.fetch;
const realObserver = globalThis.IntersectionObserver;
const realScrollIntoView = hasDom ? Element.prototype.scrollIntoView : undefined;
let root: Root | null = null;
let host: HTMLElement | null = null;
/** What the page saved, by storage key (the storage seam; the default backend is cookies). */
const saved = new Map<string, string>();
const TOUCHED: SettingName[] = [
  'diffStyle', 'diffOverflow', 'semanticDiffEnabled', 'diffSemantic', 'callFlowEnabled', 'diffPowerUp',
  'diffPowerUpMotion', 'reviewAutoViewed', 'reviewPanelView', 'defaultDiffType', 'tokenHoverTrigger',
  'tokenHoverDelay', 'diffFontSize', 'diffTabSize', 'reviewDefaults',
];
let restore: Map<SettingName, unknown>;

/** IntersectionObserver stand-in: nothing is on screen until `showObserved()`. */
let observed: Array<() => void> = [];
class ObserverStandIn {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    observed.push(() => this.callback([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
async function showObserved() {
  await act(async () => {
    for (const fire of observed) fire();
    await new Promise((r) => setTimeout(r, 10));
  });
}

async function mountPage(props: Partial<React.ComponentProps<typeof ReviewSettingsPage>> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ReviewSettingsPage controls={CLASSIC_REVIEW_SETTINGS_CONTROLS} opinionRoute="/opinion-settings" {...props} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

async function mountSettings(
  mode: 'plan' | 'review',
  externalTab?: React.ComponentProps<typeof Settings>['externalTab'],
  externalSection?: React.ComponentProps<typeof Settings>['externalSection'],
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Settings taterMode={false} onTaterModeChange={() => {}} mode={mode} externalOpen externalTab={externalTab} externalSection={externalSection} />);
  });
}

async function remount(props: Partial<React.ComponentProps<typeof ReviewSettingsPage>> = {}) {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  await mountPage(props);
}

async function slide(label: string, value: number) {
  const input = document.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
  if (!input) throw new Error(`no slider "${label}"`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!select) throw new Error(`no select "${label}"`);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const section = (id: string) => document.querySelector<HTMLElement>(`[data-review-settings-section="${id}"]`);
const switchNamed = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((b) => b.textContent?.trim().startsWith(label)) ?? null;
const radioGroup = (label: string) => document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`);
const radio = (group: string, label: string) =>
  [...(radioGroup(group)?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) ?? null;
const sidebarTabs = () => [...document.querySelectorAll<HTMLButtonElement>('nav.hidden button')].map((b) => b.textContent?.trim() ?? '');
const activeSidebarTab = () => [...document.querySelectorAll<HTMLButtonElement>('nav.hidden button')].find((b) => b.className.includes('font-medium'))?.textContent?.trim();

async function click(el: HTMLElement | null) {
  if (!el) throw new Error('control did not render');
  await act(async () => el.click());
}

describe.if(hasDom)('Settings → Reviews', () => {
  beforeEach(() => {
    saved.clear();
    setStorageBackend({ getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => void saved.set(k, v), removeItem: (k) => void saved.delete(k) });
    restore = new Map(TOUCHED.map((k) => [k, configStore.get(k)]));
    globalThis.fetch = (async () => Response.json({ configured: false, provider: null })) as unknown as typeof fetch;
    observed = [];
    globalThis.IntersectionObserver = ObserverStandIn as unknown as typeof IntersectionObserver;
  });

  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    document.body.replaceChildren();
    for (const [k, v] of restore) configStore.set(k, v as never);
    resetStorageBackend();
    globalThis.fetch = realFetch;
    globalThis.IntersectionObserver = realObserver;
    Element.prototype.scrollIntoView = realScrollIntoView!;
  });

  test('the sections come in the agreed order', async () => {
    await mountPage({ packageChangesSetting: { card: true, lookup: false, setCard: () => {}, setLookup: async () => true } });
    const order = [...document.querySelectorAll('[data-review-settings-section]')].map((el) => el.getAttribute('data-review-settings-section'));
    expect(order).toEqual(['display', 'semantic', 'powerUp', 'callFlow', 'packages', 'files']);
  });

  test('Diff display: Split or Unified and the gear switches write their existing keys; a phone gets no Split or Unified', async () => {
    configStore.set('diffStyle', 'split');
    configStore.set('diffOverflow', 'scroll');
    saved.clear();
    await mountPage();
    await click(radio('Split or Unified', 'Unified'));
    expect(saved.get('plannotator-diff-style')).toBe('unified');
    expect(radio('Split or Unified', 'Unified')?.getAttribute('aria-checked')).toBe('true');
    await click(switchNamed('Wrap long lines'));
    expect(saved.get('plannotator-diff-overflow')).toBe('wrap');
    expect(switchNamed('Wrap long lines')?.getAttribute('aria-checked')).toBe('true');

    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mountPage({ isCompactTouchLayout: true });
    expect(radioGroup('Split or Unified')).toBeNull();
    expect(section('display')?.textContent).toContain('unified diffs for the session');
    expect(switchNamed('Wrap long lines')).not.toBeNull();
  });

  test('Semantic diffs: the master switch writes its key; off greys the moved-code switch and Power Up, and the key form stays usable', async () => {
    configStore.set('semanticDiffEnabled', true);
    configStore.set('diffSemantic', true);
    saved.clear();
    await mountPage();
    await showObserved();
    expect(switchNamed('Show moved & renamed code')?.disabled).toBe(false);

    await click(switchNamed('Show moved & renamed code'));
    expect(saved.get('plannotator-diff-semantic')).toBe('false');
    await click(switchNamed('Show moved & renamed code'));

    await click(switchNamed('Semantic changes'));
    expect(saved.get('plannotator-semantic-diff-enabled')).toBe('false');
    // Still there, greyed, saying why.
    const moved = switchNamed('Show moved & renamed code');
    expect(moved?.disabled).toBe(true);
    expect(moved?.getAttribute('aria-checked')).toBe('false');
    expect(moved?.textContent).toContain('Off while Semantic changes is off.');
    const powerUp = switchNamed('Power Up');
    expect(powerUp?.disabled).toBe(true);
    expect(powerUp?.textContent).toContain('Off while Semantic changes is off.');
    // A key can still be added or removed.
    const key = section('powerUp')?.querySelector<HTMLInputElement>('input[aria-label="TypeSafe API key"]');
    expect(key?.disabled).toBe(false);
    expect(section('powerUp')?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    // Layers that do not depend on it stay as they were.
    expect(switchNamed('Call flow')?.disabled).toBe(false);

    await click(switchNamed('Semantic changes'));
    expect(saved.get('plannotator-semantic-diff-enabled')).toBe('true');
    expect(switchNamed('Show moved & renamed code')?.disabled).toBe(false);
    expect(switchNamed('Show moved & renamed code')?.getAttribute('aria-checked')).toBe('true');
  });

  test('Power Up: reads the host route only once its section is on screen, stays off without a key, and Motion writes its key', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return Response.json({ configured: false, provider: null });
    }) as unknown as typeof fetch;
    configStore.set('diffPowerUpMotion', 'still');
    saved.clear();
    await mountPage({ opinionRoute: '/host/opinion-route' });
    expect(asked).toEqual([]);
    await showObserved();
    expect(asked).toEqual(['/host/opinion-route']);
    await showObserved();
    expect(asked).toEqual(['/host/opinion-route']);
    expect(switchNamed('Power Up')?.disabled).toBe(true);
    await click(radio('Motion', 'Stream'));
    expect(saved.get('plannotator-diff-power-up-motion')).toBe('stream');
  });

  test('Hover cards: the delay is greyed while the trigger is Off, and both write their keys', async () => {
    configStore.set('tokenHoverTrigger', 'hover');
    configStore.set('tokenHoverDelay', 300);
    saved.clear();
    await mountPage();
    const delayButtons = () => [...(radioGroup('How long the pointer rests before a card is requested')?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    expect(delayButtons().length).toBe(3);
    expect(delayButtons().every((b) => !b.disabled)).toBe(true);
    await click(radio('How long the pointer rests before a card is requested', 'Relaxed'));
    expect(saved.get('plannotator-token-hover-delay')).toBe('700');

    await click(radio('Hover cards', 'Off'));
    expect(saved.get('plannotator-token-hover-trigger')).toBe('off');
    expect(delayButtons().every((b) => b.disabled)).toBe(true);
    expect(radioGroup('How long the pointer rests before a card is requested')?.getAttribute('aria-disabled')).toBe('true');
  });

  test('Code Font Size writes its key, and Reset clears it', async () => {
    configStore.set('diffFontSize', '');
    saved.clear();
    await mountPage();
    await slide('Code Font Size', 16);
    expect(saved.get('plannotator-diff-font-size')).toBe('16px');
    expect(section('display')?.textContent).toContain('16px');
    const reset = [...section('display')!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Reset');
    await click(reset ?? null);
    expect(configStore.get('diffFontSize')).toBe('');
  });

  test('Tab size steps within 1 to 8 and writes its key', async () => {
    configStore.set('diffTabSize', 7);
    saved.clear();
    await mountPage();
    const increase = document.querySelector<HTMLButtonElement>('button[aria-label="Increase tab size"]');
    await click(increase);
    expect(saved.get('plannotator-diff-tab-size')).toBe('8');
    expect(increase?.disabled).toBe(true);
  });

  test('a host writer receives every write the page makes, and the store is left to it', async () => {
    configStore.set('diffOverflow', 'scroll');
    configStore.set('defaultDiffType', 'since-base');
    configStore.set('reviewPanelView', 'sections');
    saved.clear();
    const writes: Array<[string, unknown]> = [];
    await mountPage({ onChange: (key, value) => void writes.push([key, value]) });
    await showObserved();
    await click(switchNamed('Wrap long lines'));
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Decrease tab size"]'));
    await click(radio('Motion', 'Stream'));
    await click(switchNamed('Semantic changes'));
    await click(switchNamed('Call flow'));
    await choose('Default diff view (Jujutsu)', 'jj-line');
    // The coupled Git setter writes the pair through the host too.
    await choose('Default diff view (Git)', 'uncommitted');
    const keys = writes.map(([k]) => k);
    expect(keys).toContain('diffOverflow');
    expect(keys).toContain('diffTabSize');
    expect(keys).toContain('diffPowerUpMotion');
    expect(keys).toContain('semanticDiffEnabled');
    expect(keys).toContain('callFlowEnabled');
    expect(writes.find(([k]) => k === 'reviewDefaults')?.[1]).toEqual({ ...configStore.get('reviewDefaults'), jj: { defaultDiffType: 'jj-line' } });
    expect(writes).toContainEqual(['defaultDiffType', 'uncommitted']);
    expect(writes).toContainEqual(['reviewPanelView', 'tree']);
    expect(saved.size).toBe(0);
    expect(configStore.get('diffOverflow')).toBe('scroll');
  });

  test('the Jujutsu default diff writes its own key', async () => {
    configStore.set('reviewDefaults', {});
    saved.clear();
    await mountPage();
    await choose('Default diff view (Jujutsu)', 'jj-evolog');
    expect(JSON.parse(saved.get('plannotator-review-defaults') ?? '{}')).toEqual({ jj: { defaultDiffType: 'jj-evolog' } });
  });

  test('a host leaves out the rows it cannot honour; the rest stay', async () => {
    await mountPage();
    expect(switchNamed('Hide whitespace')).not.toBeNull();
    expect(radioGroup('Minimap')).not.toBeNull();
    expect(radioGroup('Hover cards')).not.toBeNull();
    expect(document.querySelector('select[aria-label="Default diff view (Git)"]')).not.toBeNull();

    await remount({ rows: { hideWhitespace: false, minimap: false, hoverCards: false, defaultDiffViews: false } });
    expect(switchNamed('Hide whitespace')).toBeNull();
    expect(radioGroup('Minimap')).toBeNull();
    expect(radioGroup('Hover cards')).toBeNull();
    expect(radioGroup('How long the pointer rests before a card is requested')).toBeNull();
    expect(radioGroup('Default file grouping')).toBeNull();
    expect(document.querySelector('select[aria-label="Default diff view (Git)"]')).toBeNull();
    expect(document.querySelector('select[aria-label="Default diff view (Jujutsu)"]')).toBeNull();
    expect(switchNamed('Wrap long lines')).not.toBeNull();
    expect(switchNamed('Whole file')).not.toBeNull();
    expect(switchNamed('Auto-mark viewed')).not.toBeNull();
  });

  test('Call flow: its switch writes its key, and its caveat is one plain line', async () => {
    configStore.set('callFlowEnabled', false);
    saved.clear();
    await mountPage();
    await click(switchNamed('Call flow'));
    expect(saved.get('plannotator-call-flow-enabled')).toBe('true');
    expect(switchNamed('Call flow')?.getAttribute('aria-checked')).toBe('true');
    expect(section('callFlow')?.textContent).toContain('Call flow is syntactic.');
  });

  test('Package changes: both switches go to the host setting; no setting, no section; the environment locks the lookup', async () => {
    const calls: Array<[string, boolean]> = [];
    const setting: PackageChangesSetting = {
      card: true,
      lookup: false,
      setCard: (next) => void calls.push(['card', next]),
      setLookup: async (next) => { calls.push(['lookup', next]); return true; },
    };
    await mountPage({ packageChangesSetting: setting });
    await click(switchNamed('Package changes'));
    await click(switchNamed('Look up packages on npm'));
    expect(calls).toEqual([['card', false], ['lookup', true]]);

    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mountPage();
    expect(section('packages')).toBeNull();

    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mountPage({ packageChangesSetting: { ...setting, lookupEnv: false } });
    expect(switchNamed('Look up packages on npm')?.disabled).toBe(true);
    expect(section('packages')?.textContent).toContain('PLANNOTATOR_PACKAGE_LOOKUP=0');
  });

  test('Files and defaults: Auto-mark viewed and the grouping write their existing keys', async () => {
    configStore.set('reviewAutoViewed', true);
    configStore.set('reviewPanelView', 'tree');
    configStore.set('defaultDiffType', 'uncommitted');
    saved.clear();
    await mountPage();
    await click(switchNamed('Auto-mark viewed'));
    expect(saved.get('plannotator-review-auto-viewed')).toBe('false');
    await click(radio('Default file grouping', 'By git status'));
    expect(saved.get('plannotator-review-panel-view')).toBe('sections');
    // The shared setter keeps the pair coupled: git-status grouping only renders since-base.
    expect(configStore.get('defaultDiffType')).toBe('since-base');
  });

  test('Files and defaults: this repository cannot group by git status, so the row says so', async () => {
    await mountPage({ sinceBaseUnavailable: true });
    expect(section('files')?.textContent).toContain("isn't available in this repository");
  });

  test('code review has one Reviews tab where the four were', async () => {
    await mountSettings('review');
    const tabs = sidebarTabs();
    expect(tabs).toContain('Reviews');
    for (const old of ['Review', 'Editor', 'Semantic diffs', 'Analysis']) expect(tabs).not.toContain(old);
    expect(tabs.indexOf('Reviews')).toBe(tabs.indexOf('Theme') + 1);
    expect(tabs.indexOf('Comments')).toBe(tabs.indexOf('Reviews') + 1);
  });

  for (const [old, landing] of [['semantic', 'semantic'], ['analysis', 'semantic'], ['review', 'files'], ['display', null], ['reviews', null]] as const) {
    test(`an outside link to the old "${old}" tab opens Reviews ${landing ? `scrolled to ${landing}` : 'at the top'}`, async () => {
      const scrolled: string[] = [];
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this.getAttribute('data-review-settings-section') ?? '?');
      };
      await mountSettings('review', old);
      expect(activeSidebarTab()).toBe('Reviews');
      expect(document.querySelector('[data-review-settings]')).not.toBeNull();
      expect(scrolled).toEqual(landing ? [landing] : []);
    });
  }

  test('the Power Up status link opens Reviews at Power Up', async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-review-settings-section') ?? '?');
    };
    await mountSettings('review', 'reviews', 'powerUp');
    expect(activeSidebarTab()).toBe('Reviews');
    expect(scrolled).toEqual(['powerUp']);
  });

  test('the section a link asked for is forgotten when Settings closes: the next opening starts at the top', async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-review-settings-section') ?? '?');
    };
    await mountSettings('review', 'reviews', 'powerUp');
    expect(scrolled).toEqual(['powerUp']);
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]'));
    expect(document.querySelector('[data-review-settings]')).toBeNull();

    // Opened again with no link (the host's open signal goes off, then on with no tab).
    const render = (open: boolean) => root?.render(<Settings taterMode={false} onTaterModeChange={() => {}} mode="review" externalOpen={open} />);
    await act(async () => render(false));
    await act(async () => render(true));
    expect(activeSidebarTab()).toBe('Reviews');
    expect(document.querySelector('[data-review-settings]')).not.toBeNull();
    expect(scrolled).toEqual(['powerUp']);
  });

  test('a greyed Power Up switch shows off and keeps the saved choice', async () => {
    globalThis.fetch = (async () => Response.json({ configured: true, provider: 'jev' })) as unknown as typeof fetch;
    configStore.set('semanticDiffEnabled', true);
    configStore.set('diffSemantic', true);
    configStore.set('diffPowerUp', true);
    await mountPage();
    await showObserved();
    expect(switchNamed('Power Up')?.disabled).toBe(false);
    expect(switchNamed('Power Up')?.getAttribute('aria-checked')).toBe('true');

    saved.clear();
    await click(switchNamed('Semantic changes'));
    expect(switchNamed('Power Up')?.disabled).toBe(true);
    expect(switchNamed('Power Up')?.getAttribute('aria-checked')).toBe('false');
    expect(saved.has('plannotator-diff-power-up')).toBe(false);
    expect(configStore.get('diffPowerUp')).toBe(true);

    await click(switchNamed('Semantic changes'));
    expect(switchNamed('Power Up')?.getAttribute('aria-checked')).toBe('true');
  });

  test('outside code review, "display" still opens Display', async () => {
    await mountSettings('plan', 'display');
    expect(activeSidebarTab()).toBe('Display');
    expect(document.querySelector('[data-review-settings]')).toBeNull();
  });
});

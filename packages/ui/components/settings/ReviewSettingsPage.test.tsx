/**
 * Settings → Reviews (`ReviewSettingsPage`): one page for reading a review,
 * which replaced classic code review's Review, Editor, Semantic diffs and
 * Analysis tabs. Each section's controls still write their own setting's
 * existing key; the master Semantic changes switch hides what depends on it;
 * and an old tab id still lands on Reviews.
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
let root: Root | null = null;
let host: HTMLElement | null = null;
/** What the page saved, by storage key (the storage seam; the default backend is cookies). */
const saved = new Map<string, string>();
const TOUCHED: SettingName[] = [
  'diffStyle', 'diffOverflow', 'semanticDiffEnabled', 'diffSemantic', 'callFlowEnabled',
  'diffPowerUpMotion', 'reviewAutoViewed', 'reviewPanelView', 'defaultDiffType', 'tokenHoverTrigger',
];
let restore: Map<SettingName, unknown>;

async function mountPage(props: Partial<React.ComponentProps<typeof ReviewSettingsPage>> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ReviewSettingsPage controls={CLASSIC_REVIEW_SETTINGS_CONTROLS} opinionRoute="/opinion-settings" {...props} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

async function mountSettings(mode: 'plan' | 'review', externalTab?: React.ComponentProps<typeof Settings>['externalTab']) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Settings taterMode={false} onTaterModeChange={() => {}} mode={mode} externalOpen externalTab={externalTab} />);
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

  test('Semantic diffs: the master switch writes its key, and off hides the moved-code switch and Power Up', async () => {
    configStore.set('semanticDiffEnabled', true);
    configStore.set('diffSemantic', true);
    saved.clear();
    await mountPage();
    expect(switchNamed('Show moved & renamed code')).not.toBeNull();
    expect(section('powerUp')).not.toBeNull();

    await click(switchNamed('Show moved & renamed code'));
    expect(saved.get('plannotator-diff-semantic')).toBe('false');

    await click(switchNamed('Semantic changes'));
    expect(saved.get('plannotator-semantic-diff-enabled')).toBe('false');
    expect(switchNamed('Show moved & renamed code')).toBeNull();
    expect(section('powerUp')).toBeNull();
    // Layers that do not depend on it stay.
    expect(switchNamed('Call flow')).not.toBeNull();
    expect(section('files')).not.toBeNull();

    await click(switchNamed('Semantic changes'));
    expect(saved.get('plannotator-semantic-diff-enabled')).toBe('true');
    expect(switchNamed('Show moved & renamed code')).not.toBeNull();
    expect(section('powerUp')).not.toBeNull();
  });

  test('Power Up: reads the host route it is given, stays off without a key, and Motion writes its key', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return Response.json({ configured: false, provider: null });
    }) as unknown as typeof fetch;
    configStore.set('diffPowerUpMotion', 'still');
    saved.clear();
    await mountPage({ opinionRoute: '/host/opinion-route' });
    expect(asked).toEqual(['/host/opinion-route']);
    expect(switchNamed('Power Up')?.disabled).toBe(true);
    await click(radio('Motion', 'Stream'));
    expect(saved.get('plannotator-diff-power-up-motion')).toBe('stream');
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

  for (const old of ['semantic', 'analysis', 'review', 'display', 'reviews'] as const) {
    test(`an outside link to the old "${old}" tab opens Reviews`, async () => {
      await mountSettings('review', old);
      expect(activeSidebarTab()).toBe('Reviews');
      expect(document.querySelector('[data-review-settings]')).not.toBeNull();
    });
  }

  test('outside code review, "display" still opens Display', async () => {
    await mountSettings('plan', 'display');
    expect(activeSidebarTab()).toBe('Display');
    expect(document.querySelector('[data-review-settings]')).toBeNull();
  });
});

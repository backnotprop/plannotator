import { afterEach, describe, expect, test } from 'bun:test';

import {
  FONT_CATALOG, getFontLoadStatus, legacyDiffFontSelection, loadCatalogFont,
  migrateLegacyDiffFont, monoFontStack, type FontCatalogRole,
} from './typography';
import {
  DISPLAY_TYPOGRAPHY_CATALOG_IDS, MONO_TYPOGRAPHY_CATALOG_IDS, parseTypographyConfig,
} from '@plannotator/core/config-types';

const hasDom = typeof document !== 'undefined';

describe.if(hasDom)('catalog font loader', () => {
  afterEach(() => {
    document.querySelectorAll('link[data-plannotator-font]').forEach(link => link.remove());
  });

  test('loads trusted catalog URLs once and reports readiness', async () => {
    for (const font of FONT_CATALOG) expect(font.stylesheet).toMatch(/^https:\/\//);

    const first = loadCatalogFont('inter');
    const second = loadCatalogFont('inter');
    const link = document.querySelector<HTMLLinkElement>('link[data-plannotator-font="inter"]');

    expect(first).toBe(second);
    expect(document.querySelectorAll('link[data-plannotator-font]').length).toBe(1);
    expect(getFontLoadStatus('inter')).toBe('loading');

    link!.dispatchEvent(new Event('load'));
    expect(await first).toBe('ready');
    expect(getFontLoadStatus('inter')).toBe('ready');
  });

  test('allows retry after a failed stylesheet load', async () => {
    const first = loadCatalogFont('fira-code');
    const firstLink = document.querySelector<HTMLLinkElement>('link[data-plannotator-font="fira-code"]')!;
    firstLink.dispatchEvent(new Event('error'));
    expect(await first).toBe('error');

    const retry = loadCatalogFont('fira-code');
    const retryLink = document.querySelector<HTMLLinkElement>('link[data-plannotator-font="fira-code"]')!;
    expect(retry).not.toBe(first);
    retryLink.dispatchEvent(new Event('load'));
    expect(await retry).toBe('ready');
  });
});

describe('catalog integrity', () => {
  // The trust boundary (parseTypographyConfig) validates catalog ids against a
  // list in @plannotator/core, which cannot import this file. A drift between
  // the two means either a font the picker offers is rejected on save, or an id
  // the parser trusts resolves to no family at all.
  test('catalog ids match the core allowlist, per role', () => {
    const ids = (role: FontCatalogRole) =>
      FONT_CATALOG.filter(f => (f.roles as readonly FontCatalogRole[]).includes(role)).map(f => f.id).sort();
    expect(ids('display')).toEqual([...DISPLAY_TYPOGRAPHY_CATALOG_IDS].sort());
    expect(ids('mono')).toEqual([...MONO_TYPOGRAPHY_CATALOG_IDS].sort());
  });

  test('one stylesheet URL per family, so no face loads twice at two weight ranges', () => {
    const urls = FONT_CATALOG.map(f => f.stylesheet);
    expect(new Set(urls).size).toBe(urls.length);
    expect(new Set(FONT_CATALOG.map(f => f.family)).size).toBe(FONT_CATALOG.length);
  });

  test('every mono family ends in a generic monospace fallback', () => {
    for (const font of FONT_CATALOG) {
      if ((font.roles as readonly FontCatalogRole[]).includes('mono')) {
        expect(font.family.endsWith(', monospace')).toBe(true);
      }
    }
  });
});

describe('monoFontStack', () => {
  test('quotes a bare family and appends the generic', () => {
    expect(monoFontStack('JetBrains Mono')).toBe("'JetBrains Mono', monospace");
  });

  test('leaves an existing stack alone but still guarantees a generic', () => {
    expect(monoFontStack('"Berkeley Mono", monospace')).toBe('"Berkeley Mono", monospace');
    expect(monoFontStack('"Berkeley Mono", Consolas')).toBe('"Berkeley Mono", Consolas, monospace');
    expect(monoFontStack('ui-monospace')).toBe('ui-monospace');
  });

  test('is empty for empty input', () => {
    expect(monoFontStack(undefined)).toBeUndefined();
    expect(monoFontStack('   ')).toBeUndefined();
  });
});

describe('legacy diffFontFamily migration', () => {
  function fakeStore(values: { diffFontFamily?: string; typography?: unknown }) {
    const state: Record<string, unknown> = { diffFontFamily: '', typography: {}, ...values };
    return {
      state,
      get: (key: 'diffFontFamily' | 'typography') => state[key],
      set: (key: 'diffFontFamily' | 'typography', value: never) => { state[key] = value; },
    };
  }

  test('every family the retired picker offered still maps to a catalog entry', () => {
    for (const legacy of [
      'Fira Code', 'Hack', 'IBM Plex Mono', 'Inconsolata', 'JetBrains Mono',
      'Red Hat Mono', 'Roboto Mono', 'Source Code Pro', 'Atkinson Hyperlegible Mono',
    ]) {
      const selection = legacyDiffFontSelection(legacy);
      expect(selection?.source).toBe('catalog');
      expect(parseTypographyConfig({ review: { mono: selection } }).ok).toBe(true);
    }
  });

  test('seeds review.mono from the legacy value and retires the legacy key', () => {
    const store = fakeStore({ diffFontFamily: 'Hack' });
    expect(migrateLegacyDiffFont(store)).toBe(true);
    expect(store.state.typography).toEqual({ review: { mono: { family: 'hack', source: 'catalog' } } });
    expect(store.state.diffFontFamily).toBe('');
  });

  test('a hand-edited family outside the catalog survives as a custom stack', () => {
    const store = fakeStore({ diffFontFamily: 'Berkeley Mono' });
    migrateLegacyDiffFont(store);
    expect(store.state.typography).toEqual({
      review: { mono: { family: "'Berkeley Mono', monospace", source: 'custom' } },
    });
  });

  test('never overwrites a typography choice the user already made', () => {
    const chosen = { review: { mono: { family: 'fira-code', source: 'catalog' } } };
    const store = fakeStore({ diffFontFamily: 'Hack', typography: chosen });
    migrateLegacyDiffFont(store);
    expect(store.state.typography).toEqual(chosen);
    expect(store.state.diffFontFamily).toBe('');
  });

  test('is one-time: clearing the seeded font does not resurrect it', () => {
    const store = fakeStore({ diffFontFamily: 'Hack' });
    migrateLegacyDiffFont(store);
    store.state.typography = {}; // user picks "Theme default"
    expect(migrateLegacyDiffFont(store)).toBe(false);
    expect(store.state.typography).toEqual({});
  });

  test('does nothing when there was never a legacy value', () => {
    const store = fakeStore({});
    expect(migrateLegacyDiffFont(store)).toBe(false);
    expect(store.state.typography).toEqual({});
  });
});

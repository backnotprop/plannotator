import { afterEach, describe, expect, test } from 'bun:test';

import { FONT_CATALOG, getFontLoadStatus, loadCatalogFont } from './typography';

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

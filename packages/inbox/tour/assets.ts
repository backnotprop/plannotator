import { inboxUrl } from '../inboxUrl';
import type { TourFixture } from './model';

const ASSET_BASE = inboxUrl('/tour/assets/');
export const TOUR_MOCK = 'vscode-mockups.html';
const NAME_RE = /^[a-z0-9][a-z0-9.-]*\.(webp|html|mp4|md)$/;
const BODY_IMAGE_RE = /\]\(([a-z0-9][a-z0-9.-]*\.webp)\)/g;
const isText = (name: string) => name.endsWith('.html') || name.endsWith('.md');

const urls = new Map<string, string>();
const texts = new Map<string, string>();

export function tourAssetUrl(name: string): string {
  return urls.get(name) ?? `${ASSET_BASE}${encodeURIComponent(name)}`;
}

export function tourAssetNameOf(src: string): string {
  for (const [name, url] of urls) if (url === src) return name;
  return decodeURIComponent(src.split('?')[0]!.split('#')[0]!.split('/').pop() ?? '');
}

export function tourAssetLoaded(name: string): boolean {
  return urls.has(name) || texts.has(name);
}

export function tourAssetText(name: string): string | null {
  return texts.get(name) ?? null;
}

export function tourMockHtml(): string | null {
  return tourAssetText(TOUR_MOCK);
}

export function tourAssetNames(fixture: TourFixture): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined) => name && NAME_RE.test(name) && names.add(name);
  for (const [thumb, full] of Object.entries(fixture.full)) {
    add(thumb);
    add(full);
  }
  for (const thread of fixture.threads) {
    for (const m of thread.messages) {
      for (const a of m.attachments ?? []) {
        add(a.asset);
        add(a.poster);
      }
      for (const i of m.inline_images ?? []) add(i.ref);
      for (const match of (m.body ?? '').matchAll(BODY_IMAGE_RE)) add(match[1]);
    }
  }
  return [...names];
}

export async function preloadTourAssets(fixture: TourFixture, waitMs = 10_000): Promise<void> {
  const one = async (name: string) => {
    if (tourAssetLoaded(name) || name.endsWith('.mp4')) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${ASSET_BASE}${encodeURIComponent(name)}`);
        if (!res.ok) continue;
        if (isText(name)) texts.set(name, await res.text());
        else urls.set(name, URL.createObjectURL(await res.blob()));
        return;
      } catch {
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.allSettled(tourAssetNames(fixture).map(one)), new Promise((done) => (timer = setTimeout(done, waitMs)))]);
  clearTimeout(timer);
}

const MARKUP_PREFIX = 'inbox-tour-markup:';
const markups = new Map<string, string>();
let markupCount = 0;

export function keepTourMarkup(blob: Blob): { path: string; name: string } {
  markupCount += 1;
  const path = `${MARKUP_PREFIX}${markupCount}`;
  markups.set(path, URL.createObjectURL(blob));
  return { path, name: `tour-drawing-${markupCount}.png` };
}

export function tourMarkupUrl(path: string): string | null {
  return markups.get(path) ?? null;
}

export function forgetTourMarkups(): void {
  for (const url of markups.values()) URL.revokeObjectURL?.(url);
  markups.clear();
}

export function __forgetTourAssetsForTests(): void {
  for (const url of urls.values()) URL.revokeObjectURL?.(url);
  urls.clear();
  texts.clear();
  forgetTourMarkups();
}

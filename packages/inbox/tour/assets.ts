/**
 * The onboarding tour's content, loaded whole before the tour shows (the
 * owner, on #2178: the tour never shows an error, so failures are made
 * unlikely up front). The fixture, every picture, the film, EVALUATION.md and
 * prototype.html are fetched once per page into memory: pictures as blob URLs
 * (the window's CSP allows `img-src blob:`), the text files as their text.
 * The film is the one exception: it plays from its read-only route by HTTP
 * Range, as media from this origin is all the window's CSP allows. A server that stops mid-tour then changes
 * nothing.
 *
 * What still is not here degrades quietly: a picture or the film falls back to
 * the server's URL (and, failing that, the card's own labelled row).
 *
 * The person's drawings in the tour (a circle on a screenshot, a film's frame)
 * are kept here too, as blob URLs under `inbox-tour-markup:<n>` (images.ts maps
 * the path), and revoked when the tour ends.
 */
import { inboxUrl } from '../inboxUrl';
import type { TourFixture } from './model';

const ASSET_BASE = inboxUrl('/tour/assets/');
export const TOUR_MOCK = 'vscode-mockups.html';
const NAME_RE = /^[a-z0-9][a-z0-9.-]*\.(webp|html|mp4|md)$/;
const BODY_IMAGE_RE = /\]\(([a-z0-9][a-z0-9.-]*\.webp)\)/g;
const isText = (name: string) => name.endsWith('.html') || name.endsWith('.md');

const urls = new Map<string, string>();
const texts = new Map<string, string>();

/** The URL a tour asset loads from: its copy in memory when the tour loaded it, else the read-only asset route. */
export function tourAssetUrl(name: string): string {
  return urls.get(name) ?? `${ASSET_BASE}${encodeURIComponent(name)}`;
}

/** The asset's name for a URL tourAssetUrl gave out (its copy in memory, or the asset route). */
export function tourAssetNameOf(src: string): string {
  for (const [name, url] of urls) if (url === src) return name;
  return decodeURIComponent(src.split('?')[0]!.split('#')[0]!.split('/').pop() ?? '');
}

/** The picture (or film) is in memory (loaded when the tour started). */
export function tourAssetLoaded(name: string): boolean {
  return urls.has(name) || texts.has(name);
}

/** A text asset's text (prototype.html, evaluation.md), when the tour loaded it. */
export function tourAssetText(name: string): string | null {
  return texts.get(name) ?? null;
}

/** prototype.html's text, when the tour loaded it. */
export function tourMockHtml(): string | null {
  return tourAssetText(TOUR_MOCK);
}

/** Every asset the fixture names: the question's tiles and their larger versions, the files, their posters, the images in text. */
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

/**
 * Load every asset the fixture names (at most `waitMs` in all: whatever has
 * not come by then is left to the asset route). Never throws; a name that did
 * not load is simply not in memory.
 */
export async function preloadTourAssets(fixture: TourFixture, waitMs = 10_000): Promise<void> {
  const one = async (name: string) => {
    // The film plays from its route by HTTP Range (the window's CSP takes media from this origin only).
    if (tourAssetLoaded(name) || name.endsWith('.mp4')) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${ASSET_BASE}${encodeURIComponent(name)}`);
        if (!res.ok) continue;
        if (isText(name)) texts.set(name, await res.text());
        else urls.set(name, URL.createObjectURL(await res.blob()));
        return;
      } catch {
        // Tried once more, then left to the asset route.
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.allSettled(tourAssetNames(fixture).map(one)), new Promise((done) => (timer = setTimeout(done, waitMs)))]);
  clearTimeout(timer);
}

// ── The person's drawings in the tour: in memory only ──

const MARKUP_PREFIX = 'inbox-tour-markup:';
const markups = new Map<string, string>();
let markupCount = 0;

/** Keep a drawing (a blob) for this tour: its path, `inbox-tour-markup:<n>`, rides the comment's `images`. */
export function keepTourMarkup(blob: Blob): { path: string; name: string } {
  markupCount += 1;
  const path = `${MARKUP_PREFIX}${markupCount}`;
  markups.set(path, URL.createObjectURL(blob));
  return { path, name: `tour-drawing-${markupCount}.png` };
}

/** The URL a tour drawing shows from, or null once the tour ended. */
export function tourMarkupUrl(path: string): string | null {
  return markups.get(path) ?? null;
}

/** The tour ended (Exit, Finish): every drawing's URL is let go. */
export function forgetTourMarkups(): void {
  for (const url of markups.values()) URL.revokeObjectURL?.(url);
  markups.clear();
}

/** For tests: forget what was loaded. */
export function __forgetTourAssetsForTests(): void {
  for (const url of urls.values()) URL.revokeObjectURL?.(url);
  urls.clear();
  texts.clear();
  forgetTourMarkups();
}

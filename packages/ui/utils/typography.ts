import type { FontSelection } from '@plannotator/core/config-types';

export type FontCatalogRole = 'display' | 'mono';

interface FontCatalogEntryBase {
  label: string;
  family: string;
  roles: readonly FontCatalogRole[];
  stylesheet?: `https://${string}`;
}

/**
 * The single font catalog. The six mono entries below `ibm-plex-mono` came from
 * the retired Code Font picker (`utils/diffFonts.ts`): folding them in here is
 * what keeps a reviewer who had picked Hack or Inconsolata from finding their
 * font unreachable, and keeps ONE stylesheet URL per family so a face is never
 * fetched twice at two different weight ranges.
 */
export const FONT_CATALOG = [
  { id: 'inter', label: 'Inter', family: 'Inter, sans-serif', roles: ['display'], stylesheet: 'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap' },
  { id: 'atkinson-hyperlegible', label: 'Atkinson Hyperlegible', family: '"Atkinson Hyperlegible", sans-serif', roles: ['display'], stylesheet: 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap' },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', family: '"IBM Plex Sans", sans-serif', roles: ['display'], stylesheet: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: '"JetBrains Mono", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@100..800&display=swap' },
  { id: 'fira-code', label: 'Fira Code', family: '"Fira Code", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap' },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', family: '"IBM Plex Mono", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap' },
  { id: 'hack', label: 'Hack', family: 'Hack, monospace', roles: ['mono'], stylesheet: 'https://cdn.jsdelivr.net/npm/hack-font@3/build/web/hack.css' },
  { id: 'inconsolata', label: 'Inconsolata', family: 'Inconsolata, monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=Inconsolata:wght@300..700&display=swap' },
  { id: 'red-hat-mono', label: 'Red Hat Mono', family: '"Red Hat Mono", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=Red+Hat+Mono:wght@300..700&display=swap' },
  { id: 'roboto-mono', label: 'Roboto Mono', family: '"Roboto Mono", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@300..700&display=swap' },
  { id: 'source-code-pro', label: 'Source Code Pro', family: '"Source Code Pro", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=Source+Code+Pro:wght@300..700&display=swap' },
  { id: 'atkinson-hyperlegible-mono', label: 'Atkinson Hyperlegible Mono', family: '"Atkinson Hyperlegible Mono", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@200..700&display=swap' },
] as const satisfies readonly (FontCatalogEntryBase & { id: string })[];

export type FontCatalogEntry = (typeof FONT_CATALOG)[number];
export type FontCatalogId = FontCatalogEntry['id'];
export type DisplayFontId = Extract<FontCatalogEntry, { roles: readonly ['display'] }>['id'];
export type MonoFontId = Extract<FontCatalogEntry, { roles: readonly ['mono'] }>['id'];
export type FontLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** How long a catalog stylesheet may hang before the loader gives up. */
export const FONT_LOAD_TIMEOUT_MS = 10_000;

const byId = new Map<FontCatalogId, FontCatalogEntry>(FONT_CATALOG.map(font => [font.id, font]));
const loads = new Map<FontCatalogId, Promise<FontLoadStatus>>();
const statuses = new Map<FontCatalogId, FontLoadStatus>();

export function fontForId(id: string | undefined): FontCatalogEntry | undefined {
  return id ? byId.get(id as FontCatalogId) : undefined;
}

export function resolveFontFamily(selection: FontSelection | undefined): string | undefined {
  if (!selection?.family) return undefined;
  return selection.source === 'catalog' ? fontForId(selection.family)?.family : selection.family;
}

export function getFontLoadStatus(id: FontCatalogId): FontLoadStatus {
  return statuses.get(id) ?? 'idle';
}

/** Loads a trusted catalog stylesheet once and resolves when its font face is usable. */
export function loadCatalogFont(id: FontCatalogId | undefined): Promise<FontLoadStatus> {
  const font = id && fontForId(id);
  if (!font?.stylesheet) return Promise.resolve('idle');
  const cached = loads.get(font.id);
  if (cached) return cached;
  if (typeof document === 'undefined') return Promise.resolve('idle');

  statuses.set(font.id, 'loading');
  let link: HTMLLinkElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = () => {
    if (timer !== undefined) clearTimeout(timer);
    statuses.set(font.id, 'error');
    loads.delete(font.id);
    link?.remove();
    return 'error' as const;
  };
  const succeed = () => {
    if (timer !== undefined) clearTimeout(timer);
    statuses.set(font.id, 'ready');
    return 'ready' as const;
  };
  const load = new Promise<FontLoadStatus>((resolve) => {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = font.stylesheet!;
    link.dataset.plannotatorFont = font.id;
    link.onload = () => {
      const fontSet = document.fonts;
      if (!fontSet?.load) {
        resolve(succeed());
        return;
      }
      void fontSet.load(`1em ${font.family}`).then(
        () => resolve(succeed()),
        () => resolve(fail()),
      );
    };
    link.onerror = () => resolve(fail());
    // A stylesheet that neither loads nor errors (a CDN that accepts the
    // connection and then stalls) would otherwise leave the settings panel
    // saying "Loading font…" forever. Settle as a failure and let the retry
    // path — fail() drops the memo — try again.
    timer = setTimeout(() => resolve(fail()), FONT_LOAD_TIMEOUT_MS);
    document.head.appendChild(link);
  });
  loads.set(font.id, load);
  return load;
}

export function loadFont(selection: FontSelection | undefined): Promise<FontLoadStatus> {
  return selection?.source === 'catalog' ? loadCatalogFont(selection.family as FontCatalogId) : Promise.resolve('idle');
}

export function isSafeCustomFontFamily(value: string): boolean {
  return value.length > 0 && value.length <= 240 && !/[{};]/.test(value);
}

/**
 * Make a value safe to drop into `font-family: …` for the diff pane.
 *
 * The diff renderer addresses code by column, so a face that fails to load has
 * to fall back to SOME monospace or the columns stop lining up. Callers pass
 * either a bare family name (the legacy `diffFontFamily` cookie, still in use
 * by the read-only guides.show viewer) or a full CSS stack (everything the
 * typography catalog and the custom input produce), so quote the bare form and
 * only append the generic when the stack does not already end in one.
 */
export function monoFontStack(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  // A generic keyword must stay unquoted: '"monospace"' is a family NAME.
  const endsGeneric = /^(?:monospace|ui-monospace)$/.test(trimmed.split(',').pop()!.trim());
  const stack = /[,'"]/.test(trimmed) || endsGeneric ? trimmed : `'${trimmed}'`;
  return endsGeneric ? stack : `${stack}, monospace`;
}

/** Legacy `diffFontFamily` values, by the exact strings the old picker wrote. */
const LEGACY_DIFF_FONT_IDS: Record<string, MonoFontId> = {
  'Fira Code': 'fira-code',
  'Hack': 'hack',
  'IBM Plex Mono': 'ibm-plex-mono',
  'Inconsolata': 'inconsolata',
  'JetBrains Mono': 'jetbrains-mono',
  'Red Hat Mono': 'red-hat-mono',
  'Roboto Mono': 'roboto-mono',
  'Source Code Pro': 'source-code-pro',
  'Atkinson Hyperlegible Mono': 'atkinson-hyperlegible-mono',
};

/**
 * Translate a legacy `diffFontFamily` value into a typography selection.
 * Families the old picker offered become catalog entries; anything else a user
 * hand-edited into config.json survives as a custom stack rather than vanishing.
 */
export function legacyDiffFontSelection(family: string | undefined): FontSelection | undefined {
  const trimmed = family?.trim();
  if (!trimmed) return undefined;
  const id = LEGACY_DIFF_FONT_IDS[trimmed];
  if (id) return { family: id, source: 'catalog' };
  return isSafeCustomFontFamily(trimmed) ? { family: monoFontStack(trimmed)!, source: 'custom' } : undefined;
}

/**
 * One-time migration off the retired Code Font picker.
 *
 * The picker is gone but `diffOptions.fontFamily` is still on disk for anyone
 * who used it, so seed `typography.review.mono` from it once and then clear the
 * legacy key. Clearing is what makes this idempotent: without it, a user who
 * later chose "Theme default" would have their old font resurrected on the next
 * reload, because "no review.mono" would read as "not migrated yet" again.
 * After this runs, typography is the only source of truth for the review face.
 */
export function migrateLegacyDiffFont(store: {
  get: (key: 'diffFontFamily' | 'typography') => unknown;
  set: (key: 'diffFontFamily' | 'typography', value: never) => void;
}): boolean {
  const legacy = store.get('diffFontFamily');
  if (typeof legacy !== 'string' || !legacy.trim()) return false;
  const typography = (store.get('typography') ?? {}) as Record<string, Record<string, unknown>>;
  if (!typography.review?.mono) {
    const selection = legacyDiffFontSelection(legacy);
    if (selection) {
      store.set('typography', {
        ...typography,
        review: { ...typography.review, mono: selection },
      } as never);
    }
  }
  store.set('diffFontFamily', '' as never);
  return true;
}

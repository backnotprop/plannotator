import type { FontSelection } from '@plannotator/core/config-types';

export type FontCatalogRole = 'display' | 'mono';

interface FontCatalogEntryBase {
  label: string;
  family: string;
  roles: readonly FontCatalogRole[];
  stylesheet?: `https://${string}`;
}

export const FONT_CATALOG = [
  { id: 'inter', label: 'Inter', family: 'Inter, sans-serif', roles: ['display'], stylesheet: 'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap' },
  { id: 'atkinson-hyperlegible', label: 'Atkinson Hyperlegible', family: '"Atkinson Hyperlegible", sans-serif', roles: ['display'], stylesheet: 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap' },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', family: '"IBM Plex Sans", sans-serif', roles: ['display'], stylesheet: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: '"JetBrains Mono", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@100..800&display=swap' },
  { id: 'fira-code', label: 'Fira Code', family: '"Fira Code", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap' },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', family: '"IBM Plex Mono", monospace', roles: ['mono'], stylesheet: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap' },
] as const satisfies readonly (FontCatalogEntryBase & { id: string })[];

export type FontCatalogEntry = (typeof FONT_CATALOG)[number];
export type FontCatalogId = FontCatalogEntry['id'];
export type DisplayFontId = Extract<FontCatalogEntry, { roles: readonly ['display'] }>['id'];
export type MonoFontId = Extract<FontCatalogEntry, { roles: readonly ['mono'] }>['id'];
export type FontLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

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
  const fail = () => {
    statuses.set(font.id, 'error');
    loads.delete(font.id);
    link?.remove();
    return 'error' as const;
  };
  const load = new Promise<FontLoadStatus>((resolve) => {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = font.stylesheet!;
    link.dataset.plannotatorFont = font.id;
    link.onload = () => {
      const fontSet = document.fonts;
      if (!fontSet?.load) {
        statuses.set(font.id, 'ready');
        resolve('ready');
        return;
      }
      void fontSet.load(`1em ${font.family}`).then(
        () => { statuses.set(font.id, 'ready'); resolve('ready'); },
        () => resolve(fail()),
      );
    };
    link.onerror = () => resolve(fail());
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

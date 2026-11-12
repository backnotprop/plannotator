/**
 * Hover-card providers beyond the forges (the Inbox's Linear cards use them).
 * Two seams:
 *
 * - A provider names the links it reads (`parse`) and may draw its own card
 *   (`View`): `refCardTarget` (utils/refCard.ts) asks the providers after
 *   `parseForgeRefUrl`, and `RefCardView` (components/RefHoverCard.tsx) hands
 *   a provider's ref to its `View`. Its refs travel as `ForgeRef`s (shaped
 *   alike; `platform` names the provider at runtime), so the controller, the
 *   client cache and the host's transport carry them unchanged.
 * - A plain-text linker turns words in prose into links (`spans`): the inline
 *   scanner (components/InlineMarkdown.tsx `emitPlainTextWithBareUrls`) adds
 *   them beside bare URLs and code paths, never over one. Text already on
 *   screen links too: `usePlainTextLinkers` re-renders on a change.
 *
 * Nothing is registered by default: every host is unchanged until it installs one.
 */
import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import type { ForgeRef } from '@plannotator/core/forge-ref-card';
import type { RefCardViewProps } from '../components/RefHoverCard';

export interface RefCardProvider {
  /** The ref a link names for this provider, or null. */
  parse: (href: string) => ForgeRef | null;
  /** Its card; absent, the forge card draws it. */
  View?: ComponentType<RefCardViewProps>;
  /** The ref is this provider's (for `View` and `label`). */
  owns: (ref: ForgeRef) => boolean;
  /** The card's accessible name for its ref ("Linear issue ENG-123"); absent, the forge's ("Issue #123"). */
  label?: (ref: ForgeRef) => string;
}

const providers: RefCardProvider[] = [];

export function registerRefCardProvider(provider: RefCardProvider): () => void {
  providers.push(provider);
  return () => {
    const at = providers.indexOf(provider);
    if (at >= 0) providers.splice(at, 1);
  };
}

/** The first provider's ref for a link, or null. */
export function providedRefCardTarget(href: string): ForgeRef | null {
  for (const provider of providers) {
    const ref = provider.parse(href);
    if (ref) return ref;
  }
  return null;
}

/** The card a provider draws for its ref, or null (the forge card). */
export function providedRefCardView(ref: ForgeRef): ComponentType<RefCardViewProps> | null {
  return providers.find((provider) => provider.owns(ref))?.View ?? null;
}

/** The accessible name a provider gives its ref's card, or null (the forge's). */
export function providedRefCardLabel(ref: ForgeRef): string | null {
  return providers.find((provider) => provider.owns(ref))?.label?.(ref) ?? null;
}

/** A link a plain-text linker found: `[start, end)` of the text, drawn by `node`. */
export interface PlainTextLinkSpan {
  start: number;
  end: number;
  node: (key: number) => ReactNode;
}

export type PlainTextLinker = (text: string, previousChar: string) => PlainTextLinkSpan[];

const linkers: PlainTextLinker[] = [];
const listeners = new Set<() => void>();
let version = 0;

export function registerPlainTextLinker(linker: PlainTextLinker): () => void {
  linkers.push(linker);
  changed();
  return () => {
    const at = linkers.indexOf(linker);
    if (at >= 0) linkers.splice(at, 1);
    changed();
  };
}

function changed(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

/** The linkers' spans in a piece of prose, leaving out any that overlaps one already `taken` (a URL, a path). */
export function plainTextLinkSpans(text: string, previousChar: string, taken: readonly { start: number; end: number }[]): (PlainTextLinkSpan & { kind: 'node'; value: string })[] {
  if (linkers.length === 0) return [];
  const out: (PlainTextLinkSpan & { kind: 'node'; value: string })[] = [];
  for (const linker of linkers) {
    for (const span of linker(text, previousChar)) {
      if ([...taken, ...out].some((t) => span.start < t.end && span.end > t.start)) continue;
      out.push({ ...span, kind: 'node', value: text.slice(span.start, span.end) });
    }
  }
  return out;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const snapshot = () => version;

/** Re-renders the caller when a linker comes or goes (the inline scanner calls it once). */
export function usePlainTextLinkers(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

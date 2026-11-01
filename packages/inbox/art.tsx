/**
 * The art backgrounds in the Inbox (the owner, 2026-11-01: "the themes I
 * expect to be the same" as Workspaces): Settings → General → Appearance →
 * Background, None by default, so the window is today's until someone picks
 * one. The engine, the six themes and the layer are @plannotator/ui/art, the
 * code Workspaces draws with; this file keeps the choice. A layer sits behind
 * the thread list, the open thread and Settings (InboxArtLayer, one per pane),
 * over the pane's fill and under everything in it; the art keeps clear of
 * every word and control. Reduce motion holds the art still; a hidden tab
 * stops its clock.
 *
 * Remembered per browser in a cookie, like the Inbox's other window-only look
 * choices (the list's look, the sidebar): a cookie ignores the port, so it
 * holds when the Inbox comes back on another one. Nothing goes to the server.
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { storage } from '@plannotator/ui/utils/storage';
import {
  ArtBackgroundProvider,
  ArtLayer,
  type ArtGround,
  parseArtCity,
  parseArtTheme,
  type ArtCityId,
  type ArtThemeId,
  type ArtWorkerFactory,
} from '@plannotator/ui/art';

export const ART_THEME_COOKIE = 'plannotator-inbox-background';
export const ART_CITY_COOKIE = 'plannotator-inbox-background-city';

export interface InboxArtChoice {
  theme: ArtThemeId;
  city: ArtCityId;
}

function read(): InboxArtChoice {
  return { theme: parseArtTheme(storage.getItem(ART_THEME_COOKIE)), city: parseArtCity(storage.getItem(ART_CITY_COOKIE)) };
}

let current: InboxArtChoice = read();
const listeners = new Set<() => void>();

function set(next: InboxArtChoice): void {
  if (next.theme === current.theme && next.city === current.city) return;
  current = next;
  // The defaults leave no cookie behind.
  if (next.theme === 'none') storage.removeItem(ART_THEME_COOKIE);
  else storage.setItem(ART_THEME_COOKIE, next.theme);
  if (next.city === 'harbour') storage.removeItem(ART_CITY_COOKIE);
  else storage.setItem(ART_CITY_COOKIE, next.city);
  for (const listener of listeners) listener();
}

export function chooseArtTheme(theme: ArtThemeId): void {
  set({ ...current, theme });
}

export function chooseArtCity(city: ArtCityId): void {
  set({ ...current, city });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInboxArt(): InboxArtChoice {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Tests only: read the cookies again, as a fresh page would. */
export function resetInboxArtForTests(): void {
  current = read();
  for (const listener of listeners) listener();
}

/** The worker, from a lazy chunk (inlined in the single-file build). */
export const createInboxArtWorker: ArtWorkerFactory = () => import('./artWorker').then((module) => module.startArtWorker());

/** The one art worker for the window, fed the person's choice and the mode on screen. */
export function InboxArtProvider({ children }: { children: ReactNode }) {
  const { theme, city } = useInboxArt();
  const { resolvedMode } = useTheme();
  return (
    <ArtBackgroundProvider theme={theme} city={city} dark={resolvedMode === 'dark'} createWorker={createInboxArtWorker}>
      {children}
    </ArtBackgroundProvider>
  );
}

/**
 * One pane's art layer, as the pane's first child: the list column and the
 * thread pane are frames (their scrollers are inside), Settings scrolls
 * itself. The layer isolates its pane while it is mounted, so with None the
 * pane is exactly what it was.
 */
export function InboxArtLayer({ ground }: { ground: ArtGround }) {
  return <ArtLayer ground={ground} isolateGround />;
}

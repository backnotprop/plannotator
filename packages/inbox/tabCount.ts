import { useEffect, useRef } from 'react';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

export function inboxTabCount(sections: readonly InboxListSection[]): number {
  const counted = new Set<string>();
  for (const section of sections) {
    for (const row of section.threads) {
      if (rowCounts(row)) counted.add(row.thread_id);
    }
  }
  return counted.size;
}

function rowCounts(row: Pick<InboxListRow, 'unseen' | 'resolved_at' | 'back_from_archive'>): boolean {
  if (row.unseen <= 0) return false;
  return row.resolved_at === null || row.back_from_archive === true;
}

export function tabBadgeLabel(count: number): string {
  if (count <= 0) return '';
  return count > 9 ? '9+' : String(count);
}

const COUNT_PREFIX = /^\(\d+\+?\)\s+/;

export function tabTitle(base: string, count: number): string {
  const plain = base.replace(COUNT_PREFIX, '');
  return count > 0 ? `(${count}) ${plain}` : plain;
}

/** One badge for all of the app's windows, last write wins: written only from a list this window has read, never while it has none (zero would mean "not known") and never on unmount. */
export function setAppBadge(count: number, nav: Pick<Navigator, 'setAppBadge' | 'clearAppBadge'> = navigator): void {
  try {
    const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    void done?.catch(() => {});
  } catch {
    // Thrown, not rejected, by a browser whose API differs.
  }
}

export const TAB_ICON_SIZE = 64;
const BADGE_HEIGHT = 40;
// White with near-black digits and a dark ring: Tater is orange, and a red or blue badge sat too close to it at tab size.
const BADGE_RING = 4;
const BADGE_FILL = '#ffffff';
const BADGE_RING_COLOR = '#18181b';
const BADGE_TEXT = '#18181b';
const BADGE_FONT = '700 30px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';

function badgeBox(label: string): { x: number; y: number; w: number; h: number } {
  const w = label.length > 1 ? 54 : BADGE_HEIGHT;
  return { x: TAB_ICON_SIZE - w, y: TAB_ICON_SIZE - BADGE_HEIGHT, w, h: BADGE_HEIGHT };
}

export function drawTabIcon(base: CanvasImageSource, count: number, doc: Document = document): string | null {
  // A browser without part of the canvas API (`roundRect` came in Safari 16 and Firefox 112)
  // answers null, and the caller draws the SVG instead.
  try {
    return drawOnCanvas(base, count, doc);
  } catch {
    return null;
  }
}

function drawOnCanvas(base: CanvasImageSource, count: number, doc: Document): string | null {
  const label = tabBadgeLabel(count);
  const canvas = doc.createElement('canvas');
  canvas.width = TAB_ICON_SIZE;
  canvas.height = TAB_ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // The plain icon is a pixel build (Glass's 32): doubled pixel for pixel, not
  // smoothed, so the tab's own halving gives back the studio's frame under the badge.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(base, 0, 0, TAB_ICON_SIZE, TAB_ICON_SIZE);
  if (label) {
    const { x, y, w, h } = badgeBox(label);
    const inset = BADGE_RING / 2;
    ctx.beginPath();
    ctx.roundRect(x + inset, y + inset, w - BADGE_RING, h - BADGE_RING, (h - BADGE_RING) / 2);
    ctx.fillStyle = BADGE_FILL;
    ctx.fill();
    ctx.lineWidth = BADGE_RING;
    ctx.strokeStyle = BADGE_RING_COLOR;
    ctx.stroke();
    ctx.fillStyle = BADGE_TEXT;
    ctx.font = BADGE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Digits sit a pixel low on a middle baseline; lift them to the optical centre.
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
  }
  return canvas.toDataURL('image/png');
}

export function tabIconSvg(baseDataUrl: string, count: number): string {
  const label = tabBadgeLabel(count);
  const s = TAB_ICON_SIZE;
  let badge = '';
  if (label) {
    const { x, y, w, h } = badgeBox(label);
    const inset = BADGE_RING / 2;
    const r = (h - BADGE_RING) / 2;
    badge =
      `<rect x="${x + inset}" y="${y + inset}" width="${w - BADGE_RING}" height="${h - BADGE_RING}" rx="${r}" fill="${BADGE_FILL}" stroke="${BADGE_RING_COLOR}" stroke-width="${BADGE_RING}"/>` +
      `<text x="${x + w / 2}" y="${y + h / 2 + 1}" fill="${BADGE_TEXT}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" font-weight="700" font-size="30" text-anchor="middle" dominant-baseline="central">${label}</text>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><image href="${baseDataUrl}" width="${s}" height="${s}"/>${badge}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result));
    reader.onerror = () => fail(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((done, fail) => {
    const image = new Image();
    image.onload = () => done(image);
    image.onerror = () => fail(new Error('the icon did not load'));
    image.src = src;
  });
}

type BaseIcon = { dataUrl: string; image: HTMLImageElement | null };

export function useTabCount(count: number, iconHref: string | null = null, badgeHref: string | null = null): void {
  const original = useRef<{ title: string; href: string; type: string | null; badge: string } | null>(null);
  const loaded = useRef<{ href: string; type: string | null; badge: string } | null>(null);
  const base = useRef<Promise<BaseIcon | null> | null>(null);
  const drawn = useRef(new Map<number, string>());

  useEffect(() => {
    const link = iconLink();
    if (!original.current) {
      original.current = {
        title: document.title.replace(COUNT_PREFIX, ''),
        href: link?.getAttribute('href') ?? '/favicon.png',
        type: link?.getAttribute('type') ?? null,
        badge: '/favicon.png',
      };
      loaded.current = { href: original.current.href, type: original.current.type, badge: original.current.badge };
    }
    const plain = iconHref ? { href: iconHref, type: null, badge: badgeHref ?? iconHref } : loaded.current!;
    if (plain.href !== original.current.href) {
      original.current = { ...original.current, ...plain };
      base.current = null;
      drawn.current.clear();
    }
    const start = original.current;
    document.title = tabTitle(start.title, count);
    if (!link) return;
    if (count <= 0) {
      setIcon(link, start.href, start.type);
      return;
    }
    let cancelled = false;
    const key = Math.min(count, 10);
    const ready = drawn.current.get(key);
    if (ready) {
      setIcon(link, ready, null);
      return;
    }
    base.current ??= loadBase(start.badge);
    void base.current.then((icon) => {
      if (!icon) base.current = null;
      if (cancelled || !icon) return;
      let url: string;
      try {
        url = (icon.image ? drawTabIcon(icon.image, count) : null) ?? tabIconSvg(icon.dataUrl, count);
      } catch {
        return;
      }
      drawn.current.set(key, url);
      setIcon(link, url, null);
    });
    return () => {
      cancelled = true;
    };
  }, [count, iconHref, badgeHref]);

  useEffect(
    () => () => {
      const start = original.current;
      if (!start) return;
      document.title = start.title;
      const link = iconLink();
      if (link) setIcon(link, start.href, start.type);
    },
    [],
  );
}

function iconLink(): HTMLLinkElement | null {
  return document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

function setIcon(link: HTMLLinkElement, href: string, type: string | null): void {
  if (link.getAttribute('href') === href) return;
  if (type) link.setAttribute('type', type);
  else link.removeAttribute('type');
  link.setAttribute('href', href);
}

async function loadBase(href: string): Promise<BaseIcon | null> {
  try {
    let dataUrl = href;
    if (!href.startsWith('data:')) {
      const response = await fetch(href, { cache: 'no-cache' });
      if (!response.ok) return null;
      dataUrl = await readAsDataUrl(await response.blob());
    }
    const hasCanvas = document.createElement('canvas').getContext('2d') !== null;
    const image = hasCanvas ? await loadImage(dataUrl).catch(() => null) : null;
    return { dataUrl, image };
  } catch {
    return null;
  }
}

/**
 * The Inbox as an installed app: its web app manifest and the icons it names, the brand studio's larger builds byte for byte (never redrawn or resized).
 * Each file is a literal `type: "file"` import so `bun build --compile` embeds it; a name not listed here is never served.
 */
import { DEFAULT_FAVICON_STYLE, isFaviconStyle, type FaviconStyle } from "@plannotator/shared/favicon";

// @ts-ignore - Bun import attribute for an embedded file
import glass180 from "../inbox/assets/app-icon/glass-180.png" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import glass512 from "../inbox/assets/app-icon/glass-512.png" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import face256 from "../inbox/assets/tab-icon/face-256.png" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import glass192 from "../inbox/assets/tab-icon/glass-192.png" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import yellow192 from "../inbox/assets/tab-icon/yellow-192.png" with { type: "file" };

export const INBOX_MANIFEST_ROUTE = "/manifest.webmanifest";
export const INBOX_APP_ICON_ROUTE = "/app-icon/";
export const INBOX_TOUCH_ICON_ROUTE = "/apple-touch-icon.png";

export const INBOX_APP_ICON_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "glass-180.png": glass180,
  "glass-192.png": glass192,
  "glass-512.png": glass512,
  "yellow-192.png": yellow192,
  "face-256.png": face256,
} as unknown as Record<string, string>);

const STYLE_ICONS: Readonly<Record<FaviconStyle, readonly { name: string; size: number }[]>> = {
  glass: [
    { name: "glass-192.png", size: 192 },
    { name: "glass-512.png", size: 512 },
  ],
  yellow: [{ name: "yellow-192.png", size: 192 }],
  totman: [{ name: "face-256.png", size: 256 }],
};

const TOUCH_ICON: Readonly<Record<FaviconStyle, string>> = {
  glass: "glass-180.png",
  yellow: "yellow-192.png",
  totman: "face-256.png",
};

const styleOf = (style: unknown): FaviconStyle => (isFaviconStyle(style) ? style : DEFAULT_FAVICON_STYLE);

/** The manifest. No `theme_color` or `background_color`: the window's colours are the person's theme, so any one value would tint the app's title bar wrong for most of them. */
export function inboxManifest(style: unknown): Record<string, unknown> {
  return {
    name: "Plannotator Inbox",
    short_name: "Plannotator",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    icons: STYLE_ICONS[styleOf(style)].map(({ name, size }) => ({
      src: `${INBOX_APP_ICON_ROUTE}${name}`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    })),
  };
}

export function inboxAppIconResponse(path: string, style: unknown): Response | null {
  if (path === INBOX_MANIFEST_ROUTE) {
    return new Response(JSON.stringify(inboxManifest(style)), {
      headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }
  const name =
    path === INBOX_TOUCH_ICON_ROUTE
      ? TOUCH_ICON[styleOf(style)]
      : path.startsWith(INBOX_APP_ICON_ROUTE)
        ? path.slice(INBOX_APP_ICON_ROUTE.length)
        : null;
  if (name === null) return null;
  const file = Object.hasOwn(INBOX_APP_ICON_PATHS, name) ? INBOX_APP_ICON_PATHS[name] : undefined;
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(file), { headers: { "Content-Type": "image/png", "Cache-Control": "no-cache" } });
}

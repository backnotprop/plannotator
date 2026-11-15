/**
 * The Inbox as an installed app (Chrome's "Install page as app", Safari's
 * "Add to Dock", a phone's home screen): its web app manifest and the icons
 * the manifest names.
 *
 * With no manifest the browser makes the app's icon from the tab's favicon
 * (16 to 64 px), enlarged. These are the brand studio's larger builds, byte
 * for byte, never redrawn or resized here: Glass's `web/icon-192.png`,
 * `web/icon-512.png` and `web/apple-touch-icon.png`, the Yellow set's
 * `web/icon-192.png`, and the 256 px Face. The manifest names the ones of the
 * person's favicon style (config.json `favicon`), as `/favicon.ico` does.
 *
 * Each file is a literal `type: "file"` import, as the tour's content is
 * (inbox-tour-content.ts): `bun build --compile` embeds it, and nothing is
 * read until a browser asks. A name not listed here is never served.
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

/** Every app icon, by the name its URL carries (the style is in the name, so a new style is a new URL to the browser). */
export const INBOX_APP_ICON_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "glass-180.png": glass180,
  "glass-192.png": glass192,
  "glass-512.png": glass512,
  "yellow-192.png": yellow192,
  "face-256.png": face256,
} as unknown as Record<string, string>);

/** A style's icons, smallest first, with the size each file really is. */
const STYLE_ICONS: Readonly<Record<FaviconStyle, readonly { name: string; size: number }[]>> = {
  glass: [
    { name: "glass-192.png", size: 192 },
    { name: "glass-512.png", size: 512 },
  ],
  yellow: [{ name: "yellow-192.png", size: 192 }],
  totman: [{ name: "face-256.png", size: 256 }],
};

/** What `<link rel="apple-touch-icon">` gets: Glass has the studio's 180; the other styles their one large build. */
const TOUCH_ICON: Readonly<Record<FaviconStyle, string>> = {
  glass: "glass-180.png",
  yellow: "yellow-192.png",
  totman: "face-256.png",
};

const styleOf = (style: unknown): FaviconStyle => (isFaviconStyle(style) ? style : DEFAULT_FAVICON_STYLE);

/**
 * The manifest. No `theme_color` or `background_color`: the window's colours
 * are the person's theme (dozens, light and dark), so any one value here would
 * tint the app's title bar wrong for most of them.
 */
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

/** The manifest, an app icon or the touch icon for a GET; null for any other path. */
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

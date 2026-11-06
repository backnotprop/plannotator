/**
 * Web pictures on a Shape board: `<image href="https://…/logo.png">`, an
 * image ref's `https://` target. `plannotator shape update` fetches each one
 * once, here, and the store copies the bytes into the shape's files/ like a
 * picture from this computer (store.ts, `webPictures`). So the stored board
 * names only its own files: nothing is fetched when someone views it, the
 * Inbox window's policy (`img-src 'self' data: blob:`) stays as it is, and the
 * board still shows the picture offline, on a phone, and after the site
 * changes it.
 *
 * The rules: `http:` or `https:` with a host and no credentials; one 15 s
 * deadline per picture, across its redirects and its body; at most 10 MB
 * (the store's cap); the bytes must sniff as an image (an SVG by its `<svg>`
 * root), and the kept name carries the sniffed type's extension. CLI only
 * (Bun): Pi has no `shape update`, so this is not vendored.
 */
import { sniffImageContentType } from "../review-image";
import { SHAPE_IMAGE_MAX_BYTES, shapeBoardPictureSources, type ShapeWebPicture } from "./store";

export const SHAPE_WEB_PICTURE_TIMEOUT_MS = 15_000;
/** The most web pictures one board fetches. */
export const SHAPE_WEB_PICTURES_MAX = 60;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/svg+xml": "svg",
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** An attribute's source text as the browser would read it (`&amp;` is `&`). */
const decodeEntities = (raw: string) =>
  raw.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (e, d?: string, h?: string, name?: string) => {
    if (name !== undefined) return ENTITIES[name] ?? e;
    const c = d !== undefined ? Number(d) : parseInt(h!, 16);
    return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : e;
  });

/** The web address a picture names, or null when it is not one we fetch. */
function webPictureUrl(src: string): URL | null {
  try {
    const url = new URL(decodeEntities(src.trim()));
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** The name a fetched picture is kept under: the address's last segment, with the extension its bytes say. */
function pictureName(url: URL, contentType: string): string {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const stem = last.replace(/[^\w.-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "picture";
  return `${stem}.${EXTENSIONS[contentType] ?? "png"}`;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** The body, or null past `max`. The deadline stops it too, even from a server that sends nothing more. */
async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const stop = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (signal.aborted) throw new Error("timed out");
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function fetchOne(src: string, fetchImpl: Fetch, timeoutMs: number): Promise<ShapeWebPicture | string> {
  const url = webPictureUrl(src);
  if (!url) return "is not a web address this board can fetch (http or https, with a host)";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: controller.signal, credentials: "omit", headers: { Accept: "image/*" } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return `could not be fetched (HTTP ${res.status})`;
    }
    const bytes = await readCapped(res, SHAPE_IMAGE_MAX_BYTES, controller.signal);
    if (!bytes) return `is larger than ${SHAPE_IMAGE_MAX_BYTES} bytes`;
    const type = sniffImageContentType(bytes);
    if (!type || !EXTENSIONS[type]) return "is not a PNG, JPEG, GIF, WebP, SVG, AVIF or ICO image";
    return { bytes, name: pictureName(url, type) };
  } catch {
    return controller.signal.aborted ? `did not arrive within ${timeoutMs / 1000} s` : "could not be fetched";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch every web picture the board names, by the address as written: what
 * `store.update` takes as `webPictures`. A picture that fails is one error
 * line under its field; the board is then refused, as for a missing file.
 */
export async function fetchShapeWebPictures(
  board: unknown,
  options: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<{ pictures: Map<string, ShapeWebPicture>; errors: string[] }> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? SHAPE_WEB_PICTURE_TIMEOUT_MS;
  const pictures = new Map<string, ShapeWebPicture>();
  const fields = new Map<string, string>();
  for (const { src, field } of shapeBoardPictureSources(board)) {
    if (/^https?:\/\//i.test(src) && !fields.has(src)) fields.set(src, field);
  }
  const wanted = [...fields];
  if (wanted.length > SHAPE_WEB_PICTURES_MAX) {
    return { pictures, errors: [`the board names ${wanted.length} web pictures; at most ${SHAPE_WEB_PICTURES_MAX}`] };
  }
  // A few at a time: a board of logos fetches quickly without opening dozens of connections at once.
  // Errors in the order the board names them, whichever answers first.
  const failed: (string | null)[] = wanted.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const i = next++;
      const [src, field] = wanted[i]!;
      const got = await fetchOne(src, fetchImpl, timeoutMs);
      if (typeof got === "string") failed[i] = `${field}: "${src.slice(0, 80)}" ${got}`;
      else pictures.set(src, got);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, worker));
  return { pictures, errors: failed.filter((e): e is string => e !== null) };
}

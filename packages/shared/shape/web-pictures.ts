import { sniffImageContentType } from "../review-image";
import { SHAPE_IMAGE_MAX_BYTES, shapeBoardPictureSources, type ShapeWebPicture } from "./store";

export const SHAPE_WEB_PICTURE_TIMEOUT_MS = 15_000;
export const SHAPE_WEB_PICTURES_TIMEOUT_MS = 30_000;
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
const decodeEntities = (raw: string) =>
  raw.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (e, d?: string, h?: string, name?: string) => {
    if (name !== undefined) return ENTITIES[name] ?? e;
    const c = d !== undefined ? Number(d) : parseInt(h!, 16);
    return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : e;
  });

function webPictureUrl(src: string, html: boolean): URL | null {
  try {
    const url = new URL(html ? decodeEntities(src.trim()) : src.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function pictureName(url: URL, contentType: string): string {
  const segment = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
  }
  const last = decoded.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const stem = last.replace(/[^\w.-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "picture";
  return `${stem}.${EXTENSIONS[contentType] ?? "png"}`;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  if (signal.aborted) throw new Error("timed out");
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

const INSTEAD = "; download it and name the file, or leave it out";

const untilAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("timed out"));
    signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
  });

function reason(e: unknown): string {
  const err = e as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const code = typeof err?.code === "string" ? err.code : typeof err?.cause?.code === "string" ? err.cause.code : "";
  const message = typeof err?.message === "string" ? err.message : "";
  const text = [code, message].filter(Boolean).join(": ").replace(/\s+/g, " ").trim();
  return text ? (text.length > 120 ? `${text.slice(0, 119)}…` : text) : "no answer";
}

async function fetchOne(src: string, html: boolean, fetchImpl: Fetch, timeoutMs: number, board: AbortSignal, boardMs: number): Promise<ShapeWebPicture | string> {
  const url = webPictureUrl(src, html);
  if (!url) return "is not a web address this board can fetch (http or https, with a host)";
  if (board.aborted) return `was not fetched: the board's web pictures get ${boardMs / 1000} s in all${INSTEAD}`;
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), timeoutMs);
  const signal = AbortSignal.any([own.signal, board]);
  try {
    const res = await Promise.race([fetchImpl(url, { redirect: "follow", signal, credentials: "omit", headers: { Accept: "image/*" } }), untilAbort(signal)]);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return `could not be fetched: the site answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${INSTEAD}`;
    }
    const bytes = await readCapped(res, SHAPE_IMAGE_MAX_BYTES, signal);
    if (!bytes) return `is too large: more than ${SHAPE_IMAGE_MAX_BYTES / 1024 / 1024} MB, the most a board keeps`;
    const type = sniffImageContentType(bytes);
    if (!type || !EXTENSIONS[type]) {
      const said = res.headers.get("content-type")?.split(";")[0]?.trim();
      return `is not an image: its bytes are not a PNG, JPEG, GIF, WebP, SVG, AVIF or ICO${said ? ` (the site called it ${said})` : ""}`;
    }
    return { bytes, name: pictureName(url, type) };
  } catch (e) {
    if (own.signal.aborted) return `timed out: it did not arrive within ${timeoutMs / 1000} s${INSTEAD}`;
    if (board.aborted) return `timed out: the board's web pictures get ${boardMs / 1000} s in all, and this one was still on its way${INSTEAD}`;
    return `could not be fetched (${reason(e)})${INSTEAD}`;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchShapeWebPictures(
  board: unknown,
  options: { fetch?: Fetch; timeoutMs?: number; boardTimeoutMs?: number } = {},
): Promise<{ pictures: Map<string, ShapeWebPicture>; errors: string[] }> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? SHAPE_WEB_PICTURE_TIMEOUT_MS;
  const boardMs = options.boardTimeoutMs ?? SHAPE_WEB_PICTURES_TIMEOUT_MS;
  const pictures = new Map<string, ShapeWebPicture>();
  const fields = new Map<string, string>();
  for (const { src, field } of shapeBoardPictureSources(board)) {
    if (/^https?:\/\//i.test(src) && !fields.has(src)) fields.set(src, field);
  }
  const wanted = [...fields];
  if (wanted.length > SHAPE_WEB_PICTURES_MAX) {
    return { pictures, errors: [`the board names ${wanted.length} web pictures; at most ${SHAPE_WEB_PICTURES_MAX}`] };
  }
  const failed: (string | null)[] = wanted.map(() => null);
  const allOf = new AbortController();
  const deadline = setTimeout(() => allOf.abort(), boardMs);
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const i = next++;
      const [src, field] = wanted[i]!;
      const got = await fetchOne(src, field.endsWith(".html"), fetchImpl, timeoutMs, allOf.signal, boardMs);
      if (typeof got === "string") failed[i] = `${field}: "${src.slice(0, 80)}" ${got}`;
      else pictures.set(src, got);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, worker));
  } finally {
    clearTimeout(deadline);
  }
  return { pictures, errors: failed.filter((e): e is string => e !== null) };
}

/**
 * A project's picture for its letter mark (approval "inbox-letter-marks", 2026-11-07; Settings → Rows, all off by
 * default). In order, the first one there:
 *
 * 1. A picture someone set (the project's ⋯ menu "Set picture…"), kept in the data dir per project.
 * 2. "Logo from the repo" (a switch): a favicon or logo found inside the project's own folder. Read from disk only,
 *    never the network.
 * 3. "GitHub pictures" (a switch, off by default): the owner's picture, for a project whose `origin` is on
 *    github.com (inbox-repos.ts `InboxProjectRepo`). Fetched by the Inbox, never by the window, from
 *    `https://avatars.githubusercontent.com/<owner>?s=64`, once per owner, kept in the data dir and fetched again
 *    after a week (the kept one is served if that fails). A failed fetch is remembered for an hour.
 * 4. None: the window draws the letters.
 *
 * The window's CSP stays `img-src 'self' data: blob:`: every picture is served from the Inbox's own origin.
 *
 * Under the test sandbox (`PLANNOTATOR_TEST_SANDBOX`) with no fetcher given, nothing is fetched: only a kept picture
 * is served, so tests and scratch runs never ask GitHub.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sniffImageContentType } from "@plannotator/shared/review-image";
import type { InboxProjectRepo } from "@plannotator/core/inbox-types";
import { readCapped } from "./inbox-card-favicons";

export type ProjectPictureFrom = "upload" | "repo" | "github";
export interface ProjectPicture {
  type: string;
  body: Uint8Array<ArrayBuffer>;
  from: ProjectPictureFrom;
}

export interface ProjectPictureOptions {
  /** Where pictures are kept (the Inbox's own data dir, `inbox/project-pictures`). */
  dir: string;
  /** How the GitHub picture is fetched (default the runtime's). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
  /** A GitHub picture this old is fetched again (a week). */
  freshMs?: number;
  /** A failed GitHub fetch is not tried again for this long (an hour). */
  missMs?: number;
  /** A repo's logo is looked for again after this long (five minutes). */
  repoMs?: number;
  /** Where `PLANNOTATOR_TEST_SANDBOX` is read (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
}

export const PROJECT_PICTURE_MAX_BYTES = 512 * 1024;
export const PROJECT_GITHUB_TIMEOUT_MS = 4000;
const GITHUB_MAX_BYTES = 256 * 1024;
const REPO_LOGO_MAX_BYTES = 256 * 1024;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const REPO_MS = 5 * 60 * 1000;
const MAX_REDIRECTS = 3;
const GITHUB_AVATARS = "avatars.githubusercontent.com";
/** What a picture set with Set picture… may be: the five the refusal names. */
const UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
/** What a repo's logo may be: a favicon is often an ICO. */
const PICTURE_TYPES = new Set([...UPLOAD_TYPES, "image/x-icon", "image/avif", "image/bmp"]);
/** What GitHub's answer may be: never SVG. */
const GITHUB_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PROJECT_ID = /^[A-Za-z0-9_]{1,80}$/;
/** A GitHub login: letters, digits and single hyphens, at most 39. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * Where a repo's logo is looked for, in order, from the project's folder: then the same in each folder under `apps/`
 * and `packages/` (a monorepo's site), then a `<link rel="icon">` in an `index.html`.
 */
export const REPO_LOGO_FILES = [
  "favicon.svg",
  "favicon.png",
  "favicon.ico",
  "public/favicon.svg",
  "public/favicon.png",
  "public/favicon.ico",
  "public/icon.svg",
  "public/icon.png",
  "public/logo.svg",
  "public/logo.png",
  "app/icon.svg",
  "app/icon.png",
  "app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",
  "static/favicon.svg",
  "static/favicon.png",
  "static/favicon.ico",
];
const MONOREPO_DIRS = ["apps", "packages"];
const MONOREPO_MAX_CHILDREN = 24;
const INDEX_HTML = ["index.html", "public/index.html", "src/index.html"];

/** The GitHub owner of a project's `origin`, or null: github.com only (never another host), a valid login only. */
export function githubOwner(repo: InboxProjectRepo | null | undefined): string | null {
  if (!repo || (repo.host ?? "").toLowerCase() !== "github.com") return null;
  const owner = repo.display.split("/")[0] ?? "";
  return GITHUB_LOGIN.test(owner) ? owner : null;
}

/** The project's folder as a real path, or null (gone, not a folder). */
function realRoot(root: string): string | null {
  if (!root || !isAbsolute(root)) return null;
  try {
    const real = realpathSync(root);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** A picture file inside `root` (its real path inside the real root, a file, small enough, an image), or null. */
function readInside(root: string, path: string): { type: string; body: Uint8Array<ArrayBuffer> } | null {
  try {
    const full = resolve(root, path);
    const real = realpathSync(full);
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    const stat = statSync(real);
    if (!stat.isFile() || stat.size === 0 || stat.size > REPO_LOGO_MAX_BYTES) return null;
    const bytes = readFileSync(real);
    const body = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as Uint8Array<ArrayBuffer>;
    const type = sniffImageContentType(body);
    return type && PICTURE_TYPES.has(type) ? { type, body } : null;
  } catch {
    return null;
  }
}

/** The `href` of an `index.html`'s `<link rel="icon">` (or "shortcut icon", "apple-touch-icon"), or null. */
export function iconHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)["']?/i.exec(tag)?.[1]?.toLowerCase().split(/\s+/) ?? [];
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (value) return value;
  }
  return null;
}

/** A local path an icon `href` names, or null: never a URL with a scheme or host (the network is never asked). */
function localHref(href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const path = href.split(/[?#]/)[0]!;
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** The places to look in a folder: the fixed names, then its `index.html` files' icon links. */
function findIn(root: string, base: string): { type: string; body: Uint8Array<ArrayBuffer> } | null {
  for (const file of REPO_LOGO_FILES) {
    const found = readInside(root, join(base, file));
    if (found) return found;
  }
  for (const file of INDEX_HTML) {
    let html: string;
    try {
      // The page itself must be inside the folder too (a symlink out of it is not read).
      const real = realpathSync(join(root, base, file));
      const rel = relative(root, real);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
      const stat = statSync(real);
      if (!stat.isFile() || stat.size > 512 * 1024) continue;
      html = readFileSync(real, "utf8");
    } catch {
      continue;
    }
    const href = iconHref(html);
    const path = href ? localHref(href) : null;
    if (!path) continue;
    // "/favicon.png" is the site's root: the folder the page is served from (its own, or `public/`).
    const tries = path.startsWith("/")
      ? [join(base, path), join(base, "public", path), join(base, dirname(file), path)]
      : [join(base, dirname(file), path), join(base, "public", path)];
    for (const tryPath of tries) {
      const found = readInside(root, tryPath);
      if (found) return found;
    }
  }
  return null;
}

/** A favicon or logo inside the project's folder (`REPO_LOGO_FILES`, then `apps/*` and `packages/*`, then index.html), or null. Never throws. */
export function findRepoLogo(root: string): { type: string; body: Uint8Array<ArrayBuffer> } | null {
  const real = realRoot(root);
  if (!real) return null;
  const own = findIn(real, ".");
  if (own) return own;
  for (const dir of MONOREPO_DIRS) {
    let children: string[];
    try {
      const full = join(real, dir);
      if (!lstatSync(full).isDirectory()) continue;
      children = readdirSync(full, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort()
        .slice(0, MONOREPO_MAX_CHILDREN);
    } catch {
      continue;
    }
    for (const child of children) {
      const found = findIn(real, join(dir, child));
      if (found) return found;
    }
  }
  return null;
}

export interface ProjectPictures {
  /** When the project's uploaded picture was set (ms), or undefined: the window's key for it. */
  uploadedAt(projectId: string): number | undefined;
  /** Keep an uploaded picture (sniffed: PNG, JPEG, GIF, WebP, SVG, ICO, AVIF or BMP; at most 512 KB). */
  setUpload(projectId: string, bytes: Uint8Array): { ok: true; at: number } | { ok: false; reason: "not_image" | "too_big" | "not_saved" };
  /** Drop the uploaded picture; true when there was one. */
  removeUpload(projectId: string): boolean;
  /** The project's picture in order (uploaded, the repo's logo when `logo`, the GitHub owner's when `github`), or null. */
  get(project: { id: string; root: string }, use: { logo: boolean; github: boolean; repo: () => InboxProjectRepo | null | Promise<InboxProjectRepo | null> }): Promise<ProjectPicture | null>;
}

export function createProjectPictures(options: ProjectPictureOptions): ProjectPictures {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? PROJECT_GITHUB_TIMEOUT_MS;
  const freshMs = options.freshMs ?? WEEK_MS;
  const missMs = options.missMs ?? HOUR_MS;
  const repoMs = options.repoMs ?? REPO_MS;
  const sandbox = !!(options.env ?? process.env).PLANNOTATOR_TEST_SANDBOX;
  // Tests and scratch runs never reach GitHub: with no fetcher given, the sandbox serves only what is kept.
  const fetchImpl = options.fetch ?? (sandbox ? null : (url: string, init: RequestInit) => fetch(url, init));
  const uploadDir = join(options.dir, "upload");
  const githubDir = join(options.dir, "github");
  const misses = new Map<string, number>();
  const inFlight = new Map<string, Promise<ProjectPicture | null>>();
  const repoLogos = new Map<string, { at: number; found: { type: string; body: Uint8Array<ArrayBuffer> } | null }>();
  /** Each uploaded picture's time, read from disk once. */
  let uploads: Map<string, number> | null = null;

  const readMeta = (file: string): { type: string; at: number } | null => {
    try {
      const meta = JSON.parse(readFileSync(file, "utf8")) as { type?: unknown; at?: unknown };
      return typeof meta.type === "string" && typeof meta.at === "number" ? { type: meta.type, at: meta.at } : null;
    } catch {
      return null;
    }
  };
  const readPicture = (base: string, allowed: Set<string>): { type: string; at: number; body: Uint8Array<ArrayBuffer> } | null => {
    const meta = readMeta(`${base}.json`);
    if (!meta || !allowed.has(meta.type)) return null;
    try {
      const bytes = readFileSync(`${base}.img`);
      return { ...meta, body: new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as Uint8Array<ArrayBuffer> };
    } catch {
      return null;
    }
  };
  const writePicture = (dir: string, name: string, type: string, body: Uint8Array, at: number): boolean => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.img`), body);
      writeFileSync(join(dir, `${name}.json`), JSON.stringify({ type, at }));
      return true;
    } catch {
      return false;
    }
  };

  const uploadTimes = (): Map<string, number> => {
    if (uploads) return uploads;
    uploads = new Map();
    try {
      for (const name of readdirSync(uploadDir)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        const meta = PROJECT_ID.test(id) ? readMeta(join(uploadDir, name)) : null;
        if (meta) uploads.set(id, meta.at);
      }
    } catch {
      // No folder yet: no uploads.
    }
    return uploads;
  };

  const repoLogo = (root: string) => {
    const kept = repoLogos.get(root);
    if (kept && now() - kept.at < repoMs) return kept.found;
    const found = findRepoLogo(root);
    repoLogos.set(root, { at: now(), found });
    if (repoLogos.size > 500) repoLogos.delete(repoLogos.keys().next().value!);
    return found;
  };

  async function fetchGithub(owner: string): Promise<{ type: string; body: Uint8Array<ArrayBuffer> } | null> {
    if (!fetchImpl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
    aborted.catch(() => {});
    const deadline = <T,>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);
    let url = new URL(`https://${GITHUB_AVATARS}/${encodeURIComponent(owner)}?s=64`);
    try {
      for (let hop = 0; ; hop++) {
        const response = await deadline(fetchImpl(url.href, { method: "GET", redirect: "manual", credentials: "omit", headers: { accept: "image/*" }, signal: controller.signal }));
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => {});
          const location = response.headers.get("location");
          if (!location || hop + 1 > MAX_REDIRECTS) return null;
          const next = new URL(location, url);
          // Only GitHub's own picture host, over https.
          if (next.protocol !== "https:" || next.hostname !== GITHUB_AVATARS || next.port || next.username || next.password) return null;
          url = next;
          continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          return null;
        }
        const body = await readCapped(response, GITHUB_MAX_BYTES, deadline);
        if (!body) return null;
        const type = sniffImageContentType(body);
        return type && GITHUB_TYPES.has(type) ? { type, body } : null;
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function github(owner: string): Promise<ProjectPicture | null> {
    const key = owner.toLowerCase();
    const base = join(githubDir, key);
    const kept = readPicture(base, GITHUB_TYPES);
    if (kept && now() - kept.at < freshMs) return Promise.resolve({ type: kept.type, body: kept.body, from: "github" });
    const keptPicture = kept ? ({ type: kept.type, body: kept.body, from: "github" } as const) : null;
    const missed = misses.get(key);
    if (missed !== undefined && now() - missed < missMs) return Promise.resolve(keptPicture);
    if (!fetchImpl) return Promise.resolve(keptPicture);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const run = fetchGithub(owner)
      .then((got): ProjectPicture | null => {
        if (!got) {
          misses.set(key, now());
          if (misses.size > 500) misses.delete(misses.keys().next().value!);
          // Offline or a failure: the kept picture, else the letters.
          return keptPicture;
        }
        misses.delete(key);
        writePicture(githubDir, key, got.type, got.body, now());
        return { ...got, from: "github" };
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  }

  return {
    uploadedAt: (projectId) => uploadTimes().get(projectId),
    setUpload(projectId, bytes) {
      if (!PROJECT_ID.test(projectId)) return { ok: false, reason: "not_saved" };
      if (bytes.byteLength === 0 || bytes.byteLength > PROJECT_PICTURE_MAX_BYTES) return { ok: false, reason: bytes.byteLength === 0 ? "not_image" : "too_big" };
      const type = sniffImageContentType(bytes);
      if (!type || !UPLOAD_TYPES.has(type)) return { ok: false, reason: "not_image" };
      // Never the same time twice for one project, so the window's key always changes.
      const at = Math.max(now(), (uploadTimes().get(projectId) ?? 0) + 1);
      if (!writePicture(uploadDir, projectId, type, bytes, at)) return { ok: false, reason: "not_saved" };
      uploadTimes().set(projectId, at);
      return { ok: true, at };
    },
    removeUpload(projectId) {
      if (!PROJECT_ID.test(projectId)) return false;
      const had = uploadTimes().delete(projectId);
      for (const ext of [".img", ".json"]) {
        try {
          rmSync(join(uploadDir, `${projectId}${ext}`), { force: true });
        } catch {
          // Gone already.
        }
      }
      return had;
    },
    async get(project, use) {
      if (PROJECT_ID.test(project.id) && uploadTimes().has(project.id)) {
        const upload = readPicture(join(uploadDir, project.id), UPLOAD_TYPES);
        if (upload) return { type: upload.type, body: upload.body, from: "upload" };
      }
      if (use.logo) {
        const logo = repoLogo(project.root);
        if (logo) return { ...logo, from: "repo" };
      }
      if (use.github) {
        const owner = githubOwner(await use.repo());
        if (owner) return github(owner);
      }
      return null;
    },
  };
}

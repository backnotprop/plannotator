/**
 * npm metadata for the review's package cards: weekly downloads, license,
 * release date, deprecation. Runtime-agnostic (fetch only).
 *
 * Nothing here runs until the reviewer turned the lookup on, and the names it
 * is given were already filtered by `packageRouting` (see
 * package-changes-service.ts): a name under a private scope, or any name when
 * the default registry is not npm's, never reaches `lookupPackages`.
 *
 * Sources (measured 2026-10-26):
 *  - license, publish time, latest, deprecated: the full packument,
 *    `GET <registry>/<name>` (the only npm document with per-version `time`;
 *    100 KB to 2 MB gzipped for popular packages).
 *  - weekly downloads: `GET <downloads>/downloads/point/last-week/<a,b,c>`
 *    (bulk for unscoped names; npm refuses scoped names in bulk).
 */
import type { PackageMetadata } from "@plannotator/core/package-changes";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const NPM_API = "https://api.npmjs.org";
const PACKUMENT_CONCURRENCY = 4;
const TIMEOUT_MS = 8000;
const CACHE_MS = 60 * 60 * 1000;

export interface PackageLookupRequest { name: string; version: string | null }

export interface PackageRouting {
  /** The default registry is not npm's, or a setting could not be read: nothing may be sent. */
  privateDefault: boolean;
  /** Scopes (`@acme`) configured for another registry, or configured at all in Yarn or Bun. */
  privateScopes: Set<string>;
}

const PUBLIC_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

function unquote(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

function isPublicRegistry(url: string): boolean {
  try {
    return PUBLIC_REGISTRY_HOSTS.has(new URL(unquote(url)).hostname);
  } catch {
    return false;
  }
}

function scopeOf(raw: string): string | null {
  const s = unquote(raw);
  if (!s) return null;
  return s.startsWith("@") ? s : `@${s}`;
}

/** Drops a trailing ` # comment` outside quotes. */
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line;
}

/**
 * The keys of a flow mapping (`{ acme: {...}, "@b": x }` in YAML, `{ acme = "..." }`
 * in TOML), depth one only. Null when the braces never close.
 */
function flowKeys(text: string, separator: ":" | "="): string[] | null {
  const open = text.indexOf("{");
  if (open < 0) return null;
  const keys: string[] = [];
  let depth = 0;
  let quote = "";
  let key = "";
  let readingKey = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
      if (readingKey) key += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      if (readingKey) key += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      if (depth === 1) { readingKey = true; key = ""; }
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return keys;
      continue;
    }
    if (depth === 1 && ch === ",") { readingKey = true; key = ""; continue; }
    if (depth === 1 && readingKey && ch === separator) {
      if (key.trim()) keys.push(unquote(key));
      readingKey = false;
      continue;
    }
    if (readingKey) key += ch;
  }
  return null;
}

/** The registry settings package managers read, as text. */
export interface PackageRoutingFiles {
  npmrc: readonly string[];
  /** Yarn Berry, `.yarnrc.yml`. */
  yarnrc: readonly string[];
  /** Yarn classic, `.yarnrc`. */
  yarnrcClassic?: readonly string[];
  bunfig: readonly string[];
  /** A settings file existed but could not be read: nothing may be sent. */
  unreadable?: boolean;
}

function readNpmrc(text: string, routing: PackageRouting): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^["']?(@[^:=\s"']+:)?registry["']?\s*=\s*(.*)$/.exec(line);
    if (!m || isPublicRegistry(m[2])) continue;
    if (m[1]) routing.privateScopes.add(m[1].slice(0, -1));
    else routing.privateDefault = true;
  }
}

function readYarnrcClassic(text: string, routing: PackageRouting): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const m = /^["']?(?:--)?(@[^:"'\s]+:)?registry["']?(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!m || isPublicRegistry(m[2])) continue;
    if (m[1]) routing.privateScopes.add(m[1].slice(0, -1));
    else routing.privateDefault = true;
  }
}

/**
 * `.yarnrc.yml`: `npmRegistryServer` and the keys of `npmScopes`, in block or
 * flow style at any indent. A scope Yarn configures at all counts as private;
 * an `npmScopes` this cannot read withholds everything.
 */
function readYarnrcYml(text: string, routing: PackageRouting): void {
  const lines = text.split(/\r?\n/).map(stripComment).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length === 0) return;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const topIndent = indentOf(lines[0]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (indentOf(line) !== topIndent) continue;
    const m = /^["']?([A-Za-z][\w]*)["']?\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, rest] = m;
    if (key === "npmRegistryServer") {
      if (!isPublicRegistry(rest)) routing.privateDefault = true;
      continue;
    }
    if (key !== "npmScopes") continue;
    const children: string[] = [];
    for (let j = i + 1; j < lines.length && indentOf(lines[j]) > topIndent; j++) children.push(lines[j]);
    let scopes: string[] | null = null;
    if (rest.startsWith("{") || (!rest && children[0]?.trim().startsWith("{"))) {
      scopes = flowKeys([rest, ...children].join("\n"), ":");
    } else if (!rest && children.length > 0) {
      const childIndent = indentOf(children[0]);
      const keys = children
        .filter((c) => indentOf(c) === childIndent)
        .map((c) => /^((?:"[^"]*"|'[^']*'|[^:\s]+))\s*:/.exec(c.trim())?.[1]);
      scopes = keys.every((k): k is string => !!k) ? keys.map(unquote) : null;
    }
    if (scopes === null || (scopes.length === 0 && rest.replace(/\s/g, "") !== "{}")) {
      routing.privateDefault = true;
      continue;
    }
    for (const s of scopes) {
      const scope = scopeOf(s);
      if (scope) routing.privateScopes.add(scope);
    }
  }
}

/** `bunfig.toml`: `[install] registry`, and any scope under `install.scopes` (a table, a sub-table or an inline table). */
function readBunfig(text: string, routing: PackageRouting): void {
  let table = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1].trim().replace(/\s+/g, "");
      const sub = /^install\.scopes\.(.+)$/.exec(table);
      if (sub) {
        const scope = scopeOf(sub[1]);
        if (scope) routing.privateScopes.add(scope);
      }
      continue;
    }
    const kv = /^("[^"]*"|'[^']*'|[^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = table ? `${table}.${unquote(kv[1])}` : unquote(kv[1]);
    const value = kv[2];
    if (key === "install.registry") {
      const url = /url\s*=\s*["']([^"']+)["']/.exec(value)?.[1] ?? value;
      if (!isPublicRegistry(url)) routing.privateDefault = true;
    } else if (key === "install.scopes") {
      const keys = flowKeys(value, "=");
      if (!keys || keys.length === 0) routing.privateDefault = true;
      else for (const k of keys) { const scope = scopeOf(k); if (scope) routing.privateScopes.add(scope); }
    } else if (key.startsWith("install.scopes.")) {
      const scope = scopeOf(key.slice("install.scopes.".length).split(".")[0]);
      if (scope) routing.privateScopes.add(scope);
    }
  }
}

/**
 * Registry settings in the environment. npm reads any `npm_config_*` key
 * case-insensitively; Yarn and Bun have their own. A scoped key withholds its
 * scope; a default one, or one this cannot read, withholds everything.
 */
function readEnv(env: Record<string, string | undefined>, routing: PackageRouting): void {
  for (const [rawKey, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    const m = /^(npm_config_|yarn_|bun_config_)(.+)$/.exec(key);
    if (!m) continue;
    const rest = m[2];
    if (rest === "registry" || rest === "npm_registry_server") {
      if (!isPublicRegistry(value)) routing.privateDefault = true;
      continue;
    }
    const scoped = /^(@[^:]+):registry$/.exec(rest);
    if (scoped) {
      if (!isPublicRegistry(value)) routing.privateScopes.add(scoped[1]);
      continue;
    }
    if (rest === "npm_scopes") routing.privateDefault = true;
  }
}

/**
 * Which names may be sent to npm. Errs toward withholding: a scope that Yarn
 * or Bun configures at all counts as private, and so does every scope when
 * the default registry is not npm's or a setting could not be read.
 */
export function packageRouting(files: PackageRoutingFiles, env: Record<string, string | undefined> = {}): PackageRouting {
  const routing: PackageRouting = { privateDefault: files.unreadable === true, privateScopes: new Set() };
  readEnv(env, routing);
  for (const text of files.npmrc) readNpmrc(text, routing);
  for (const text of files.yarnrcClassic ?? []) readYarnrcClassic(text, routing);
  for (const text of files.yarnrc) readYarnrcYml(text, routing);
  for (const text of files.bunfig) readBunfig(text, routing);
  return routing;
}

/** True when the name may be sent to npm under this routing. */
export function isSendable(name: string, routing: PackageRouting): boolean {
  if (routing.privateDefault) return false;
  if (name.startsWith("@")) return !routing.privateScopes.has(name.split("/")[0]);
  return true;
}

/** Test knob: a stand-in registry on this machine (loopback only), never another host. */
function baseUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    const u = new URL(value);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    if (loopback && (u.protocol === "http:" || u.protocol === "https:")) return value.replace(/\/+$/, "");
  } catch {}
  return fallback;
}

interface PackumentSummary { license: string | null; times: Record<string, string>; latest: string | null; deprecated: Record<string, string> }
const CACHE_ENTRIES = 2000;
const packumentCache = new Map<string, { at: number; value: PackumentSummary | "not-found" }>();
const downloadsCache = new Map<string, { at: number; value: number | null }>();
/** One request per package at a time: two versions of a name share its packument. */
const packumentInFlight = new Map<string, Promise<PackumentSummary | "not-found">>();

function remember<V>(cache: Map<string, { at: number; value: V }>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

/** Test hook: forget every cached answer. */
export function clearPackageMetadataCache(): void {
  packumentCache.clear();
  downloadsCache.clear();
  packumentInFlight.clear();
}

class LookupError extends Error {
  constructor(readonly offline: boolean, message: string) { super(message); }
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown | "not-found"> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "plannotator-review" },
    });
  } catch (err) {
    throw new LookupError(true, err instanceof Error && err.name === "TimeoutError" ? "timed out" : "offline");
  }
  if (res.status === 404) return "not-found";
  if (res.status === 429) throw new LookupError(false, "rate limited");
  if (!res.ok) throw new LookupError(false, `npm ${res.status}`);
  return res.json();
}

function licenseOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") return (v as { type: string }).type;
  return null;
}

function packument(fetchImpl: typeof fetch, registry: string, name: string): Promise<PackumentSummary | "not-found"> {
  const key = `${registry} ${name}`;
  const hit = packumentCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  let pending = packumentInFlight.get(key);
  if (!pending) {
    pending = fetchPackument(fetchImpl, registry, name, key).finally(() => packumentInFlight.delete(key));
    packumentInFlight.set(key, pending);
  }
  return pending;
}

async function fetchPackument(fetchImpl: typeof fetch, registry: string, name: string, key: string): Promise<PackumentSummary | "not-found"> {
  const data = await getJson(fetchImpl, `${registry}/${name.replace("/", "%2F")}`);
  let value: PackumentSummary | "not-found" = "not-found";
  if (data !== "not-found" && data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const versions = (d.versions && typeof d.versions === "object" ? d.versions : {}) as Record<string, Record<string, unknown>>;
    const deprecated: Record<string, string> = {};
    for (const [v, m] of Object.entries(versions)) if (typeof m?.deprecated === "string" && m.deprecated) deprecated[v] = m.deprecated;
    const tags = (d["dist-tags"] ?? {}) as Record<string, unknown>;
    const latest = typeof tags.latest === "string" ? tags.latest : null;
    value = {
      license: licenseOf(d.license) ?? (latest ? licenseOf(versions[latest]?.license) : null),
      times: (d.time && typeof d.time === "object" ? d.time : {}) as Record<string, string>,
      latest,
      deprecated,
    };
  }
  remember(packumentCache, key, value);
  return value;
}

async function weeklyDownloads(fetchImpl: typeof fetch, api: string, names: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const todo = names.filter((n) => {
    const hit = downloadsCache.get(`${api} ${n}`);
    if (hit && Date.now() - hit.at < CACHE_MS) { out.set(n, hit.value); return false; }
    return true;
  });
  const unscoped = todo.filter((n) => !n.startsWith("@"));
  const scoped = todo.filter((n) => n.startsWith("@"));
  const record = (n: string, v: number | null) => { out.set(n, v); remember(downloadsCache, `${api} ${n}`, v); };
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < unscoped.length; i += 100) {
    const batch = unscoped.slice(i, i + 100);
    jobs.push(getJson(fetchImpl, `${api}/downloads/point/last-week/${batch.join(",")}`).then((data) => {
      // A single name answers its own object, several a map of them.
      const map = data === "not-found" ? {} : batch.length === 1 ? { [batch[0]]: data } : (data as Record<string, unknown>);
      for (const n of batch) {
        const d = map[n] as { downloads?: unknown } | null | undefined;
        record(n, typeof d?.downloads === "number" ? d.downloads : null);
      }
    }));
  }
  for (const n of scoped) {
    jobs.push(getJson(fetchImpl, `${api}/downloads/point/last-week/${n}`).then((d) => {
      record(n, d !== "not-found" && typeof (d as { downloads?: unknown })?.downloads === "number" ? (d as { downloads: number }).downloads : null);
    }));
  }
  await Promise.all(jobs);
  return out;
}

export interface PackageLookupResult {
  packages: PackageMetadata[];
  /** Set when some lookups failed: a word or two (`offline`, `rate limited`). */
  failure?: string;
  offline: boolean;
}

/** Looks up exactly the given names: the caller has already filtered them. */
export async function lookupPackages(
  requests: readonly PackageLookupRequest[],
  deps: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<PackageLookupResult> {
  const env = deps.env ?? {};
  const fetchImpl = deps.fetchImpl ?? fetch;
  const registry = baseUrl(env.PLANNOTATOR_PACKAGE_REGISTRY_URL, NPM_REGISTRY);
  const api = baseUrl(env.PLANNOTATOR_PACKAGE_DOWNLOADS_URL, NPM_API);
  const results: PackageMetadata[] = requests.map((r) => ({ name: r.name, version: r.version, status: "ok" }));
  let offline = false;
  let failure: string | undefined;
  const fail = (err: unknown) => {
    const e = err instanceof LookupError ? err : new LookupError(false, "failed");
    if (e.offline) offline = true;
    failure ??= e.message;
  };

  const names = [...new Set(results.map((r) => r.name))];
  const downloadsJob = weeklyDownloads(fetchImpl, api, names).catch((err) => { fail(err); return new Map<string, number | null>(); });
  let next = 0;
  const worker = async () => {
    while (next < results.length) {
      const r = results[next++];
      try {
        const p = await packument(fetchImpl, registry, r.name);
        if (p === "not-found") { r.status = "not-found"; continue; }
        const v = r.version && p.times[r.version] ? r.version : null;
        Object.assign(r, {
          license: p.license,
          latest: p.latest,
          publishedAt: v ? p.times[v] : null,
          deprecated: r.version ? p.deprecated[r.version] ?? null : null,
        });
      } catch (err) {
        r.status = "error";
        fail(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PACKUMENT_CONCURRENCY, results.length) }, worker));
  const downloads = await downloadsJob;
  for (const r of results) {
    if (r.status === "ok") r.weeklyDownloads = downloads.get(r.name) ?? null;
  }
  return { packages: results, offline, ...(failure ? { failure } : {}) };
}

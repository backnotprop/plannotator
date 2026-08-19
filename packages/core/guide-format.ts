/**
 * Portable Guided Review format — the versioned snapshot document plus the
 * pure `(snapshot) → HTML` renderer every producer shares (Plannotator UI,
 * `plannotator guide export`, future agent skills).
 *
 * Browser-safe and dependency-free: this module is consumed by the review UI,
 * the CDN viewer, both servers, and the CLI. It must never import `node:*`.
 *
 * Decision record: adr/decisions/007-portable-guided-reviews-20260815.md (D1, D5, D9).
 */

import { parseDiffToFiles } from "./diff-files";
import type { CodeGuideOutput, GuideDiffRef, GuideSection } from "./guide";

/** Discriminator for a portable guided-review snapshot. */
export const GUIDE_SNAPSHOT_KIND = "plannotator-guided-review" as const;

/** Current snapshot schema version. Bump only for breaking changes; add optional fields freely. */
export const GUIDE_SNAPSHOT_VERSION = 1 as const;

/** DOM id of the inert `<script type="application/json">` carrying the snapshot inside an exported HTML file. */
export const GUIDE_SNAPSHOT_SCRIPT_ID = "plannotator-guided-review";

/** `<meta name>` marker on exported documents. */
export const GUIDE_EXPORT_META_NAME = "plannotator-guided-review";

/** Structural sanity caps — these bound parsing work, they are NOT size limits (D1: no caps on diff size). */
export const MAX_GUIDE_SECTIONS = 100;
export const MAX_GUIDE_DIFF_REFS = 50_000;

/** What kind of changeset the guide describes. Rendered in the viewer header so a reader knows what they are looking at. */
export type GuideSourceKind = "local" | "pr" | "workspace" | "commit";

/** The exact review the guide was generated against — the diff panes are drawn from `rawPatch` and nothing else. */
export interface GuideSnapshotReview {
  readonly rawPatch: string;
  /** Human label, e.g. "main..HEAD" or "PR #123". */
  readonly gitRef: string;
  /** Plannotator diff type id, e.g. "since-base", "merge-base", "commit:<sha>", "workspace-current". */
  readonly diffType?: string;
  /** Base ref the diff was computed against, when the diff type has one. */
  readonly base?: string;
}

/** Pull/merge request identity, when the guide is of a PR. */
export interface GuideSnapshotPullRequest {
  readonly url: string;
  readonly number?: number;
  readonly title?: string;
  readonly platform?: "github" | "gitlab";
}

/** Where the changeset came from. Every field but `kind` is optional so any producer can be honest about what it knows. */
export interface GuideSnapshotSource {
  readonly kind: GuideSourceKind;
  /** e.g. "owner/repo" or a directory name. */
  readonly repo?: string;
  readonly branch?: string;
  readonly headSha?: string;
  readonly pr?: GuideSnapshotPullRequest;
  /** For `kind: "commit"` — the commit the guide describes. */
  readonly commitSha?: string;
}

/** Provenance of the guide text itself. */
export interface GuideSnapshotGenerator {
  readonly engine?: string;
  readonly model?: string;
  readonly generatedAt?: string;
  /** Reviewer-supplied instructions that shaped this guide, kept for provenance (D5). */
  readonly customInstructions?: string;
}

/** Presentation hint recorded by the exporter; the viewer may honor it, the reader may override it. */
export interface GuideSnapshotTheme {
  readonly palette?: string;
}

/** The guide plus the reader's checkbox state. Never carries persistence flags (`saved`/`moved`). */
export type GuideSnapshotGuide = CodeGuideOutput & { readonly reviewed: readonly boolean[] };

/** Versioned data contract shared by downloaded files, the CDN viewer, and future hosted guides. */
export interface GuideSnapshotV1 {
  readonly kind: typeof GUIDE_SNAPSHOT_KIND;
  readonly version: typeof GUIDE_SNAPSHOT_VERSION;
  readonly exportedAt: string;
  readonly guide: GuideSnapshotGuide;
  readonly review: GuideSnapshotReview;
  readonly source: GuideSnapshotSource;
  readonly generator?: GuideSnapshotGenerator;
  readonly theme?: GuideSnapshotTheme;
}

export type GuideSnapshot = GuideSnapshotV1;

/**
 * What a producer captures when a guide job LAUNCHES: the exact review the
 * guide will describe. Stored beside the saved guide and turned into a
 * snapshot at export time (decision record D6). Never read at export time
 * from live session state — the on-screen diff may have moved since.
 */
export interface GuideLaunchReview {
  readonly rawPatch: string;
  readonly gitRef: string;
  readonly diffType?: string;
  readonly base?: string;
  readonly source: GuideSnapshotSource;
  /** Reviewer-supplied instructions the guide was generated with (provenance). */
  readonly customInstructions?: string;
}

export interface BuildGuideSnapshotInput {
  readonly guide: CodeGuideOutput;
  readonly reviewed: readonly boolean[];
  readonly review: GuideLaunchReview;
  readonly generator?: GuideSnapshotGenerator;
  readonly theme?: GuideSnapshotTheme;
  /** Injected for deterministic tests; defaults to now. */
  readonly exportedAt?: string;
}

/** Assemble a v1 snapshot from producer-side pieces. Pure; strips persistence-only guide flags. */
export function buildGuideSnapshot(input: BuildGuideSnapshotInput): GuideSnapshotV1 {
  const { guide } = input;
  const reviewed = new Array<boolean>(guide.sections.length).fill(false);
  input.reviewed.forEach((v, i) => { if (i < reviewed.length) reviewed[i] = v === true; });
  const generatorInput: GuideSnapshotGenerator = {
    ...input.generator,
    ...(input.generator?.customInstructions === undefined && input.review.customInstructions
      ? { customInstructions: input.review.customInstructions }
      : {}),
  };
  const generator = Object.fromEntries(
    Object.entries(generatorInput).filter(([, v]) => typeof v === "string" && v.length > 0),
  ) as GuideSnapshotGenerator;
  return {
    kind: GUIDE_SNAPSHOT_KIND,
    version: GUIDE_SNAPSHOT_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    guide: {
      title: guide.title,
      intent: guide.intent,
      sections: guide.sections,
      ...(guide.unplacedFiles !== undefined && { unplacedFiles: guide.unplacedFiles }),
      reviewed,
    },
    review: {
      rawPatch: input.review.rawPatch,
      gitRef: input.review.gitRef,
      ...(input.review.diffType !== undefined && { diffType: input.review.diffType }),
      ...(input.review.base !== undefined && { base: input.review.base }),
    },
    source: input.review.source,
    ...(Object.keys(generator).length > 0 && { generator }),
    ...(input.theme?.palette && { theme: { palette: input.theme.palette } }),
  };
}

/** Stable parse failure for malformed or unsupported snapshot data. */
export interface GuideSnapshotParseError {
  readonly _tag: "GuideSnapshotParseError";
  readonly message: string;
  /** JSON-path-ish location, e.g. `$.guide.sections[2].diffs[0].file`. */
  readonly path: string;
}

export type GuideSnapshotParseResult =
  | { readonly ok: true; readonly value: GuideSnapshotV1 }
  | { readonly ok: false; readonly error: GuideSnapshotParseError };

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GuideSnapshotParseError };

// ---------------------------------------------------------------------------
// Parsing — strict, total, unknown fields rejected at every level.
// ---------------------------------------------------------------------------

function fail(path: string, message: string): Parsed<never> {
  return { ok: false, error: { _tag: "GuideSnapshotParseError", path, message } };
}

/**
 * Type guard for the failure branch. `packages/core` compiles without
 * strictNullChecks, where `if (!x.ok)` does not narrow a discriminated union;
 * a user-defined guard does.
 */
function isFail<T>(x: Parsed<T>): x is { readonly ok: false; readonly error: GuideSnapshotParseError } {
  return !x.ok;
}

function asRecord(input: unknown, path: string): Parsed<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail(path, "Expected an object");
  }
  // SAFETY: object/null/array checks above establish a string-keyed object.
  return { ok: true, value: input as Record<string, unknown> };
}

function strict(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): Parsed<Record<string, unknown>> {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    return fail(path, `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  return { ok: true, value: record };
}

function str(input: unknown, path: string, opts?: { readonly nonEmpty?: boolean }): Parsed<string> {
  if (typeof input !== "string") return fail(path, "Expected a string");
  if (opts?.nonEmpty && input.trim().length === 0) return fail(path, "Expected a non-empty string");
  return { ok: true, value: input };
}

function optStr(record: Record<string, unknown>, key: string, path: string): Parsed<string | undefined> {
  const input = record[key];
  if (input === undefined) return { ok: true, value: undefined };
  return str(input, `${path}.${key}`);
}

function optNum(record: Record<string, unknown>, key: string, path: string): Parsed<number | undefined> {
  const input = record[key];
  if (input === undefined) return { ok: true, value: undefined };
  if (typeof input !== "number" || !Number.isFinite(input)) return fail(`${path}.${key}`, "Expected a number");
  return { ok: true, value: input };
}

function parseDiffRef(input: unknown, path: string): Parsed<GuideDiffRef> {
  const object = asRecord(input, path);
  if (isFail(object)) return object;
  const s = strict(object.value, ["file", "summary"], path);
  if (isFail(s)) return s;
  const file = str(s.value.file, `${path}.file`, { nonEmpty: true });
  if (isFail(file)) return file;
  const summary = optStr(s.value, "summary", path);
  if (isFail(summary)) return summary;
  return {
    ok: true,
    value: summary.value === undefined ? { file: file.value } : { file: file.value, summary: summary.value },
  };
}

function parseSection(input: unknown, path: string): Parsed<GuideSection> {
  const object = asRecord(input, path);
  if (isFail(object)) return object;
  const s = strict(object.value, ["title", "overview", "diffs"], path);
  if (isFail(s)) return s;
  const title = str(s.value.title, `${path}.title`, { nonEmpty: true });
  if (isFail(title)) return title;
  const overview = str(s.value.overview, `${path}.overview`);
  if (isFail(overview)) return overview;
  if (!Array.isArray(s.value.diffs)) return fail(`${path}.diffs`, "Expected an array");
  const diffs: GuideDiffRef[] = [];
  for (let i = 0; i < s.value.diffs.length; i++) {
    const ref = parseDiffRef(s.value.diffs[i], `${path}.diffs[${i}]`);
    if (isFail(ref)) return ref;
    diffs.push(ref.value);
  }
  return { ok: true, value: { title: title.value, overview: overview.value, diffs } };
}

function parseGuide(input: unknown): Parsed<GuideSnapshotGuide> {
  const path = "$.guide";
  const object = asRecord(input, path);
  if (isFail(object)) return object;
  const s = strict(object.value, ["title", "intent", "sections", "unplacedFiles", "reviewed"], path);
  if (isFail(s)) return s;
  const title = str(s.value.title, `${path}.title`, { nonEmpty: true });
  if (isFail(title)) return title;
  const intent = str(s.value.intent, `${path}.intent`);
  if (isFail(intent)) return intent;
  if (!Array.isArray(s.value.sections)) return fail(`${path}.sections`, "Expected an array");
  if (s.value.sections.length === 0) return fail(`${path}.sections`, "Expected at least one section");
  if (s.value.sections.length > MAX_GUIDE_SECTIONS) {
    return fail(`${path}.sections`, `Guide exceeds the ${MAX_GUIDE_SECTIONS}-section limit`);
  }
  const sections: GuideSection[] = [];
  let refCount = 0;
  for (let i = 0; i < s.value.sections.length; i++) {
    const section = parseSection(s.value.sections[i], `${path}.sections[${i}]`);
    if (isFail(section)) return section;
    refCount += section.value.diffs.length;
    if (refCount > MAX_GUIDE_DIFF_REFS) {
      return fail(`${path}.sections`, `Guide exceeds the ${MAX_GUIDE_DIFF_REFS}-file-reference limit`);
    }
    sections.push(section.value);
  }

  let unplacedFiles: string[] | undefined;
  if (s.value.unplacedFiles !== undefined) {
    if (!Array.isArray(s.value.unplacedFiles)) return fail(`${path}.unplacedFiles`, "Expected an array");
    if (refCount + s.value.unplacedFiles.length > MAX_GUIDE_DIFF_REFS) {
      return fail(`${path}.unplacedFiles`, `Guide exceeds the ${MAX_GUIDE_DIFF_REFS}-file-reference limit`);
    }
    unplacedFiles = [];
    for (let i = 0; i < s.value.unplacedFiles.length; i++) {
      const file = str(s.value.unplacedFiles[i], `${path}.unplacedFiles[${i}]`, { nonEmpty: true });
      if (isFail(file)) return file;
      unplacedFiles.push(file.value);
    }
  }

  if (!Array.isArray(s.value.reviewed)) return fail(`${path}.reviewed`, "Expected an array");
  // Normalize to sections.length: pad with false, drop extras.
  const reviewed = new Array<boolean>(sections.length).fill(false);
  for (let i = 0; i < s.value.reviewed.length; i++) {
    const value = s.value.reviewed[i];
    if (typeof value !== "boolean") return fail(`${path}.reviewed[${i}]`, "Expected a boolean");
    if (i < sections.length) reviewed[i] = value;
  }

  return {
    ok: true,
    value: {
      title: title.value,
      intent: intent.value,
      sections,
      ...(unplacedFiles !== undefined && { unplacedFiles }),
      reviewed,
    },
  };
}

function parseReview(input: unknown): Parsed<GuideSnapshotReview> {
  const path = "$.review";
  const object = asRecord(input, path);
  if (isFail(object)) return object;
  const s = strict(object.value, ["rawPatch", "gitRef", "diffType", "base"], path);
  if (isFail(s)) return s;
  const rawPatch = str(s.value.rawPatch, `${path}.rawPatch`);
  if (isFail(rawPatch)) return rawPatch;
  const gitRef = str(s.value.gitRef, `${path}.gitRef`);
  if (isFail(gitRef)) return gitRef;
  const diffType = optStr(s.value, "diffType", path);
  if (isFail(diffType)) return diffType;
  const base = optStr(s.value, "base", path);
  if (isFail(base)) return base;
  return {
    ok: true,
    value: {
      rawPatch: rawPatch.value,
      gitRef: gitRef.value,
      ...(diffType.value !== undefined && { diffType: diffType.value }),
      ...(base.value !== undefined && { base: base.value }),
    },
  };
}

const SOURCE_KINDS: readonly GuideSourceKind[] = ["local", "pr", "workspace", "commit"];

function parsePullRequest(input: unknown, path: string): Parsed<GuideSnapshotPullRequest | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  const object = asRecord(input, path);
  if (isFail(object)) return object;
  const s = strict(object.value, ["url", "number", "title", "platform"], path);
  if (isFail(s)) return s;
  const url = str(s.value.url, `${path}.url`, { nonEmpty: true });
  if (isFail(url)) return url;
  // Hosted pages render this straight into an href, so only web URLs pass;
  // CSP and React already neuter `javascript:` links, this keeps that guard
  // from resting on them alone.
  if (!/^https?:\/\//i.test(url.value)) return fail(`${path}.url`, "Expected an http(s) URL");
  const number = optNum(s.value, "number", path);
  if (isFail(number)) return number;
  const title = optStr(s.value, "title", path);
  if (isFail(title)) return title;
  const rawPlatform = s.value.platform;
  if (rawPlatform !== undefined && rawPlatform !== "github" && rawPlatform !== "gitlab") {
    return fail(`${path}.platform`, "Expected github or gitlab");
  }
  const platform = rawPlatform as "github" | "gitlab" | undefined;
  return {
    ok: true,
    value: {
      url: url.value,
      ...(number.value !== undefined && { number: number.value }),
      ...(title.value !== undefined && { title: title.value }),
      ...(platform !== undefined && { platform }),
    },
  };
}

function parseSource(input: unknown): Parsed<GuideSnapshotSource> {
  const path = "$.source";
  const object = asRecord(input, path);
  if (isFail(object)) return object;
  const s = strict(object.value, ["kind", "repo", "branch", "headSha", "pr", "commitSha"], path);
  if (isFail(s)) return s;
  const kind = s.value.kind;
  if (typeof kind !== "string" || !SOURCE_KINDS.includes(kind as GuideSourceKind)) {
    return fail(`${path}.kind`, `Expected one of ${SOURCE_KINDS.join(", ")}`);
  }
  const repo = optStr(s.value, "repo", path);
  if (isFail(repo)) return repo;
  const branch = optStr(s.value, "branch", path);
  if (isFail(branch)) return branch;
  const headSha = optStr(s.value, "headSha", path);
  if (isFail(headSha)) return headSha;
  const pr = parsePullRequest(s.value.pr, `${path}.pr`);
  if (isFail(pr)) return pr;
  const commitSha = optStr(s.value, "commitSha", path);
  if (isFail(commitSha)) return commitSha;
  return {
    ok: true,
    value: {
      kind: kind as GuideSourceKind,
      ...(repo.value !== undefined && { repo: repo.value }),
      ...(branch.value !== undefined && { branch: branch.value }),
      ...(headSha.value !== undefined && { headSha: headSha.value }),
      ...(pr.value !== undefined && { pr: pr.value }),
      ...(commitSha.value !== undefined && { commitSha: commitSha.value }),
    },
  };
}

function parseGenerator(input: unknown): Parsed<GuideSnapshotGenerator | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  const path = "$.generator";
  const object = asRecord(input, path);
  if (isFail(object)) return object;
  const s = strict(object.value, ["engine", "model", "generatedAt", "customInstructions"], path);
  if (isFail(s)) return s;
  const out: { -readonly [K in keyof GuideSnapshotGenerator]: GuideSnapshotGenerator[K] } = {};
  for (const key of ["engine", "model", "generatedAt", "customInstructions"] as const) {
    const v = optStr(s.value, key, path);
    if (isFail(v)) return v;
    if (v.value !== undefined) out[key] = v.value;
  }
  return { ok: true, value: out };
}

function parseTheme(input: unknown): Parsed<GuideSnapshotTheme | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  const path = "$.theme";
  const object = asRecord(input, path);
  if (isFail(object)) return object;
  const s = strict(object.value, ["palette"], path);
  if (isFail(s)) return s;
  const palette = optStr(s.value, "palette", path);
  if (isFail(palette)) return palette;
  return { ok: true, value: palette.value === undefined ? {} : { palette: palette.value } };
}

/** Parse an unknown value into a v1 snapshot. Never throws. */
export function parseGuideSnapshot(input: unknown): GuideSnapshotParseResult {
  const object = asRecord(input, "$");
  if (isFail(object)) return object;
  const s = strict(
    object.value,
    ["kind", "version", "exportedAt", "guide", "review", "source", "generator", "theme"],
    "$",
  );
  if (isFail(s)) return s;
  if (s.value.kind !== GUIDE_SNAPSHOT_KIND) return fail("$.kind", `Expected ${GUIDE_SNAPSHOT_KIND}`);
  if (s.value.version !== GUIDE_SNAPSHOT_VERSION) {
    return fail("$.version", `Unsupported snapshot version: ${String(s.value.version)}`);
  }
  const exportedAt = str(s.value.exportedAt, "$.exportedAt", { nonEmpty: true });
  if (isFail(exportedAt)) return exportedAt;
  if (!Number.isFinite(Date.parse(exportedAt.value))) return fail("$.exportedAt", "Expected an ISO-compatible timestamp");
  const guide = parseGuide(s.value.guide);
  if (isFail(guide)) return guide;
  const review = parseReview(s.value.review);
  if (isFail(review)) return review;
  const source = parseSource(s.value.source);
  if (isFail(source)) return source;
  const generator = parseGenerator(s.value.generator);
  if (isFail(generator)) return generator;
  const theme = parseTheme(s.value.theme);
  if (isFail(theme)) return theme;
  return {
    ok: true,
    value: {
      kind: GUIDE_SNAPSHOT_KIND,
      version: GUIDE_SNAPSHOT_VERSION,
      exportedAt: exportedAt.value,
      guide: guide.value,
      review: review.value,
      source: source.value,
      ...(generator.value !== undefined && { generator: generator.value }),
      ...(theme.value !== undefined && { theme: theme.value }),
    },
  };
}

/** Parse serialized JSON into a v1 snapshot. Never throws. */
export function parseGuideSnapshotJson(text: string): GuideSnapshotParseResult {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return fail("$", "Snapshot is not valid JSON");
  }
  return parseGuideSnapshot(input);
}

// ---------------------------------------------------------------------------
// Patch inspection — file list and language detection (best-effort hints).
// ---------------------------------------------------------------------------

export interface GuidePatchFile {
  readonly path: string;
  readonly patch: string;
}

/** Per-file chunks of a unified diff with their resolved (post-image) path. */
export function listGuidePatchFiles(rawPatch: string): GuidePatchFile[] {
  return parseDiffToFiles(rawPatch).map((file) => ({ path: file.path, patch: file.patch }));
}

/**
 * Extension → Shiki grammar id. A superset of what the review UI recognizes.
 * This only drives `<link rel="modulepreload">` hints in exported HTML; the
 * viewer still lazy-loads any grammar the preload list missed, so gaps here
 * cost latency, never correctness.
 */
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "json5",
  py: "python", pyi: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", cs: "csharp", fs: "fsharp", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  c: "c", h: "c", m: "objective-c", mm: "objective-cpp",
  css: "css", scss: "scss", less: "less", html: "html", htm: "html", vue: "vue", svelte: "svelte", astro: "astro",
  xml: "xml", svg: "xml", md: "markdown", mdx: "mdx", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish", ps1: "powershell",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto", lua: "lua", php: "php", dart: "dart",
  ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", scala: "scala", clj: "clojure", r: "r",
  pl: "perl", tf: "terraform", hcl: "hcl", zig: "zig", nix: "nix", ml: "ocaml", mli: "ocaml",
  dockerfile: "docker", makefile: "make", cmake: "cmake", tex: "latex", diff: "diff", patch: "diff",
};

const BASENAME_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  makefile: "make",
  cmakelists: "cmake",
};

/** Every grammar id `guideLanguageForPath` can return — the only chunks an export's `viewer.langs` pin can ever reference. */
export const GUIDE_LANGUAGE_IDS: readonly string[] = [...new Set([...Object.values(EXTENSION_LANGUAGES), ...Object.values(BASENAME_LANGUAGES)])].sort();

/** Shiki grammar id for a path, or undefined when the viewer should render plain text. */
export function guideLanguageForPath(path: string): string | undefined {
  const base = path.split("/").pop() ?? path;
  const lowerBase = base.toLowerCase();
  const byBasename = BASENAME_LANGUAGES[lowerBase.replace(/\.[^.]*$/, "")] ?? BASENAME_LANGUAGES[lowerBase];
  if (byBasename) return byBasename;
  const dot = lowerBase.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXTENSION_LANGUAGES[lowerBase.slice(dot + 1)];
}

/** Sorted, deduplicated grammar ids the viewer will need for this patch (preload hint). */
export function detectGuideLanguages(rawPatch: string): string[] {
  const langs = new Set<string>();
  for (const file of listGuidePatchFiles(rawPatch)) {
    const lang = guideLanguageForPath(file.path);
    if (lang) langs.add(lang);
  }
  return [...langs].sort();
}

// ---------------------------------------------------------------------------
// HTML rendering — the one place an exported document is built.
// ---------------------------------------------------------------------------

/** Where the viewer lives. Produced by the CDN build (manifest) and pinned into every export. */
export interface GuideViewerAssets {
  /** Absolute base, e.g. "https://guides.show/v1/". Must be https (http allowed for localhost only). */
  readonly baseUrl: string;
  /** Path relative to `baseUrl`, e.g. "viewer.8f3a2c.js". */
  readonly js: string;
  /** Path relative to `baseUrl`, e.g. "viewer.8f3a2c.css". */
  readonly css: string;
  /** Subresource integrity for `js`/`css` (sha384-…). Strongly recommended; omitted only for local dev. */
  readonly jsIntegrity?: string;
  readonly cssIntegrity?: string;
  /** Grammar chunks by Shiki id, relative to `baseUrl`, e.g. { typescript: "langs/typescript.ab12.js" }. */
  readonly langs?: Readonly<Record<string, string>>;
}

export interface GuideHtmlOptions {
  readonly viewer: GuideViewerAssets;
  /**
   * Set when the document is served by a guide host (guides.show `/g/<id>` or a
   * self-hosted origin) rather than downloaded as a file. Adds a canonical URL,
   * Open Graph metadata (title + intent) so links unfurl, and the
   * `plannotator-guided-review-hosted` meta the viewer reads to offer a
   * "Download this guide" affordance. Never set on the portable file.
   */
  readonly hosted?: GuideHostedPage;
}

/** Where a hosted guide page lives. */
export interface GuideHostedPage {
  /** Canonical URL of the page (no fragment). */
  readonly url: string;
}

/** `<meta name>` on hosted pages carrying the canonical URL; absent on downloaded files. */
export const GUIDE_HOSTED_META_NAME = "plannotator-guided-review-hosted";
/** `<meta name>` on an encrypted hosted page: the URL the viewer fetches the ciphertext from. */
export const GUIDE_PAYLOAD_META_NAME = "plannotator-guided-review-payload";
/** URL-fragment parameter carrying the AES-256-GCM key of an encrypted hosted guide (`#key=…`), as plan share links do. */
export const GUIDE_SHARE_KEY_PARAM = "key";

/**
 * The viewer build a producer pins into exports. Producers embed the
 * generated `guide-viewer-manifest` module (checked in, kept in sync with the
 * viewer build) and may override the base URL for local development or
 * self-hosting via `PLANNOTATOR_GUIDE_VIEWER_URL` (https, or http localhost).
 */
export function resolveGuideViewerAssets(
  manifest: Omit<GuideViewerAssets, "baseUrl">,
  options?: { readonly baseUrl?: string; readonly defaultBaseUrl?: string },
): GuideViewerAssets {
  const candidate = options?.baseUrl?.trim();
  const fallback = options?.defaultBaseUrl ?? DEFAULT_GUIDE_VIEWER_BASE_URL;
  const base = (candidate && normalizeGuideViewerBaseUrl(candidate)?.href) || fallback;
  return { ...manifest, baseUrl: base };
}

/** Where published viewer builds live (decision record D7/D8). */
export const DEFAULT_GUIDE_VIEWER_BASE_URL = "https://guides.show/v1/";

export function escapeHtmlText(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(input: string): string {
  return escapeHtmlText(input).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * Make JSON safe to inline inside `<script type="application/json">`: a patch
 * line containing `</script>` (or `<!--`, or U+2028/9) must not terminate or
 * corrupt the element. Escaped as JSON unicode escapes, so `JSON.parse` of the
 * element's text yields the original bytes.
 */
export function escapeJsonForHtmlScript(json: string): string {
  return json
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** Validate and normalize a viewer base URL. Returns null when it must not be embedded. */
export function normalizeGuideViewerBaseUrl(input: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) return null;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed;
}

function describeSource(snapshot: GuideSnapshotV1): string {
  const s = snapshot.source;
  const parts: string[] = [];
  switch (s.kind) {
    case "pr":
      parts.push(s.pr?.number !== undefined ? `Pull request #${s.pr.number}` : "Pull request");
      if (s.pr?.title) parts.push(`— ${s.pr.title}`);
      break;
    case "commit":
      parts.push(`Commit ${s.commitSha ? s.commitSha.slice(0, 12) : ""}`.trim());
      break;
    case "workspace":
      parts.push("Multi-repository workspace changes");
      break;
    default:
      parts.push("Local changes");
  }
  if (s.repo) parts.push(`in ${s.repo}`);
  if (s.branch) parts.push(`(${s.branch})`);
  return parts.join(" ");
}

/**
 * The no-JavaScript body: title, intent, every chapter's overview and file
 * list. Readable when guides.show is unreachable; replaced by the viewer once
 * it mounts. Deliberately simple (decision record, D6 note).
 */
export function renderGuideFallbackHtml(snapshot: GuideSnapshotV1): string {
  const g = snapshot.guide;
  const sections = g.sections
    .map((section, index) => {
      const files = section.diffs
        .map(
          (ref) =>
            `<li><code>${escapeHtmlText(ref.file)}</code>${ref.summary ? ` — ${escapeHtmlText(ref.summary)}` : ""}</li>`,
        )
        .join("");
      return `<section>
<h2>${index + 1}. ${escapeHtmlText(section.title)}</h2>
<pre class="prose">${escapeHtmlText(section.overview)}</pre>
${files ? `<ul>${files}</ul>` : ""}
</section>`;
    })
    .join("\n");
  const unplaced = g.unplacedFiles?.length
    ? `<section><h2>Everything else</h2><ul>${g.unplacedFiles.map((f) => `<li><code>${escapeHtmlText(f)}</code></li>`).join("")}</ul></section>`
    : "";
  const gen = snapshot.generator;
  const genLine = gen?.engine ? `Generated by ${escapeHtmlText(gen.engine)}${gen.model ? ` (${escapeHtmlText(gen.model)})` : ""}` : "";
  const prLink = snapshot.source.pr?.url
    ? ` · <a href="${escapeHtmlAttribute(snapshot.source.pr.url)}" rel="noopener noreferrer">${escapeHtmlText(snapshot.source.pr.url)}</a>`
    : "";
  return `<article class="pgr-fallback">
<header>
<h1>${escapeHtmlText(g.title)}</h1>
<p class="meta">${escapeHtmlText(describeSource(snapshot))} · ${escapeHtmlText(snapshot.review.gitRef)}${prLink}</p>
${genLine ? `<p class="meta">${genLine}</p>` : ""}
<pre class="prose">${escapeHtmlText(g.intent)}</pre>
</header>
${sections}
${unplaced}
<footer class="meta">This is the plain-text version of a Plannotator Guided Review. Connect to the internet to load the full diff viewer.</footer>
</article>`;
}

// The fallback article is for readers whose viewer never arrives (offline,
// blocked, no JS). Everyone else would otherwise see it flash for the second
// or two the viewer takes to download on a cold cache, so it stays invisible
// for the first moments and reveals itself only if nothing has replaced it
// (CSS-only, no script needed). The body ground paints in the right theme
// immediately.
export const FALLBACK_STYLE = `
html{color-scheme:light dark}
body.pgr-fallback-body{margin:0;background:#f5f7f6}
@keyframes pgr-reveal{to{opacity:1}}
.pgr-fallback{opacity:0;animation:pgr-reveal 0s linear 2.5s forwards;max-width:72ch;margin:2rem auto;padding:0 1.25rem;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c2421}
.pgr-fallback h1{font-size:1.75rem;line-height:1.2;margin:0 0 .5rem}
.pgr-fallback h2{font-size:1.15rem;margin:1.75rem 0 .5rem}
.pgr-fallback .meta{color:#5b6a64;font-size:.9rem;margin:.25rem 0}
.pgr-fallback .prose{white-space:pre-wrap;font:inherit;margin:.5rem 0}
.pgr-fallback code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
.pgr-fallback ul{padding-left:1.25rem}
.pgr-fallback a{color:#2b7f6c}
@media (prefers-color-scheme:dark){body.pgr-fallback-body{background:#121815}.pgr-fallback{color:#dbe4df}.pgr-fallback .meta{color:#93a39c}.pgr-fallback a{color:#63c8b0}}
`.trim();

/**
 * Render a portable Guided Review document. Size ≈ the snapshot; the renderer
 * is referenced from `options.viewer`, never embedded (D1).
 * Throws only when `viewer.baseUrl` is not an https URL (or http localhost).
 */
export function createGuideHtml(snapshot: GuideSnapshotV1, options: GuideHtmlOptions): string {
  const head = buildGuideHead({
    viewer: options.viewer,
    title: snapshot.guide.title,
    description: snapshot.guide.intent,
    languages: detectGuideLanguages(snapshot.review.rawPatch),
    hosted: options.hosted,
  });
  const serialized = escapeJsonForHtmlScript(JSON.stringify(snapshot));
  return `<!doctype html>
<html lang="en">
<head>
${head.head}
</head>
<body class="pgr-fallback-body">
<div id="root">${renderGuideFallbackHtml(snapshot)}</div>
<script id="${GUIDE_SNAPSHOT_SCRIPT_ID}" type="application/json">${serialized}</script>
${head.script}
</body>
</html>
`;
}

export interface GuideShellHtmlOptions {
  readonly viewer: GuideViewerAssets;
  readonly hosted: GuideHostedPage;
  /** Same-origin URL the viewer fetches the encrypted payload from (e.g. `/api/g/<id>`). */
  readonly payloadUrl: string;
}

/**
 * The page a guide host serves for an ENCRYPTED shared guide: the pinned
 * viewer and nothing else — no title, no snapshot, no fallback prose, because
 * the host cannot read the guide. The viewer fetches `payloadUrl`, decrypts
 * with the key in the URL fragment (`#key=…`), and renders exactly as it would
 * an embedded snapshot. Same head (stylesheet, SRI, CSP, fallback style) as
 * `createGuideHtml`, so hosted and downloaded pages never drift.
 */
export function createGuideShellHtml(options: GuideShellHtmlOptions): string {
  const head = buildGuideHead({
    viewer: options.viewer,
    title: "Guided Review",
    description: "A Plannotator Guided Review. The guide is end-to-end encrypted; the key travels in the link.",
    languages: [],
    hosted: options.hosted,
    payloadUrl: options.payloadUrl,
  });
  return `<!doctype html>
<html lang="en">
<head>
${head.head}
</head>
<body class="pgr-fallback-body">
<div id="root"><article class="pgr-fallback"><header><h1>Guided Review</h1><p class="meta">This guide is encrypted. Open the full link (including the part after <code>#</code>) in a browser with JavaScript enabled to read it.</p></header></article></div>
${head.script}
</body>
</html>
`;
}

interface GuideHeadInput {
  readonly viewer: GuideViewerAssets;
  readonly title: string;
  readonly description: string;
  readonly languages: readonly string[];
  readonly hosted?: GuideHostedPage;
  readonly payloadUrl?: string;
}

/** Shared `<head>` + viewer `<script>` for exported and hosted guide pages. */
function buildGuideHead(input: GuideHeadInput): { head: string; script: string } {
  const base = normalizeGuideViewerBaseUrl(input.viewer.baseUrl);
  if (!base) throw new Error(`Refusing to embed a non-https viewer base URL: ${input.viewer.baseUrl}`);
  const origin = base.origin;
  const jsUrl = new URL(input.viewer.js, base).href;
  const cssUrl = new URL(input.viewer.css, base).href;
  const integrityAttr = (value?: string) => (value ? ` integrity="${escapeHtmlAttribute(value)}"` : "");
  const langs = input.viewer.langs ?? {};
  const preloads = input.languages
    .map((lang) => langs[lang])
    .filter((path): path is string => typeof path === "string")
    .map((path) => `<link rel="modulepreload" href="${escapeHtmlAttribute(new URL(path, base).href)}" crossorigin="anonymous">`)
    .join("\n");
  // A hosted page fetches its payload from its own origin; a downloaded file
  // only ever talks to the viewer origin.
  const hostedOrigin = input.hosted ? safeOrigin(input.hosted.url) : null;
  const connectSrc = hostedOrigin && hostedOrigin !== origin ? `${origin} ${hostedOrigin}` : origin;
  const csp = [
    "default-src 'none'",
    `script-src ${origin} 'wasm-unsafe-eval' blob:`,
    `style-src ${origin} 'unsafe-inline'`,
    `font-src ${origin}`,
    "img-src data: blob:",
    `connect-src ${connectSrc}`,
    "worker-src blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join("; ");
  const hostedMeta = input.hosted
    ? [
        `<link rel="canonical" href="${escapeHtmlAttribute(input.hosted.url)}">`,
        `<meta name="${GUIDE_HOSTED_META_NAME}" content="${escapeHtmlAttribute(input.hosted.url)}">`,
        `<meta property="og:type" content="article">`,
        `<meta property="og:site_name" content="${escapeHtmlAttribute(hostedSiteName(input.hosted.url))}">`,
        `<meta property="og:title" content="${escapeHtmlAttribute(input.title)}">`,
        `<meta property="og:description" content="${escapeHtmlAttribute(truncateForMeta(input.description))}">`,
        `<meta property="og:url" content="${escapeHtmlAttribute(input.hosted.url)}">`,
        `<meta name="twitter:card" content="summary">`,
        `<meta name="robots" content="noindex">`,
      ].join("\n")
    : "";
  const payloadMeta = input.payloadUrl ? `<meta name="${GUIDE_PAYLOAD_META_NAME}" content="${escapeHtmlAttribute(input.payloadUrl)}">` : "";
  // A hosted plain guide's URL is the whole capability, and a file put on
  // some web host is no different: outbound links (the PR link, links in
  // overviews) must never carry the page URL as Referer.
  const referrerMeta = `<meta name="referrer" content="no-referrer">`;
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="${GUIDE_EXPORT_META_NAME}" content="v${GUIDE_SNAPSHOT_VERSION}">`,
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    referrerMeta,
    `<title>${escapeHtmlText(input.title)} · Guided Review</title>`,
    hostedMeta,
    payloadMeta,
    `<link rel="stylesheet" href="${escapeHtmlAttribute(cssUrl)}"${integrityAttr(input.viewer.cssIntegrity)} crossorigin="anonymous">`,
    preloads,
    `<style>${FALLBACK_STYLE}</style>`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  const script = `<script type="module" src="${escapeHtmlAttribute(jsUrl)}"${integrityAttr(input.viewer.jsIntegrity)} crossorigin="anonymous"></script>`;
  return { head, script };
}

/** `og:site_name` for a hosted page: the host that serves it (a self-host is not guides.show). */
function hostedSiteName(url: string): string {
  try {
    return new URL(url).host || "guides.show";
  } catch {
    return "guides.show";
  }
}

function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function truncateForMeta(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
}

/** Read the snapshot back out of an exported document's DOM (viewer boot). */
export function readEmbeddedGuideSnapshot(doc: {
  getElementById(id: string): { textContent: string | null } | null;
}): GuideSnapshotParseResult | null {
  const el = doc.getElementById(GUIDE_SNAPSHOT_SCRIPT_ID);
  if (!el) return null;
  return parseGuideSnapshotJson(el.textContent ?? "");
}

/** Bounded, filesystem-safe filename derived from the guide title. */
export function guideExportFilename(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return `guided-review-${slug || "export"}.html`;
}

/**
 * `plannotator guide <list|export|share|unshare>` — portable Guided Review
 * exports and share links from the command line (decision record D9; guide
 * share hosting contract §7): the same pure export function and the same
 * upload the UI uses, callable without a running review server. Three
 * sources for export and share alike:
 *
 *   --id <savedGuideId>              a guide Plannotator saved (any repo shelf)
 *   --guide <guide.json> --patch <p> a guide authored elsewhere (an agent skill
 *                                    writes the guide, hands over the `git diff`;
 *                                    we validate the guide against the patch,
 *                                    infer provenance from git, and wrap it)
 *   --snapshot <file.json>           a complete snapshot document
 *
 * Kept free of process.exit / console so it is unit-testable; the CLI entry
 * prints `stdout`/`stderr` and exits with `code`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  buildGuideSnapshot,
  createGuideHtml,
  guideExportFilename,
  listGuidePatchFiles,
  parseGuideSnapshot,
  parseGuideSnapshotJson,
  resolveGuideViewerAssets,
  type GuideSnapshot,
  type GuideSnapshotGenerator,
  type GuideSnapshotSource,
} from "@plannotator/shared/guide-format";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/shared/guide-viewer-manifest";
import { buildSavedGuideSnapshot, findSavedGuideById, listAllSavedGuides, updateGuideShare, type SavedGuideShare } from "@plannotator/shared/guide-store";
import { parseRemoteUrl } from "@plannotator/shared/repo";
import { loadConfig, resolveGuideShareUrl, resolveSharingEnabled } from "@plannotator/shared/config";
import { validateGuideOutput } from "./guide-review";
import { GuideShareError, shareGuide, unshareGuide } from "./guide-share";

export interface GuideCliResult {
  code: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

export const GUIDE_CLI_USAGE = [
  "Usage:",
  "  plannotator guide list",
  "  plannotator guide export --id <savedGuideId> [--out <file.html> | --out -]",
  "  plannotator guide export --guide <guide.json> --patch <diff.patch | -> [--out <file.html> | --out -]",
  "  plannotator guide export --snapshot <snapshot.json> [--out <file.html> | --out -]",
  "  plannotator guide share --id <savedGuideId> | --guide <guide.json> --patch <diff.patch | -> | --snapshot <snapshot.json>",
  "                          [--public] [--ttl <7d | 24h | 30m | 3600>] [--json]",
  "  plannotator guide unshare <id> --token <deleteToken>",
  "",
  "Export a Guided Review as one portable HTML file (the viewer loads from guides.show),",
  "or share it as a link on guides.show (or your own deployment of it: PLANNOTATOR_GUIDE_SHARE_URL,",
  "or `guideShareUrl` in ~/.plannotator/config.json).",
  "",
  "Options:",
  "  --id <id>          A guide Plannotator saved (see `plannotator guide list`)",
  "  --guide <file>     A guide you wrote: { title, intent, sections[{ title, overview, diffs[{ file, summary }] }],",
  "                     unplacedFiles?, review?{ gitRef, base }, source?, generator? }. Validated against --patch;",
  "                     every file in the guide must appear in the patch. Provenance (repo, branch, head) is read",
  "                     from git in the current directory unless `source` says otherwise.",
  "  --patch <file>     The unified diff the guide describes (`git diff <base>...HEAD > guide.patch`); `-` reads stdin",
  "  --snapshot <file>  A complete portable guide snapshot document (JSON) to wrap as HTML",
  "  --out <file>       Where to write the HTML (default: ./guided-review-<slug>.html); `-` writes to stdout",
  "  --viewer-url <u>   Viewer base URL override (default https://guides.show/v1/; also PLANNOTATOR_GUIDE_VIEWER_URL)",
  "",
  "Share options:",
  "  --public           Store the guide unencrypted so the link can unfurl with a preview. By default the",
  "                     upload is end-to-end encrypted: the host never sees the code and the key lives",
  "                     only in the link (the part after #).",
  "  --ttl <duration>   Remove the link automatically after this long: seconds, or 30m / 24h / 7d.",
  "                     Default: the link stays until you unshare it.",
  "  --json             Print { id, url, deleteToken, expiresAt? } instead of the bare URL",
  "  --token <t>        (unshare) The delete token printed when the guide was shared",
  "",
  "Sharing is refused while PLANNOTATOR_SHARE=disabled (or `share: \"disabled\"` in config.json).",
  "",
  "Exit codes: 0 done · 1 not found / not exportable / invalid guide or snapshot / share service error · 2 usage",
].join("\n");

function takeOption(args: string[], name: string): { value?: string; rest: string[] } | { error: string } {
  const i = args.indexOf(name);
  if (i < 0) return { rest: args };
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) return { error: `${name} requires a value` };
  return { value, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

function takeFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const i = args.indexOf(name);
  if (i < 0) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, i), ...args.slice(i + 1)] };
}

/**
 * `--ttl` values: whole seconds, or a number with an s / m / h / d suffix
 * (`30m`, `24h`, `7d`). Null when the text is not a positive duration.
 */
export function parseGuideShareTtl(text: string): number | null {
  const m = /^\s*(\d+)\s*([smhd]?)\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const factor = unit === "d" ? 86_400 : unit === "h" ? 3_600 : unit === "m" ? 60 : 1;
  const seconds = n * factor;
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/** What `runGuideCli` may inject: stdin for `--patch -`, a fixed clock, a fetch for the share service. */
export interface GuideCliIo {
  stdin?: () => string;
  now?: string;
  fetch?: typeof fetch;
}

export function runGuideList(): GuideCliResult {
  const guides = listAllSavedGuides();
  if (guides.length === 0) return { code: 0, stdout: "No saved guides.\n" };
  const rows = guides.map(({ repoKey, id, envelope }) => ({
    id,
    when: new Date(envelope.savedAt).toISOString().replace("T", " ").slice(0, 16),
    exportable: envelope.review ? "yes" : "no ",
    label: envelope.label,
    title: envelope.title,
    repo: repoKey,
  }));
  const idW = Math.max(2, ...rows.map((r) => r.id.length));
  const labelW = Math.min(24, Math.max(5, ...rows.map((r) => r.label.length)));
  const lines = [
    `${"ID".padEnd(idW)}  ${"SAVED".padEnd(16)}  EXPORT  ${"LABEL".padEnd(labelW)}  TITLE`,
    ...rows.map((r) => `${r.id.padEnd(idW)}  ${r.when.padEnd(16)}  ${r.exportable}     ${r.label.slice(0, labelW).padEnd(labelW)}  ${r.title}`),
    "",
    "EXPORT=no: the guide predates portable exports (its diff was not retained).",
  ];
  return { code: 0, stdout: lines.join("\n") + "\n" };
}


function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort provenance for an authored guide: repo from origin (or the directory name), branch, head. */
export function inferGuideSource(cwd: string): GuideSnapshotSource {
  const remote = git(["remote", "get-url", "origin"], cwd);
  const repo = (remote && parseRemoteUrl(remote)) || basename(cwd);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const headSha = git(["rev-parse", "HEAD"], cwd);
  return {
    kind: "local",
    repo,
    ...(branch && branch !== "HEAD" && { branch }),
    ...(headSha && { headSha }),
  };
}

interface AuthoredGuideOptions {
  readonly cwd: string;
  readonly stdin?: string;
  /** Injected for deterministic tests. */
  readonly now?: string;
  readonly source?: GuideSnapshotSource;
}

/**
 * Turn an authored guide (`--guide`) plus its patch (`--patch`) into a
 * snapshot. Strict where the in-app validator is lenient: a file the guide
 * names that is not in the patch is an error naming the file and the files
 * that ARE in the patch, so the author can fix the guide instead of silently
 * losing a chapter. Files the guide leaves out land in "Everything else".
 */
export function buildAuthoredGuideSnapshot(
  guideJson: string,
  rawPatch: string,
  opts: AuthoredGuideOptions,
): { ok: true; snapshot: GuideSnapshot } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(guideJson);
  } catch (e) {
    return { ok: false, error: `Guide file is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Guide file must be a JSON object." };
  const g = raw as Record<string, unknown>;

  const patchFiles = listGuidePatchFiles(rawPatch).map((f) => f.path);
  if (patchFiles.length === 0) return { ok: false, error: "The patch contains no file diffs. Expected unified diff output, e.g. `git diff <base>...HEAD`." };

  const problems: string[] = [];
  if (typeof g.title !== "string" || g.title.trim() === "") problems.push("`title` must be a non-empty string.");
  if (typeof g.intent !== "string" || g.intent.trim() === "") problems.push("`intent` must be a non-empty string.");
  if (!Array.isArray(g.sections) || g.sections.length === 0) {
    problems.push("`sections` must be a non-empty array.");
  } else {
    const patchSet = new Set(patchFiles);
    const seen = new Map<string, number>();
    const unknown = new Set<string>();
    g.sections.forEach((section, i) => {
      if (!section || typeof section !== "object") { problems.push(`sections[${i}] must be an object.`); return; }
      const sec = section as Record<string, unknown>;
      if (typeof sec.title !== "string" || sec.title.trim() === "") problems.push(`sections[${i}].title must be a non-empty string.`);
      if (typeof sec.overview !== "string" || sec.overview.trim() === "") problems.push(`sections[${i}].overview must be a non-empty string.`);
      if (sec.diffs !== undefined && !Array.isArray(sec.diffs)) { problems.push(`sections[${i}].diffs must be an array of { file, summary }.`); return; }
      for (const [j, ref] of ((sec.diffs as unknown[] | undefined) ?? []).entries()) {
        const r = (ref && typeof ref === "object" ? ref : {}) as Record<string, unknown>;
        if (typeof r.file !== "string" || r.file === "") { problems.push(`sections[${i}].diffs[${j}].file must be a path from the patch.`); continue; }
        if (typeof r.summary !== "string") problems.push(`sections[${i}].diffs[${j}].summary must be a string.`);
        if (!patchSet.has(r.file)) unknown.add(r.file);
        const first = seen.get(r.file);
        if (first !== undefined) problems.push(`${r.file} is placed twice (sections[${first}] and sections[${i}]); a file belongs to one section.`);
        else seen.set(r.file, i);
      }
    });
    if (unknown.size > 0) {
      problems.push(
        `These files are not in the patch: ${[...unknown].join(", ")}.\nFiles in the patch:\n  ${patchFiles.join("\n  ")}`,
      );
    }
    if (g.unplacedFiles !== undefined) {
      if (!Array.isArray(g.unplacedFiles) || g.unplacedFiles.some((f) => typeof f !== "string")) problems.push("`unplacedFiles` must be an array of paths.");
      else {
        const bad = (g.unplacedFiles as string[]).filter((f) => !patchSet.has(f));
        if (bad.length > 0) problems.push(`unplacedFiles not in the patch: ${bad.join(", ")}.`);
      }
    }
  }
  if (problems.length > 0) return { ok: false, error: `Guide is not valid:\n- ${problems.join("\n- ")}` };

  const validated = validateGuideOutput(
    { title: g.title, intent: g.intent, sections: g.sections, unplacedFiles: g.unplacedFiles },
    patchFiles,
  );
  if ("error" in validated) return { ok: false, error: `Guide is not valid: ${validated.error}` };

  const review = (g.review && typeof g.review === "object" ? g.review : {}) as Record<string, unknown>;
  const gitRef = typeof review.gitRef === "string" && review.gitRef.trim() ? review.gitRef.trim() : "HEAD";
  const base = typeof review.base === "string" && review.base.trim() ? review.base.trim() : undefined;
  const source = { ...(opts.source ?? inferGuideSource(opts.cwd)), ...((g.source as Partial<GuideSnapshotSource> | undefined) ?? {}) } as GuideSnapshotSource;
  const generator: GuideSnapshotGenerator = {
    generatedAt: opts.now ?? new Date().toISOString(),
    ...((g.generator as GuideSnapshotGenerator | undefined) ?? {}),
  };

  const snapshot = buildGuideSnapshot({
    guide: validated.guide,
    reviewed: [],
    review: { rawPatch, gitRef, ...(base && { base }), source },
    generator,
    exportedAt: opts.now,
  });
  // The strict format parser is the authority on user-supplied `source` /
  // `generator` / `review` shapes — round-trip so a bad field fails here, not
  // in someone's browser.
  const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(snapshot)));
  if (!parsed.ok) return { ok: false, error: `Guide is not valid (${parsed.error.path}): ${parsed.error.message}` };
  return { ok: true, snapshot: parsed.value };
}

interface SourceArgs {
  id?: string;
  snapshot?: string;
  guide?: string;
  patch?: string;
  /** Arguments left for the caller's own flags. */
  rest: string[];
}

type SnapshotSource =
  | { ok: true; snapshot: GuideSnapshot; saved?: { repoKey: string; id: string; share?: SavedGuideShare } }
  | { ok: false; result: GuideCliResult };

/**
 * The `--id | --guide/--patch | --snapshot` source selection shared by
 * `export` and `share`. Consumes those options from `argv`; usage mistakes
 * come back as exit-2 results so callers can finish their own argument
 * checks before anything is read from disk.
 */
function parseSourceArgs(argv: string[]): { ok: true; args: SourceArgs } | { ok: false; result: GuideCliResult } {
  const usage = (msg: string) => ({ ok: false as const, result: { code: 2 as const, stderr: `${msg}\n\n${GUIDE_CLI_USAGE}\n` } });
  const idOpt = takeOption(argv, "--id");
  if ("error" in idOpt) return usage(idOpt.error);
  const snapOpt = takeOption(idOpt.rest, "--snapshot");
  if ("error" in snapOpt) return usage(snapOpt.error);
  const guideOpt = takeOption(snapOpt.rest, "--guide");
  if ("error" in guideOpt) return usage(guideOpt.error);
  const patchOpt = takeOption(guideOpt.rest, "--patch");
  if ("error" in patchOpt) return usage(patchOpt.error);
  if ((idOpt.value ? 1 : 0) + (snapOpt.value ? 1 : 0) + (guideOpt.value ? 1 : 0) !== 1) {
    return usage("Provide exactly one of --id, --guide (with --patch), or --snapshot.");
  }
  if ((guideOpt.value === undefined) !== (patchOpt.value === undefined)) {
    return usage("--guide and --patch go together.");
  }
  return { ok: true, args: { id: idOpt.value, snapshot: snapOpt.value, guide: guideOpt.value, patch: patchOpt.value, rest: patchOpt.rest } };
}

/** Load the snapshot a parsed source names. `saved` is set for `--id` so a share can be recorded on its envelope (and carries any link it already has). */
function loadSnapshotSource(args: SourceArgs, cwd: string, io: GuideCliIo): SnapshotSource {
  if (args.id) {
    const found = findSavedGuideById(args.id);
    if (!found) return { ok: false, result: { code: 1, stderr: `No saved guide with id ${args.id}. Run \`plannotator guide list\`.\n` } };
    const built = buildSavedGuideSnapshot(found.repoKey, found.envelope);
    if (!built) return { ok: false, result: { code: 1, stderr: `Guide ${args.id} cannot be exported: its diff was not retained (it predates portable exports).\n` } };
    return { ok: true, snapshot: built, saved: { repoKey: found.repoKey, id: args.id, ...(found.envelope.share ? { share: found.envelope.share } : {}) } };
  }
  if (args.guide) {
    const guideFile = resolve(cwd, args.guide);
    if (!existsSync(guideFile)) return { ok: false, result: { code: 1, stderr: `Guide file not found: ${guideFile}\n` } };
    let rawPatch: string;
    if (args.patch === "-") {
      rawPatch = io.stdin ? io.stdin() : readFileSync(0, "utf-8");
    } else {
      const patchFile = resolve(cwd, args.patch!);
      if (!existsSync(patchFile)) return { ok: false, result: { code: 1, stderr: `Patch file not found: ${patchFile}\n` } };
      rawPatch = readFileSync(patchFile, "utf-8");
    }
    const built = buildAuthoredGuideSnapshot(readFileSync(guideFile, "utf-8"), rawPatch, { cwd, now: io.now });
    if (!built.ok) return { ok: false, result: { code: 1, stderr: `${built.error}\n` } };
    return { ok: true, snapshot: built.snapshot };
  }
  const file = resolve(cwd, args.snapshot!);
  if (!existsSync(file)) return { ok: false, result: { code: 1, stderr: `Snapshot file not found: ${file}\n` } };
  const parsed = parseGuideSnapshotJson(readFileSync(file, "utf-8"));
  if (!parsed.ok) return { ok: false, result: { code: 1, stderr: `Invalid guide snapshot (${parsed.error.path}): ${parsed.error.message}\n` } };
  return { ok: true, snapshot: parsed.value };
}

export function runGuideExport(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), io: GuideCliIo = {}): GuideCliResult {
  const outOpt = takeOption(argv, "--out");
  if ("error" in outOpt) return { code: 2, stderr: `${outOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const viewerOpt = takeOption(outOpt.rest, "--viewer-url");
  if ("error" in viewerOpt) return { code: 2, stderr: `${viewerOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const parsedSource = parseSourceArgs(viewerOpt.rest);
  if (!parsedSource.ok) return parsedSource.result;
  if (parsedSource.args.rest.length > 0) return { code: 2, stderr: `Unknown argument: ${parsedSource.args.rest[0]}\n\n${GUIDE_CLI_USAGE}\n` };
  const source = loadSnapshotSource(parsedSource.args, cwd, io);
  if (!source.ok) return source.result;
  const { snapshot } = source;

  const viewer = resolveGuideViewerAssets(GUIDE_VIEWER_MANIFEST, { baseUrl: viewerOpt.value ?? env.PLANNOTATOR_GUIDE_VIEWER_URL });
  const html = createGuideHtml(snapshot, { viewer });
  if (outOpt.value === "-") return { code: 0, stdout: html };
  const outPath = resolve(cwd, outOpt.value ?? guideExportFilename(snapshot.guide.title));
  try {
    writeFileSync(outPath, html, "utf-8");
  } catch (e) {
    return { code: 1, stderr: `Could not write ${outPath}: ${e instanceof Error ? e.message : String(e)}\n` };
  }
  return { code: 0, stdout: `${outPath}\n`, stderr: `Exported ${snapshot.guide.title} (${(Buffer.byteLength(html, "utf8") / 1024).toFixed(0)} KB)\n` };
}

/**
 * `plannotator guide share`: upload the guide (encrypted unless `--public`)
 * and print its link. The delete token is printed ONCE, on stderr, with the
 * exact `unshare` command; a `--id` share is also recorded on the saved
 * envelope so the in-app share menu sees the same link.
 */
export async function runGuideShare(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), io: GuideCliIo = {}): Promise<GuideCliResult> {
  const publicFlag = takeFlag(argv, "--public");
  const jsonFlag = takeFlag(publicFlag.rest, "--json");
  const ttlOpt = takeOption(jsonFlag.rest, "--ttl");
  if ("error" in ttlOpt) return { code: 2, stderr: `${ttlOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  let ttlSeconds: number | undefined;
  if (ttlOpt.value !== undefined) {
    const parsed = parseGuideShareTtl(ttlOpt.value);
    if (parsed === null) return { code: 2, stderr: `--ttl must be a positive duration: seconds, or 30m / 24h / 7d (got ${JSON.stringify(ttlOpt.value)}).\n\n${GUIDE_CLI_USAGE}\n` };
    ttlSeconds = parsed;
  }

  // Every argument is validated before the sharing gate so usage mistakes
  // still read as usage (exit 2), the same as `export`.
  const parsedSource = parseSourceArgs(ttlOpt.rest);
  if (!parsedSource.ok) return parsedSource.result;
  if (parsedSource.args.rest.length > 0) return { code: 2, stderr: `Unknown argument: ${parsedSource.args.rest[0]}\n\n${GUIDE_CLI_USAGE}\n` };

  if (!resolveSharingEnabled(loadConfig(), env)) {
    return { code: 1, stderr: "Sharing is disabled (PLANNOTATOR_SHARE=disabled or share: \"disabled\" in ~/.plannotator/config.json). Use `plannotator guide export` for a local file instead.\n" };
  }
  const source = loadSnapshotSource(parsedSource.args, cwd, io);
  if (!source.ok) return source.result;
  // One link per saved guide: the envelope is the only place the delete token
  // lives, so a second upload would orphan the first on the host.
  const existing = source.saved?.share;
  if (existing) {
    return {
      code: 1,
      stderr: [
        `Guide ${source.saved!.id} already has a share link: ${existing.url}`,
        `Remove it first: plannotator guide unshare ${existing.id} --token ${existing.deleteToken}`,
        "",
      ].join("\n"),
    };
  }

  const mode = publicFlag.present ? "plain" : "encrypted";
  const serviceUrl = resolveGuideShareUrl(loadConfig(), env);
  let shared;
  try {
    shared = await shareGuide(source.snapshot, { serviceUrl, mode, ttlSeconds, viewer: GUIDE_VIEWER_MANIFEST, fetch: io.fetch });
  } catch (e) {
    if (e instanceof GuideShareError) return { code: 1, stderr: `${e.message}\n` };
    throw e;
  }
  if (source.saved) {
    updateGuideShare(source.saved.repoKey, source.saved.id, {
      id: shared.id,
      url: shared.url,
      createdAt: io.now ?? new Date().toISOString(),
      deleteToken: shared.deleteToken,
      serviceUrl,
    });
  }

  const kb = (shared.bytes / 1024).toFixed(0);
  const how = mode === "encrypted" ? "encrypted, key in the link" : "public, unencrypted";
  const expiry = shared.expiresAt ? `, expires ${shared.expiresAt}` : "";
  const stderr = [
    `Shared ${source.snapshot.guide.title} (${kb} KB, ${how}${expiry})`,
    `Delete with: plannotator guide unshare ${shared.id} --token ${shared.deleteToken}`,
    "",
  ].join("\n");
  if (jsonFlag.present) {
    const record = { id: shared.id, url: shared.url, deleteToken: shared.deleteToken, ...(shared.expiresAt ? { expiresAt: shared.expiresAt } : {}) };
    return { code: 0, stdout: `${JSON.stringify(record)}\n`, stderr };
  }
  return { code: 0, stdout: `${shared.url}\n`, stderr };
}

/**
 * `plannotator guide unshare <id> --token <t>`: remove the link on the host;
 * forget it on any saved envelope that recorded it. A link some saved guide
 * remembers is removed from the host it was created on, whatever the
 * configured share URL is now; otherwise the configured host is used.
 */
export async function runGuideUnshare(argv: string[], env: NodeJS.ProcessEnv = process.env, io: GuideCliIo = {}): Promise<GuideCliResult> {
  const tokenOpt = takeOption(argv, "--token");
  if ("error" in tokenOpt) return { code: 2, stderr: `${tokenOpt.error}\n\n${GUIDE_CLI_USAGE}\n` };
  const [id, ...extra] = tokenOpt.rest;
  if (!id || id.startsWith("--")) return { code: 2, stderr: `unshare needs the shared guide id.\n\n${GUIDE_CLI_USAGE}\n` };
  if (extra.length > 0) return { code: 2, stderr: `Unknown argument: ${extra[0]}\n\n${GUIDE_CLI_USAGE}\n` };
  if (!tokenOpt.value) return { code: 2, stderr: `unshare needs --token <deleteToken>.\n\n${GUIDE_CLI_USAGE}\n` };
  const remembered = listAllSavedGuides().filter(({ envelope }) => envelope.share?.id === id);
  const serviceUrl = remembered[0]?.envelope.share?.serviceUrl ?? resolveGuideShareUrl(loadConfig(), env);

  try {
    await unshareGuide(id, tokenOpt.value, { serviceUrl, fetch: io.fetch });
  } catch (e) {
    if (e instanceof GuideShareError) return { code: 1, stderr: `${e.message}\n` };
    throw e;
  }
  for (const { repoKey, id: savedId } of remembered) updateGuideShare(repoKey, savedId, null);
  return { code: 0, stdout: "Removed\n" };
}

export async function runGuideCli(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), io: GuideCliIo = {}): Promise<GuideCliResult> {
  const [sub, ...rest] = argv;
  if (sub === "list") {
    if (rest.length > 0) return { code: 2, stderr: `Unknown argument: ${rest[0]}\n\n${GUIDE_CLI_USAGE}\n` };
    return runGuideList();
  }
  if (sub === "export") return runGuideExport(rest, env, cwd, io);
  if (sub === "share") return runGuideShare(rest, env, cwd, io);
  if (sub === "unshare") return runGuideUnshare(rest, env, io);
  return { code: 2, stderr: `${GUIDE_CLI_USAGE}\n` };
}

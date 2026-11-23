/**
 * Code review's package changes card, in the Inbox (review parity B5): what a pull request's or a guided review's
 * diff adds, removes, upgrades and downgrades under a package.json or a lockfile, for the review app's own
 * `PackageChangesCard`, which the PR page and guided reviews draw through `GuideReader`'s `images`.
 *
 *  - `GET /api/inbox/pulls/package-changes?key&scope[&from]&snapshot`: a pull request's diff; `snapshot` is the head
 *    commit the patch on screen was read at (any other is stale, 409). Each side is read as for the image preview
 *    (`InboxPulls.fileBytes`: a clone on this computer, else the forge, at most `REMOTE_PACKAGE_READS` forge reads).
 *  - `GET /api/inbox/messages/:id/guide/package-changes?snapshot`: a guided review's patch, as the agent sent it;
 *    `snapshot` is the message id. A changed file's sides are the blobs the patch names (`guideSideReader`), a
 *    lockfile's unchanged manifest as committed at the commit the guide pins (the project's HEAD for a guide that
 *    records none), a git object, never the working tree.
 *
 * Every decision is the shared service's (packages/shared/package-changes-service.ts), as in code review's servers:
 * which files hold package changes, which other files a lockfile's card needs, the read cap, the rows. This module
 * only says where a side's text comes from. It never asks npm: the Inbox has no lookup (`lookupEnabled` false,
 * `PLANNOTATOR_PACKAGE_LOOKUP=0`, so no registry setting is ever read either), and the card shows no consent button
 * (`usePackageChangeCards` in packages/inbox/guide/GuideReader.tsx). Code review's card switch (config.json `packageChanges.card`) holds here
 * too: off, no cards. A service per request, so a failed read is never kept. Bun only: the Inbox has no Pi server.
 * The routes' guards (GET, same origin, Code review on for a PR) are inbox.ts's, as for their neighbours.
 */

import { parseDiffToFiles } from "@plannotator/core/diff-files";
import type { InboxPullDiffScope } from "@plannotator/core/inbox-types";
import { coerceConfigBoolean, type PlannotatorConfig } from "@plannotator/shared/config";
import { createPackageChangesService, MAX_PACKAGE_FILE_BYTES, REMOTE_PACKAGE_READS, type PackageSideRead } from "@plannotator/shared/package-changes-service";
import { validateFilePath, type DiffSide, type FileBytesRead } from "@plannotator/shared/review-core";
import { InboxPullsError, type InboxPulls } from "./inbox-pulls";
import { guideSideReader, type GuideReadOptions } from "./inbox-review-image";

/** A route's answer: a status and a JSON body. */
export interface PackageChangesAnswer {
  status: number;
  body: unknown;
}

const NO_CARDS = (snapshot: string): PackageChangesAnswer => ({ status: 200, body: { snapshot, cards: [], lookup: { total: 0 } } });

/** Code review's card switch: config.json `packageChanges.card`, on unless set off. */
export function packageCardOn(config: PlannotatorConfig): boolean {
  return coerceConfigBoolean(config.packageChanges?.card, true);
}

/**
 * The refusal for a request that names no use of its diff, before the diff is read: `snapshot` missing or not
 * `pinned`'s shape, or a `base` (the Inbox's diffs have their own scope, never code review's base). Null: worth reading.
 */
function refusedAsked(params: URLSearchParams, pinned: (snapshot: string) => boolean): PackageChangesAnswer | null {
  const snapshot = params.get("snapshot") ?? "";
  if (!snapshot || !pinned(snapshot)) return { status: 400, body: { error: "Expected snapshot: the diff the page shows." } };
  if (params.has("base")) return { status: 400, body: { error: "No base here: the diff's scope says what it runs from." } };
  return null;
}

/** A side's bytes as the service's text read. */
function textOf(read: FileBytesRead): PackageSideRead {
  if (read.kind === "ok") return { kind: "ok", text: new TextDecoder().decode(read.bytes) };
  if (read.kind === "too-large") return { kind: "unreadable", reason: "too large" };
  if (read.kind === "missing") return { kind: "missing" };
  return { kind: "unreadable", reason: "could not be read" };
}

/** The shared service over one diff, with no lookup and no registry settings. */
function analyse(snapshot: string, patch: string, readSide: (side: DiffSide, path: string, oldPath: string | undefined) => Promise<PackageSideRead>, remote: () => Promise<boolean>): Promise<PackageChangesAnswer> {
  const service = createPackageChangesService({
    snapshotId: () => snapshot,
    diffFiles: () => parseDiffToFiles(patch).map(({ path, oldPath, status }) => ({ path, ...(oldPath ? { oldPath } : {}), status })),
    readSide: async (side, path, oldPath) => {
      try {
        validateFilePath(path);
        if (oldPath) validateFilePath(oldPath);
      } catch {
        return { kind: "unreadable", reason: "invalid path" };
      }
      return readSide(side, path, oldPath);
    },
    // Forge reads are a platform call each: at most code review's PR budget per request.
    prepare: async () => ((await remote()) ? { final: true, remote: { key: snapshot, budget: REMOTE_PACKAGE_READS } } : { final: true }),
    settings: () => ({ kind: "none" }),
    homeDir: () => null,
    lookupEnabled: () => false,
    env: { PLANNOTATOR_PACKAGE_LOOKUP: "0" },
  });
  return service.get({ snapshot, base: undefined });
}

/** A pull request's package changes (`/api/inbox/pulls/package-changes`). */
export async function pullPackageChanges(options: {
  pulls: Pick<InboxPulls, "diff" | "fileBytes">;
  key: string;
  scope: InboxPullDiffScope;
  from?: string;
  params: URLSearchParams;
  /** The clones of the PR's repository on this computer (inbox.ts `pullRoots`). */
  roots: () => Promise<string[]>;
  cardOn: boolean;
}): Promise<PackageChangesAnswer> {
  const { pulls, key, scope, from, params } = options;
  const refused = refusedAsked(params, (snapshot) => /^[0-9a-f]{40,64}$/.test(snapshot));
  if (refused) return refused;
  const asked = params.get("snapshot")!;
  if (!options.cardOn) return NO_CARDS(asked);
  let answer: { patch: string; head_sha?: string | null };
  try {
    answer = await pulls.diff(key, scope, from, asked);
  } catch (cause) {
    if (!(cause instanceof InboxPullsError)) throw cause;
    return { status: cause.code === "pull_unknown" ? 404 : 502, body: { error: cause.message, code: cause.code } };
  }
  const head = answer.head_sha;
  if (!head || head !== asked) return { status: 409, body: { error: "Diff snapshot is stale" } };
  let roots: Promise<string[]> | null = null;
  const rootsOf = () => (roots ??= options.roots());
  return analyse(
    head,
    answer.patch,
    async (side, path, oldPath) => textOf(await pulls.fileBytes(key, scope, side, path, oldPath, await rootsOf(), MAX_PACKAGE_FILE_BYTES, from, head)),
    async () => (await rootsOf()).length === 0,
  );
}

/** A guided review's package changes (`/api/inbox/messages/:id/guide/package-changes`), read by `guideSideReader`. */
export async function guidePackageChanges(options: GuideReadOptions & {
  /** The message the guide is on: the request's `snapshot`. */
  messageId: string;
  params: URLSearchParams;
  cardOn: boolean;
}): Promise<PackageChangesAnswer> {
  const { patch, messageId } = options;
  const refused = refusedAsked(options.params, (snapshot) => snapshot === messageId);
  if (refused) return refused;
  if (!options.cardOn) return NO_CARDS(messageId);
  if (patch === null) return { status: 404, body: { error: "This guided review's diff is gone." } };
  // A lockfile's manifest the patch leaves alone: as committed at the guide's revision, never the working tree.
  const read = guideSideReader(options, "head");
  return analyse(
    messageId,
    patch,
    async (side, path, oldPath) => textOf(await read(side, path, oldPath, MAX_PACKAGE_FILE_BYTES)),
    async () => !!options.forge,
  );
}

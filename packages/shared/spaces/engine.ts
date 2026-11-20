/**
 * Share this space: the run. Given a plan as it is on this computer, the record of what went up and a Spaces client,
 * it makes the calls `planSpaceShare` lists (packages/core/space-share.ts), one at a time, and keeps the record after
 * every one that answered. So:
 *
 * - It resumes. A run that failed, was stopped or died with the Inbox goes on from the step after the last one kept;
 *   the steps are planned again from the record before each call, never from memory.
 * - A call tried twice is one thing in the space. The create carries an id made here and is sent again exactly as
 *   first made (`record.seed`, `record.name`). A page add whose answer was lost finds the page by its path. A save
 *   whose answer was lost is refused by its own `If-Match`, and the version the space names is the one sent. A file is
 *   the same bytes at the same path. A comment carries its `anno_` id as the `Idempotency-Key`.
 * - It waits when told to. A 429 is waited out for as long as `Retry-After` says (10 s when it does not say), and the
 *   progress says so meanwhile.
 * - It never writes over another's work. A save names the version it expects the space to hold; when the space holds
 *   another (412), that page is marked `stopped` and left alone, and the rest goes on.
 * - It never says whose a space is. A write the space does not allow (403: a page save, a file upload, or an imported
 *   comment's `imported_owner_only`), to a space made here and not known to be the person's own, means it has an
 *   owner now: perhaps this person, from the browser or another computer. The run ends as `keep` (the record's `job.keep`), nothing more is sent, and Keep this space asks the one
 *   call that knows (the claim: theirs, or `409 claim_conflict`). The same when the claim a signed-in create makes
 *   is lost. Any other "no" is a run that did not finish; where the space is simply not
 *   there for this caller (`spaceNotAvailable`) the record says so (`job.gone`), so "Share as new" can be offered.
 *   A space is never made again by itself.
 * - The space is the person's own only when the space says so: `kept` is read from the create's answer, and a
 *   signed-in create that comes back with no owner (its first answer was lost before the sign-in) is claimed.
 * - The approval goes last, and only into a space that is the person's own. A space that does not take it is not
 *   asked again, and the run ends as done without it.
 */
import { gitBlobSha, planPictureTypeOf } from "@plannotator/core/plans";
import {
  isSpacePageKind,
  planSpaceShare,
  SPACE_OPEN_FILES_MAX,
  spaceCommentAnchor,
  spaceExternalKey,
  spaceImportedFields,
  spaceImportedOfComment,
  spacePageKindOfPath,
  type LocalSpace,
  type SpaceSharePlan,
  type SpaceShareRecord,
  type SpaceShareStep,
} from "@plannotator/core/space-share";
import { spaceKeptByAnother, spaceNotAvailable, spacesTokenRefused, spaceWriteNotAllowed, SpacesError, type SpacesClient, type SpacesSpace } from "./client";

export interface SpaceShareSource {
  /** The plan's id (`pln_…`): the space's `external_key` on a signed-in create. */
  plan_id?: string;
  local: LocalSpace;
  versionBytes(doc: string, version: number): Uint8Array | null;
  artifactBytes(path: string): Uint8Array | null;
}

export interface SpaceShareProgress {
  done: number;
  total: number;
  /** The space asked to wait: until when (ms since the epoch). */
  waiting_until: number | null;
  link: string | null;
}

/** `keep`: a write was not allowed; the space has an owner, and Keep this space finds out whether it is this person. */
export type SpaceShareEnd = "done" | "failed" | "stopped" | "over_limit" | "refused" | "keep";

/** The reason a run is aborted with when the server goes down (not the person's Stop): its record is left as running. */
export const SPACE_SHARE_SHUTDOWN = "shutdown";

export interface SpaceShareRun {
  source: SpaceShareSource;
  /** Changed in place; `save` after each change. */
  record: SpaceShareRecord;
  save(record: SpaceShareRecord): void;
  client: SpacesClient;
  signal?: AbortSignal;
  progress?(progress: SpaceShareProgress): void;
  /** Tests: the clock and the wait. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SpaceShareResult {
  end: SpaceShareEnd;
  /** The call that ended a failed run. */
  error?: SpacesError;
  /** The sign-in was refused (a 401 to a signed-in call): the caller forgets it. */
  signedOut?: boolean;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const BOM = [0xef, 0xbb, 0xbf];
const withoutBom = (bytes: Uint8Array) => (bytes.length >= 3 && BOM.every((b, i) => bytes[i] === b) ? bytes.subarray(3) : bytes);
/** The version a space names for these bytes: it drops a leading byte-order mark before it hashes. */
const hostedVersionOf = (bytes: Uint8Array) => gitBlobSha(withoutBom(bytes));
const textOf = (bytes: Uint8Array) => new TextDecoder().decode(withoutBom(bytes));

/** Marks that end one step without ending the run. */
class StepLeft extends Error {}
/** The space has an owner and is not known to be this person's: the run stops until Keep this space is pressed. */
class NeedsKeep extends Error {}

export async function runSpaceShare(run: SpaceShareRun): Promise<SpaceShareResult> {
  const { record, client, source } = run;
  const local = source.local;
  const now = run.now ?? Date.now;
  const sleep = run.sleep ?? defaultSleep;
  const stamp = () => new Date(now()).toISOString();
  const keep = () => {
    record.updated_at = stamp();
    run.save(record);
  };
  const plan = (): SpaceSharePlan => planSpaceShare(local, record, { mode: record.mode, signedIn: client.signedIn });
  const tell = (waitingUntil: number | null = null) => run.progress?.({ done: record.job?.done ?? 0, total: record.job?.total ?? 0, waiting_until: waitingUntil, link: record.share_url });
  const end = (ended: "failed" | "stopped" | "over_limit", result: Omit<SpaceShareResult, "end"> = {}): SpaceShareResult => {
    record.job = { done: record.job?.done ?? 0, total: record.job?.total ?? 0, ended, ...(ended === "over_limit" ? { bytes: plan().file_bytes } : {}) };
    keep();
    return { end: ended, ...result };
  };

  if (record.refused) return { end: "refused" };
  /** The time of this run: every version and comment it sends says it was put up then (`spaceImportedFields`). */
  const sharedAt = stamp();
  const first = plan();
  // What a run that did not finish had done still counts: "13 of 40" after "12 of 40".
  const base = record.job ? record.job.done : 0;
  const waitedForKeep = record.job?.keep === true;
  record.job = { done: base, total: base + first.steps.length, ended: null };
  // A space nobody owns holds 100 MB of files. Not counted for a space that is the person's own, nor for a share
  // started signed in until a claim has said the space is someone else's (`job.keep`).
  if (!record.kept && !(record.signed && !waitedForKeep) && first.file_bytes > SPACE_OPEN_FILES_MAX) return end("over_limit");
  keep();
  tell();

  const docOf = (id: string) => {
    const doc = local.documents.find((d) => d.id === id);
    if (!doc) throw new Error(`The plan has no page ${id}.`);
    return doc;
  };
  const bytesOf = (docId: string, n: number) => {
    const bytes = source.versionBytes(docId, n);
    if (!bytes) throw new Error(`Version ${n} of ${docId} could not be read.`);
    return bytes;
  };
  const localHash = (docId: string, n: number) => docOf(docId).versions.find((v) => v.version_number === n)?.version ?? "";
  /** Where a version came from, as the call carries it (`spaceImportedFields`: today the time of the run only). */
  const originOf = (docId: string, n: number, at = sharedAt) => spaceImportedFields(docOf(docId).versions.find((v) => v.version_number === n)?.imported ?? null, at);
  /** The space is there: its link, and whether it is the person's own, as the space says (never assumed). */
  const adopt = async (space: SpacesSpace) => {
    record.created = true;
    record.share_url = space.share_url ?? record.share_url;
    record.owner = space.owner_name ?? record.owner;
    record.visibility = space.visibility ?? record.visibility ?? null;
    record.kept = client.signedIn && space.owned;
    if (!client.signedIn || space.owned) return;
    // Signed in, and the space has no owner (it was made before the sign-in and its answer was lost): keep it now.
    try {
      const mine = await client.claim(record.space_id);
      record.kept = true;
      record.owner = mine.owner_name ?? record.owner;
      record.visibility = mine.visibility ?? record.visibility ?? null;
    } catch (error) {
      if (!spaceKeptByAnother(error)) throw error;
      // It has another owner by now. Said only when the person presses Keep; here the run just stops for it.
      throw new NeedsKeep();
    }
  };
  /** A page found in the space by its path after a lost answer: ours when it holds what was sent, else left alone. */
  const found = (docId: string, n: number, path: string, there: { id: string; version: string | null }, bytes: Uint8Array) => {
    const ours = there.version !== null && there.version === hostedVersionOf(bytes);
    record.pages[docId] = { lane: "page", remote_id: there.id, doc_path: path, pushed: ours ? [{ local: n, remote: there.version!, hash: localHash(docId, n) }] : [], stopped: ours ? null : { current: there.version } };
  };

  async function attempt(step: SpaceShareStep, next: SpaceSharePlan): Promise<void> {
    const paths = next.paths;
    const spaceId = record.space_id;
    switch (step.kind) {
      case "create": {
        // The same call every time: the page and version in it are kept before it is first made.
        if (!record.seed) {
          record.seed = { doc: step.doc, version: step.version, at: sharedAt };
          keep();
        }
        const seed = record.seed;
        const doc = seed.doc ? docOf(seed.doc) : null;
        const bytes = doc && seed.version ? bytesOf(doc.id, seed.version) : null;
        const path = doc ? paths[doc.id]! : null;
        const document = doc && bytes && path && isSpacePageKind(doc.kind) ? { path, kind: doc.kind, title: doc.title, body: textOf(bytes) } : null;
        try {
          // The key only with an account (a key sent without one is refused); the actor only with a first page.
          const externalKey = spaceExternalKey(source.plan_id, client.signedIn);
          const made = await client.createSpace({ id: spaceId, name: record.name, document, ...(externalKey ? { external_key: externalKey } : {}) }, document && seed.version ? originOf(doc!.id, seed.version, seed.at ?? sharedAt) : {});
          await adopt(made.space);
          if (doc && bytes && path) {
            if (made.document) record.pages[doc.id] = { lane: "page", remote_id: made.document.id, doc_path: path, pushed: [{ local: seed.version!, remote: made.document.version, hash: localHash(doc.id, seed.version!) }], stopped: null };
            else {
              const there = made.space.documents.find((d) => d.doc_path === path) ?? (await client.getSpace(spaceId)).documents.find((d) => d.doc_path === path);
              if (!there) throw new SpacesError(0, "no_first_page", "The space answered without its first page.");
              found(doc.id, seed.version!, path, there, bytes);
            }
          }
        } catch (error) {
          // The id is taken by a create that was not this exact call: the space is there; take it as it is.
          if (!(error instanceof SpacesError) || error.code !== "workspace_id_conflict") throw error;
          const space = await client.getSpace(spaceId);
          await adopt(space);
          const there = path ? space.documents.find((d) => d.doc_path === path) : null;
          if (doc && bytes && path && there) found(doc.id, seed.version!, path, there, bytes);
        }
        return;
      }
      case "page-add": {
        const doc = docOf(step.doc);
        if (!isSpacePageKind(doc.kind)) throw new StepLeft();
        const bytes = bytesOf(doc.id, step.version);
        const path = paths[doc.id]!;
        try {
          // No actor: the add-page call does not take one (its body is strict).
          const made = await client.addPage(spaceId, { doc_path: path, kind: doc.kind, title: doc.title, body: textOf(bytes) });
          record.pages[doc.id] = { lane: "page", remote_id: made.id, doc_path: path, pushed: [{ local: step.version, remote: made.version, hash: localHash(doc.id, step.version) }], stopped: null };
        } catch (error) {
          if (!(error instanceof SpacesError) || error.code !== "path_conflict") throw error;
          const there = (await client.getSpace(spaceId)).documents.find((d) => d.doc_path === path);
          if (!there) throw error;
          found(doc.id, step.version, path, there, bytes);
        }
        return;
      }
      case "page-save": {
        const doc = docOf(step.doc);
        const page = record.pages[doc.id];
        const last = page?.pushed[page.pushed.length - 1];
        if (!page?.remote_id || !last || !isSpacePageKind(doc.kind)) throw new Error(`Page ${doc.id} has nothing up to save onto.`);
        const bytes = bytesOf(doc.id, step.version);
        const pushed = (remote: string) => page.pushed.push({ local: step.version, remote, hash: localHash(doc.id, step.version) });
        try {
          pushed((await client.savePage(spaceId, page.remote_id, bytes, doc.kind, last.remote, originOf(doc.id, step.version))).version);
        } catch (error) {
          if (!(error instanceof SpacesError)) throw error;
          if (error.code === "version_conflict") {
            const current = typeof error.details.current_version === "string" ? error.details.current_version : null;
            // The save went through before and its answer was lost: the space holds what is being sent.
            if (current !== null && current === hostedVersionOf(bytes) && current !== last.remote) pushed(current);
            else page.stopped = { current };
          } else if (error.code === "document_archived" || error.code === "document_not_found") page.stopped = { current: null };
          else throw error;
        }
        return;
      }
      case "page-file": {
        const doc = docOf(step.doc);
        const bytes = bytesOf(doc.id, step.version);
        const path = paths[doc.id]!;
        const type = doc.kind === "data" ? "text/csv; charset=utf-8" : (planPictureTypeOf(bytes) ?? "application/octet-stream");
        const put = await client.putFile(spaceId, path, bytes, type, doc.title);
        const page = (record.pages[doc.id] ??= { lane: "file", remote_id: put.id, doc_path: path, pushed: [], stopped: null });
        page.remote_id = put.id ?? page.remote_id;
        page.pushed.push({ local: step.version, remote: put.content_hash ?? "", hash: localHash(doc.id, step.version) });
        return;
      }
      case "file": {
        const artifact = local.artifacts.find((a) => a.asset_path === step.path);
        const bytes = artifact ? source.artifactBytes(artifact.asset_path) : null;
        if (!artifact || !bytes) throw new Error(`The file ${step.path} could not be read.`);
        const path = next.file_paths[artifact.asset_path] ?? artifact.asset_path;
        const put = await client.putFile(spaceId, path, bytes, artifact.content_type, artifact.title);
        record.files[artifact.asset_path] = { remote_id: put.id, content_hash: artifact.content_hash, ...(path !== artifact.asset_path ? { remote_path: path } : {}) };
        return;
      }
      case "file-page": {
        const artifact = local.artifacts.find((a) => a.asset_path === step.path);
        const bytes = artifact ? source.artifactBytes(artifact.asset_path) : null;
        const kind = spacePageKindOfPath(step.path);
        if (!artifact || !bytes || !kind) throw new Error(`The file ${step.path} could not be read.`);
        const was = record.files[artifact.asset_path];
        const path = next.file_paths[artifact.asset_path] ?? artifact.asset_path;
        const up = (remoteId: string | null, version: string | undefined) =>
          (record.files[artifact.asset_path] = { remote_id: remoteId, content_hash: artifact.content_hash, ...(version ? { page_version: version } : {}), ...(path !== artifact.asset_path ? { remote_path: path } : {}) });
        try {
          if (was?.remote_id && was.page_version) up(was.remote_id, (await client.savePage(spaceId, was.remote_id, bytes, kind, was.page_version)).version);
          else {
            const made = await client.addPage(spaceId, { doc_path: path, kind, title: artifact.title ?? artifact.asset_path.split("/").pop()!, body: textOf(bytes) });
            up(made.id, made.version);
          }
        } catch (error) {
          if (!(error instanceof SpacesError)) throw error;
          if (error.code === "path_conflict") {
            const there = (await client.getSpace(spaceId)).documents.find((d) => d.doc_path === path);
            if (!there) throw error;
            up(there.id, there.version ?? undefined);
          } else if (error.code === "version_conflict" || error.code === "document_archived" || error.code === "document_not_found") {
            // Changed in the space: left as it is there, and not sent again until it changes here.
            up(was?.remote_id ?? null, typeof error.details.current_version === "string" ? error.details.current_version : was?.page_version);
          } else throw error;
        }
        return;
      }
      case "comment":
      case "reply": {
        const comment = local.comments.find((c) => c.id === step.id);
        if (!comment || comment.target.kind !== "document") throw new StepLeft();
        const target = comment.target;
        const page = record.pages[target.document_id];
        const version = page?.pushed.find((p) => p.hash === target.document_version)?.remote;
        if (!page?.remote_id || !version) throw new StepLeft();
        try {
          if (step.kind === "reply") {
            const parent = record.comments[step.parent];
            if (!parent || !("remote_id" in parent)) throw new StepLeft();
            record.comments[comment.id] = { remote_id: (await client.addReply(spaceId, page.remote_id, parent.remote_id, { body: comment.body }, comment.id, spaceImportedFields(spaceImportedOfComment(comment), sharedAt))).id, reply: true };
          } else {
            record.comments[comment.id] = { remote_id: (await client.addComment(spaceId, page.remote_id, { anchor: spaceCommentAnchor(comment), body: comment.body, document_version: version }, comment.id, spaceImportedFields(spaceImportedOfComment(comment), sharedAt))).id };
          }
        } catch (error) {
          // A comment the space does not take as it is stays here; the rest goes on.
          if (error instanceof StepLeft || (error instanceof SpacesError && (error.status === 422 || error.status === 400 || error.status === 413))) {
            record.comments[comment.id] = { left: error instanceof SpacesError ? error.code : "left" };
            return;
          }
          throw error;
        }
        return;
      }
      case "approval": {
        const page = record.pages[step.doc];
        const version = page?.pushed.find((p) => p.local === step.version)?.remote;
        if (!page?.remote_id || !version) {
          record.approval_refused = true;
          return;
        }
        try {
          await client.approve(spaceId, page.remote_id, version);
          record.approval = { document_id: step.doc, version_number: step.version };
        } catch (error) {
          // The space does not take an approval from here (yet): the share is whole without it.
          if (!(error instanceof SpacesError) || error.status < 400 || error.status >= 500 || error.status === 429) throw error;
          record.approval_refused = true;
        }
        return;
      }
    }
  }

  let lastStep = "";
  let sameStep = 0;
  let serverTries = 0;
  /** Aborted: the person's Stop ends it as stopped; the server going down leaves it as it was, a run not finished. */
  const aborted = (): SpaceShareResult => {
    if (run.signal?.reason !== SPACE_SHARE_SHUTDOWN) return end("stopped");
    record.job = { done: record.job?.done ?? 0, total: record.job?.total ?? 0, ended: null };
    keep();
    return { end: "stopped" };
  };
  const needsKeep = (): SpaceShareResult => {
    record.job = { done: record.job?.done ?? 0, total: record.job?.total ?? 0, ended: "failed", keep: true };
    keep();
    return { end: "keep" };
  };
  // Started signed in, made, and never confirmed as the person's own (the claim after the create did not get an
  // answer): the claim is made now, before anything more is sent.
  if (record.created && !record.kept && record.signed && client.signedIn && !record.refused) {
    try {
      const mine = await client.claim(record.space_id);
      record.kept = true;
      record.owner = mine.owner_name ?? record.owner;
      record.visibility = mine.visibility ?? record.visibility ?? null;
      keep();
    } catch (error) {
      if (run.signal?.aborted) return aborted();
      if (spaceKeptByAnother(error)) return needsKeep();
      return end("failed", error instanceof SpacesError ? { error, signedOut: spacesTokenRefused(error) } : {});
    }
  }
  for (;;) {
    if (run.signal?.aborted) return aborted();
    const next = plan();
    const step = next.steps[0];
    if (!step) break;
    // A step that neither went up nor was marked would be planned again for ever.
    const key = JSON.stringify(step);
    sameStep = key === lastStep ? sameStep + 1 : 0;
    lastStep = key;
    if (sameStep > 8) return end("failed");
    try {
      await attempt(step, next);
    } catch (error) {
      if (run.signal?.aborted) return aborted();
      if (error instanceof NeedsKeep) return needsKeep();
      if (error instanceof StepLeft) {
        if (step.kind === "comment" || step.kind === "reply") record.comments[step.id] = { left: "left" };
        else return end("failed");
        keep();
        continue;
      }
      if (!(error instanceof SpacesError)) return end("failed");
      if (error.status === 429) {
        const until = now() + (error.retryAfter ?? 10) * 1000;
        tell(until);
        await sleep(Math.max(0, until - now()), run.signal);
        sameStep = 0;
        tell();
        continue;
      }
      // A slow first save (503) and a save the space failed (500) may be sent again unchanged.
      if ((error.code === "workspace_seed_timeout" || error.status === 500) && serverTries < 3) {
        serverTries++;
        await sleep(1000 * serverTries, run.signal);
        sameStep = 0;
        continue;
      }
      // The space has an owner now, and it is not known to be this person: only a claim says whose.
      if (record.created && !record.kept && spaceWriteNotAllowed(error)) return needsKeep();
      if (error.status === 413 && error.code === "quota_exceeded") return end("over_limit");
      // The space is not there for this caller any more (expired, removed, or made private): the run did not finish,
      // and it is never made again by itself. No sign-in is started or suggested for a call made without one.
      if (record.created && spaceNotAvailable(error, client.signedIn)) {
        record.job = { done: record.job?.done ?? 0, total: record.job?.total ?? 0, ended: "failed", gone: true };
        keep();
        return { end: "failed", error };
      }
      // Anything else: the run did not finish. A sign-in the space refused is forgotten.
      return end("failed", { error, signedOut: client.signedIn && spacesTokenRefused(error) });
    }
    serverTries = 0;
    record.job = { done: (record.job?.done ?? 0) + 1, total: Math.max(record.job?.total ?? 0, (record.job?.done ?? 0) + next.steps.length), ended: null };
    keep();
    tell();
  }

  record.job = null;
  record.shared_at ??= stamp();
  keep();
  return { end: "done" };
}

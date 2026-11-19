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
 * - It tells when the space is no longer open to it. A write refused (401, 403, or the space not found) to a space
 *   made here without sign-in means someone else kept it: `refused`, and nothing more is sent.
 * - The approval goes last, and only into a space that is the person's own. A space that does not take it is not
 *   asked again, and the run ends as done without it.
 */
import { gitBlobSha, planPictureTypeOf } from "@plannotator/core/plans";
import {
  isSpacePageKind,
  planSpaceShare,
  SPACE_OPEN_FILES_MAX,
  spaceCommentAnchor,
  spaceImportedFields,
  spaceImportedOfComment,
  spacePageKindOfPath,
  type LocalSpace,
  type SpaceSharePlan,
  type SpaceShareRecord,
  type SpaceShareStep,
} from "@plannotator/core/space-share";
import { SpacesError, type SpacesClient, type SpacesSpace } from "./client";

export interface SpaceShareSource {
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

export type SpaceShareEnd = "done" | "failed" | "stopped" | "over_limit" | "refused";

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
  /** A new id for the space (a space that is gone is shared again as a new one). */
  newSpaceId: () => string;
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
    record.job = { done: record.job?.done ?? 0, total: record.job?.total ?? 0, ended };
    keep();
    return { end: ended, ...result };
  };

  if (record.refused) return { end: "refused" };
  const first = plan();
  // What a run that did not finish had done still counts: "13 of 40" after "12 of 40".
  const base = record.job ? record.job.done : 0;
  record.job = { done: base, total: base + first.steps.length, ended: null };
  if (!record.kept && first.file_bytes > SPACE_OPEN_FILES_MAX) return end("over_limit");
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
  /** Where a version came from (its agent and its own time), as the call carries it: nothing yet (`spaceImportedFields`). */
  const originOf = (docId: string, n: number) => spaceImportedFields(docOf(docId).versions.find((v) => v.version_number === n)?.imported ?? null);
  const adopt = (space: SpacesSpace | { share_url: string | null; owner_name: string | null }) => {
    record.created = true;
    record.share_url = space.share_url ?? record.share_url;
    record.owner = space.owner_name ?? record.owner;
  };
  /** A page found in the space by its path after a lost answer: ours when it holds what was sent, else left alone. */
  const found = (docId: string, n: number, path: string, there: { id: string; version: string | null }, bytes: Uint8Array) => {
    const ours = there.version !== null && there.version === hostedVersionOf(bytes);
    record.pages[docId] = { lane: "page", remote_id: there.id, doc_path: path, pushed: ours ? [{ local: n, remote: there.version!, hash: localHash(docId, n) }] : [], stopped: ours ? null : { current: there.version } };
  };

  async function attempt(step: SpaceShareStep, paths: Record<string, string>): Promise<void> {
    const spaceId = record.space_id;
    switch (step.kind) {
      case "create": {
        // The same call every time: the page and version in it are kept before it is first made.
        if (!record.seed) {
          record.seed = { doc: step.doc, version: step.version };
          keep();
        }
        const seed = record.seed;
        const doc = seed.doc ? docOf(seed.doc) : null;
        const bytes = doc && seed.version ? bytesOf(doc.id, seed.version) : null;
        const path = doc ? paths[doc.id]! : null;
        const document = doc && bytes && path && isSpacePageKind(doc.kind) ? { path, kind: doc.kind, title: doc.title, body: textOf(bytes) } : null;
        try {
          const made = await client.createSpace({ id: spaceId, name: record.name, document }, doc && seed.version ? originOf(doc.id, seed.version) : {});
          adopt(made.space);
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
          adopt(space);
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
          const made = await client.addPage(spaceId, { doc_path: path, kind: doc.kind, title: doc.title, body: textOf(bytes) }, originOf(doc.id, step.version));
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
        const put = await client.putFile(spaceId, artifact.asset_path, bytes, artifact.content_type, artifact.title);
        record.files[artifact.asset_path] = { remote_id: put.id, content_hash: artifact.content_hash };
        return;
      }
      case "file-page": {
        const artifact = local.artifacts.find((a) => a.asset_path === step.path);
        const bytes = artifact ? source.artifactBytes(artifact.asset_path) : null;
        const kind = spacePageKindOfPath(step.path);
        if (!artifact || !bytes || !kind) throw new Error(`The file ${step.path} could not be read.`);
        const was = record.files[artifact.asset_path];
        const up = (remoteId: string | null, version: string | undefined) => (record.files[artifact.asset_path] = { remote_id: remoteId, content_hash: artifact.content_hash, ...(version ? { page_version: version } : {}) });
        try {
          if (was?.remote_id && was.page_version) up(was.remote_id, (await client.savePage(spaceId, was.remote_id, bytes, kind, was.page_version)).version);
          else {
            const made = await client.addPage(spaceId, { doc_path: artifact.asset_path, kind, title: artifact.title ?? artifact.asset_path.split("/").pop()!, body: textOf(bytes) });
            up(made.id, made.version);
          }
        } catch (error) {
          if (!(error instanceof SpacesError)) throw error;
          if (error.code === "path_conflict") {
            const there = (await client.getSpace(spaceId)).documents.find((d) => d.doc_path === artifact.asset_path);
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
            record.comments[comment.id] = { remote_id: (await client.addReply(spaceId, page.remote_id, parent.remote_id, { body: comment.body }, comment.id, spaceImportedFields(spaceImportedOfComment(comment)))).id, reply: true };
          } else {
            record.comments[comment.id] = { remote_id: (await client.addComment(spaceId, page.remote_id, { anchor: spaceCommentAnchor(comment), body: comment.body, document_version: version }, comment.id, spaceImportedFields(spaceImportedOfComment(comment)))).id };
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
  for (;;) {
    if (run.signal?.aborted) return end("stopped");
    const next = plan();
    const step = next.steps[0];
    if (!step) break;
    // A step that neither went up nor was marked would be planned again for ever.
    const key = JSON.stringify(step);
    sameStep = key === lastStep ? sameStep + 1 : 0;
    lastStep = key;
    if (sameStep > 8) return end("failed");
    try {
      await attempt(step, next.paths);
    } catch (error) {
      if (run.signal?.aborted) return end("stopped");
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
      // The space is gone for good: this plan is shared again as a new one.
      if (error.status === 410 && record.created) {
        Object.assign(record, { space_id: run.newSpaceId(), seed: null, created: false, share_url: null, kept: client.signedIn, owner: null, pages: {}, files: {}, comments: {}, approval: null, approval_refused: false, shared_at: null });
        record.job = { done: 0, total: plan().steps.length, ended: null };
        keep();
        tell();
        continue;
      }
      // No way in: no credential where one is now asked for, not allowed, or a space this caller is no longer shown.
      // (A plain `not_found` is a route the service does not have, never a refusal.)
      const noEntry = error.status === 401 || error.status === 403 || (error.status === 404 && error.code === "workspace_not_found");
      if (noEntry && record.created && !record.kept) {
        record.refused = true;
        record.job = null;
        keep();
        return { end: "refused" };
      }
      if (error.status === 413 && error.code === "quota_exceeded" && !record.kept) return end("over_limit");
      return end("failed", { error, signedOut: error.status === 401 && client.signedIn });
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

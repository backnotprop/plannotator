/**
 * Share this space, for the plans in the library: one share at a time per plan, run in the background by the
 * long-lived server that mounts it (the Inbox), and the routes a plan's page drives it with. Runtime-neutral: the
 * caller gives the store, how a browser is opened and whether this server runs where a browser can come back to.
 *
 *   GET  /api/plans/:id/share               where the share stands (`SpaceShareStatus`): never a credential
 *   POST /api/plans/:id/share               { mode?, fresh? }: share, update or try again (`fresh`: as a new space);
 *                                           answers at once, the upload runs on
 *   POST /api/plans/:id/share/stop          stop the upload (what is up stays up)
 *   POST /api/plans/:id/share/keep          sign in (the browser opens) and make the space the person's own
 *   POST /api/plans/:id/share/keep/cancel   give the sign-in up; nothing changed
 *   POST /api/plans/:id/share/delete        delete the copy in Spaces (a kept space only) and forget the share
 *
 * The upload itself is engine.ts; what is kept of it is record.ts; the sign-in is signin.ts and credential.ts.
 */
import { readFileSync } from "node:fs";
import { isPlanId, planApprovalsOn, planPictureTypeOf, PLAN_PERSON } from "@plannotator/core/plans";
import { newSpaceId, newSpaceShareRecord, planSpaceShare, type LocalSpace, type SpaceShareMode, type SpaceShareRecord, type SpaceShareStatus } from "@plannotator/core/space-share";
import type { PlanStore } from "../plans/store";
import { createSpacesClient, SpacesError } from "./client";
import { clearSpacesCredential, readSpacesCredential, saveSpacesCredential } from "./credential";
import { runSpaceShare, type SpaceShareProgress, type SpaceShareSource } from "./engine";
import { dropSpaceShareRecord, readSpaceShareRecord, saveSpaceShareRecord } from "./record";
import { startSpacesSignIn, type SpacesSignIn } from "./signin";

const PICTURE_EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg" };

/** A plan as a share reads it (`LocalSpace`), with its bytes; null when the plan is not in the library. */
export function spaceShareSource(store: PlanStore, id: string): SpaceShareSource | null {
  const read = store.read(id);
  if (!read) return null;
  const primary = read.plan.primary_doc_id;
  const documents = read.documents
    .filter((doc) => !doc.archived_at)
    .map((doc) => {
      const versions = read.versions.filter((v) => v.document_id === doc.id).map((v) => ({ version_number: v.version_number, version: v.version, size: v.size }));
      const head = versions[versions.length - 1];
      let extension: string | null = null;
      if (doc.kind === "data") extension = "csv";
      if (doc.kind === "image" && head) {
        const bytes = store.versionBytes(id, doc.id, head.version_number);
        extension = (bytes && PICTURE_EXTENSION[planPictureTypeOf(bytes) ?? ""]) || "bin";
      }
      return { id: doc.id, kind: doc.kind, title: doc.title, doc_path: doc.doc_path, file_extension: extension, versions };
    });
  const head = documents.find((d) => d.id === primary)?.versions.slice(-1)[0]?.version_number ?? 0;
  const mine = (n: number) => planApprovalsOn(read.events, primary, n).some((a) => a.name === PLAN_PERSON);
  let older = 0;
  for (let n = 1; n < head; n++) if (planApprovalsOn(read.events, primary, n).length > 0) older++;
  const local: LocalSpace = {
    name: read.plan.name,
    primary_doc_id: primary,
    documents,
    artifacts: read.artifacts,
    comments: store.comments(id),
    approval: head > 0 && mine(head) ? { document_id: primary, version_number: head } : null,
    older_approvals: older,
  };
  return {
    local,
    versionBytes: (doc, n) => store.versionBytes(id, doc, n),
    artifactBytes: (path) => {
      const file = store.artifactPath(id, path);
      if (!file) return null;
      try {
        return new Uint8Array(readFileSync(file));
      } catch {
        return null;
      }
    },
  };
}

export interface SpaceShareJobsOptions {
  dataDir: string;
  store: () => PlanStore;
  /** The Spaces origin a new share goes to (read when a share starts). */
  host: () => string;
  /** Open a page in the person's browser. `remote`: this server runs where no browser of theirs can be opened. */
  openBrowser: (url: string) => Promise<"opened" | "none" | "remote" | "failed">;
  /** This server runs on another machine than the person's browser (SSH, a container): a loopback sign-in cannot come back. */
  remote: () => boolean;
  fetch?: typeof fetch;
  /** A share changed (a step went up, a run ended). */
  changed?: (id: string) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signInTimeoutMs?: number;
}

interface Live {
  running: Promise<void> | null;
  abort: AbortController | null;
  progress: SpaceShareProgress | null;
  keep: "waiting" | "remote" | null;
  signIn: SpacesSignIn | null;
}

export interface SpaceShareJobs {
  status(id: string): SpaceShareStatus | null;
  share(id: string, input: { mode?: SpaceShareMode; fresh?: boolean }): SpaceShareStatus | null;
  stop(id: string): SpaceShareStatus | null;
  keep(id: string): Promise<SpaceShareStatus | null>;
  keepCancel(id: string): SpaceShareStatus | null;
  remove(id: string): Promise<{ ok: boolean; status: SpaceShareStatus | null }>;
  /** The run going for a plan, if any (tests wait on it). */
  running(id: string): Promise<void> | null;
  /** Stop every run and sign-in (the server is going down). */
  close(): void;
}

export function createSpaceShareJobs(options: SpaceShareJobsOptions): SpaceShareJobs {
  const lives = new Map<string, Live>();
  const liveOf = (id: string): Live => {
    let live = lives.get(id);
    if (!live) lives.set(id, (live = { running: null, abort: null, progress: null, keep: null, signIn: null }));
    return live;
  };
  const now = options.now ?? Date.now;
  const credentialOf = (host: string) => readSpacesCredential(options.dataDir, host);
  const clientOf = (host: string, signal?: AbortSignal) => createSpacesClient({ host, token: credentialOf(host)?.token ?? null, fetch: options.fetch, signal });

  function status(id: string): SpaceShareStatus | null {
    if (!isPlanId("pln", id)) return null;
    const source = spaceShareSource(options.store(), id);
    if (!source) return null;
    const record = readSpaceShareRecord(options.dataDir, id);
    const live = liveOf(id);
    const host = record?.host ?? options.host();
    const credential = credentialOf(host);
    const signedIn = credential !== null;
    const planOf = (mode: SpaceShareMode) => planSpaceShare(source.local, record, { mode, signedIn });
    const plan = planOf(record?.mode ?? "all");
    const running = live.running !== null;
    const phase: SpaceShareStatus["phase"] = running ? "sharing" : !record ? "none" : record.refused ? "refused" : record.job ? (record.job.ended ?? "failed") : record.shared_at ? "shared" : "none";
    const progress = running && live.progress ? { done: live.progress.done, total: live.progress.total } : record?.job ? { done: record.job.done, total: record.job.total } : null;
    const until = running ? (live.progress?.waiting_until ?? null) : null;
    return {
      phase,
      progress,
      waiting: until !== null ? Math.max(1, Math.ceil((until - now()) / 1000)) : null,
      link: record?.share_url ?? null,
      shared_once: !!record?.shared_at,
      kept: record ? record.kept : false,
      signed_in: signedIn,
      who: signedIn ? (credential.name ?? (record?.kept ? record.owner : null)) : null,
      keep: live.keep,
      mode: record?.mode ?? "all",
      versions: Math.max(0, ...source.local.documents.map((d) => d.versions.length)),
      changes: phase === "shared" ? plan.changes : 0,
      stopped_pages: record ? source.local.documents.filter((d) => record.pages[d.id]?.stopped).map((d) => ({ title: d.title })) : [],
      details: { all: planOf("all").details, newest: planOf("newest").details },
    };
  }

  /** Run the upload for a record already on disk. */
  function start(id: string, record: SpaceShareRecord): void {
    const live = liveOf(id);
    if (live.running) return;
    const source = spaceShareSource(options.store(), id);
    if (!source) return;
    const abort = new AbortController();
    live.abort = abort;
    live.progress = { done: record.job?.done ?? 0, total: record.job?.total ?? 0, waiting_until: null, link: record.share_url };
    live.running = runSpaceShare({
      source,
      record,
      save: (next) => saveSpaceShareRecord(options.dataDir, id, next),
      client: clientOf(record.host, abort.signal),
      signal: abort.signal,
      now: options.now,
      sleep: options.sleep,
      newSpaceId: () => newSpaceId(),
      progress: (progress) => {
        live.progress = progress;
        options.changed?.(id);
      },
    })
      .then(
        (result) => {
          if (result.signedOut) clearSpacesCredential(options.dataDir, record.host);
        },
        () => {
          // Something outside a Spaces call (a file that could not be read): the run did not finish.
          record.job = { done: record.job?.done ?? 0, total: record.job?.total ?? 0, ended: "failed" };
          try {
            saveSpaceShareRecord(options.dataDir, id, record);
          } catch {
            // The plan is gone: nothing to keep.
          }
        },
      )
      .finally(() => {
        live.running = null;
        live.abort = null;
        live.progress = null;
        options.changed?.(id);
      });
  }

  function share(id: string, input: { mode?: SpaceShareMode; fresh?: boolean }): SpaceShareStatus | null {
    const source = spaceShareSource(options.store(), id);
    if (!source) return null;
    const live = liveOf(id);
    if (live.running) return status(id);
    let record = input.fresh ? null : readSpaceShareRecord(options.dataDir, id);
    if (record?.refused) return status(id);
    if (!record) {
      const host = options.host();
      record = newSpaceShareRecord({ host, space_id: newSpaceId(), name: source.local.name, mode: input.mode ?? "all", kept: credentialOf(host) !== null, at: new Date(now()).toISOString() });
      saveSpaceShareRecord(options.dataDir, id, record);
    } else if (!record.created && !record.kept && credentialOf(record.host)) {
      // Signed in since a first try that made nothing: the space is made as the person's own.
      record.kept = true;
    }
    // The person's own space, and the sign-in is gone from this computer: sign in again, then go on.
    if (record.kept && !credentialOf(record.host)) {
      void keep(id);
      return status(id);
    }
    start(id, record);
    return status(id);
  }

  function stop(id: string): SpaceShareStatus | null {
    liveOf(id).abort?.abort();
    return status(id);
  }

  /** Signed in: make the space the person's own (when it is up and not theirs yet), then send what is left. */
  async function claimAndGoOn(id: string): Promise<void> {
    const record = readSpaceShareRecord(options.dataDir, id);
    if (!record || liveOf(id).running) return;
    if (record.created && !record.kept && !record.refused) {
      try {
        const space = await clientOf(record.host).claim(record.space_id);
        record.kept = true;
        record.owner = space.owner_name ?? record.owner;
        record.share_url = space.share_url ?? record.share_url;
      } catch (error) {
        // Someone else kept it first (the space is theirs, or no longer shown to this person).
        if (error instanceof SpacesError && [401, 403, 404, 409].includes(error.status)) record.refused = true;
        else return;
      }
      saveSpaceShareRecord(options.dataDir, id, record);
    } else if (!record.created && !record.kept) {
      record.kept = true;
      saveSpaceShareRecord(options.dataDir, id, record);
    }
    if (record.refused) return;
    const source = spaceShareSource(options.store(), id);
    // What waits: a run that did not finish, or the approval, which goes only into a kept space.
    if (source && (record.job || planSpaceShare(source.local, record, { mode: record.mode, signedIn: true }).steps.length > 0)) start(id, record);
  }

  async function keep(id: string): Promise<SpaceShareStatus | null> {
    const live = liveOf(id);
    const record = readSpaceShareRecord(options.dataDir, id);
    const host = record?.host ?? options.host();
    if (status(id) === null) return null;
    if (credentialOf(host)) {
      await claimAndGoOn(id);
      return status(id);
    }
    if (options.remote()) {
      live.keep = "remote";
      return status(id);
    }
    // Open again: the same sign-in, the same page.
    if (!live.signIn) {
      const signIn = await startSpacesSignIn({ host, fetch: options.fetch, timeoutMs: options.signInTimeoutMs });
      live.signIn = signIn;
      live.keep = "waiting";
      void signIn.done.then(async (credential) => {
        if (live.signIn !== signIn) return;
        live.signIn = null;
        if (credential) {
          saveSpacesCredential(options.dataDir, host, credential);
          await claimAndGoOn(id).catch(() => {});
        }
        live.keep = null;
        options.changed?.(id);
      });
    }
    const opened = await options.openBrowser(live.signIn.url);
    if (opened === "remote") {
      live.signIn.cancel();
      live.signIn = null;
      live.keep = "remote";
    }
    return status(id);
  }

  function keepCancel(id: string): SpaceShareStatus | null {
    const live = liveOf(id);
    const signIn = live.signIn;
    live.signIn = null;
    live.keep = null;
    signIn?.cancel();
    return status(id);
  }

  async function remove(id: string): Promise<{ ok: boolean; status: SpaceShareStatus | null }> {
    const record = readSpaceShareRecord(options.dataDir, id);
    const live = liveOf(id);
    if (!record || !record.kept || live.running) return { ok: false, status: status(id) };
    try {
      if (record.created) await clientOf(record.host).deleteSpace(record.space_id);
    } catch (error) {
      // Already gone there is gone here too.
      if (!(error instanceof SpacesError && (error.status === 404 || error.status === 410))) return { ok: false, status: status(id) };
    }
    dropSpaceShareRecord(options.dataDir, id);
    options.changed?.(id);
    return { ok: true, status: status(id) };
  }

  return {
    status,
    share,
    stop,
    keep,
    keepCancel,
    remove,
    running: (id) => lives.get(id)?.running ?? null,
    close() {
      for (const live of lives.values()) {
        live.abort?.abort();
        live.signIn?.cancel();
        live.signIn = null;
        live.keep = null;
      }
    },
  };
}

// ─────────────────────────────── The routes ───────────────────────────────

export interface SpaceShareRouteRequest {
  method: string;
  /** The path after `/api/plans/`, split: `[<pln_id>, "share", …]`. */
  parts: string[];
  json: () => Promise<unknown>;
}

export type SpaceShareRouteResult = { status: number; body: unknown };

const bad = (error: string, status = 400): SpaceShareRouteResult => ({ status, body: { error } });

/** True for `/api/plans/:id/share` and the paths under it. */
export const isSpaceSharePath = (parts: readonly string[]) => parts.length >= 2 && parts[1] === "share";

export async function handleSpaceShareRoute(req: SpaceShareRouteRequest, jobs: SpaceShareJobs): Promise<SpaceShareRouteResult | null> {
  if (!isSpaceSharePath(req.parts)) return null;
  const id = req.parts[0]!;
  if (!isPlanId("pln", id)) return bad("not a plan id", 404);
  const method = req.method.toUpperCase();
  const action = req.parts.slice(2).join("/");
  const answer = (status: SpaceShareStatus | null): SpaceShareRouteResult => (status ? { status: 200, body: status } : bad(`No plan ${id}.`, 404));
  if (action === "" && method === "GET") return answer(jobs.status(id));
  if (method !== "POST") return bad("method not allowed", 405);
  let body: Record<string, unknown> = {};
  try {
    const value = await req.json();
    if (value && typeof value === "object" && !Array.isArray(value)) body = value as Record<string, unknown>;
  } catch {
    return bad("the body must be JSON");
  }
  switch (action) {
    case "": {
      const unknown = Object.keys(body).find((key) => !["mode", "fresh", "serverSession"].includes(key));
      if (unknown) return bad(`unknown field ${unknown}`);
      if (body.mode !== undefined && body.mode !== "all" && body.mode !== "newest") return bad("mode is all or newest");
      if (body.fresh !== undefined && typeof body.fresh !== "boolean") return bad("fresh is true or false");
      return answer(jobs.share(id, { mode: body.mode as SpaceShareMode | undefined, fresh: body.fresh === true }));
    }
    case "stop":
      return answer(jobs.stop(id));
    case "keep":
      return answer(await jobs.keep(id));
    case "keep/cancel":
      return answer(jobs.keepCancel(id));
    case "delete": {
      const removed = await jobs.remove(id);
      if (!removed.status) return bad(`No plan ${id}.`, 404);
      return { status: removed.ok ? 200 : 502, body: removed.ok ? removed.status : { error: "Spaces did not delete the space.", status: removed.status } };
    }
    default:
      return bad("not found", 404);
  }
}

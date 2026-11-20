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
import { createSpacesClient, spaceKeptByAnother, spacesTokenRefused, SpacesError } from "./client";
import { clearSpacesCredential, readSpacesCredential, saveSpacesCredential } from "./credential";
import { runSpaceShare, SPACE_SHARE_SHUTDOWN, type SpaceShareProgress, type SpaceShareSource } from "./engine";
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
      const versions = read.versions.filter((v) => v.document_id === doc.id).map((v) => ({ version_number: v.version_number, version: v.version, size: v.size, imported: { author_label: v.author_label ?? null, agent_host: v.agent_host ?? null, agent_session: v.agent_session ?? null, agent_name: v.agent_name ?? null, at: v.committed_at } }));
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
  /** The claim going for this plan: one at a time, and no run starts while it is. */
  claiming: Promise<void> | null;
  /** The plan as the run going read it, and the last read while something is in flight (the status is asked often then). */
  source: SpaceShareSource | null;
  memo: { at: number; source: SpaceShareSource } | null;
}

/** How long a read of the plan answers the status while a run or a sign-in is in flight. */
const STATUS_MEMO_MS = 2000;

export interface SpaceShareJobs {
  status(id: string): SpaceShareStatus | null;
  /** Answers at once; the upload runs on. Never opens a browser. */
  share(id: string, input: { mode?: SpaceShareMode; fresh?: boolean }): SpaceShareStatus | null;
  stop(id: string): SpaceShareStatus | null;
  keep(id: string): Promise<SpaceShareStatus | null>;
  keepCancel(id: string): SpaceShareStatus | null;
  remove(id: string): Promise<{ ok: boolean; status: SpaceShareStatus | null }>;
  /** The run going for a plan, if any (tests wait on it). */
  running(id: string): Promise<void> | null;
  /** The claim going for a plan, if any (tests wait on it). */
  claiming(id: string): Promise<void> | null;
  /** Stop every run and sign-in, and close every listener (the server is going down). */
  close(): void;
}

export function createSpaceShareJobs(options: SpaceShareJobsOptions): SpaceShareJobs {
  const lives = new Map<string, Live>();
  const liveOf = (id: string): Live => {
    let live = lives.get(id);
    if (!live) lives.set(id, (live = { running: null, abort: null, progress: null, keep: null, signIn: null, claiming: null, source: null, memo: null }));
    return live;
  };
  const now = options.now ?? Date.now;
  const credentialOf = (host: string) => readSpacesCredential(options.dataDir, host);
  const clientOf = (host: string, signal?: AbortSignal) => createSpacesClient({ host, token: credentialOf(host)?.token ?? null, fetch: options.fetch, signal });
  /**
   * Nothing more goes up until the person signs in and keeps the space: it is theirs (or was started signed in) and
   * the sign-in is gone from this computer, or a write was not allowed and only a claim says whose it is now.
   */
  const needsKeepOf = (record: SpaceShareRecord | null, signedIn: boolean) => !!record && !record.refused && (((record.kept || record.signed === true) && !signedIn) || record.job?.keep === true);
  const inFlight = (live: Live) => live.running !== null || live.claiming !== null || live.keep === "waiting";

  /** The plan as a share reads it. While something is in flight the status is asked for often: it is read once then. */
  function sourceOf(id: string, live: Live): SpaceShareSource | null {
    if (live.running && live.source) return live.source;
    if (inFlight(live) && live.memo && Date.now() - live.memo.at < STATUS_MEMO_MS) return live.memo.source;
    const source = spaceShareSource(options.store(), id);
    live.memo = source && inFlight(live) ? { at: Date.now(), source } : null;
    return source;
  }

  function status(id: string): SpaceShareStatus | null {
    if (!isPlanId("pln", id)) return null;
    const live = liveOf(id);
    const source = sourceOf(id, live);
    if (!source) return null;
    const record = readSpaceShareRecord(options.dataDir, id);
    const host = record?.host ?? options.host();
    const credential = credentialOf(host);
    const signedIn = credential !== null;
    const planOf = (mode: SpaceShareMode) => planSpaceShare(source.local, record, { mode, signedIn });
    const plan = planOf(record?.mode ?? "all");
    const running = live.running !== null;
    const needsKeep = needsKeepOf(record, signedIn);
    const gone = record?.job?.gone === true;
    // A space that is up and waits for Keep shows as the result, with Keep this space; one that is gone has no link.
    const phase: SpaceShareStatus["phase"] = running ? "sharing" : !record ? "none" : record.refused ? "refused" : gone ? "gone" : needsKeep && record.created && record.share_url ? "shared" : record.job ? (record.job.ended ?? "failed") : record.shared_at ? "shared" : "none";
    const progress = running && live.progress ? { done: live.progress.done, total: live.progress.total } : record?.job && phase !== "shared" && phase !== "gone" ? { done: record.job.done, total: record.job.total } : null;
    const until = running ? (live.progress?.waiting_until ?? null) : null;
    const link = phase === "gone" ? null : (record?.share_url ?? null);
    return {
      phase,
      progress,
      waiting: until !== null ? Math.max(1, Math.ceil((until - now()) / 1000)) : null,
      link,
      shared_once: !!record?.shared_at,
      kept: !!record?.kept && signedIn,
      // Said as the space is: only a space the space itself calls private is "only you"; one a write was refused by
      // has an owner, and its link still reads and comments.
      access: !record ? (signedIn ? "private" : "edit") : record.kept ? (record.visibility === "private" ? "private" : "comment") : record.job?.keep ? "comment" : record.created ? "edit" : signedIn || record.signed ? "private" : "edit",
      signed_in: signedIn,
      who: signedIn ? (credential.name ?? (record?.kept ? record.owner : null)) : null,
      keep: live.keep,
      busy: live.claiming !== null,
      needs_keep: needsKeep && !running,
      mode: record?.mode ?? "all",
      versions: Math.max(0, ...source.local.documents.map((d) => d.versions.length)),
      changes: phase === "shared" ? plan.changes : 0,
      // A page's address is the one the space returned for it; without one, the space's own link.
      stopped_pages: record ? source.local.documents.filter((d) => record.pages[d.id]?.stopped).map((d) => ({ title: d.title, url: record.pages[d.id]!.url ?? link })) : [],
      details: { all: planOf("all").details, newest: planOf("newest").details },
    };
  }

  /** Run the upload for a record already on disk. Never while a claim is going: it would write over what the claim keeps. */
  function start(id: string, record: SpaceShareRecord): void {
    const live = liveOf(id);
    if (live.running || live.claiming) return;
    const source = spaceShareSource(options.store(), id);
    if (!source) return;
    const abort = new AbortController();
    live.abort = abort;
    live.source = source;
    live.progress = { done: record.job?.done ?? 0, total: record.job?.total ?? 0, waiting_until: null, link: record.share_url };
    live.running = runSpaceShare({
      source,
      record,
      save: (next) => saveSpaceShareRecord(options.dataDir, id, next),
      client: clientOf(record.host, abort.signal),
      signal: abort.signal,
      now: options.now,
      sleep: options.sleep,
      progress: (progress) => {
        live.progress = progress;
        options.changed?.(id);
      },
    })
      .then(
        (result) => {
          // The space refused the sign-in: it is forgotten, and the person is signed out here.
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
        live.source = null;
        live.memo = null;
        options.changed?.(id);
      });
  }

  function share(id: string, input: { mode?: SpaceShareMode; fresh?: boolean }): SpaceShareStatus | null {
    const live = liveOf(id);
    if (live.running || live.claiming) return status(id);
    const source = spaceShareSource(options.store(), id);
    if (!source) return null;
    let record = input.fresh ? null : readSpaceShareRecord(options.dataDir, id);
    if (record?.refused) return status(id);
    if (!record) {
      // Whether the space is the person's own is what the space answers, never assumed here.
      const host = options.host();
      // Started signed in: it is never made, or gone on with, without the sign-in (the person saw "Only you").
      record = newSpaceShareRecord({ host, space_id: newSpaceId(), name: source.local.name, mode: input.mode ?? "all", kept: false, signed: credentialOf(host) !== null, at: new Date(now()).toISOString() });
      saveSpaceShareRecord(options.dataDir, id, record);
    }
    // Waiting for Keep (the sign-in is gone, or a write was not allowed), or the space is gone: nothing is sent,
    // and no browser is opened by an Update. The panel's Keep signs in; Share as new starts over.
    if (needsKeepOf(record, credentialOf(record.host) !== null) || record.job?.gone) return status(id);
    start(id, record);
    return status(id);
  }

  function stop(id: string): SpaceShareStatus | null {
    liveOf(id).abort?.abort("stop");
    return status(id);
  }

  /** Signed in: make the space the person's own when it is up and not theirs yet. */
  async function claim(id: string): Promise<void> {
    const live = liveOf(id);
    // A run going without the sign-in (waiting on a busy space, say) is stopped first: it goes on signed in.
    if (live.running) {
      live.abort?.abort("stop");
      await live.running;
    }
    const record = readSpaceShareRecord(options.dataDir, id);
    if (!record || !record.created || record.refused) return;
    try {
      // Claiming a space that is already the person's own answers the same again. This call alone says whose it is.
      const space = await clientOf(record.host).claim(record.space_id);
      record.kept = true;
      if (record.job?.keep) record.job = { done: record.job.done, total: record.job.total, ended: record.job.ended };
      record.owner = space.owner_name ?? record.owner;
      record.share_url = space.share_url ?? record.share_url;
      record.visibility = space.visibility ?? record.visibility ?? null;
    } catch (error) {
      if (spaceKeptByAnother(error)) record.refused = true;
      else {
        // The space refused the credential itself: it is forgotten. Anything else: nothing changed.
        if (spacesTokenRefused(error)) clearSpacesCredential(options.dataDir, record.host);
        return;
      }
    }
    saveSpaceShareRecord(options.dataDir, id, record);
  }

  /** One claim per plan at a time (a second Keep joins the first), then what waits is sent. */
  async function claimAndGoOn(id: string): Promise<void> {
    const live = liveOf(id);
    if (live.claiming) return live.claiming;
    const mine = claim(id);
    live.claiming = mine;
    try {
      await mine;
    } finally {
      live.claiming = null;
      live.memo = null;
    }
    const record = readSpaceShareRecord(options.dataDir, id);
    if (!record || record.refused || !credentialOf(record.host)) return;
    const source = spaceShareSource(options.store(), id);
    // What waits: a run that did not finish, or the approval, which goes only into a kept space.
    if (source && (record.job || planSpaceShare(source.local, record, { mode: record.mode, signedIn: true }).steps.length > 0)) start(id, record);
  }

  async function keep(id: string): Promise<SpaceShareStatus | null> {
    const live = liveOf(id);
    const record = readSpaceShareRecord(options.dataDir, id);
    const host = record?.host ?? options.host();
    if (status(id) === null) return null;
    if (live.claiming) return status(id);
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
    if (!record || !record.kept || !credentialOf(record.host) || live.running || live.claiming) return { ok: false, status: status(id) };
    try {
      if (record.created) await clientOf(record.host).deleteSpace(record.space_id);
    } catch (error) {
      // Already gone there is gone here too.
      if (!(error instanceof SpacesError && error.status === 404 && error.code === "workspace_not_found")) return { ok: false, status: status(id) };
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
    claiming: (id) => lives.get(id)?.claiming ?? null,
    close() {
      for (const live of lives.values()) {
        // Not the person's Stop: the record is left as a run not finished, which the next Try again goes on from.
        live.abort?.abort(SPACE_SHARE_SHUTDOWN);
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

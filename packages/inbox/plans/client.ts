/**
 * Plans' routes as the window reads them (packages/shared/plans/routes.ts, mounted by the Inbox only while
 * config.json `inboxPlans` is on; docs/agent-guides/inbox-plans.md). This computer's own: Plans is not on any door
 * route, so a phone's door or a linked machine gets the unknown-route 404. Every write (a look, a comment kept or
 * taken away) carries the page's `serverSession`.
 */
import type { PlanApprovalCleared, PlanApprovalMoved, PlanArtifact, PlanComment, PlanDecision, PlanDocument, PlanEvent, PlanFaceText, PlanLook, PlanRecord, PlanSummary, PlanVersion, SpacesView } from '@plannotator/core/plans';
import type { SpaceShareMode, SpaceShareStatus } from '@plannotator/core/space-share';
import { pageServerSession } from '../api';
import { readJson } from '../apiError';

declare module '../api' {
  interface SettingsModel {
    /** Plans (config.json `inboxPlans`, turned on by `plannotator plans`): present only while on. */
    plans?: { on: boolean; /** Share this space is on too (config.json `inboxSpaceShare`). */ share?: boolean };
  }
}

export interface PlansList {
  plans: PlanSummary[];
  /** The import is bringing in plan history: ask again shortly. */
  importing: boolean;
  /** The Inbox's last read of the plan history failed (its message); absent from an Inbox before this answer. */
  import_error?: string | null;
  /** The person's pinned plans, in their order; absent from an Inbox before Spaces. */
  pins?: string[];
  /** The Spaces home's view, the person's (config.json); absent from an Inbox before Spaces. */
  view?: SpacesView;
}

export interface PlanRead {
  plan: PlanRecord;
  documents: PlanDocument[];
  /** The plan's other files; absent from an Inbox before artifacts were read. */
  artifacts?: PlanArtifact[];
  decisions: PlanDecision[];
  events: PlanEvent[];
  /** What the person had seen before this visit; null before the first look. */
  look: PlanLook | null;
  /** The person's comments still kept; absent from an Inbox before plan comments. */
  comments?: PlanComment[];
}

export interface PlanDiffSide {
  version_number: number;
  version: string;
  committed_at: string;
  text: string;
}

export interface PlanDiffTexts {
  document_id: string;
  seen: number | null;
  from: PlanDiffSide | null;
  to: PlanDiffSide | null;
}

const BASE = '/api/plans';
const docQuery = (doc: string | null, lead: '?' | '&') => (doc ? `${lead}doc=${encodeURIComponent(doc)}` : '');
const one = (id: string, rest = '') => `${BASE}/${encodeURIComponent(id)}${rest}`;

async function get<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' }));
}

/** A write: JSON with the page's server session (the Inbox refuses another page's). */
async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const session = pageServerSession();
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(session ? { ...body, serverSession: session } : body),
  });
  return readJson<T>(response);
}

async function text(path: string): Promise<string> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) await readJson(response);
  return response.text();
}

/**
 * The list. `retry`: the list's Try again, so the Inbox reads the plan history now, whatever its wait after a failure.
 * `poll`: the home's every-5-s read (the Inbox picks up plan history less often for it). `etag`: the last answer's
 * tag: an unchanged list answers 304, here null (nothing to draw again).
 */
async function list(retry = false, options: { poll?: boolean; etag?: string | null } = {}): Promise<{ list: PlansList; etag: string | null } | null> {
  const query = retry ? '?retry=1' : options.poll ? '?poll=1' : '';
  const response = await fetch(`${BASE}${query}`, { headers: { Accept: 'application/json', ...(options.etag ? { 'If-None-Match': options.etag } : {}) }, cache: 'no-store' });
  if (response.status === 304) return null;
  return { list: await readJson<PlansList>(response), etag: response.headers.get('ETag') };
}

export const plansApi = {
  list,
  read: (id: string) => get<PlanRead>(one(id)),
  /** A document's versions (`doc` null: the primary one). */
  versions: (id: string, doc: string | null = null) => get<{ document_id: string; versions: PlanVersion[] }>(one(id, `/versions${docQuery(doc, '?')}`)),
  /** One version's text, as saved. */
  version: (id: string, n: number, doc: string | null = null) => text(one(id, `/versions/${n}${docQuery(doc, '?')}`)),
  /** The top of the main page's version `n`, as its face on the Spaces home draws it (null text: too big to draw). */
  face: (id: string, n: number) => get<PlanFaceText>(one(id, `/versions/${n}?face=1`)),
  /** Where one version's bytes are (its Download). */
  versionUrl: (id: string, n: number, doc: string | null = null) => one(id, `/versions/${n}${docQuery(doc, '?')}`),
  /** Keep the person's comment on version `n` of a document (`doc` null: the primary one), new or edited. */
  saveComment: (id: string, n: number, annotation: object, doc: string | null = null) => post<{ comment: PlanComment }>(one(id, '/comments'), doc ? { doc, version: n, annotation } : { version: n, annotation }),
  /** Take a comment away, by its annotation's id. */
  removeComment: (id: string, annotationId: string) => post<{ comment: PlanComment }>(one(id, `/comments/${encodeURIComponent(annotationId)}/remove`), {}),
  diff: (id: string, from: number, to: number, doc: string | null = null) => get<PlanDiffTexts>(one(id, `/diff?from=${from}&to=${to}${docQuery(doc, '&')}`)),
  /** Where an artifact's bytes are (a raster picture as itself; other text as plain text). */
  fileUrl: (id: string, assetPath: string) => one(id, `/files/${assetPath.split('/').map(encodeURIComponent).join('/')}`),
  /** An artifact's bytes as text (an HTML page, an SVG). */
  fileText: (id: string, assetPath: string) => text(one(id, `/files/${assetPath.split('/').map(encodeURIComponent).join('/')}`)),
  /** The person read version `seen` of a document (`doc` null: the primary one). */
  look: (id: string, seen: number, doc: string | null = null) => post<{ look: PlanLook }>(one(id, '/look'), doc ? { doc, seen } : { seen }),
  /**
   * A new newest version the person made from version `base`: their edit (`text`) or a Restore (`restore`). Refused
   * (409, `moved_on` with the newest as `head`) when a newer version came, or (`unchanged`) when nothing changed.
   */
  saveVersion: (id: string, base: number, change: { text: string } | { restore: number }, doc: string | null = null) => post<PlanVersionSaved>(one(id, '/versions'), { ...(doc ? { doc } : {}), base, ...change }),
  /** Approve the version on screen; refused (409, `moved_on`) when a newer one came. */
  approve: (id: string, version: number, doc: string | null = null) => post<{ decision: PlanDecision }>(one(id, '/approve'), doc ? { doc, version } : { version }),
  /** Share this space (packages/shared/spaces/share-job.ts): where the plan's share stands. */
  share: (id: string) => get<SpaceShareStatus>(one(id, '/share')),
  /** Share, update or try again; `fresh`: as a new space. The upload runs on in the Inbox. */
  shareStart: (id: string, input: { mode?: SpaceShareMode; fresh?: boolean } = {}) => post<SpaceShareStatus>(one(id, '/share'), input),
  shareStop: (id: string) => post<SpaceShareStatus>(one(id, '/share/stop'), {}),
  /** Keep this space: the browser opens for the sign-in. */
  shareKeep: (id: string) => post<SpaceShareStatus>(one(id, '/share/keep'), {}),
  shareKeepCancel: (id: string) => post<SpaceShareStatus>(one(id, '/share/keep/cancel'), {}),
  /** Stop sharing: delete the copy in Spaces. */
  shareDelete: (id: string) => post<SpaceShareStatus>(one(id, '/share/delete'), {}),
  /** Pin a plan (at `index`, else last), move it, or unpin it: the order after. */
  pin: (id: string, pinned: boolean, index: number | null = null) => post<{ pins: string[] }>(`${BASE}/pins`, index === null ? { id, pinned } : { id, pinned, index }),
  /** Keep the Spaces home's view for the person (config.json). */
  saveView: (view: SpacesView) => post<{ view: SpacesView }>(`${BASE}/view`, { view }),
  /**
   * A Send went out (`thread_id`, the message that carried it; null: held for another machine, whose thread is not
   * known here): its comments are sent, the plan has that thread, and `told` is the version a Direct Edits section carried.
   */
  sent: (id: string, sent: { thread_id: string | null; message_id: string; to: { host: string; session: string } | null; comments: string[]; told?: { doc: string; version: number } | null }) => post<{ plan: PlanRecord; comments: PlanComment[] }>(one(id, '/sent'), sent),
};

export interface PlanVersionSaved {
  version: PlanVersion;
  /** Plan review's "# Direct Edits" section: the unified diff from the newest version the agent knows to this one. */
  direct_edits: string;
  /** The version that diff starts from. */
  told_from: number;
  cleared: PlanApprovalCleared | null;
  moved: PlanApprovalMoved | null;
}

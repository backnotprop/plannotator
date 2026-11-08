/**
 * Plannotator Inbox: guided reviews from agents (PLAN step 5; owner Q6: code
 * diffs only, in Plannotator's portable format as it is).
 *
 *   get_guide_brief  the authoring brief: Plannotator's method, the guide's
 *                    JSON shape, how to read the diff, the rules and a worked
 *                    example call (the shape Workspaces' tool of that name
 *                    gives agents).
 *   submit_guide     a guide plus the patch it describes, or a complete
 *                    snapshot. Validated by Plannotator's own checks: the
 *                    snapshot parser (`parseGuideSnapshot`) and the strict
 *                    placement checks of `buildAuthoredGuideSnapshot`
 *                    (packages/server/guide/guide-cli.ts), called, never
 *                    re-implemented: a file not in the patch, or placed twice,
 *                    is refused by name. The snapshot is stored as a blob
 *                    (`inbox/blobs/<sha256>`) and the message carries a
 *                    `guide` record; the window opens it in Plannotator's
 *                    guide viewer.
 *
 * No size bound beyond what the snapshot parser enforces (owner, 2026-10-06).
 * The diff is the one the agent sent, never re-read from a working tree
 * (adr/decisions/007-portable-guided-reviews-20260815.md).
 */

import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { parseDiffToFiles, patchBlobIds, type DiffFile, type PatchBlobIds } from "@plannotator/core/diff-files";
import { forgeRefKey, parseForgeRefUrl } from "@plannotator/core/forge-ref-card";
import { GUIDE_REVIEW_PROMPT, GUIDE_SCHEMA_JSON } from "@plannotator/core/guide-prompt";
import {
  GUIDE_SNAPSHOT_DRAWN_VERSION,
  GUIDE_SNAPSHOT_OVERVIEW_VERSION,
  GUIDE_SNAPSHOT_VERSION,
  guideDiagramIsDrawn,
  parseGuideSnapshot,
  parseGuideSnapshotJson,
  type GuideSnapshot,
} from "@plannotator/core/guide-format";
import type { GuideOverviewDiagram } from "@plannotator/core/guide";
import { displayInboxSubject, inboxReviewSourceOf, type InboxFileContents, type InboxGuideRef } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { readFileSync } from "node:fs";
import { checkInboxDrawing, INBOX_REVIEW_FIELD_DESCRIPTION, INBOX_REVIEW_OVERVIEW_DIAGRAM_DOC, inboxReviewTitleLine } from "@plannotator/core/inbox-review";
import { inboxBlobPath, writeBlob } from "@plannotator/shared/inbox/attachments";
import { questionOpenersWithTextText } from "@plannotator/shared/inbox/question-openers";
import { questionsToCheckText } from "@plannotator/shared/inbox/questions-to-check";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { readDiffSideBytes, readGitObjectBytes } from "@plannotator/shared/review-core";
import { runtime as gitRuntime } from "./git";
import { gitBlobId, INBOX_PULL_FILE_MAX_BYTES, textOfBytes } from "./inbox-pulls";
import { buildAuthoredGuideSnapshot } from "./guide/guide-cli";
import { SEND_ROUTING_FIELDS, replyNextStepText, senderWakes, guarded, imagesNotShownText, noStakesText, recommendedInLabelText,
  callerWorkingFolder, namingLine, ok, sendAgentMessage, sendProject, type InboxMcpContext } from "./inbox-mcp";

/** How to read the diff to send as `patch` (Workspaces' local-diff steps, for this machine). */
export const GUIDE_DIFF_STEPS =
  "In the project folder: find the base with `git merge-base <base branch> HEAD` and read the diff with `git diff <merge-base>` (it includes uncommitted edits; `git add -N <path>` first puts a new untracked file in it). Send that exact diff as `patch`. The Inbox keeps the diff as sent and never reads your working tree again.";

export const GUIDE_RULES = [
  "Every `diffs[].file` is a path from the patch, copied exactly.",
  "A file belongs to one section: never place it twice.",
  "Files you leave out show in a trailing \"Everything else\" chapter; list them in `unplacedFiles`.",
  "Code diffs only: `patch` is unified diff output (`git diff`).",
  "Instead of `guide` and `patch`, `snapshot` takes a complete Plannotator guide snapshot (`kind: \"plannotator-guided-review\"`, the JSON inside an exported guide); the same checks apply.",
];

/**
 * The brief's worked example: the AUTHORED fixture of guide-cli.test.ts (the
 * `guided-review` skill's worked example) and its two-file patch, as one
 * submit_guide call. The browser proof submits exactly this.
 */
export const GUIDE_BRIEF_EXAMPLE = {
  body: "I wrote a guided review of the token refresh change.",
  guide: {
    title: "Token refresh",
    intent: "Refresh tokens before they expire.",
    sections: [{ title: "The guard", overview: "Where the refresh happens.", diffs: [{ file: "src/auth.ts", summary: "Adds the refresh guard." }] }],
    review: { gitRef: "origin/main...HEAD", base: "origin/main" },
    generator: { engine: "claude-code", model: "claude-opus-5" },
  },
  patch:
    "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n" +
    "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{ }\n",
};

export const GET_GUIDE_BRIEF_DESCRIPTION =
  "Get what you need to write a guided review of a code change for the person: Plannotator's method, the JSON shape of the guide, how to read the diff, the rules, and a worked submit_guide call. Read the diff in your checkout, write the guide on your own model, then call submit_guide with the guide and that exact patch.";

export const SUBMIT_GUIDE_DESCRIPTION =
  "Send the person a guided review of a code change. It lands in the Plannotator Inbox as a message with a \"Guided review\" card that opens in Plannotator's guide viewer. Pass `guide` (the shape get_guide_brief gives) and `patch` (the exact unified diff it describes), or `snapshot` (a complete Plannotator guide snapshot). Every file a section names must be in the patch, in one section only; a refusal names the file. Files you leave out show under \"Everything else\". `body` is your note above the card (default: the guide's intent). thread, reply_to, supersedes, done and idempotency_key work as in send_message, and the person's answer comes back the same way.\n\nExample: get_guide_brief's `example` is a call that works as it is.";

export type InboxGuideCheck = { ok: true; snapshot: GuideSnapshot } | { ok: false; error: string };

/** The snapshot versions read while Code review is off: the release before Show me's. */
const OFF_SNAPSHOT_VERSIONS = [GUIDE_SNAPSHOT_VERSION, GUIDE_SNAPSHOT_OVERVIEW_VERSION] as const;

/**
 * A guide as an agent sent it, checked by Plannotator's own code. `cwd` is the
 * project root, where `buildAuthoredGuideSnapshot` reads provenance (origin,
 * branch, head) for a guide that does not name its `source`.
 */
export function checkInboxGuide(input: { snapshot?: unknown; guide?: unknown; patch?: string }, cwd: string, options: { codeReview?: boolean } = {}): InboxGuideCheck {
  const hasSnapshot = input.snapshot !== undefined;
  if (hasSnapshot === (input.guide !== undefined || input.patch !== undefined)) {
    return { ok: false, error: "Send either `snapshot`, or `guide` with `patch`." };
  }
  if (hasSnapshot) {
    // A drawn overview picture (format version 3) is code review's: off, the parse reads versions 1 and 2 only,
    // and a version 3 is refused in the release-before-Show-me's own words ("Unsupported snapshot version: 3").
    const parseOptions = options.codeReview ? {} : { versions: OFF_SNAPSHOT_VERSIONS };
    const parsed = typeof input.snapshot === "string" ? parseGuideSnapshotJson(input.snapshot, parseOptions) : parseGuideSnapshot(input.snapshot, parseOptions);
    if (!parsed.ok) return { ok: false, error: `Invalid guide snapshot (${parsed.error.path}): ${parsed.error.message}` };
    const snapshot = parsed.value;
    // A drawn picture (version 3, read only while Code review is on): Shape's rules and the patch's files. A version-2
    // document is taken as it always was; the review pane draws its html picture only if it keeps Shape's rules.
    const drawnProblem = overviewDiagramProblem(snapshot.guide.overview?.diagram, snapshot.review.rawPatch);
    if (drawnProblem) return { ok: false, error: drawnProblem };
    // The strict placement checks, on the snapshot's own guide and patch. The
    // snapshot format lets a file reference omit its summary (a shipped
    // fixture does); the authored form wants a string, so an absent one is "".
    const { reviewed: _reviewed, ...content } = snapshot.guide;
    const strict = buildAuthoredGuideSnapshot(
      JSON.stringify({
        ...content,
        sections: content.sections.map((section) => ({ ...section, diffs: section.diffs.map((ref) => ({ file: ref.file, summary: ref.summary ?? "" })) })),
      }),
      snapshot.review.rawPatch,
      { cwd, source: snapshot.source, now: snapshot.exportedAt },
    );
    return strict.ok ? { ok: true, snapshot } : { ok: false, error: strict.error };
  }
  if (input.guide === undefined || typeof input.patch !== "string") return { ok: false, error: "`guide` and `patch` go together." };
  const built = buildAuthoredGuideSnapshot(typeof input.guide === "string" ? input.guide : JSON.stringify(input.guide), input.patch, { cwd });
  if (!built.ok) return { ok: false, error: built.error };
  // The overview (and its drawing) rides an authored guide only while Code review is on; off, it is left out as always.
  if (!options.codeReview) return { ok: true, snapshot: built.snapshot };
  let raw: unknown = input.guide;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const overview = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).overview : undefined;
  if (overview === undefined) return { ok: true, snapshot: built.snapshot };
  return withAuthoredOverview(built.snapshot, overview);
}

/** What is wrong with an overview's drawn (version-3) diagram, by Shape's rules and the patch's files, or null. */
function overviewDiagramProblem(diagram: GuideOverviewDiagram | undefined, rawPatch: string): string | null {
  if (!diagram || diagram.kind !== "html" || !guideDiagramIsDrawn(diagram)) return null;
  const files = parseDiffToFiles(rawPatch).map((file) => file.path);
  const checked = checkInboxDrawing(diagram, files, { withTitle: false });
  return checked.ok ? null : `overview.diagram has problems:\n${checked.problems.map((p) => `  - ${p}`).join("\n")}`;
}

/**
 * An authored guide's `overview: { text, diagram? }` (code review in the
 * Inbox), on the snapshot buildAuthoredGuideSnapshot built: version 2, or 3
 * for a drawn picture (`css`, `width` and `height`, `tall`), then parsed again
 * by the snapshot's own strict parser.
 */
function withAuthoredOverview(snapshot: GuideSnapshot, overview: unknown): InboxGuideCheck {
  const bad = (error: string): InboxGuideCheck => ({ ok: false, error: `overview: ${error}` });
  if (!overview || typeof overview !== "object" || Array.isArray(overview)) return bad("must be { text, diagram? }.");
  const o = overview as Record<string, unknown>;
  for (const key of Object.keys(o)) if (key !== "text" && key !== "diagram") return bad(`${key} is not a field (text, diagram).`);
  if (typeof o.text !== "string" || !o.text.trim()) return bad("text must be a few sentences of markdown.");
  let diagram: GuideOverviewDiagram | undefined;
  if (o.diagram !== undefined) {
    const d = o.diagram as Record<string, unknown>;
    if (!d || typeof d !== "object" || Array.isArray(d)) return bad('diagram must be { "kind": "html", "source", … } or { "kind": "mermaid", "source" }.');
    if (d.kind === "mermaid") {
      for (const key of Object.keys(d)) if (key !== "kind" && key !== "source") return bad(`diagram.${key}: a mermaid diagram is { kind, source }.`);
      if (typeof d.source !== "string" || !d.source.trim()) return bad("diagram.source is empty.");
      diagram = { kind: "mermaid", source: d.source };
    } else {
      const files = parseDiffToFiles(snapshot.review.rawPatch).map((file) => file.path);
      const checked = checkInboxDrawing(d, files, { withTitle: false });
      if (!checked.ok) return { ok: false, error: `overview.diagram has problems:\n${checked.problems.map((p) => `  - ${p}`).join("\n")}` };
      const v = checked.view;
      diagram = {
        kind: "html",
        source: v.html,
        ...(v.css !== undefined && { css: v.css }),
        ...(v.width !== undefined && v.height !== undefined && { width: v.width, height: v.height }),
        ...(v.tall && { tall: { source: v.tall.html, ...(v.tall.css !== undefined && { css: v.tall.css }) } }),
      };
    }
  }
  const { title, intent, overview: _old, sections, unplacedFiles, reviewed } = snapshot.guide;
  const next = {
    ...snapshot,
    version: guideDiagramIsDrawn(diagram) ? GUIDE_SNAPSHOT_DRAWN_VERSION : GUIDE_SNAPSHOT_OVERVIEW_VERSION,
    guide: { title, intent, overview: { text: o.text, ...(diagram && { diagram }) }, sections, ...(unplacedFiles !== undefined && { unplacedFiles }), reviewed },
  };
  const parsed = parseGuideSnapshot(next);
  return parsed.ok ? { ok: true, snapshot: parsed.value } : { ok: false, error: `Invalid overview (${parsed.error.path}): ${parsed.error.message}` };
}

/**
 * The hash of what the agent sent, as given: the snapshot, or the guide and
 * the patch. A retry is the same input; the built snapshot is not, because
 * `buildAuthoredGuideSnapshot` stamps the time it ran.
 */
export function inboxGuideInputHash(input: { snapshot?: unknown; guide?: unknown; patch?: string }): string {
  const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null));
  const sent = input.snapshot !== undefined ? ["snapshot", text(input.snapshot)] : ["guide", text(input.guide), input.patch ?? ""];
  return createHash("sha256").update(sent.join("\0")).digest("hex");
}

/**
 * A checked snapshot as it will be stored (`text`, the blob) and the record the message carries. `review`: the agent
 * asked for a verdict (submit_guide `review: true` while Code review is on); the record then carries `review` and the
 * chapter titles the review card lists.
 */
export function describeInboxGuide(snapshot: GuideSnapshot, inputSha256: string, review = false): { text: string; ref: InboxGuideRef } {
  const text = JSON.stringify(snapshot);
  const files = parseDiffToFiles(snapshot.review.rawPatch);
  const ref: InboxGuideRef = {
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    input_sha256: inputSha256,
    bytes: Buffer.byteLength(text, "utf8"),
    title: snapshot.guide.title,
    sections: snapshot.guide.sections.length,
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    ...(review ? { review: true as const, chapters: snapshot.guide.sections.map((section) => inboxReviewTitleLine(section.title)) } : {}),
  };
  // Reviews (approval "inbox-reviews-page") lists a review by where its changes came from.
  const source = review ? inboxReviewSourceOf(snapshot) : null;
  if (source) ref.source = source;
  return { text, ref };
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** A snapshot's patch is read once per guide, not once per file the page asks for. */
const guidePatchFiles = new Map<string, DiffFile[]>();

function patchFilesOf(store: InboxStore, sha256: string): DiffFile[] {
  const hit = guidePatchFiles.get(sha256);
  if (hit) return hit;
  let files: DiffFile[] = [];
  try {
    const parsed = parseGuideSnapshotJson(readFileSync(inboxBlobPath(store.dir, sha256), "utf8"));
    if (parsed.ok) files = parseDiffToFiles(parsed.value.review.rawPatch);
  } catch {
    // Gone from the store: no file to read.
  }
  guidePatchFiles.set(sha256, files);
  while (guidePatchFiles.size > 8) guidePatchFiles.delete(guidePatchFiles.keys().next().value!);
  return files;
}

/**
 * One changed file's whole text for a guided review's expand arrows
 * (`GET /api/inbox/messages/:id/guide/file`). The guide keeps the diff as sent
 * and the working tree moves on, so each side is taken only when it is the very
 * file the patch's `index` line names:
 *  - the project's git for either side, by that blob id;
 *  - the working tree for the new side (a diff of uncommitted edits names a blob
 *    git never stored), when its bytes hash to that id;
 *  - `forge`, a guide of a pull request whose commits this clone never fetched,
 *    held to the same ids.
 * Both null otherwise, and for a path the patch does not change, a renamed,
 * added or deleted file, a binary or too large one: no arrows.
 */
export async function inboxGuideFileContents(
  store: InboxStore,
  sha256: string,
  path: string,
  root: string | null,
  forge?: (ids: PatchBlobIds, oldPath: string | undefined) => Promise<InboxFileContents> | null,
): Promise<InboxFileContents> {
  const none: InboxFileContents = { oldContent: null, newContent: null };
  const file = patchFilesOf(store, sha256).find((f) => f.path === path);
  if (!file) return none;
  const ids = patchBlobIds(file.patch);
  if (!ids) return none;
  const { oldId, newId } = ids;
  const stored = async (id: string): Promise<Uint8Array | null> => {
    if (!root) return null;
    const read = await readGitObjectBytes(gitRuntime, id, INBOX_PULL_FILE_MAX_BYTES, root);
    return read.kind === "ok" ? read.bytes : null;
  };
  const inTree = async (): Promise<Uint8Array | null> => {
    if (!root) return null;
    const read = await readDiffSideBytes(gitRuntime, { kind: "worktree", path }, INBOX_PULL_FILE_MAX_BYTES, root);
    return read.kind === "ok" && gitBlobId(read.bytes).startsWith(newId) ? read.bytes : null;
  };
  const oldBytes = await stored(oldId);
  const newBytes = oldBytes ? ((await stored(newId)) ?? (await inTree())) : null;
  if (oldBytes && newBytes) {
    const oldContent = textOfBytes(oldBytes);
    const newContent = textOfBytes(newBytes);
    return oldContent !== null && newContent !== null ? { oldContent, newContent } : none;
  }
  // The forge's reader checks both texts against these ids.
  return (await forge?.(ids, file.oldPath)) ?? none;
}

/** The key the Pull requests list would give the pull request a guide is of, or null. */
export function guidePullKey(store: InboxStore, sha256: string): string | null {
  try {
    const parsed = parseGuideSnapshotJson(readFileSync(inboxBlobPath(store.dir, sha256), "utf8"));
    const url = parsed.ok ? parsed.value.source.pr?.url : undefined;
    const ref = url ? parseForgeRefUrl(url) : null;
    return ref && ref.kind === "pull" ? forgeRefKey(ref) : null;
  } catch {
    return null;
  }
}

/**
 * The window's guide routes, null when the path is neither:
 *  - `GET /api/inbox/messages/:id/guide`: the snapshot a message carries, for
 *    the guide viewer. Served only by message, never a blob by hash.
 *  - `POST /api/inbox/messages/:id/guide/reviewed` `{ serverSession?, reviewed }`:
 *    the person's reviewed ticks, kept on the message (the record's 4.2). The
 *    server has already run the same-origin check on every POST; the stale-tab
 *    `serverSession` check runs here, as on the other writing routes.
 */
/**
 * A review message's guide snapshot as stored (code review in the Inbox: Show
 * me checks a drawing's files against it), or null when the message carries
 * no review or its snapshot is gone.
 */
export function readInboxReviewSnapshot(store: InboxStore, messageId: string): GuideSnapshot | null {
  const message = store.message(messageId);
  if (!message?.guide?.review) return null;
  try {
    const parsed = parseGuideSnapshotJson(readFileSync(inboxBlobPath(store.dir, message.guide.sha256), "utf8"));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

export async function inboxGuideRoute(
  req: Request,
  path: string,
  store: InboxStore,
  serverSession: string,
  codeReviewOn: () => boolean = () => false,
): Promise<Response | null> {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
  // The files the person ticked Viewed in a review (code review in the Inbox): only while Code review is on.
  const viewedMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/guide\/viewed$/.exec(path);
  if (viewedMatch) {
    if (req.method !== "POST") return answer({ error: "Use POST." }, 405);
    if (!codeReviewOn()) return answer({ error: "Code review is off in this Inbox (Settings → Capabilities).", code: "code_review_off" }, 409);
    let body: Record<string, unknown>;
    try {
      const value = await req.json();
      body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      return answer({ error: "body: expected a JSON object.", code: "validation_error" }, 422);
    }
    if (checkServerSession(body, serverSession) === "mismatch") return answer(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    const message = store.message(viewedMatch[1]!);
    let files: string[] = [];
    if (message?.guide?.review) {
      try {
        const snapshot = parseGuideSnapshotJson(readFileSync(inboxBlobPath(store.dir, message.guide.sha256), "utf8"));
        if (snapshot.ok) files = parseDiffToFiles(snapshot.value.review.rawPatch).map((file) => file.path);
      } catch {
        // Gone from the store: no file can be ticked.
      }
    }
    try {
      return answer({ message_id: viewedMatch[1], viewed: store.saveGuideViewed(viewedMatch[1]!, body.viewed, files) });
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      const status = error.code === "validation_error" ? 422 : 404;
      return answer({ error: error.message, code: error.code, ...error.details }, status);
    }
  }
  const reviewedMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/guide\/reviewed$/.exec(path);
  if (reviewedMatch) {
    if (req.method !== "POST") return answer({ error: "Use POST." }, 405);
    let body: Record<string, unknown>;
    try {
      const value = await req.json();
      body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      return answer({ error: "body: expected a JSON object.", code: "validation_error" }, 422);
    }
    if (checkServerSession(body, serverSession) === "mismatch") return answer(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    try {
      return answer({ message_id: reviewedMatch[1], reviewed: store.saveGuideReviewed(reviewedMatch[1]!, body.reviewed) });
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      const status = error.code === "validation_error" ? 422 : 404;
      return answer({ error: error.message, code: error.code, ...error.details }, status);
    }
  }
  const match = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/guide$/.exec(path);
  if (!match) return null;
  if (req.method !== "GET") return answer({ error: "Use GET." }, 405);
  const message = store.message(match[1]!);
  if (!message) return answer({ error: "No such message.", code: "message_not_found" }, 404);
  if (!message.guide) return answer({ error: "This message carries no guided review.", code: "guide_not_found" }, 404);
  let text: string | null = null;
  try {
    text = readFileSync(inboxBlobPath(store.dir, message.guide.sha256), "utf8");
  } catch {
    // Gone from the store (or not a blob hash): answered as missing below.
  }
  if (text === null) return answer({ error: "The guided review is missing from the store.", code: "guide_not_found" }, 404);
  return new Response(`{"message_id":${JSON.stringify(message.id)},"guide":${JSON.stringify(message.guide)},"snapshot":${text}}`, { headers: JSON_HEADERS });
}

/**
 * get_guide_brief's output_schema while Code review is on: the guide's, plus
 * an optional `overview: { text, diagram? }` (a drawing: `kind: "html"` with
 * source, css, width and height, tall; or `kind: "mermaid"` with source).
 */
function guideSchemaWithOverview(): Record<string, unknown> {
  const schema = JSON.parse(GUIDE_SCHEMA_JSON) as { properties: Record<string, unknown> } & Record<string, unknown>;
  const drawnSide = { type: "object", properties: { source: { type: "string" }, css: { type: "string" } }, required: ["source"], additionalProperties: false };
  schema.properties.overview = {
    type: "object",
    properties: {
      text: { type: "string" },
      diagram: {
        type: "object",
        properties: {
          kind: { enum: ["html", "mermaid"] },
          source: { type: "string" },
          css: { type: "string" },
          width: { type: "integer", minimum: 200, maximum: 4000 },
          height: { type: "integer", minimum: 200, maximum: 4000 },
          tall: drawnSide,
        },
        required: ["kind", "source"],
        additionalProperties: false,
      },
    },
    required: ["text"],
    additionalProperties: false,
  };
  return schema;
}

/** get_guide_brief and submit_guide, on the Inbox's MCP server. */
export function registerInboxGuideTools(server: McpServer, context: InboxMcpContext): void {
  server.registerTool(
    "get_guide_brief",
    {
      title: "Get the method for a guided review",
      description: GET_GUIDE_BRIEF_DESCRIPTION,
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      ok("The guided-review method, the guide's shape, how to read the diff, the rules and a worked submit_guide call.", {
        methodology: GUIDE_REVIEW_PROMPT,
        output_schema: context.codeReviewOn?.() ? guideSchemaWithOverview() : (JSON.parse(GUIDE_SCHEMA_JSON) as Record<string, unknown>),
        diff_steps: GUIDE_DIFF_STEPS,
        // Code review on (approval "shape-in-code-review", AGENT-TEXT §4, approved): the overview and its one drawing. Off: as before, byte for byte.
        rules: context.codeReviewOn?.() ? [...GUIDE_RULES, INBOX_REVIEW_OVERVIEW_DIAGRAM_DOC] : GUIDE_RULES,
        example: GUIDE_BRIEF_EXAMPLE,
      }),
  );

  server.registerTool(
    "submit_guide",
    {
      title: "Send the person a guided review",
      description: SUBMIT_GUIDE_DESCRIPTION,
      inputSchema: z
        .object({
          guide: z
            .union([z.record(z.string(), z.unknown()), z.string()])
            .optional()
            .describe("The guide: { title, intent, sections: [{ title, overview, diffs: [{ file, summary }] }], unplacedFiles?, review?: { gitRef, base }, source?, generator? } (get_guide_brief's output_schema), as an object or its JSON."),
          patch: z.string().optional().describe("The exact unified diff the guide describes (get_guide_brief's diff_steps)."),
          snapshot: z
            .union([z.record(z.string(), z.unknown()), z.string()])
            .optional()
            .describe("Instead of guide and patch: a complete Plannotator guide snapshot, as an object or its JSON."),
          body: z.string().optional().describe("Your note above the card, markdown. Default: the guide's intent."),
          // Code review (approval "inbox-code-review-direction"): listed only while the person has it on.
          ...(context.codeReviewOn?.() ? { review: z.boolean().optional().describe(INBOX_REVIEW_FIELD_DESCRIPTION) } : {}),
          ...SEND_ROUTING_FIELDS,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, ctx) =>
      guarded(async () => {
        const project = await sendProject(context, input);
        const checked = checkInboxGuide(input, project.root, { codeReview: context.codeReviewOn?.() ?? false });
        if (!checked.ok) throw new InboxError("invalid_guide", checked.error);
        // `review` exists only while Code review is on (the schema above); a session that listed it before the
        // switch went off is refused here rather than sending a review the window would not draw.
        const review = (input as { review?: boolean }).review === true;
        if (review && !context.codeReviewOn?.()) throw new InboxError("code_review_off", "Code review is off in this Inbox (Settings → Capabilities): send the guide without `review`.");
        const described = describeInboxGuide(checked.snapshot, inboxGuideInputHash(input), review);
        const body = input.body?.trim() ? input.body : checked.snapshot.guide.intent;
        // A reply never gets the default: its only subject is one the agent gives (it may name a thread the person started).
        // The default is made one line here (displayInboxSubject), so the guide's own title can never fail the subject check.
        const subject =
          input.subject ??
          (input.body?.trim() || input.reply_to ? undefined : (displayInboxSubject(`Guided review: ${described.ref.title}`) ?? undefined));
        const wakes = await senderWakes(context, ctx, input);
        const sent = await sendAgentMessage(context, project, { ...input, body, subject, working_folder: callerWorkingFolder(ctx) }, described.ref, wakes);
        // The blob is written once the message has landed, in the same turn (nothing can ask for it
        // in between); a refused send writes none, and a retry answers the first message's guide.
        if (!sent.replayed) writeBlob(context.store.dir, described.ref.sha256, Buffer.from(described.text, "utf8"));
        const guide = context.store.message(String(sent.structured.message_id))?.guide ?? described.ref;
        return ok(
          `${sent.replayed ? "Already sent" : "Sent"} the ${guide.review ? "review" : "guided review"} "${guide.title}" (${guide.sections} section${guide.sections === 1 ? "" : "s"}, ${guide.files} file${guide.files === 1 ? "" : "s"}) to the Plannotator Inbox (thread ${sent.structured.thread_id}, ${sent.structured.url}).${namingLine(sent.naming)} ${replyNextStepText(wakes, input.agent_host)}${imagesNotShownText(sent.imagesNotShown)}${noStakesText(sent.noStakes)}${recommendedInLabelText(sent.recommendedInLabel)}${questionsToCheckText(String(sent.structured.message_id), sent.questionsToCheck)}${questionOpenersWithTextText(sent.questionOpenersWithText)}`,
          { ...sent.structured, guide },
        );
      }),
  );
}

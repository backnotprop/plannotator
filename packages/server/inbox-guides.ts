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
import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { GUIDE_REVIEW_PROMPT, GUIDE_SCHEMA_JSON } from "@plannotator/core/guide-prompt";
import { parseGuideSnapshot, parseGuideSnapshotJson, type GuideSnapshot } from "@plannotator/core/guide-format";
import type { InboxGuideRef } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { readFileSync } from "node:fs";
import { inboxBlobPath, writeBlob } from "@plannotator/shared/inbox/attachments";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { buildAuthoredGuideSnapshot } from "./guide/guide-cli";
import { INBOX_REPLY_ARRIVES_TEXT, SEND_ROUTING_FIELDS, callerWakes, guarded, ok, sendAgentMessage, sendProject, type InboxMcpContext } from "./inbox-mcp";

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
 * `plannotator-guide` skill's worked example) and its two-file patch, as one
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
  "Send the person a guided review of a code change. It lands in the Plannotator Inbox as a message with a \"Guided review\" card that opens in Plannotator's guide viewer. Pass `guide` (the shape get_guide_brief gives) and `patch` (the exact unified diff it describes), or `snapshot` (a complete Plannotator guide snapshot). Every file a section names must be in the patch, in one section only; a refusal names the file. Files you leave out show under \"Everything else\". `body` is your note above the card (default: the guide's intent). thread, reply_to and idempotency_key work as in send_message; the person's answer comes back through wait_for_reply.\n\nExample: get_guide_brief's `example` is a call that works as it is.";

export type InboxGuideCheck = { ok: true; snapshot: GuideSnapshot } | { ok: false; error: string };

/**
 * A guide as an agent sent it, checked by Plannotator's own code. `cwd` is the
 * project root, where `buildAuthoredGuideSnapshot` reads provenance (origin,
 * branch, head) for a guide that does not name its `source`.
 */
export function checkInboxGuide(input: { snapshot?: unknown; guide?: unknown; patch?: string }, cwd: string): InboxGuideCheck {
  const hasSnapshot = input.snapshot !== undefined;
  if (hasSnapshot === (input.guide !== undefined || input.patch !== undefined)) {
    return { ok: false, error: "Send either `snapshot`, or `guide` with `patch`." };
  }
  if (hasSnapshot) {
    const parsed = typeof input.snapshot === "string" ? parseGuideSnapshotJson(input.snapshot) : parseGuideSnapshot(input.snapshot);
    if (!parsed.ok) return { ok: false, error: `Invalid guide snapshot (${parsed.error.path}): ${parsed.error.message}` };
    const snapshot = parsed.value;
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
  return built.ok ? { ok: true, snapshot: built.snapshot } : { ok: false, error: built.error };
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

/** A checked snapshot as it will be stored (`text`, the blob) and the record the message carries. */
export function describeInboxGuide(snapshot: GuideSnapshot, inputSha256: string): { text: string; ref: InboxGuideRef } {
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
  };
  return { text, ref };
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/**
 * The window's guide routes, null when the path is neither:
 *  - `GET /api/inbox/messages/:id/guide`: the snapshot a message carries, for
 *    the guide viewer. Served only by message, never a blob by hash.
 *  - `POST /api/inbox/messages/:id/guide/reviewed` `{ serverSession?, reviewed }`:
 *    the person's reviewed ticks, kept on the message (the record's 4.2). The
 *    server has already run the same-origin check on every POST; the stale-tab
 *    `serverSession` check runs here, as on the other writing routes.
 */
export async function inboxGuideRoute(req: Request, path: string, store: InboxStore, serverSession: string): Promise<Response | null> {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
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
        output_schema: JSON.parse(GUIDE_SCHEMA_JSON) as Record<string, unknown>,
        diff_steps: GUIDE_DIFF_STEPS,
        rules: GUIDE_RULES,
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
          ...SEND_ROUTING_FIELDS,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, ctx) =>
      guarded(async () => {
        const project = await sendProject(context, input);
        const checked = checkInboxGuide(input, project.root);
        if (!checked.ok) throw new InboxError("invalid_guide", checked.error);
        const described = describeInboxGuide(checked.snapshot, inboxGuideInputHash(input));
        const body = input.body?.trim() ? input.body : checked.snapshot.guide.intent;
        const subject = input.subject ?? (input.body?.trim() ? undefined : `Guided review: ${described.ref.title}`);
        const sent = sendAgentMessage(context, project, { ...input, body, subject }, described.ref);
        // The blob is written once the message has landed, in the same turn (nothing can ask for it
        // in between); a refused send writes none, and a retry answers the first message's guide.
        if (!sent.replayed) writeBlob(context.store.dir, described.ref.sha256, Buffer.from(described.text, "utf8"));
        const guide = context.store.message(String(sent.structured.message_id))?.guide ?? described.ref;
        return ok(
          `${sent.replayed ? "Already sent" : "Sent"} the guided review "${guide.title}" (${guide.sections} section${guide.sections === 1 ? "" : "s"}, ${guide.files} file${guide.files === 1 ? "" : "s"}) to the Plannotator Inbox (thread ${sent.structured.thread_id}, ${sent.structured.url}). ${callerWakes(ctx) ? INBOX_REPLY_ARRIVES_TEXT : "Call wait_for_reply with this thread_id for the person's answer."}`,
          { ...sent.structured, guide },
        );
      }),
  );
}

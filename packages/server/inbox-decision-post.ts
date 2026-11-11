/**
 * `POST /api/inbox/threads/<id>/decisions/post` `{ pull, tz? }`: Post decisions (design brief "export-decisions" step
 * 2). The thread's decisions go on one of its pull requests as ONE comment (a GitLab merge request note), edited in
 * place on a later post: the comment is found on the forge by its first line, the hidden marker the Markdown download
 * already carries, never a second one. Only when the person (or `plannotator inbox export-decisions --pr`) asks;
 * nothing posts on Send.
 *
 * Every forge call goes through the review app's provider layer (`upsertPRMarkedComment`,
 * `upsertPRDescriptionSection` in packages/shared/pr-provider.ts), as the person's own gh / glab, the way the Inbox's
 * review post goes. The route's guards are that post's: the owner only (this computer, or the owner over the tailnet),
 * same origin. Unlike the review post it needs no head commit: a comment is not pinned to one, and a merged or
 * closed PR still takes it.
 *
 * Where it goes is `DECISION_POST_DESTINATION` (packages/shared/inbox/decision-post.ts): the comment until the owner
 * answers about the description. `deps.destination` overrides it for tests only.
 */
import { inboxThreadPullRefOfKey, inboxThreadPullText, parseInboxThreadPullRef } from "@plannotator/core/inbox-types";
import { DECISION_POST_DESTINATION, DECISION_POST_SECTION_END, DECISION_POST_SECTION_START, DECISION_POST_COMMENT_MARKER, decisionExportForPost, renderDecisionComment, renderDecisionSummary, type DecisionPostPlatform } from "@plannotator/shared/inbox/decision-post";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { PRMarkedBrokenSectionError, PRMarkedRaceError, PRMarkedTooLongError, type PRMarkedDestination, type PRMarkedResult } from "@plannotator/shared/pr-marked";
import { canPostMarkedText, upsertPRDescriptionSection, upsertPRMarkedComment, type PRRef, type PRRuntime } from "@plannotator/shared/pr-provider";
import { threadDecisionExport } from "./inbox-decision-export";

export const INBOX_DECISION_POST_ROUTE = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/decisions\/post$/;

/** The answer: what happened, where, and the link the toast's Open goes to. */
export interface InboxDecisionPostAnswer {
  ok: true;
  action: "created" | "updated";
  destination: PRMarkedDestination;
  /** As the person writes it: `owner/repo#12`, `group/project!12`. */
  ref: string;
  url: string;
}

export type InboxDecisionPostResult = { status: 200; body: InboxDecisionPostAnswer } | { status: number; body: { error: string; code: string } };

const refused = (status: number, code: string, error: string): InboxDecisionPostResult => ({ status, body: { error, code } });

const FORGE = { github: { name: "GitHub", cli: "gh" }, gitlab: { name: "GitLab", cli: "glab" } } as const;

/** A forge's refusal as one plain sentence that says what to do. */
export function decisionPostFailure(platform: DecisionPostPlatform, ref: string, message: string, what: "comment" | "description"): string {
  const { name, cli } = FORGE[platform];
  const lead = `Couldn't post on ${ref}`;
  if (/not authenticated|auth login|not logged in|bad credentials|HTTP 401|401 Unauthorized/i.test(message)) return `${lead}: ${cli} isn't signed in. Run \`${cli} auth login\`, then try again.`;
  if (/executable file not found|ENOENT|command not found|not installed/i.test(message)) return `${lead}: ${cli} isn't installed on this computer. Install it and sign in, then try again.`;
  if (/locked/i.test(message)) return `${lead}: its conversation is locked. Ask a maintainer to unlock it, then try again.`;
  if (/HTTP 404|404 Not Found/i.test(message)) return `${lead}: your ${name} account can't see it. Sign in to ${cli} with an account that can, then try again.`;
  if (/HTTP 403|403 Forbidden|Resource not accessible|must have (?:write|push)|permission/i.test(message)) {
    return `${lead}: your ${name} account isn't allowed to ${what === "comment" ? "comment there" : "edit its description"}. Ask for access, then try again.`;
  }
  if (/rate limit|HTTP 429/i.test(message)) return `${lead}: ${name} is limiting requests. Try again in a few minutes.`;
  const detail = message.replace(/\s+/g, " ").trim();
  return `${lead}: ${detail.length > 200 ? `${detail.slice(0, 199)}…` : detail}`;
}

function prRefOf(key: string, url: string): PRRef | null {
  const ref = inboxThreadPullRefOfKey(key, url);
  if (!ref) return null;
  return ref.platform === "github"
    ? { platform: "github", host: ref.host, owner: ref.owner, repo: ref.repo, number: ref.number }
    : { platform: "gitlab", host: ref.host, projectPath: `${ref.owner}/${ref.repo}`, iid: ref.number };
}

/** Post (or update) a thread's decisions on one of its pull requests. */
export async function postThreadDecisions(
  store: InboxStore,
  threadId: string,
  input: { pull: unknown; tz?: unknown },
  deps: { runtime: PRRuntime; version: string; now?: () => Date; destination?: PRMarkedDestination },
): Promise<InboxDecisionPostResult> {
  const built = threadDecisionExport(store, threadId, { tz: typeof input.tz === "string" ? input.tz : "UTC", version: deps.version, now: deps.now });
  if (!built) return refused(404, "thread_not_found", "No such thread.");
  const parsed = parseInboxThreadPullRef(input.pull);
  if ("error" in parsed) return refused(422, "validation_error", `pull: ${parsed.error}`);
  const linked = store.threadPulls(threadId).find((pull) => pull.pull === parsed.key);
  if (!linked) return refused(409, "pull_not_on_thread", "That pull request is not on this thread. Add it to the thread first, then post.");
  const doc = decisionExportForPost(built.doc);
  if (doc.decisions.length + doc.others.length === 0) return refused(409, "no_decisions", "This thread has no questions to post.");
  const ref = prRefOf(linked.pull, linked.url);
  if (!ref || ref.platform === "bitbucket" || !canPostMarkedText(ref)) return refused(422, "forge_unsupported", "Posting decisions works on GitHub and GitLab only.");
  const platform: DecisionPostPlatform = ref.platform;
  const refText = inboxThreadPullText(linked);
  const destination = deps.destination ?? DECISION_POST_DESTINATION;
  const comment = () =>
    upsertPRMarkedComment(deps.runtime, ref, { marker: DECISION_POST_COMMENT_MARKER(doc.thread.id), body: (room) => renderDecisionComment(doc, { platform, room }) });
  const section = (body: (room: number) => string) =>
    upsertPRDescriptionSection(deps.runtime, ref, { start: DECISION_POST_SECTION_START(doc.thread.id), end: DECISION_POST_SECTION_END, body });
  let step: "comment" | "description" = "comment";
  try {
    let result: PRMarkedResult;
    if (destination === "comment") result = await comment();
    else if (destination === "description") {
      step = "description";
      // The whole body (its marker line aside: the section has its own); past the room, the short form.
      result = await section((room) => {
        const full = renderDecisionComment(doc, { platform }).split("\n").slice(1).join("\n");
        return full.length <= room ? full : renderDecisionSummary(doc, { room });
      });
    } else {
      result = await comment();
      step = "description";
      const url = result.url;
      await section((room) => renderDecisionSummary(doc, { commentUrl: url, room }));
    }
    return { status: 200, body: { ok: true, action: result.action, destination, ref: refText, url: result.url } };
  } catch (cause) {
    const already = destination === "both" && step === "description" ? "The comment is posted, but the description was not changed. " : "";
    if (cause instanceof PRMarkedTooLongError) return refused(422, "too_long", `${already}Too long for ${FORGE[platform].name} even in its shortest form. Download the decisions instead.`);
    if (cause instanceof PRMarkedRaceError || cause instanceof PRMarkedBrokenSectionError) return refused(409, "description_changed", `${already}${cause.message}`);
    const message = cause instanceof Error ? cause.message : String(cause);
    return refused(502, "post_failed", `${already}${decisionPostFailure(platform, refText, message, step)}`);
  }
}

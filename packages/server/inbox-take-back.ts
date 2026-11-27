import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { splitInboxReplyBody } from "@plannotator/core/inbox-questions";
import { withoutInboxReplyQuoteLead } from "@plannotator/core/inbox-reply-quote";
import { inboxThreadMentionsTakenBack } from "@plannotator/core/inbox-thread-mention";
import { inboxId, type InboxDraft, type InboxMessage, type InboxReplyDraft, type InboxUpload } from "@plannotator/core/inbox-types";
import { withoutInboxSkillsBlock } from "@plannotator/core/skill-reference-block";
import { saveInboxDraft } from "@plannotator/shared/inbox/drafts";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadFromAttachment } from "@plannotator/shared/inbox/uploads";

const ROUTE = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/take-back$/;

/**
 * A reply's words as the person typed them, from the body the agent would have read: the still-open sentence the store
 * wrote out (`splitInboxReplyBody`, as the thread view draws it), the skills block the window added at Send out (the
 * `$skill` / `/skill` words stay, and the next Send adds the block again), and the quote's lead out only when the draft
 * gets the quote back (`quoted`), so a quote is never lost. The stored body and what agents receive never change.
 */
const replyWordsOf = (message: InboxMessage, quoted: boolean): string => {
  const parts = splitInboxReplyBody(withoutInboxSkillsBlock(message.body));
  const words = [parts.words, parts.rest].filter((part) => part !== "").join("\n\n");
  return quoted ? withoutInboxReplyQuoteLead(words) : words;
};

/**
 * A thread's first message without the skills block. A PR page's Start a thread keeps the PR's details after the
 * words: the person's Send carried them, and sent again they make the thread that PR's own again (`linkInboxPulls`).
 */
const rootWordsOf = (message: InboxMessage): string => withoutInboxSkillsBlock(message.body);

/** The taken-back words and the box's kept draft both hold words: they go one blank line apart, the taken-back first. */
const both = (taken: string, kept: InboxReplyDraft | null) => taken.trim() !== "" && !!kept?.body.trim();

const joined = (taken: string, kept: InboxReplyDraft | null) => (both(taken, kept) ? `${taken}\n\n${kept!.body}` : taken.trim() !== "" ? taken : (kept?.body ?? taken));

/** How far the kept draft's words moved in the joined text. */
const shiftOf = (taken: string, kept: InboxReplyDraft | null) => (both(taken, kept) ? taken.length + 2 : 0);

const filesOf = (taken: string, uploads: readonly InboxUpload[], kept: InboxReplyDraft | null) => {
  const shift = shiftOf(taken, kept);
  return [
    ...uploads.map((upload) => ({ upload_id: upload.upload_id })),
    ...(kept?.files ?? []).map((file) => ({ upload_id: file.upload_id, ...(file.pasted ? { pasted: { ...file.pasted, at: file.pasted.at + shift } } : {}) })),
  ];
};

export function createInboxTakeBack(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  now?: () => Date;
}) {
  const { store, json } = options;
  const now = options.now ?? (() => new Date());

  const uploadsOf = async (message: InboxMessage): Promise<InboxUpload[]> => {
    const made = await Promise.all((message.attachments ?? []).map((attachment) => inboxUploadFromAttachment(store.dir, attachment, "sent", { at: now().toISOString() }).catch(() => null)));
    return made.filter((upload): upload is InboxUpload => upload !== null);
  };

  const replyDraft = (message: InboxMessage, uploads: readonly InboxUpload[]): InboxReplyDraft | null => {
    const kept = store.replyDraft(message.thread_id);
    const recipients = [store.recipientOf(message)?.session, ...(message.tags ?? []).map((t) => t.session)].filter((s): s is string => !!s);
    // The words as the person wrote them: each thread mention its title again, kept as a mention (the list goes).
    // The quote comes back as the draft's quote when no draft is kept, so only then does its lead leave the words.
    const taken = inboxThreadMentionsTakenBack(replyWordsOf(message, !kept && !!message.quote));
    const shift = shiftOf(taken.body, kept);
    return store.saveReplyDraft(message.thread_id, {
      base: kept?.updated_at ?? null,
      body: joined(taken.body, kept),
      files: filesOf(taken.body, uploads, kept),
      mentions: [...taken.mentions, ...(kept?.mentions ?? []).map((m) => ({ ...m, at: m.at + shift }))],
      all_files: true,
      ...(kept ? {} : { recipients, ...(message.quote ? { quote: message.quote } : {}) }),
    });
  };

  const composeDraft = (message: InboxMessage, uploads: readonly InboxUpload[]): InboxDraft => {
    const kept = store.replyDraft(message.thread_id);
    const project = store.project(message.project_id);
    const taken = inboxThreadMentionsTakenBack(rootWordsOf(message)).body;
    const where = project ? { id: project.id, root: project.root, name: project.name } : null;
    const draft = saveInboxDraft(
      store.dir,
      inboxId("drf"),
      {
        body: joined(taken, kept),
        to: message.to ? { host: message.to.host, session: message.to.session, project_root: where?.root ?? null, project_name: where?.name ?? null, started_at: null } : null,
        project: where,
        files: filesOf(taken, uploads, kept),
        ...(message.thread_name ? { thread_name: message.thread_name } : {}),
      },
      now().toISOString(),
    );
    if (kept) store.deleteReplyDraft(message.thread_id);
    return draft;
  };

  return {
    async route(req: Request, url: URL): Promise<Response | null> {
      const match = ROUTE.exec(url.pathname);
      if (!match) return null;
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      const already = store.message(match[1]!)?.taken_back_at;
      const message = store.takeBack(match[1]!);
      if (already) return json({ message, draft: null, compose: null });
      const uploads = await uploadsOf(message);
      const lone = message.id === message.thread_id;
      return json({ message, draft: lone ? null : replyDraft(message, uploads), compose: lone ? composeDraft(message, uploads) : null });
    },
  };
}

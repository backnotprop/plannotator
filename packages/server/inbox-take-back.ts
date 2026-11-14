import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { inboxId, type InboxDraft, type InboxMessage, type InboxReplyDraft, type InboxUpload } from "@plannotator/core/inbox-types";
import { saveInboxDraft } from "@plannotator/shared/inbox/drafts";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadFromAttachment } from "@plannotator/shared/inbox/uploads";

const ROUTE = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/take-back$/;

const joined = (taken: string, kept: InboxReplyDraft | null) => (kept?.body.trim() ? `${taken}\n\n${kept.body}` : taken);

const filesOf = (taken: string, uploads: readonly InboxUpload[], kept: InboxReplyDraft | null) => {
  const shift = kept?.body.trim() ? taken.length + 2 : 0;
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
    return store.saveReplyDraft(message.thread_id, {
      base: kept?.updated_at ?? null,
      body: joined(message.body, kept),
      files: filesOf(message.body, uploads, kept),
      all_files: true,
      ...(kept ? {} : { recipients, ...(message.quote ? { quote: message.quote } : {}) }),
    });
  };

  const composeDraft = (message: InboxMessage, uploads: readonly InboxUpload[]): InboxDraft => {
    const kept = store.replyDraft(message.thread_id);
    const project = store.project(message.project_id);
    const where = project ? { id: project.id, root: project.root, name: project.name } : null;
    const draft = saveInboxDraft(
      store.dir,
      inboxId("drf"),
      {
        body: joined(message.body, kept),
        to: message.to ? { host: message.to.host, session: message.to.session, project_root: where?.root ?? null, project_name: where?.name ?? null, started_at: null } : null,
        project: where,
        files: filesOf(message.body, uploads, kept),
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

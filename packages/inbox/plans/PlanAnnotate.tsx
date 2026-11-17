/**
 * A plan's Markdown page in the Inbox's own file viewer: components/AttachmentPane.tsx, the very pane a Markdown file
 * opens in beside a thread (its header with Download and the Side by side / Full screen switch, the annotation
 * toolstrip, the Viewer with Copy file and Global comment, the comments panel, the typed comment kept as the file's
 * draft), taking one version of the plan as its file through the file-source seam (fileSource.tsx):
 * - the text is the version's, read from the plan library; Download is that version's bytes;
 * - a comment is kept in the plan library (`POST /api/plans/:id/comments`, `comments.jsonl`), as the Inbox keeps a
 *   file's comment until a Send carries it, and taken away the same way; one a Send carried is an earlier comment;
 * - the rules for a plan's own words hold (planContent.tsx): no picture but one written into it, no link but a web
 *   one does anything, a Mermaid fence that could load is shown as its source, a drawn diagram that loads is refused.
 *
 * The plan page is not a file beside a thread: an Escape never leaves it for the Plans list (the pane's "Escape
 * closes the file" is for a thread's file). × still goes back to Plans, as the Plans crumb and the rail's back do.
 *
 * Send (deliver.ts): the comments on the version on screen as plan feedback, into the plan's thread once it has one,
 * else New message to the agent live in the plan's project (`agent`, the page's read of the Inbox's live sessions,
 * found again as Send is pressed); once it went, they are sent and the plan has the thread. With neither, Send is
 * disabled and says why in the Inbox's words for a project with no live agent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { planCommentAnnotationId, planDocumentFileName, type PlanComment, type PlanDocument, type PlanVersion } from '@plannotator/core/plans';
import { exportAnnotations, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { pageServerSession } from '../api';
import { attachmentBlocks } from '../attachments';
import { AttachmentPane } from '../components/AttachmentPane';
import { INBOX_FILE_SOURCE, InboxFileSourceProvider, type InboxFileSource } from '../fileSource';
import { Icon } from '../icons';
import { plansApi, type PlanRead } from './client';
import { deliverToPlanAgent, noAgentWords, planAgentNow, type PlanAgent } from './deliver';
import { PlanContentRules, planBlocks, resolvePlanImage, resolvePlanLink } from './planContent';

const noop = () => {};

/** A version as the pane's file: one attachment per version, so its comments are keyed by it ("current" always). */
export function planAttachment(planId: string, document: PlanDocument, version: PlanVersion): InboxAttachmentState {
  const name = planDocumentFileName(document);
  return {
    id: `plan-${document.id}-v${version.version_number}`,
    path: `plans/${planId}/${document.id}/${version.version_number}`,
    named_path: null,
    name,
    kind: 'markdown',
    sent_sha256: version.version,
    size: version.size,
    sent_at: version.committed_at,
    sent_mtime: version.committed_at,
    message_id: '',
    current: { sha256: version.version, size: version.size, mtime: version.committed_at },
    changed_since_sent: false,
    unavailable: null,
  };
}

/** A kept comment as the pane's record (its annotation's id is the record's id, as the Inbox's); a sent one names its message. */
export function planRecord(plan: PlanRead['plan'], comment: PlanComment, attachment: InboxAttachmentState): InboxAnnotationRecord {
  return {
    id: planCommentAnnotationId(comment)!,
    project_id: plan.project_id ?? '',
    thread_id: plan.thread_id ?? '',
    message_id: '',
    attachment_id: attachment.id,
    path: attachment.path,
    version: 'current',
    annotation: comment.anchor as Record<string, unknown>,
    created_at: comment.created_at,
    updated_at: comment.sent?.at ?? comment.created_at,
    removed_at: null,
    sent_reply_id: comment.sent?.message_id ?? null,
  };
}

/**
 * The pane's close, which an Escape never reaches: its "Escape closes the file" calls the same close as ×, so an
 * Escape seen on its way down (the window's capture phase, before any handler) holds the close until it is over.
 */
function useCloseNotOnEscape(onClose: () => void): () => void {
  const escaping = useRef(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const down = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      escaping.current = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        escaping.current = false;
      }, 0);
    };
    window.addEventListener('keydown', down, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return useCallback(() => {
    if (!escaping.current) onClose();
  }, [onClose]);
}

export function PlanAnnotate({ read, document, docRef, versions, shown, phone, agent: found, onClose, onChanged }: { read: PlanRead; document: PlanDocument; docRef: string | null; versions: readonly PlanVersion[]; shown: number; phone: boolean; agent: PlanAgent; onClose: () => void; onChanged: () => void }) {
  const planId = read.plan.id;
  const byAttachment = useMemo(() => new Map(versions.map((v) => [planAttachment(planId, document, v).id, v])), [planId, document, versions]);
  const attachmentOf = useCallback((v: PlanVersion) => planAttachment(planId, document, v), [planId, document]);
  const version = versions.find((v) => v.version_number === shown) ?? versions[versions.length - 1]!;
  const attachment = useMemo(() => attachmentOf(version), [attachmentOf, version]);
  // This document's kept comments, each on its version's file, as the plan library holds them (read again after a Send).
  const kept = useMemo(
    () =>
      (read.comments ?? []).flatMap((c) => {
        if (c.target.kind !== 'document' || c.target.document_id !== document.id) return [];
        const v = versions.find((x) => x.version === (c.target as { document_version: string }).document_version);
        return v ? [planRecord(read.plan, c, attachmentOf(v))] : [];
      }),
    [read.comments, read.plan, document.id, versions, attachmentOf],
  );
  const [records, setRecords] = useState<InboxAnnotationRecord[]>(kept);
  useEffect(() => setRecords(kept), [kept]);
  const waiting = useMemo(() => records.filter((r) => r.sent_reply_id === null), [records]);
  const earlier = useMemo(() => records.filter((r) => r.sent_reply_id !== null), [records]);
  const [full, setFull] = useState(false);
  const close = useCloseNotOnEscape(onClose);
  const source = useMemo<InboxFileSource>(() => {
    const numberOf = (a: InboxAttachmentState) => byAttachment.get(a.id)?.version_number ?? shown;
    return {
      writes: true,
      imageUrl: () => '',
      videoUrl: () => '',
      downloadUrl: (a) => plansApi.versionUrl(planId, numberOf(a), docRef),
      view: async (a) => ({ serverSession: pageServerSession() ?? '', attachment: a, version: 'current', text: await plansApi.version(planId, numberOf(a), docRef), html: null }),
      linkedPage: async () => {
        throw new Error('A plan page links to nothing in the Inbox.');
      },
      keepMarkup: (blob) => INBOX_FILE_SOURCE.keepMarkup(blob),
      saveAnnotation: async (a, _version, annotation) => {
        const v = byAttachment.get(a.id);
        if (!v) throw new Error('That version is not here.');
        const { comment } = await plansApi.saveComment(planId, v.version_number, annotation, docRef);
        return planRecord(read.plan, comment, a);
      },
      removeAnnotation: async (annotationId) => {
        await plansApi.removeComment(planId, annotationId);
      },
      markdownImage: (src) => resolvePlanImage(src)!,
      markdownLink: (href) => resolvePlanLink(href)!,
      textBlocks: (kind, text, name) => planBlocks(attachmentBlocks(kind, text, name)),
    };
  }, [byAttachment, planId, docRef, read.plan, shown]);

  const agent = found.kind === 'none' ? 'the agent' : found.label;
  const project = read.plan.project_name;
  const onScreen = waiting.filter((r) => r.path === attachment.path);
  const reachable = found.kind !== 'none';
  const canSend = reachable && onScreen.length > 0;
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const send = async () => {
    if (!canSend || sending) return;
    setSending(true);
    setFailed(null);
    try {
      const text = await plansApi.version(planId, version.version_number, docRef);
      const blocks = planBlocks(parseMarkdownToBlocks(text));
      const body = exportAnnotations(blocks, onScreen.map((r) => r.annotation), [], 'Plan Feedback', 'plan');
      const now = await planAgentNow(read.plan, versions);
      if (now.kind === 'none') throw new Error(`${noAgentWords(project)} now.`);
      await deliverToPlanAgent({ plan: read.plan, agent: now, words: body, comments: onScreen.map((r) => r.id), onSent: onChanged });
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="ib-plan-annotate" data-plan-document={version.version_number} data-plan-annotate="">
      <PlanContentRules>
        <InboxFileSourceProvider source={source}>
          <AttachmentPane
            key={attachment.id}
            attachment={attachment}
            attachments={[attachment]}
            records={waiting}
            earlierRecords={earlier}
            agent={agent}
            projectName={project ?? 'Spaces'}
            projectRoot={read.plan.project_root ?? ''}
            version="current"
            onVersion={noop}
            full={full}
            fullLocked={phone}
            exitCloses={false}
            phone={phone}
            onToggleFull={() => setFull((f) => !f)}
            onKeepView={() => setFull(false)}
            focusId={null}
            readOnly={false}
            onSaved={(record) => setRecords((all) => [...all.filter((r) => r.id !== record.id), record])}
            onRemoved={(id) => setRecords((all) => all.filter((r) => r.id !== id))}
            onOpenAt={noop}
            onClose={close}
            strip={{ picks: 0, annotations: onScreen.length, onWriteReply: () => (canSend ? void send() : setFull(false)) }}
          />
        </InboxFileSourceProvider>
      </PlanContentRules>
      <div className="ib-plan-send" data-plan-send="">
        <p className="ib-plan-send-t" id={`plan-send-${attachment.id}`} role={failed ? 'alert' : undefined}>
          {/* The pane's own chip words (its full screen foot), or the Inbox's for a project with no live agent. */}
          {failed ?? (!reachable ? noAgentWords(project) : `${onScreen.length} annotation${onScreen.length === 1 ? '' : 's'} ${onScreen.length === 1 ? 'rides' : 'ride'} your next Send to ${agent}.`)}
        </p>
        <button type="button" className="ib-btn ib-sm ib-pri" disabled={!canSend || sending} aria-describedby={`plan-send-${attachment.id}`} onClick={() => void send()} data-plan-send-button="">
          <Icon name="send" size={14} />
          Send
        </button>
      </div>
    </div>
  );
}

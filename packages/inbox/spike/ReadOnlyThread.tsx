/**
 * A thread pane after the first: a real thread read from the Inbox, drawn with the thread pane's own message parts
 * (MessageView with drawMessageHead / drawMessageBody, AttachmentTiles), read only. Its reply box, picks, looks and
 * shortcuts need App's one-thread wiring (route.thread, the look, the send hooks), which ThreadSlot is taking out of
 * App on its own branch; until then "Reply here" swaps this thread into the main pane.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InboxAttachmentState, InboxMessageWire, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { AttachmentTiles } from '../components/AttachmentTiles';
import { agentName, fullTime, whenTime } from '../format';
import { MessageView } from '../parts/MessageView';
import { drawMessageHead } from '../parts/MessageHead';
import { drawMessageBody } from '../parts/MessageBodyView';
import type { MessageActs } from '../parts/messageActs';
import type { CopyMenuHost } from '../components/CopyMenus';
import { threadLink } from '../rowMenu';

const POLL_MS = 4000;
const NO_ANSWERS = new Map();
const NO_COUNTS = new Map<string, number>();
const NO_QUESTIONS: InboxQuestion[] = [];
const noop = () => {};

export function useThreadRead(threadId: string): { thread: InboxThread | null; files: InboxAttachmentState[]; failed: boolean } {
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [files, setFiles] = useState<InboxAttachmentState[]>([]);
  const [failed, setFailed] = useState(false);
  const last = useRef('');
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const model = await inboxApi.thread(threadId);
        if (!live) return;
        const key = `${model.thread.messages.length}:${model.thread.messages.at(-1)?.id ?? ''}:${model.cursor}`;
        if (key === last.current) return;
        last.current = key;
        setThread(model.thread);
        setFailed(false);
        if (model.thread.messages.some((m) => (m.attachments?.length ?? 0) > 0)) {
          const attachments = await inboxApi.attachments(threadId);
          if (live) setFiles(attachments.attachments);
        }
      } catch {
        if (live) setFailed(true);
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [threadId]);
  return { thread, files, failed };
}

export function ReadOnlyThread({ threadId, onOpenFile, onReplyHere, onSubject }: { threadId: string; onOpenFile: (threadId: string, attachmentId: string) => void; onReplyHere: (threadId: string) => void; onSubject: (subject: string) => void }) {
  const { thread, files, failed } = useThreadRead(threadId);
  const subject = thread ? (thread.subject ?? '(no subject)') : null;
  useEffect(() => {
    if (subject) onSubject(subject);
  }, [subject, onSubject]);
  const openFile = useRef(onOpenFile);
  openFile.current = onOpenFile;
  const acts = useMemo<{ current: MessageActs }>(
    () => ({
      current: {
        openFromReply: (attachment) => openFile.current(threadId, attachment.id),
        jumpTo: noop,
        noteChips: () => ({}),
        openFromMessage: (attachment) => openFile.current(threadId, attachment.id),
        setPageStart: noop,
        openOptionSet: noop,
        pick: noop,
        markAction: async () => false,
        saveMessageComment: async () => false,
        noteUnanchored: noop,
        repaintHits: noop,
        openListAt: noop,
        toggleMessage: noop,
        replyToMessage: () => onReplyHere(threadId),
        quoteAtPress: noop,
        setHeaderOpen: noop,
        closeHeaderOnEscape: () => noop,
        tryPrototype: noop,
        takeBackOf: () => null,
        openFileRef: noop,
      },
    }),
    [threadId, onReplyHere],
  );
  const copy = useRef<CopyMenuHost | null>(null);
  if (thread) copy.current = { thread, linkOf: (messageId) => threadLink(thread.thread_id, null, location.origin, messageId), phone: false };

  if (!thread) {
    return (
      <section className="ib-pane spk-ro" data-spike-thread={threadId}>
        <div className="ib-pbody" tabIndex={-1}>
          <p className="spk-note">{failed ? 'This thread could not be read.' : 'Opening…'}</p>
        </div>
      </section>
    );
  }
  return (
    <section className="ib-pane spk-ro" data-spike-thread={threadId}>
      <div className="ib-pbody" tabIndex={-1}>
        <h2 className="ib-subject" dir="auto">
          {thread.subject ?? '(no subject)'}
        </h2>
        <div className="ib-tmeta">{thread.project.name}</div>
        {thread.messages.map((message: InboxMessageWire) => {
          const isAgent = message.author.kind === 'agent';
          const name = isAgent ? agentName(message.author) : 'You';
          const messageFiles = files.filter((a) => a.message_id === message.id);
          return (
            <article className="ib-message" key={message.id} data-author={message.author.kind} data-message-article={message.id}>
              <MessageView
                data={{
                  message,
                  phone: false,
                  one: true,
                  isNew: false,
                  revealed: false,
                  time: whenTime(message.created_at),
                  fullWhen: fullTime(message.created_at),
                  name,
                  nameSaid: name,
                  nameTip: name,
                  named: null,
                  kind: isAgent ? name : null,
                  authorLabel: null,
                  folder: thread.project.name,
                  toLabel: isAgent ? 'you' : 'the agent',
                  ended: false,
                  tagNames: null,
                  fileCount: 0,
                  filesOpen: false,
                  changed: 0,
                  live: false,
                  acts,
                  copy: copy as { readonly current: CopyMenuHost },
                }}
                draw={drawMessageHead}
              />
              <div className="ib-msg">
                <MessageView
                  data={{
                    message,
                    answers: NO_ANSWERS,
                    footers: (message.questions ?? []).map(() => null),
                    replaced: (message.questions ?? []).map(() => [null, undefined, NO_QUESTIONS] as const),
                    readOnly: true,
                    live: false,
                    sentAnswers: undefined,
                    sentActions: undefined,
                    files: null,
                    personMessageIds: null,
                    root: thread.project.root,
                    repo: thread.project.repo ?? null,
                    codeReview: false,
                    notes: null,
                    refRepo: null,
                    name,
                    comments: null,
                    openComment: null,
                    revealedComment: null,
                    side: false,
                    farMachine: null,
                    fileRefs: false,
                    acts,
                  }}
                  draw={drawMessageBody}
                />
                {messageFiles.length > 0 && <AttachmentTiles attachments={messageFiles} annotationCounts={NO_COUNTS} onOpen={(a) => onOpenFile(threadId, a.id)} />}
              </div>
            </article>
          );
        })}
      </div>
      <div className="spk-ro-foot">
        <span>Read only in this pane</span>
        <button type="button" className="ib-btn" onClick={() => onReplyHere(threadId)} data-spike-reply-here="">
          Reply here
        </button>
      </div>
    </section>
  );
}

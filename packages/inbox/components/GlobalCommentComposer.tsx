import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CommentPopoverFrame, GlobalCommentComposerContext, type CommentPopoverProps } from '@plannotator/ui/components/CommentPopover';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';
import { useConfigValue } from '@plannotator/ui/config';
import type { InboxReplyDraft } from '@plannotator/core/inbox-types';
import type { ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import { inboxApi, onInboxDraftChange, pageServerSession, replyDraftSaveBody } from '../api';
import { inboxUrl, machineOf } from '../inboxUrl';
import { keepaliveBody } from '../replyDraftHttp';
import { landInReplyDraft, useReplyDraft } from '../replyDraft';
import { AttachFilesButton, ComposeFileTiles, attachedAnnouncement, pastedSignature, useComposeFiles, useFileDrop } from '../compose/ComposeFiles';
import { useVoiceSession } from '../voice';
import { usePhone } from '../phone';
import { InboxComposerField } from './ComposerField';
import { VoiceFoot } from './VoiceMic';
import { DraftHead, DraftStamp } from './DraftLabel';

export function commentDraftStore(messageId: string, scope: string, key: string): ReplyDraftStore {
  const asTarget = (draft: InboxReplyDraft | null) => draft ? { ...draft, thread_id: key } : null;
  return {
    read: async () => asTarget((await inboxApi.commentDraft(messageId, scope)).draft),
    save: async (_key, input, options) => {
      const body = replyDraftSaveBody(input.body, input.base, input.baseBody, input.files);
      if (options.keepalive && !machineOf(messageId)) {
        await fetch(inboxUrl(`/messages/${encodeURIComponent(messageId)}/comment-draft`, `scope=${encodeURIComponent(scope)}`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          ...keepaliveBody({ ...body, serverSession: pageServerSession() }),
        });
        return { draft: null };
      }
      return { draft: asTarget((await inboxApi.saveCommentDraft(messageId, scope, body)).draft) };
    },
    discard: async () => { await inboxApi.discardCommentDraft(messageId, scope); },
  };
}

export function GlobalCommentProvider({ messageId, scope, enabled = true, children }: { messageId: string; scope: string; enabled?: boolean; children: ReactNode }) {
  const Composer = useMemo(() => function HostedComposer(props: CommentPopoverProps) {
    return <GlobalCommentComposer {...props} messageId={messageId} scope={scope} />;
  }, [messageId, scope]);
  return <GlobalCommentComposerContext.Provider value={enabled ? Composer : null}>{children}</GlobalCommentComposerContext.Provider>;
}

type GlobalCommentProps = CommentPopoverProps & { messageId: string; scope: string };

export function GlobalCommentComposer(props: GlobalCommentProps) {
  if (machineOf(props.messageId)) return <CommentPopoverFrame {...props} />;
  return <LocalGlobalCommentComposer key={`${props.messageId}:${props.scope}`} {...props} />;
}

function LocalGlobalCommentComposer({ messageId, scope, ...props }: GlobalCommentProps) {
  const key = `comment:${messageId}:${scope}`;
  const store = useMemo(() => commentDraftStore(messageId, scope, key), [messageId, scope, key]);
  const [text, setText] = useState(props.initialText ?? '');
  const textRef = useRef(text);
  textRef.current = text;
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [mentions, setMentions] = useState<readonly string[]>([]);
  const phone = usePhone();
  const enterSaves = useConfigValue('enterSavesComment');
  const voice = useVoiceSession();
  const merges = useRef<(draft: InboxReplyDraft, wanted: readonly string[]) => void>(() => {});
  const draft = useReplyDraft(key, {
    store,
    onFiles: (_key, next, wanted) => merges.current(next, wanted),
    onWords: (_key, next, was) => {
      if (textRef.current !== was) return 'differs';
      textRef.current = next.body;
      setText(next.body);
      return 'took';
    },
  });
  const files = useComposeFiles([], {
    onPasted: (names) => setAnnouncement(attachedAnnouncement(names)),
    onPutBack: () => setAnnouncement('The pasted text is back in your comment.'),
    machine: machineOf(messageId),
    text: { get value() { return textRef.current; }, set: (next) => change(next) },
    onUnmountUploads: (uploads) => { for (const upload of uploads) void landInReplyDraft(key, upload, store); },
  });
  const change = (next: string) => {
    textRef.current = next;
    setText(next);
    files.follow();
    draft.save(next, files.draftFiles(next));
    setError(null);
  };
  merges.current = (next, wanted) => {
    const text = textRef.current;
    const want = new Set(wanted);
    const held = new Set(draft.heldOf(key));
    const all = files.draftFiles(text).map((file) => file.upload_id);
    const fresh = all.filter((id) => !held.has(id) && !want.has(id));
    const now = all.filter((id) => !fresh.includes(id));
    if (now.length !== want.size || now.some((id) => !want.has(id))) {
      const inDraft = new Set((next.files ?? []).map((file) => file.upload_id));
      files.restoreDraft((next.files ?? []).filter((file) => want.has(file.upload_id)), text, 'replace', [...wanted.filter((id) => !inDraft.has(id)), ...fresh]);
    }
    const saved = files.draftFiles().filter((file) => !fresh.includes(file.upload_id));
    if (fresh.length > 0) lastFiles.current = pastedSignature(saved);
    draft.boxTook(key, saved.map((file) => file.upload_id));
  };
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || draft.loadedFor !== key) return;
    restored.current = true;
    const words = draft.conflict ?? draft.draft?.body ?? textRef.current;
    textRef.current = words;
    setText(words);
    files.restoreDraft(draft.draft?.files ?? [], words);
    draft.boxTook(key, (draft.draft?.files ?? []).map((file) => file.upload_id));
  }, [draft.loadedFor, key]);
  const refresh = useRef<() => void>(() => {});
  refresh.current = () => {
    if (!restored.current || savingRef.current) return;
    void draft.reload(() => ({ text: textRef.current, files: files.draftFiles(textRef.current) })).then((answer) => {
      if (!answer?.replaceBox) return;
      const words = answer.draft?.body ?? '';
      textRef.current = words;
      setText(words);
      const kept = draft.withMyChanges(answer.draft?.files ?? []);
      files.restoreDraft(kept, words);
      draft.boxTook(key, kept.map((file) => file.upload_id));
      lastFiles.current = pastedSignature(kept);
    });
  };
  useEffect(() => onInboxDraftChange(() => refresh.current()), []);
  const signature = pastedSignature(files.draftFiles());
  const lastFiles = useRef('');
  useEffect(() => {
    if (!restored.current || saving || signature === lastFiles.current) return;
    lastFiles.current = signature;
    draft.save(textRef.current, files.draftFiles(textRef.current));
  }, [signature, saving]);
  useEffect(() => {
    if (draft.loadedFor !== key) return;
    fieldRef.current?.focus({ preventScroll: true });
  }, [draft.loadedFor, key]);
  const source = useMemo(() => props.mentionSource ? {
    ...props.mentionSource,
    onMentionsChange: (ids: readonly string[]) => {
      setMentions(ids);
      props.mentionSource?.onMentionsChange?.(ids);
    },
  } : undefined, [props.mentionSource]);
  const drop = useFileDrop((list) => files.add(list), !saving);
  const canSave = draft.loadedFor === key && !saving && !voice.busy && !files.uploading && !files.files.some((file) => file.state === 'refused') && (text.trim() !== '' || files.uploaded.length > 0);
  const submit = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (!await draft.settle(textRef.current, files.draftFiles(textRef.current))) throw new Error('The draft is not saved. Resolve the draft before adding this comment.');
      const revision = await draft.claim();
      const accepted = await props.onSubmit(textRef.current, undefined, source ? mentions : undefined, files.current().flatMap((file) => file.upload ? [{ id: file.upload.upload_id, name: file.upload.name }] : []));
      if (accepted === false) throw new Error('The comment was not saved. Your draft is kept.');
      await inboxApi.discardCommentDraft(messageId, scope, revision);
      draft.sent();
      requestAnimationFrame(() => props.anchorEl?.isConnected && props.anchorEl.focus({ preventScroll: true }));
    } catch (cause) {
      draft.release();
      setError(cause instanceof Error ? cause.message : 'The comment was not saved. Your draft is kept.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const close = useCallback(() => {
    voice.session.cancel();
    draft.flush();
    props.onClose();
  }, [voice.session, draft.flush, props.onClose]);
  const content = (
    <fieldset className="pn-inbox ib-global-comment" data-global-composer="" aria-busy={saving} disabled={saving || draft.loadedFor !== key}>
      {draft.conflict !== null && <DraftHead conflict={{
        id: 'global-comment-conflict', text: 'Not saved: this comment changed in another window.',
        onKeepMine: () => draft.keepMine(textRef.current, files.draftFiles()),
        onDiscard: () => {
          const theirs = draft.takeTheirs();
          const words = theirs?.body ?? '';
          textRef.current = words;
          setText(words);
          files.restoreDraft(theirs?.files ?? [], words);
          draft.boxTook(key, (theirs?.files ?? []).map((file) => file.upload_id));
          lastFiles.current = pastedSignature(theirs?.files ?? []);
        },
      }} />}
      <div className="ib-rbox" data-drop-over={drop.over ? '' : undefined} {...drop.handlers} onPaste={(event) => files.paste(event)}>
        <InboxComposerField value={text} onChange={change} textareaRef={fieldRef} voice={voice} mentionSource={source}
          placeholder="Add a global comment..." ariaLabel="Global comment" autoFocus destination="your comment"
          onKeyDown={(event) => {
            if (isCommentSubmitKey(event, enterSaves)) { event.preventDefault(); event.stopPropagation(); void submit(); }
          }} />
        <div className="ib-global-files"><ComposeFileTiles files={files.files} onRemove={(id) => files.remove(id)} onPutBack={(id) => files.putBack(id, fieldRef.current)} /></div>
        <div className="ib-rfoot">
          <AttachFilesButton className="ib-rclip" iconSize={16} phone={phone} inputData="data-global-attach" onFiles={(list) => files.add(list)} />
          <VoiceFoot voice={voice} phone={phone} />
        </div>
      </div>
      <div className="ib-sr" role="status" aria-live="polite">{announcement}</div>
      {error && <div role="alert" className="ib-global-error">{error}</div>}
      <div className="ib-global-actions">
        <button type="button" className="ib-btn ib-pri" disabled={!canSave} onClick={() => void submit()}>{saving ? 'Adding…' : 'Add'}</button>
        <DraftStamp savedAt={draft.conflict === null ? draft.draft?.updated_at ?? null : null} failed={draft.failed} tooLong={draft.tooLong} onDiscard={() => {
          voice.session.cancel();
          draft.discard();
          files.reset();
          setText('');
          textRef.current = '';
          setError(null);
          lastFiles.current = '';
          fieldRef.current?.focus();
        }} />
      </div>
    </fieldset>
  );
  return <CommentPopoverFrame {...props} draftKey={undefined} onClose={close} body={{ content, textareaRef: fieldRef, hasContent: text.trim() !== '' || files.files.length > 0 }} />;
}

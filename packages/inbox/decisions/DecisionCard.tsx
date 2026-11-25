/**
 * One card of decision mode (approval "inbox-decision-mode"; the owner, 2026-11-24: "ensure the decision mode
 * supported the new various Question card fields/capabilities ... without losing the focus mode emphasis").
 *
 * A question is drawn by the thread's own card: the message's body through `MessageBody` (ui `Viewer` and
 * `QuestionBlock`), only this question's card (`onlyQuestion`). So everything the thread's card shows shows here:
 * Before/After with the change marked, Where, Shows, Stakes, Why, Holds up, Stopped, Pros/Cons, picture choices,
 * "Try prototype", Other, a note and Skip, a pick-any and a text question. Its answers are the thread's drafts: the
 * same records, saved through the same picks route, tagged "Draft" on the card in both places.
 *
 * An action item keeps decision mode's own card (Open, Copy, Done and Can't do it), as before.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import type { InboxAttachment, InboxDecision, InboxInlineImage, InboxMessageWire, InboxProjectRepo } from '@plannotator/core/inbox-types';
import { readInboxQuestionKind } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { agentName, formatCount, shortTime } from '../format';
import { HostMark, Icon } from '../icons';
import { inboxUrl, machineOf } from '../inboxUrl';
import { Tip } from '../components/Tip';
import { ContextMarkdown } from '../components/ContextMarkdown';
import { useRefRepo } from '../links';
import { MessageBody } from '../parts/MessageBody/MessageBody';
import type { FileRef } from '../fileRefs';
import { answerWords } from './model';

/**
 * A line the card draws as a sentence: its first letter capitalised, but only when its first word is plain lower-case
 * letters (a-z, then a space, or a punctuation mark and a space), so a URL, a path, `code` or a name such as iOS stays
 * as written.
 */
export function sentence(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return /^[a-z]+[,;:.!?]?(?:\s|$)/.test(trimmed) ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

/** A picture the dialog's viewer shows. */
export interface CardPicture {
  name: string;
  src: string;
  /** The picture's own alt text, where its name is something else (a picture choice is named by its choice). */
  alt?: string;
}

/** Where an attached file's picture loads from. */
export function attachmentPictureUrl(attachmentId: string): string {
  return inboxUrl(`/attachments/${encodeURIComponent(attachmentId)}/image`, undefined, machineOf(attachmentId));
}

/** The context without the `Stopped:` and `Holds up:` lines (drawn as their own lines under the prompt). */
function contextWithout(context: string): string {
  return context
    .split('\n')
    .filter((line) => !/^\s*(?:stopped|holds up)\s*:/i.test(line))
    .join('\n')
    .trim();
}

/** What the card hands the thread's card: the message's body, its folder and repo, and the thread's answers. */
export interface CardBody {
  message: InboxMessageWire;
  projectRoot: string;
  repo: InboxProjectRepo | null;
  answers: ReadonlyMap<string, QuestionAnswer>;
  footerFor: (key: string) => string | null;
}

export interface DecisionCardProps {
  decision: InboxDecision;
  /** The thread's copy of the decision's message, read from the thread: null until it is there (the card waits). */
  body: CardBody | null;
  /** The thread could not be read (every try failed): the card says so, with Try again, never "Reading…" forever. */
  readFailed?: boolean;
  onReadAgain?: () => void;
  /** The banner over the card when the agent replaced the question on screen. */
  banner?: ReactNode;
  /** The pick just made (the stamp): the card shows it while it leaves. */
  stamp: QuestionAnswer | 'done' | 'cant' | null;
  /** A change to this question's answer (its draft). `pointer`: made by a click or a tap, not typed or by the keyboard. */
  onPick: (key: string, answer: QuestionAnswer | null, pointer: boolean) => void;
  /** An action item's Done, or Can't do it with the reason. */
  onAction: (mark: { outcome: 'done' | 'cant'; note?: string }) => void;
  /** The reason under "Can't do it…", a draft the dialog keeps (reasonDrafts.ts): '' when none. */
  reason?: string;
  /** The person typed the reason. */
  onReason?: (text: string) => void;
  /** "Open the thread", or an attached file that is not a picture: decision mode tucks into its pill meanwhile. */
  onOpenThread: (fileId?: string) => void;
  /** A file the message names, opened beside the thread as from the thread's card. */
  onOpenFileRef: (ref: FileRef) => void;
  /** A picture opens in the dialog's viewer. */
  onImage: (pictures: CardPicture[], index: number) => void;
  /** A picture choice's zoom: the viewer over the question's choices, on the choice zoomed. */
  onOptionSet: (key: string, image: InboxInlineImage, choice: number) => void;
  /** "Try prototype": the question's pages open in the prototype window, over the dialog. */
  onTryPrototype: (key: string) => void;
  /** Escape walked out of a field the card opened: report it so the dialog does not close too. */
  fieldOpenRef: { current: (() => boolean) | null };
  /** A reply already took this answer (Previous reached it): drawn read only. */
  sent?: boolean;
  /** Its group's reply is on its way: drawn read only until it lands (a pick would race the Send). */
  sending?: boolean;
}

export function DecisionCard(props: DecisionCardProps) {
  const { decision } = props;
  const q = decision.question;
  const refRepo = useRefRepo(decision.message.repo !== undefined ? decision.message.repo : (decision.thread.project.repo ?? null));
  const kind = readInboxQuestionKind(q.kind);
  const promptId = useId();
  const promptRef = useRef<HTMLHeadingElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const reason = props.reason ?? '';
  const [field, setField] = useState<'none' | 'cant'>(reason.trim() ? 'cant' : 'none');
  // A reason saved earlier (read back as the card shows) opens its field, the words in it.
  const hasReason = reason.trim() !== '';
  useEffect(() => {
    if (hasReason) setField('cant');
  }, [hasReason]);
  const locked = props.sent === true || props.sending === true;
  /** Pressed with a pointer since the last key: a pick by a click or a tap moves the queue on, one by the keyboard does not. */
  const pointer = useRef(false);

  // Escape is one layer at a time: focus in a field lets go of it first (the words stay, saved as the draft).
  props.fieldOpenRef.current = () => {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const inField = (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === 'text')) && articleRef.current?.contains(active) === true;
    if (field === 'cant' && !reason.trim()) {
      setField('none');
      focusPrompt();
      return true;
    }
    if (inField) {
      focusPrompt();
      return true;
    }
    return false;
  };

  /** Focus on the card's prompt: the thread card's own prompt, or the action item's heading. */
  const focusPrompt = () => {
    const card = articleRef.current?.querySelector<HTMLElement>('fieldset[data-question-key]');
    const prompt = card?.getAttribute('aria-labelledby') ? document.getElementById(card.getAttribute('aria-labelledby')!.split(' ')[0]!) : null;
    const target = prompt ?? promptRef.current ?? articleRef.current;
    if (target && !target.hasAttribute('tabindex')) target.tabIndex = -1;
    target?.focus({ preventScroll: true });
  };
  const bodyReady = props.body !== null;
  useEffect(() => {
    focusPrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision.id, bodyReady]);

  const author = decision.message.author;
  const name = agentName(author);
  const badge = q.stopped !== null ? <span className="ib-badge ib-b-stop">Stopped</span> : q.holds_up.length > 0 ? <span className="ib-badge ib-b-hold">Holds up {formatCount(q.holds_up.length)}</span> : null;
  const images = decision.pictures.attachments.filter((f) => f.kind === 'image');
  const files = decision.pictures.attachments.filter((f) => f.kind !== 'image');
  const pictures: CardPicture[] = images.map((f) => ({ name: f.name, src: attachmentPictureUrl(f.attachment_id) }));

  return (
    <article
      className="ib-dm-card"
      aria-labelledby={kind === 'action' ? promptId : undefined}
      aria-label={kind === 'action' ? undefined : `${name}: ${q.prompt}`}
      data-decision-card={decision.id}
      data-kind={kind}
      ref={articleRef}
      data-stamped={props.stamp ? '' : undefined}
      data-sent={locked ? '' : undefined}
      onPointerDownCapture={() => (pointer.current = true)}
      onKeyDownCapture={() => (pointer.current = false)}
    >
      {props.banner}
      <div className="ib-dm-main">
        {/* Who and where. */}
        <div className="ib-dm-who">
          <HostMark host={author.kind === 'agent' ? author.host : null} />
          <b>{name}</b>
          <span>· {decision.thread.project.name}</span>
          {decision.thread.subject && (
            <Tip content={decision.thread.subject} cut>
              <span className="ib-dm-subj">· {decision.thread.subject}</span>
            </Tip>
          )}
          <span>· {shortTime(decision.message.created_at)}</span>
          {badge}
        </div>
        {kind !== 'action' ? (
          <>
            {decision.message.excerpt && <p className="ib-dm-excerpt">{decision.message.excerpt}</p>}
            {props.body ? (
              <div className="ib-dm-qcard" data-decision-question="">
                <MessageBody
                  message={props.body.message}
                  onlyQuestion={q.key}
                  projectRoot={props.body.projectRoot}
                  repo={props.body.repo}
                  readOnly={locked}
                  answers={props.body.answers}
                  onPick={(key, answer) => props.onPick(key, answer, pointer.current)}
                  footerFor={props.body.footerFor}
                  onOpenAttachment={(attachment: InboxAttachment) =>
                    attachment.kind === 'image' ? props.onImage([{ name: attachment.name, src: attachmentPictureUrl(attachment.id) }], 0) : props.onOpenThread(attachment.id)
                  }
                  onOpenFileRef={props.onOpenFileRef}
                  onOpenInlineImage={(image) => props.onImage([{ name: image.name, src: attachmentPictureUrl(image.id) }], 0)}
                  // A picture not captured yet (a choice's zoom too) opens in the same viewer, never the page's lightbox behind the dialog.
                  onOpenUncapturedImage={(src, alt) => props.onImage([{ name: alt || 'image', src }], 0)}
                  onOpenOptionSet={props.onOptionSet}
                  onTryPrototype={author.kind === 'agent' ? props.onTryPrototype : undefined}
                />
              </div>
            ) : props.readFailed ? (
              <div className="ib-dm-loading" role="alert" data-decision-question-failed="">
                Couldn&apos;t read the question.{' '}
                <button type="button" className="ib-dm-lnk" onClick={props.onReadAgain}>
                  Try again
                </button>
              </div>
            ) : (
              <div className="ib-dm-loading" data-decision-question-loading="">
                Reading the question…
              </div>
            )}
          </>
        ) : (
          <>
            <h2 id={promptId} ref={promptRef} tabIndex={-1} className="ib-dm-prompt" data-decision-prompt="">
              <InlineMarkdown githubRepo={refRepo?.display} repoHost={refRepo?.host} text={q.prompt} />
            </h2>
            {q.stopped !== null && (
              <p className="ib-dm-stop" data-decision-stopped="">
                <Icon name="warn" size={16} />
                <span>Stopped{q.stopped ? `: ${q.stopped}` : ''}</span>
              </p>
            )}
            {q.holds_up.length > 0 && (
              <p className="ib-dm-hold">
                <Icon name="clock" size={16} />
                <span>Holds up {q.holds_up.join(', ')}</span>
              </p>
            )}
            {decision.message.excerpt && <p className="ib-dm-excerpt">{decision.message.excerpt}</p>}
            <ContextMarkdown
              className="ib-body ib-dm-ctx"
              data-decision-context=""
              markdown={contextWithout(q.context ?? '')}
              messageId={decision.message.id}
              refRepo={refRepo}
              onImage={(src, alt) => props.onImage([{ name: alt || 'image', src }], 0)}
            />
          </>
        )}
        <div className="ib-dm-refs">
          {images.map((file, i) => (
            <button key={file.attachment_id} type="button" className="ib-dm-file" data-decision-picture={file.attachment_id} onClick={() => props.onImage(pictures, i)}>
              <Icon name="photo" size={15} />
              <span>{file.name}</span>
            </button>
          ))}
          {files.map((file) => (
            <button key={file.attachment_id} type="button" className="ib-dm-file" data-decision-file={file.attachment_id} onClick={() => props.onOpenThread(file.attachment_id)}>
              <Icon name="doc" size={15} />
              <span>{file.name}</span>
            </button>
          ))}
          <button type="button" className="ib-dm-open" data-decision-open-thread="" onClick={() => props.onOpenThread()}>
            <Icon name="comment" size={15} />
            Open the thread
          </button>
        </div>

        {kind === 'action' && locked && (
          <p className="ib-dm-sentline" data-decision-sent={props.sending && !props.sent ? undefined : ''} data-decision-sending={props.sending && !props.sent ? '' : undefined}>
            <Icon name={props.sending && !props.sent ? 'clock' : 'check'} size={16} />
            <span>
              <b>{props.sending && !props.sent ? 'Sending' : 'Sent'}</b> · {q.action_result?.outcome === 'cant' ? "Can't do it" : q.action_result?.outcome === 'skip' ? 'Skipped' : 'Done'}
            </span>
          </p>
        )}
        {kind === 'action' && !locked && (
          <div className="ib-dm-answers">
            <div className="ib-dm-action">
              {q.action?.where_url && (
                <a className="ib-btn" href={q.action.where_url} target="_blank" rel="noopener noreferrer">
                  Open {q.action.where ?? 'link'}
                  <Icon name="external" size={14} />
                </a>
              )}
              {q.action?.run && (
                <div className="ib-dm-run">
                  <code>{q.action.run}</code>
                  <button type="button" className="ib-btn ib-sm" onClick={() => void navigator.clipboard?.writeText(q.action?.run ?? '')}>
                    Copy
                  </button>
                </div>
              )}
              <div className="ib-dm-actbtns">
                <button type="button" className="ib-btn ib-pri" data-decision-done="" onClick={() => props.onAction({ outcome: 'done' })}>
                  Done
                </button>
                <button type="button" className="ib-btn" data-decision-cant="" aria-expanded={field === 'cant'} onClick={() => setField(field === 'cant' ? 'none' : 'cant')}>
                  Can&apos;t do it…
                </button>
              </div>
              {field === 'cant' && (
                <div className="ib-dm-field">
                  <label className="ib-dm-flabel" htmlFor={`${promptId}-cant`}>
                    Why can&apos;t you? {name} gets this word for word.
                  </label>
                  <textarea id={`${promptId}-cant`} className="ib-dm-ta" rows={2} value={reason} onChange={(event) => props.onReason?.(event.target.value)} autoFocus />
                  {/* Save, not Send: the mark waits in the draft with the reason until the dialog's Send. */}
                  <button type="button" className="ib-btn ib-pri ib-sm" data-decision-cant-save="" disabled={!reason.trim()} onClick={() => props.onAction({ outcome: 'cant', note: reason.trim() })}>
                    Save
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {props.stamp && (
        <div className="ib-dm-stamp" aria-hidden="true">
          <Icon name="check" size={18} />
          {props.stamp === 'done' ? 'Done' : props.stamp === 'cant' ? "Can't do it" : answerWords(props.stamp)}
        </div>
      )}
    </article>
  );
}

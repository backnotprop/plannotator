import { inboxUrl, machineOf } from '../inboxUrl';
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { QuestionPictureTiles } from '@plannotator/ui/components/blocks/QuestionBlock';
import type { InboxDecision, InboxQuestion } from '@plannotator/core/inbox-types';
import { readInboxQuestionKind } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { agentName, formatCount, shortTime } from '../format';
import { HostMark, Icon } from '../icons';
import { inboxMessageImageUrl } from '../images';
import { Tip } from '../components/Tip';
import { ContextMarkdown } from '../components/ContextMarkdown';
import { useRefRepo } from '../links';
import { choiceName } from '../optionSets';
import { answerNeedsConfirm, answerWords, choiceAnswer, confirmLabel, otherAnswer, skipAnswer, swipeChoices, swipeHint, textAnswer } from './model';

export interface CardFacts {
  stakes: string | null;
  why: string | null;
  irreversible: { why: string | null } | null;
  shows: { kind: 'image' | 'link'; label: string; src: string } | null;
}

export function sentence(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return /^[a-z]+[,;:.!?]?(?:\s|$)/.test(trimmed) ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

export function cardFacts(decision: InboxDecision): CardFacts {
  const q = decision.question;
  return {
    stakes: sentence(q.stakes),
    why: sentence(q.why),
    irreversible: q.reversible ? { why: q.reversible.why?.trim() || null } : null,
    shows: q.shows ?? null,
  };
}

export interface CardPicture {
  attachmentId: string;
  name: string;
  ref: string | null;
  src: string;
  alt?: string;
}

export function cardPictures(decision: InboxDecision): CardPicture[] {
  const q = decision.question;
  const choiceRefs = new Set(q.choices.map((choice) => choice.image?.src).filter((src): src is string => !!src));
  const out: CardPicture[] = decision.pictures.inline
    .filter((image) => !choiceRefs.has(image.ref))
    .map((image) => ({
      attachmentId: image.attachment_id,
      name: image.name,
      ref: image.ref,
      src: inboxUrl(`/attachments/${encodeURIComponent(image.attachment_id)}/image`, undefined, machineOf(image.attachment_id)),
    }));
  for (const file of decision.pictures.attachments) {
    if (file.kind !== 'image') continue;
    out.push({ attachmentId: file.attachment_id, name: file.name, ref: null, src: inboxUrl(`/attachments/${encodeURIComponent(file.attachment_id)}/image`, undefined, machineOf(file.attachment_id)) });
  }
  if (q.shows?.kind === 'image') {
    const src = q.shows.src;
    const at = out.findIndex((picture) => picture.ref === src);
    const shown = at >= 0 ? out.splice(at, 1)[0]! : { attachmentId: '', name: '', ref: src, src: inboxMessageImageUrl(decision.message.id, src) };
    out.unshift({ ...shown, name: q.shows.label || shown.name || 'Picture' });
  }
  return out;
}

export function choicePictureUrl(decision: InboxDecision, src: string): string {
  const image = decision.pictures.inline.find((candidate) => candidate.ref === src);
  return image ? inboxUrl(`/attachments/${encodeURIComponent(image.attachment_id)}/image`, undefined, machineOf(image.attachment_id)) : inboxMessageImageUrl(decision.message.id, src);
}

export function showsFile(decision: InboxDecision, src: string): InboxDecision['pictures']['attachments'][number] | null {
  const path = (src.split(/[?#]/)[0] ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  const name = path.split('/').pop() ?? '';
  const files = decision.pictures.attachments;
  if (path.includes('/')) {
    const byPath = files.find((file) => (file.paths ?? []).some((p) => { const at = p.replace(/\\/g, '/'); return at === path || at.endsWith(`/${path}`); }));
    if (byPath) return byPath;
  }
  return files.find((file) => file.name === name) ?? null;
}

function contextWithout(context: string, refs: readonly string[]): string {
  let out = context
    .split('\n')
    .filter((line) => !/^\s*(?:stopped|holds up)\s*:/i.test(line))
    .join('\n');
  for (const ref of refs) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!\\[[^\\]]*\\]\\(\\s*<?${escaped}>?(?:\\s+"[^"]*")?\\s*\\)`, 'g'), '');
    out = out.replace(new RegExp(`<img\\b[^>]*\\bsrc=["']${escaped}["'][^>]*>`, 'gi'), '');
  }
  return out.trim();
}


export interface DecisionCardProps {
  decision: InboxDecision;
  banner?: ReactNode;
  stamp: QuestionAnswer | 'done' | 'cant' | null;
  phone: boolean;
  touch: boolean;
  onAnswer: (answer: QuestionAnswer) => void;
  onAction: (mark: { outcome: 'done' | 'cant'; note?: string }) => void;
  onLater: () => void;
  onOpenThread: (fileId?: string) => void;
  onImage: (pictures: CardPicture[], index: number) => void;
  fieldOpenRef: { current: (() => boolean) | null };
  unsavedWordsRef?: { current: (() => boolean) | null };
  sent?: boolean;
  sending?: boolean;
  keptWords?: Map<string, CardWords>;
  onEditing?: (editing: boolean) => void;
  reduced?: boolean;
}

export interface CardWords {
  field: 'none' | 'other' | 'note' | 'cant';
  other: string;
  note: string;
  text: string;
  reason: string;
}

function flingDistance(direction: number): number {
  const width = typeof window === 'undefined' ? 1200 : window.innerWidth;
  return direction * Math.max(width, 600);
}

export function DecisionCard(props: DecisionCardProps) {
  const { decision } = props;
  const q = decision.question;
  const refRepo = useRefRepo(decision.thread.project.repo ?? null);
  const refProps = { githubRepo: refRepo?.display, repoHost: refRepo?.host };
  const kind = readInboxQuestionKind(q.kind);
  const facts = cardFacts(decision);
  const pictures = cardPictures(decision);
  const promptId = useId();
  const stakesId = `${promptId}-stakes`;
  const promptRef = useRef<HTMLHeadingElement>(null);
  const saved = q.state === 'picked' ? q.answer : null;
  const [selected, setSelected] = useState<string[]>(() => initialSelection(q));
  const kept = props.keptWords?.get(decision.id);
  const [field, setField] = useState<'none' | 'other' | 'note' | 'cant'>(() => kept?.field ?? (saved?.other ? 'other' : saved?.note ? 'note' : 'none'));
  const [other, setOther] = useState(kept?.other ?? saved?.other ?? '');
  const [note, setNote] = useState(kept?.note ?? saved?.note ?? '');
  const [text, setText] = useState(kept?.text ?? saved?.text ?? '');
  const [reason, setReason] = useState(kept?.reason ?? '');
  const pointer = useRef(false);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const [drag, setDrag] = useState(0);
  const [fling, setFling] = useState<number | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const locked = props.sent === true || props.sending === true;
  const choices2 = locked ? null : swipeChoices(q);
  const [confirming, setConfirming] = useState<{ answer: QuestionAnswer; words: string } | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const shownChoices = q.choices.map((choice) => (choice.description ? { ...choice, description: sentence(choice.description) } : choice));
  const [failedPictures, setFailedPictures] = useState<ReadonlySet<string>>(() => new Set());
  const tileUrls = q.choices.map((choice) => {
    if (!choice.image) return null;
    const url = choicePictureUrl(decision, choice.image.src);
    return failedPictures.has(url) ? null : url;
  });
  const showTiles = (kind === 'single' || kind === 'multi') && tileUrls.some((url) => url !== null);

  const boxWords = (box: 'other' | 'note' | 'cant' | 'text'): string =>
    box === 'other' ? other : box === 'note' ? note : box === 'cant' ? reason : text;
  const openBoxEmpty = field === 'none' || !boxWords(field).trim();

  props.fieldOpenRef.current = () => {
    if (confirming) {
      cancelConfirm();
      return true;
    }
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const inBox = active instanceof HTMLTextAreaElement && articleRef.current?.contains(active) === true;
    if (inBox && active.value.trim()) {
      promptRef.current?.focus({ preventScroll: true });
      return true;
    }
    if (field !== 'none' && openBoxEmpty) {
      setField('none');
      promptRef.current?.focus({ preventScroll: true });
      return true;
    }
    return false;
  };
  const differs = (typed: string, was: string | null | undefined) => typed.trim() !== '' && typed.trim() !== (was ?? '').trim();
  const typedWords =
    !props.stamp &&
    !locked &&
    ((kind === 'text' && differs(text, saved?.text)) ||
      (field === 'other' && differs(other, saved?.other)) ||
      differs(note, saved?.note) ||
      (field === 'cant' && reason.trim() !== ''));
  if (props.unsavedWordsRef) props.unsavedWordsRef.current = () => typedWords;

  const editing = !props.stamp && !locked && (field !== 'none' || typedWords);
  const onEditing = useRef(props.onEditing);
  onEditing.current = props.onEditing;
  useEffect(() => {
    onEditing.current?.(editing);
  }, [editing]);
  useEffect(() => () => onEditing.current?.(false), []);

  const words = useRef<{ typed: boolean; value: CardWords }>({ typed: false, value: { field, other, note, text, reason } });
  words.current = { typed: typedWords, value: { field, other, note, text, reason } };
  useEffect(() => {
    const store = props.keptWords;
    return () => {
      if (!store) return;
      if (words.current.typed) store.set(decision.id, words.current.value);
      else store.delete(decision.id);
    };
  }, [decision.id]);

  useEffect(() => {
    promptRef.current?.focus({ preventScroll: true });
  }, [decision.id]);

  useEffect(() => {
    if (!confirming) return;
    confirmCancelRef.current?.focus();
    confirmCancelRef.current?.closest('[data-decision-confirm-pick]')?.scrollIntoView?.({ block: 'nearest' });
  }, [confirming]);

  const request = (answer: QuestionAnswer) => {
    if (answerNeedsConfirm(q, answer)) setConfirming({ answer, words: answerWords(answer) });
    else props.onAnswer(answer);
  };
  const cancelConfirm = () => {
    const was = confirming;
    setConfirming(null);
    if (kind === 'single') setSelected(initialSelection(q));
    const label = was?.answer.selected[0];
    const radio = label ? [...(articleRef.current?.querySelectorAll<HTMLInputElement>('.ib-dm-answers input') ?? [])].find((input) => input.value === label) : undefined;
    (radio ?? promptRef.current)?.focus({ preventScroll: true });
  };

  const commitChoice = (labels: readonly string[]) => {
    if (labels.length === 0) return;
    request(choiceAnswer(q, labels, note));
  };

  const author = decision.message.author;
  const name = agentName(author);
  const badge = q.stopped !== null ? <span className="ib-badge ib-b-stop">Stopped</span> : q.holds_up.length > 0 ? <span className="ib-badge ib-b-hold">Holds up {formatCount(q.holds_up.length)}</span> : null;
  const heroRefs = pictures.map((p) => p.ref).filter((r): r is string => r !== null);
  const context = contextWithout(q.context ?? '', heroRefs);
  const shownFile = facts.shows?.kind === 'link' ? showsFile(decision, facts.shows.src) : null;
  const files = decision.pictures.attachments.filter((f) => f.kind !== 'image' && f.attachment_id !== shownFile?.attachment_id);
  const recommendedLabels = q.choices.filter((c) => c.recommended).map((c) => c.label);
  const tilePictures: CardPicture[] = q.choices.flatMap((choice, index) =>
    choice.image && tileUrls[index] ? [{ attachmentId: '', name: choiceName(choice.label, index, q.choices.map((c) => c.label)), alt: choice.image.alt || choice.label, ref: choice.image.src, src: tileUrls[index]! }] : [],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!choices2 || event.pointerType !== 'touch' || props.stamp) return;
    swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    if (Math.abs(event.clientY - start.y) > Math.abs(dx) && Math.abs(dx) < 12) return;
    setDrag(dx);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId || !choices2) return setDrag(0);
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < 90) return setDrag(0);
    setDrag(dx);
    if (!props.reduced) {
      const target = flingDistance(Math.sign(dx));
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setFling(target));
      else setFling(target);
    }
    commitChoice([dx > 0 ? choices2[0] : choices2[1]]);
  };

  return (
    <article
      className="ib-dm-card"
      aria-labelledby={promptId}
      aria-describedby={facts.stakes ? stakesId : undefined}
      data-decision-card={decision.id}
      data-one-way={facts.irreversible ? '' : undefined}
      data-kind={kind}
      data-has-picture={pictures.length > 0 ? '' : undefined}
      ref={articleRef}
      data-stamped={props.stamp ? '' : undefined}
      data-flung={drag !== 0 && props.stamp ? '' : undefined}
      data-sent={locked ? '' : undefined}
      style={
        fling !== null
          ? {
              translate: `${fling}px 0`,
              rotate: `${Math.max(-18, Math.min(18, fling / 40))}deg`,
              opacity: 0,
              transition: 'translate 320ms cubic-bezier(0.2, 0.6, 0.3, 1), rotate 320ms cubic-bezier(0.2, 0.6, 0.3, 1), opacity 260ms ease-in 60ms',
            }
          : drag
            ? { translate: `${drag}px 0`, rotate: `${Math.max(-18, Math.min(18, drag / 40))}deg` }
            : undefined
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={() => {
        swipe.current = null;
        setDrag(0);
      }}
    >
      {props.banner}
      {pictures.length > 0 && (
        <div className="ib-dm-pics" data-decision-pictures="">
          <button type="button" className="ib-dm-hero" onClick={() => props.onImage(pictures, 0)} aria-label={`Open ${pictures[0]!.name} large`}>
            <img src={pictures[0]!.src} alt="" />
            <span className="ib-dm-zoom" aria-hidden="true">
              <Icon name="expand" size={14} />
              Open large
            </span>
          </button>
          {pictures.length > 1 && (
            <div className="ib-dm-thumbs">
              {pictures.slice(1).map((p, i) => (
                <button key={p.attachmentId} type="button" className="ib-dm-thumb" onClick={() => props.onImage(pictures, i + 1)} aria-label={`Open ${p.name} large`}>
                  <img src={p.src} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="ib-dm-main">
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
          {facts.irreversible && (
            <Tip content={facts.irreversible.why ? `Can't be undone: ${facts.irreversible.why}` : "Can't be undone"}>
              <span className="ib-badge ib-b-oneway" data-decision-one-way="">
                One-way
                <span className="ib-sr">: can&rsquo;t be undone{facts.irreversible.why ? `, ${facts.irreversible.why}` : ''}</span>
              </span>
            </Tip>
          )}
        </div>
        <h2 id={promptId} ref={promptRef} tabIndex={-1} className="ib-dm-prompt" data-decision-prompt="">
          <InlineMarkdown {...refProps} text={q.prompt} />
        </h2>
        {facts.stakes && (
          <p id={stakesId} className="ib-dm-stakes" data-decision-stakes="">
            <Icon name="warn" size={16} />
            <span>
              <InlineMarkdown {...refProps} text={facts.stakes} />
            </span>
          </p>
        )}
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
          markdown={context}
          messageId={decision.message.id}
          refRepo={refRepo}
          onImage={(src, alt) => props.onImage([{ attachmentId: '', name: alt || 'image', ref: null, src }], 0)}
        />
        <div className="ib-dm-refs">
          {facts.shows?.kind === 'link' &&
            (shownFile ? (
              <button type="button" className="ib-dm-file" data-decision-shows="" onClick={() => props.onOpenThread(shownFile.attachment_id)}>
                <Icon name="doc" size={15} />
                <span>{facts.shows.label || shownFile.name}</span>
              </button>
            ) : /^https?:\/\//i.test(facts.shows.src) ? (
              <a className="ib-dm-file" data-decision-shows="" href={facts.shows.src} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={15} />
                <span>{facts.shows.label || facts.shows.src}</span>
              </a>
            ) : (
              <button type="button" className="ib-dm-file" data-decision-shows="" onClick={() => props.onOpenThread()}>
                <Icon name="doc" size={15} />
                <span>{facts.shows.label || facts.shows.src}</span>
              </button>
            ))}
          {files.map((file) => (
            <button key={file.attachment_id} type="button" className="ib-dm-file" onClick={() => props.onOpenThread(file.attachment_id)}>
              <Icon name="doc" size={15} />
              <span>{file.name}</span>
            </button>
          ))}
          <button type="button" className="ib-dm-open" data-decision-open-thread="" onClick={() => props.onOpenThread()}>
            <Icon name="comment" size={15} />
            Open the thread
          </button>
        </div>

        {locked && (
          <p className="ib-dm-sentline" data-decision-sent={props.sending && !props.sent ? undefined : ''} data-decision-sending={props.sending && !props.sent ? '' : undefined}>
            <Icon name={props.sending && !props.sent ? 'clock' : 'check'} size={16} />
            <span>
              <b>{props.sending && !props.sent ? 'Sending' : 'Sent'}</b> · {kind === 'action' ? (q.action_result?.outcome === 'cant' ? "Can't do it" : 'Done') : answerWords(q.answer)}
            </span>
          </p>
        )}
        {!locked && (
        <div className="ib-dm-answers" onPointerDownCapture={() => (pointer.current = true)} onKeyDownCapture={() => (pointer.current = false)}>
          {showTiles && (
            <div className="ib-dm-tiles" role={kind === 'multi' ? 'group' : 'radiogroup'} aria-labelledby={promptId} data-decision-tiles="">
              <QuestionPictureTiles
                choices={shownChoices}
                urls={tileUrls}
                selected={selected}
                inputType={kind === 'multi' ? 'checkbox' : 'radio'}
                name={`ib-dm-${decision.id}`}
                onPick={(label, checked) =>
                  kind === 'multi'
                    ? setSelected((current) => (checked ? [...current.filter((l) => l !== label), label] : current.filter((l) => l !== label)))
                    : checked && setSelected([label])
                }
                onZoom={(_url, _alt, index) => props.onImage(tilePictures, q.choices.slice(0, index).filter((c, i) => c.image && tileUrls[i]).length)}
                onPictureError={(url) => setFailedPictures((prev) => (prev.has(url) ? prev : new Set([...prev, url])))}
                renderText={(text) => <InlineMarkdown {...refProps} text={text} />}
                inputProps={(label) => ({
                  value: label,
                  onClick:
                    kind === 'single'
                      ? () => {
                          if (pointer.current) commitChoice([label]);
                        }
                      : undefined,
                  onKeyDown:
                    kind === 'single'
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            commitChoice([label]);
                          }
                        }
                      : undefined,
                })}
                renderBadges={(choice) => (
                  <>
                    {choice.recommended && <span className="ib-dm-rec">Recommended</span>}
                  </>
                )}
              />
            </div>
          )}
          {kind === 'single' && !showTiles && (
            <fieldset className={`ib-dm-choices${q.choices.length === 2 ? ' ib-dm-two' : ''}`} aria-labelledby={promptId}>
              {shownChoices.map((choice) => {
                const on = selected.includes(choice.label);
                const isSaved = saved?.selected.includes(choice.label) === true;
                return (
                  <label key={choice.label} className="ib-dm-choice" data-on={on ? '' : undefined} data-recommended={choice.recommended ? '' : undefined} data-saved={isSaved ? '' : undefined}>
                    <input
                      type="radio"
                      name={`ib-dm-${decision.id}`}
                      value={choice.label}
                      checked={on}
                      onChange={() => setSelected([choice.label])}
                      onClick={() => {
                        if (pointer.current) commitChoice([choice.label]);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          commitChoice([choice.label]);
                        }
                      }}
                    />
                    <span className="ib-dm-dot" aria-hidden="true" />
                    <span className="ib-dm-ch">
                      <span className="ib-dm-chl">
                        <InlineMarkdown {...refProps} text={choice.label} />
                      </span>
                      {choice.description && (
                        <span className="ib-dm-chd">
                          <InlineMarkdown {...refProps} text={choice.description} />
                        </span>
                      )}
                      </span>
                    {choice.recommended && <span className="ib-dm-rec">Recommended</span>}
                  </label>
                );
              })}
            </fieldset>
          )}
          {kind === 'multi' && !showTiles && (
            <fieldset className="ib-dm-choices" aria-labelledby={promptId}>
              {shownChoices.map((choice) => {
                const on = selected.includes(choice.label);
                return (
                  <label key={choice.label} className="ib-dm-choice ib-dm-check" data-on={on ? '' : undefined} data-recommended={choice.recommended ? '' : undefined}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setSelected((current) => (current.includes(choice.label) ? current.filter((l) => l !== choice.label) : [...current, choice.label]))}
                    />
                    <span className="ib-dm-box" aria-hidden="true" />
                    <span className="ib-dm-ch">
                      <span className="ib-dm-chl">
                        <InlineMarkdown {...refProps} text={choice.label} />
                      </span>
                      {choice.description && (
                        <span className="ib-dm-chd">
                          <InlineMarkdown {...refProps} text={choice.description} />
                        </span>
                      )}
                      </span>
                    {choice.recommended && <span className="ib-dm-rec">Recommended</span>}
                  </label>
                );
              })}
            </fieldset>
          )}
          {kind === 'multi' && !confirming && (
            <button type="button" className="ib-btn ib-pri ib-dm-go" data-decision-answer="" disabled={selected.length === 0} onClick={() => commitChoice(selected)}>
              Answer with {formatCount(selected.length)}
            </button>
          )}
          {kind === 'single' && !confirming && selected.length > 0 && !(saved && sameSet(saved.selected, selected) && !saved.other) && (
            <button type="button" className="ib-btn ib-pri ib-dm-go" data-decision-answer="" onClick={() => commitChoice(selected)}>
              Answer
            </button>
          )}
          {kind === 'text' && (
            <div className="ib-dm-text">
              {q.suggested_text && (
                <div className="ib-dm-suggest">
                  <span>
                    <b>Suggested:</b> {q.suggested_text}
                  </span>
                  <button type="button" className="ib-btn ib-sm" onClick={() => setText(q.suggested_text ?? '')}>
                    Use
                  </button>
                </div>
              )}
              <textarea className="ib-dm-ta" aria-labelledby={promptId} value={text} rows={3} onChange={(event) => setText(event.target.value)} />
              <button type="button" className="ib-btn ib-pri ib-dm-go" data-decision-answer="" disabled={!text.trim()} onClick={() => request(textAnswer(q, text, note))}>
                Answer
              </button>
            </div>
          )}
          {kind === 'action' && (
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
                  <textarea id={`${promptId}-cant`} className="ib-dm-ta" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
                  <button type="button" className="ib-btn ib-pri ib-sm" disabled={!reason.trim()} onClick={() => props.onAction({ outcome: 'cant', note: reason.trim() })}>
                    Send
                  </button>
                </div>
              )}
            </div>
          )}
          {confirming && (
            <div className="ib-dm-confirm1" role="alertdialog" aria-labelledby={`${promptId}-confirm`} aria-describedby={`${promptId}-confirm-d`} data-decision-confirm-pick="">
              <span>
                <b id={`${promptId}-confirm`}>{confirming.words}?</b>{' '}
                <span id={`${promptId}-confirm-d`}>{facts.irreversible?.why ? `Can't be undone: ${facts.irreversible.why}` : "Can't be undone."}</span>
              </span>
              <button type="button" className="ib-btn" ref={confirmCancelRef} data-decision-confirm-cancel="" onClick={cancelConfirm}>
                Cancel
              </button>
              <button
                type="button"
                className="ib-btn ib-dm-danger"
                data-decision-confirm-yes=""
                aria-label={confirming.words}
                onClick={() => {
                  const answer = confirming.answer;
                  setConfirming(null);
                  props.onAnswer(answer);
                }}
              >
                {confirmLabel(confirming.words)}
              </button>
            </div>
          )}
          {facts.why && (
            <p className="ib-dm-why" data-decision-why="">
              <b>{recommendedLabels.length > 0 || q.suggested_text ? `Why ${name} recommends it:` : 'Why:'}</b> <InlineMarkdown {...refProps} text={facts.why} />
            </p>
          )}
          {choices2 && props.touch && (
            <p className="ib-dm-swipehint" aria-hidden="true">
              {swipeHint(choices2)}
            </p>
          )}
        </div>
        )}

        {!locked && kind !== 'action' && (
          <>
            {field === 'other' && kind !== 'text' && (
              <div className="ib-dm-field">
                <label className="ib-dm-flabel" htmlFor={`${promptId}-other`}>
                  Your own answer
                </label>
                <textarea id={`${promptId}-other`} className="ib-dm-ta" rows={2} value={other} onChange={(event) => setOther(event.target.value)} autoFocus />
                <button type="button" className="ib-btn ib-pri ib-sm" data-decision-other-answer="" disabled={!other.trim()} onClick={() => request(otherAnswer(q, other, note))}>
                  Answer
                </button>
              </div>
            )}
            {field === 'note' && (
              <div className="ib-dm-field">
                <label className="ib-dm-flabel" htmlFor={`${promptId}-note`}>
                  A note with your answer
                </label>
                <textarea id={`${promptId}-note`} className="ib-dm-ta" rows={2} value={note} onChange={(event) => setNote(event.target.value)} autoFocus />
              </div>
            )}
            <div className="ib-dm-more">
              {kind !== 'text' && (
                <button type="button" className="ib-dm-lnk" aria-expanded={field === 'other'} data-decision-other="" onClick={() => setField(field === 'other' ? 'none' : 'other')}>
                  Other…
                </button>
              )}
              <button type="button" className="ib-dm-lnk" aria-expanded={field === 'note'} data-decision-note="" onClick={() => setField(field === 'note' ? 'none' : 'note')}>
                Add a note
              </button>
              <button type="button" className="ib-dm-lnk" data-decision-later="" onClick={props.onLater}>
                <Icon name="clock" size={15} />
                Later
              </button>
              <button type="button" className="ib-dm-lnk" data-decision-skip="" onClick={() => props.onAnswer(skipAnswer(q, note))}>
                Skip
              </button>
            </div>
          </>
        )}
        {!locked && kind === 'action' && (
          <div className="ib-dm-more">
            <button type="button" className="ib-dm-lnk" data-decision-later="" onClick={props.onLater}>
              <Icon name="clock" size={15} />
              Later
            </button>
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

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function initialSelection(q: InboxQuestion): string[] {
  if (q.state === 'picked' && q.answer) return [...q.answer.selected];
  if (readInboxQuestionKind(q.kind) === 'multi') return q.choices.filter((c) => c.recommended).map((c) => c.label);
  return [];
}

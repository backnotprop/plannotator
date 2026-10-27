import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { capturePlace, holdPlace, openerOf, opensFile, parsePlaceLayout, placeInView, placeLayoutKey, placeSelector, placeShown, restorePlace, type ThreadPlace } from '../threadPlace';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { useRefHoverCards } from '@plannotator/ui/components/RefHoverCard';
import type { Annotation, Block } from '@plannotator/ui/types';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';
import { ImageLightbox } from '@plannotator/ui/components/ImageLightbox';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import type { InboxListRow, InboxMessageWire, InboxProjectRepo, InboxQuestion, InboxSentRecipient, InboxThread, InboxUpload } from '@plannotator/core/inbox-types';
import { capQuestionPrompt, emptyQuestionAnswer, indexQuestionBlocks, isQuestionAnswerEmpty, type IndexedQuestion, type QuestionAnswer, type QuestionStatus } from '@plannotator/core/question-block';
import { INBOX_AUTO_SEND_ACK_NOTES, inboxAskingMessage, wholeMinutes, isInboxNote, isInboxTextKind, readInboxAttachmentKind, type InboxAnnotationRecord, type InboxAttachment, type InboxAttachmentState, type InboxInlineImage, type InboxQuestionState } from '@plannotator/core/inbox-types';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { NOT_ATTACHED_TITLE, attachmentDeepLink, attachmentDisplayPath, attachmentForLink, openAttachmentTitle, useRefRepo } from '../links';
import { InboxApiError, inboxApi, type AttachmentsModel } from '../api';
import { annotationOf, attachmentFeedback, isFileComment } from '../attachments';
import { AttachmentTiles, AttachmentsCount, changedCount } from './AttachmentTiles';
import { AttachmentPane, type AttachmentPaneHandle } from './AttachmentPane';
import type { OpenInSurface } from './OpenIn';
import { stepsOf } from '../stepping';
import { artifactKey, artifactOfFile, threadArtifacts } from '../artifacts';
import { ArtifactsView } from './ArtifactsView';
import { fileViewFor, openingView, parseFileView, readFileViewChoice, writeFileViewChoice, type FileView } from '../fileView';
import type { InboxToastModel } from './Toast';
import { AnnotationsChip } from './AnnotationsChip';
import { agentName, clockTime, dayWords, formatCount, fullTime, plural, whenTime } from '../format';
import { foldSnippet, holdingsOf, isDelivered, isPersonLook, isPersonReply, lastNonNote, lookBoundary, newSinceLook, planFolds, snippetText, type FoldSnippet, type Holding } from '../folding';
import { highlightSearchHits } from '../search/highlight';
import { AuthorMark, Icon } from '../icons';
import { PILL_BAND_PX, atEnd, followBy, lookThrough, measureFirstLines, unseenArrivals, useSeenOnSight } from '../seenOnSight';
import { GuideCard } from './GuideCard';
import { inboxMessageImageBase, inlineImageRefFromSrc, markTallImage } from '../images';
import { reportUnsentReply } from '../unsent';
import { useReplyDraft } from '../replyDraft';
import { conflictText, DraftHead, DraftFootNote } from './DraftLabel';
import { canToggleRead } from '../markRead';
import { NewMessageButton, NewMessageComposer, NewMessagePopover, hostName, useLiveSessions, type NewMessageMode } from './NewMessage';
import { autoAfterText, deliveryLine, restartNote, TURN_ENDED_TEXT, uncertainItem, waitInputs, type DeliveryLine, type RecipientConnection } from '../deliveryLine';
import { RestartLine } from './RestartNote';
import { UndeliveredBand, UndeliveredText, useMinuteClock } from './Undelivered';
import { SendToAnotherSession } from '../compose/SendToAnotherSession';
import { ComposeFileTiles, attachedAnnouncement, useComposeFiles } from '../compose/ComposeFiles';
import {
  AskerEndedNote,
  CLOSED_ROUTE,
  LEAVE,
  RouteChoice,
  SessionEndedMark,
  askerCanEnd,
  askerHasEnded,
  isRedirected,
  mergeRouteRows,
  othersLive,
  redirectedName,
  routeRace,
  type AskingSession,
  type RouteState,
} from './ReplyRoute';
import { ReaskNote } from './ReaskNote';
import { reaskedIn, reaskNoteAgent, reaskOffered, reaskTargets, reaskTooltip } from '../reask';
import { ChangedNotice, ReplacedQuestionCard, ReplacesLine, StaleGuard, replacedBy, replacementOf, type JumpTarget } from './ReplacedQuestion';
import { InboxComposerField } from './ComposerField';
import { ReplyAnswers, SentAnswers, draftAnswerWords, type DraftAnswer } from './ReplyAnswers';
import { sentAnswersOf, sentReplyParts, type SentAnswerGroup } from '../sentReply';
import { SkillsLine } from './SkillsLine';
import { paintSkillReferences } from '../skillHighlight';
import { paintTagReferences, type TagMarkPlace } from '../tagHighlight';
import { TagNotes, TagStack, useTagConnections, useTaggable } from './TagPicker';
import { messageTags, participantsWords, sendTagsByTarget, tagDeliveryLine, tagName, tagOptions, tagPeople, threadParticipants, type TagOption } from '../tags';
import type { MentionSource } from '@plannotator/ui/utils/mentions';
import { TAG_TOKEN_CLASS } from './ComposerField';
import { HostMark } from '../icons';
import { INBOX_REPLY_SKILL_AUDIENCE, annotationSkillTexts, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { ActionChecklist, type ActionMark } from './ActionChecklist';
import { actionForBlock } from '../actions';
import { splitInboxSkillsBlock } from '@plannotator/core/skill-reference-block';
import { Tip } from './Tip';
import { OpenQuestionsButton, type OpenQuestionsDecide } from './OpenQuestions';
import { fitWholeFootRow, footRowOpenQuestionsForm, footRowTokens, laidOutChildren, pillHitsButtons, type OpenQuestionsLabelForm } from '../footFit';
import { openQuestionsShown, placeOf, reaskItemLabel, skipToggledAnswer, threadOpenQuestions, type OpenQuestion, type OpenQuestionPlace } from '../openQuestions';
import { selectionToolbarShowing } from '../selectionToolbar';
import { replyKeysToRenew, routeSendAnnotations, sendTargetAnswerIds, sendTargetsOf, type SendTarget, type SentContents } from '../sendTargets';

export { routeSendAnnotations, sendTargetsOf, type SendTarget };

const noop = () => {};
/** The agent superseded the question this call named (`422 question_superseded`). */
const isSuperseded = (cause: unknown): boolean => cause instanceof InboxApiError && cause.code === 'question_superseded';
const NO_ANNOTATIONS: never[] = [];
/** An unsent pick's tag on its card (MessageBody's statusLabel). */
// A pick saved and not sent is part of the person's draft (approval "inbox-reply-drafts": "Draft" replaces "Not sent").
const NOT_SENT_STATUS = { label: 'Draft', tone: 'open' } as const;
const NO_IDS: ReadonlySet<string> = new Set();
/** The reply box starts with no files: they come only from a paste (compose's tiles and upload path). */
const NO_UPLOADS: InboxUpload[] = [];

/** The fold state of one open thread: in memory only, decided once when the thread opens. */
interface FoldState {
  threadId: string;
  /** Messages shown as one line. A message that arrives later is not in it, so it shows open. */
  folded: Set<string>;
  /** The middle of each long read run ("N earlier messages"), by run. */
  hidden: string[][];
  /** The runs whose "N earlier messages" was opened. */
  revealed: Set<number>;
}

/** "Today, 9:12 AM": a moment in the thread's meta line. */
function momentWords(iso: string): string {
  const day = dayWords(iso);
  return day ? `${day.charAt(0).toUpperCase()}${day.slice(1)}, ${clockTime(iso)}` : '';
}

/** "Today, 9:12 AM to 5:48 PM", both days when they differ, one moment when the times are the same. */
function spanWords(from: string, to: string): string {
  if (dayWords(from) === dayWords(to)) return clockTime(from) === clockTime(to) ? momentWords(from) : `${momentWords(from)} to ${clockTime(to)}`;
  return `${momentWords(from)} to ${momentWords(to)}`;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * What the "↓ N new" pill counts and goes to, in thread order, of the
 * messages whose top is below the view (under the pill's band): the arrivals
 * not yet seen on sight (`data-arrival`, design record
 * "inbox-new-in-open-thread": the pill counts only unseen arrivals below);
 * only when none waits there, the messages that were new when the thread
 * opened (`data-new`). An arrival already seen (`data-sighted`) never counts,
 * and neither does a message the person has had on screen this visit
 * (`passed`): once its top was in the view, or the view went past it, it is
 * read as far as the pill is concerned, so scrolling back up never brings it
 * back. `mark` (the tab visible and nothing over the thread) adds what is on
 * screen now to `passed`; scrolled to the end, everything is on screen.
 */
function newBelow(body: HTMLElement, passed: Set<string>, mark: boolean): HTMLElement[] {
  const bottom = body.getBoundingClientRect().bottom - PILL_BAND_PX;
  const end = mark && body.scrollHeight > 0 && atEnd(body);
  const below = (selector: string) =>
    [...body.querySelectorAll<HTMLElement>(selector)].filter((a) => {
      const id = a.getAttribute('data-message-article') ?? '';
      if (passed.has(id)) return false;
      if (end || a.getBoundingClientRect().top <= bottom) {
        if (mark) passed.add(id);
        return false;
      }
      return true;
    });
  const arrivals = below('[data-message-article][data-arrival]:not([data-sighted])');
  const atOpen = below('[data-message-article][data-new]:not([data-arrival]):not([data-sighted])');
  return arrivals.length > 0 ? arrivals : atOpen;
}

/** A folded line's snippet: the message's first words, or the person's answers. */
function SnippetText({ snippet }: { snippet: FoldSnippet }) {
  if (snippet.kind === 'words') return <>{snippet.text}</>;
  return (
    <>
      {snippet.parts.map((part, index) => (
        <span key={index} className="ib-fl-ans">
          {index > 0 && <span className="ib-fl-sep"> · </span>}
          {part.prompt} <span className="ib-fl-arr">→</span> <b>{part.answer}</b>
        </span>
      ))}
    </>
  );
}

/** What a folded line says a message holds. */
function HoldingChips({ holdings }: { holdings: Holding[] }) {
  if (holdings.length === 0) return <span className="ib-fl-chips" />;
  return (
    <span className="ib-fl-chips" data-holdings="">
      {holdings.map((h) => (
        <span key={h.kind} className={`ib-fl-chip${h.kind === 'open' || h.kind === 'todo' ? ' ib-fl-open' : h.kind === 'picks' ? ' ib-fl-pick' : ''}`} data-holding={h.kind}>
          {h.kind === 'answered' || h.kind === 'delivered' ? <Icon name="check" size={14} /> : null}
          {h.kind === 'files' ? <Icon name="clip" size={14} /> : null}
          {h.kind === 'annotations' ? <Icon name="doc" size={14} /> : null}
          {h.kind === 'guide' ? <Icon name="book" size={14} /> : null}
          {h.text}
        </span>
      ))}
    </span>
  );
}

/** A wire message's question states, for the shared asking rule. */
const questionStatesOf = (message: InboxMessageWire): InboxQuestionState[] => (message.questions ?? []).map((q) => q.state);

/**
 * A question's empty answer as its card builds it (ui's QuestionBlock:
 * `emptyQuestionAnswer` of the question Viewer indexes from the same body),
 * so a Skip from the open-questions list saves what the card's Skip saves.
 */
function emptyAnswerFor(message: InboxMessageWire, q: { key: string; prompt: string; question: InboxQuestion }): QuestionAnswer {
  const indexed = indexQuestionBlocks(parseMarkdownToBlocks(message.body, { frontmatter: false }), { decisionLines: false }).find(
    (i) => i.question.key === q.key,
  );
  if (indexed) return emptyQuestionAnswer(indexed);
  const kind = q.question.kind === 'multi' || q.question.kind === 'text' ? q.question.kind : 'single';
  return { v: 1, key: q.key, kind, prompt: capQuestionPrompt(q.prompt), selected: [] };
}

/**
 * The session a Send reaches, when its message names one: the last target's
 * when words or annotations ride on it (`carries`; the latest agent message,
 * or the last pick or skip when the same session wrote both), otherwise the
 * last message a pick or a skip answers (a message that only would have
 * carried words receives nothing, so its session is not asked about). With
 * nothing to send, the latest agent message's.
 */
function askingSessionOf(thread: InboxThread, options: { skip: ReadonlySet<string>; carries: boolean }): AskingSession | null {
  // Nothing rides on the latest message: the shared rule the list row's delivery uses too (core
  // inbox-delivery), plus the questions the person chose to skip, when any.
  const message = options.carries
    ? sendTargetsOf(thread, options.skip).at(-1)!.message
    : (lastSkipOrPick(thread, options.skip) ?? inboxAskingMessage(thread.messages, questionStatesOf, false));
  if (!message) return null;
  if (message.author.kind !== 'agent' || !message.author.session) return null;
  return { message, session: message.author.session, host: message.author.host ?? '', name: agentName(message.author) };
}

/** The last agent message a pick or a chosen skip answers (null when the person chose no skip: the shared rule decides). */
function lastSkipOrPick(thread: InboxThread, skip: ReadonlySet<string>): InboxMessageWire | null {
  if (skip.size === 0) return null;
  let found: InboxMessageWire | null = null;
  for (const m of thread.messages) {
    if (m.author.kind !== 'agent') continue;
    if ((m.questions ?? []).some((q) => q.state === 'picked' || (q.state === 'open' && skip.has(`${m.id}/${q.key}`)))) found = m;
  }
  return found;
}

/** The key a reply of a Send keeps across retries: one per session (a message with no session is its own). */
function replyKeyOf(message: InboxMessageWire): string {
  return message.author.kind === 'agent' && message.author.session ? `s:${message.author.host ?? ''}\u0000${message.author.session}` : `m:${message.id}`;
}

/** The sessions a comment tags with `@` (ui's `Annotation.mentions`): a tag there sends the whole reply to them. */
export function commentTags(record: InboxAnnotationRecord): string[] {
  const mentions = annotationOf(record)?.mentions;
  return Array.isArray(mentions) ? mentions.filter((id): id is string => typeof id === 'string') : [];
}

const NO_SENT_ANSWERS: readonly SentAnswerGroup[] = [];

/** One message's text, with its question cards (exported for its DOM test). */
export function MessageBody({
  message,
  projectRoot,
  repo,
  onOpenAttachment,
  onOpenInlineImage,
  readOnly,
  answers,
  onPick,
  footerFor,
  renderReplacedCard,
  renderReplacesLine,
  renderActions,
  comments,
  sentAnswers,
  onJumpQuestion,
  imageBase,
  onImage,
  pictureBadge,
  inlineRefOf,
}: {
  message: InboxMessageWire;
  /** The thread's project root: relative links start there or at the message's own folder. */
  projectRoot: string;
  /** The project's git `origin` (the thread payload's `project.repo`): bare `#123` refs link into it. */
  repo?: InboxProjectRepo | null;
  /** A link in the body to one of this message's attachments was followed. */
  onOpenAttachment: (attachment: InboxAttachment) => void;
  /** An image the body shows was clicked (or pressed): its captured file (`inline_images`) opens in the viewer. */
  onOpenInlineImage?: (image: InboxInlineImage) => void;
  readOnly: boolean;
  answers: ReadonlyMap<string, QuestionAnswer>;
  onPick: (key: string, answer: QuestionAnswer | null) => void;
  footerFor: (key: string) => string | null;
  /** A superseded question's card in place of its answer card (the question's key and number), or undefined to keep it. */
  renderReplacedCard?: (key: string, number: number) => React.ReactNode | undefined;
  /** The "Replaces …" line under a question's prompt, or null. */
  renderReplacesLine?: (key: string) => React.ReactNode;
  /**
   * Action items (approval "action-items-checklist"): each run of adjacent
   * `:::action` blocks (blank lines between them only) is drawn as one card
   * in place of the run's first block; the run's other blocks draw nothing.
   * `recordFor` names the record a block draws (null: the block stays text
   * and ends the run); `render` draws a run's records, in body order.
   */
  renderActions?: {
    recordFor: (block: { startLine: number; content: string }) => InboxQuestion | null;
    render: (records: InboxQuestion[]) => React.ReactNode;
  };
  /**
   * Comments on the text (an agent's message that can still be answered;
   * approval "inbox-message-comments"): the person's comments on this message
   * waiting for a Send, drawn as highlights, and a selection opens the
   * comment-only toolbar. `onSave` stores a new one (false: it was refused,
   * and its highlight goes). `onUnanchored` hears which could not be found by
   * their words; `onPainted` that highlights were drawn (the DOM changed).
   * Absent: the text takes no comments.
   */
  comments?: {
    annotations: readonly Annotation[];
    onSave: (annotation: Annotation) => Promise<boolean>;
    onUnanchored?: (report: { attempted: readonly string[]; unanchored: readonly string[] }) => void;
    onPainted?: () => void;
    /** Words the comment box opens with for this selection (the tour's suggested comment); absent: an empty box. */
    suggest?: (selectedText: string) => string | undefined;
  };
  /**
   * The person's own sent reply (sentReply.ts): the answers it carried, read
   * from the thread's questions. The reply is then drawn in the person's
   * words, these answers as a short list, then its comments and files; the
   * agent-facing parts of the body ("Answered N questions.", the still-open
   * line, "## Answers to your questions") are left out. Display only: the
   * stored body and what agents get are unchanged.
   */
  sentAnswers?: readonly SentAnswerGroup[];
  /** A row of `sentAnswers` was pressed: show its question. */
  onJumpQuestion?: (target: JumpTarget) => void;
  /**
   * Where the body's images load from, in place of the message's own image
   * route (`inboxMessageImageBase`): the onboarding tour's assets
   * (`inbox-tour:`, images.ts). Absent: the message's route.
   */
  imageBase?: string;
  /** An image the body shows (a picture choice's zoom included) was opened: the host shows it. Absent: the thread's viewer. */
  onImage?: (src: string, alt: string) => void;
  /** A label over each picture choice's picture (ui QuestionBlock `pictureBadge`); absent: none. */
  pictureBadge?: (choice: { label: string; image: { alt: string; src: string } }) => string | null;
  /**
   * The src as the body wrote it, read back from an image URL the body drew: what finds the image's captured
   * file (`inline_images`, by `ref`). Absent: the message's own image route (inlineImageRefFromSrc). The
   * tour passes its own, for images drawn from its assets.
   */
  inlineRefOf?: (src: string) => string | null;
}) {
  // A person's message ends with the skills block the window pasted when it
  // was sent: folded behind one quiet line (SkillsLine). An agent's message
  // is shown whole, whatever it says.
  const skills = useMemo(() => (message.author.kind === 'person' ? splitInboxSkillsBlock(message.body) : null), [message.author.kind, message.body]);
  const sent = skills ? skills.before : message.body;
  const replyParts = useMemo(() => sentReplyParts(message, sent, sentAnswers ?? []), [message, sent, sentAnswers]);
  const shown = replyParts ? replyParts.words : sent;
  const restShown = replyParts ? replyParts.rest : '';
  const blocks = useMemo(() => parseMarkdownToBlocks(shown, { frontmatter: false }), [shown]);
  const restBlocks = useMemo(() => (restShown ? parseMarkdownToBlocks(restShown, { frontmatter: false }) : []), [restShown]);
  const refRepo = useRefRepo(repo);
  // The body's images go through a host resolver that names the same URL ui's
  // default would (the window's resolver, `inboxImageSrcResolver`), only so ui
  // draws an image the Inbox refuses (403 image_hidden, 404) as its alt text in
  // a quiet chip instead of a broken-image icon: markdown images, `<img>` in
  // raw-HTML blocks and question cards' pictures alike. Remote, `data:` and
  // `blob:` sources keep their URL (HtmlBlock's default test: `https:host/a.png`
  // is remote too).
  const imageBaseDir = imageBase ?? inboxMessageImageBase(message.id);
  const resolveImage = useCallback<ImageResolver>(
    (src) => ({ kind: 'src', src: /^(https?:|data:|blob:)/i.test(src) ? src : getImageSrc(src, imageBaseDir) }),
    [imageBaseDir],
  );
  // A tall screenshot in the body shows its top, cropped like the gallery's
  // (inbox.css); a click still opens it whole.
  const bodyRef = useRef<HTMLDivElement>(null);
  // Hover cards for issue, PR and MR links in the body (ui RefHoverCard).
  const refCard = useRefHoverCards(bodyRef);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) markTallImage(event.target);
    };
    for (const img of body.querySelectorAll('img')) if (img.complete) markTallImage(img);
    // Load does not bubble: a capture listener on the body hears every image in it.
    body.addEventListener('load', onLoad, true);
    return () => body.removeEventListener('load', onLoad, true);
  }, []);
  // Images the body shows open in the thread's one viewer (approval "inbox-image-viewer"): a
  // click, or Enter / Space on one (every image the window loads from the message is a button).
  // Until the store has captured it (a later read of the thread does, in the background), the
  // plain lightbox shows it, so a click always opens something.
  const inlineRef = useRef<readonly InboxInlineImage[]>(message.inline_images ?? []);
  inlineRef.current = message.inline_images ?? [];
  const openImageRef = useRef(onOpenInlineImage);
  openImageRef.current = onOpenInlineImage;
  const [fallback, setFallback] = useState<{ src: string; alt: string } | null>(null);
  const refOfRef = useRef(inlineRefOf);
  refOfRef.current = inlineRefOf;
  const refOf = useCallback((src: string) => (refOfRef.current ? refOfRef.current(src) : inlineImageRefFromSrc(src, message.id)), [message.id]);
  const imageOf = useCallback(
    (src: string | null) => {
      const ref = src ? refOf(src) : null;
      return ref === null ? null : (inlineRef.current.find((image) => image.ref === ref) ?? null);
    },
    [refOf],
  );
  /** Open one of the body's images: its captured file in the viewer, else the lightbox. False: not one of them. */
  const openImage = useCallback(
    (src: string | null, alt: string): boolean => {
      if (!src || refOf(src) === null) return false;
      // An image that failed to load (outside the project, gone) opens nothing: an empty lightbox helps no one.
      if ([...(bodyRef.current?.querySelectorAll<HTMLImageElement>('img[data-ib-broken]') ?? [])].some((img) => img.getAttribute('src') === src)) return true;
      const image = imageOf(src);
      if (image && openImageRef.current) openImageRef.current(image);
      else setFallback({ src, alt });
      return true;
    },
    [imageOf, refOf],
  );
  const onImageRef = useRef(onImage);
  onImageRef.current = onImage;
  const onImageClick = useCallback((src: string, alt: string) => (onImageRef.current ? onImageRef.current(src, alt) : void openImage(src, alt)), [openImage]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    for (const img of body.querySelectorAll<HTMLImageElement>('img')) {
      // A question card's picture (a picture choice, `Shows:`): the card makes it pick, or opens it with its own button.
      if (img.hasAttribute('data-question-picture')) continue;
      const src = img.getAttribute('src');
      const ref = src ? refOf(src) : null;
      if (ref === null || img.hasAttribute('data-ib-broken')) continue;
      const image = imageOf(src);
      const name = image?.name ?? ref.split(/[\\/]/).pop() ?? 'image';
      img.setAttribute('role', 'button');
      img.tabIndex = 0;
      img.setAttribute('aria-label', `Open ${name}${img.alt ? `, ${img.alt}` : ''}`);
      if (image) img.setAttribute('data-inline-image', image.id);
      else img.removeAttribute('data-inline-image');
      img.style.cursor = 'zoom-in';
    }
  });
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    // Markdown images reach openImage through Viewer's onImageClick; an image in a raw-HTML block has no handler of its own.
    const onClick = (event: MouseEvent) => {
      const img = event.target instanceof HTMLImageElement ? event.target : null;
      if (!img || img.classList.contains('cursor-zoom-in') || img.hasAttribute('data-question-picture')) return;
      if (openImage(img.getAttribute('src'), img.alt)) event.preventDefault();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const img = event.target instanceof HTMLImageElement ? event.target : null;
      if (img && !img.hasAttribute('data-question-picture') && openImage(img.getAttribute('src'), img.alt)) event.preventDefault();
    };
    body.addEventListener('click', onClick);
    body.addEventListener('keydown', onKey);
    // An image that fails to load is not a button (error does not bubble: a capture listener hears it).
    const onError = (event: Event) => {
      const img = event.target instanceof HTMLImageElement ? event.target : null;
      if (!img) return;
      img.setAttribute('data-ib-broken', '');
      img.removeAttribute('role');
      img.removeAttribute('tabindex');
      img.removeAttribute('aria-label');
      img.style.cursor = '';
    };
    body.addEventListener('error', onError, true);
    return () => {
      body.removeEventListener('click', onClick);
      body.removeEventListener('keydown', onKey);
      body.removeEventListener('error', onError, true);
    };
  }, [openImage]);
  // The skills the block names are painted in the person's words, as the composer painted them.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !skills) return;
    return paintSkillReferences(message.id, body, skills.skills);
  }, [message.id, skills]);
  // The agents the reply tags are painted too (approval "inbox-tag-agents"), from the labels it carries.
  const sentTags = message.author.kind === 'person' ? (message.tags ?? []) : [];
  const tagLabels = sentTags.map((t) => t.label ?? '').filter(Boolean).join('\u0000');
  // Each token's chip carries its agent's mark over the `@` (the approved shot 5), drawn in a layer of our own.
  const tagHosts = new Map(sentTags.filter((t) => t.label).map((t) => [t.label!, t.host]));
  const tagLayerRef = useRef<HTMLDivElement>(null);
  const [tagMarks, setTagMarks] = useState<TagMarkPlace[]>([]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !tagLabels) return;
    return paintTagReferences(`${message.id}:tags`, body, tagLabels.split('\u0000'), {
      layer: tagLayerRef.current,
      onMarks: (next) => setTagMarks((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next)),
    });
  }, [message.id, tagLabels]);
  // A link to a file this message attached opens it beside the thread; any
  // other local link is inert text (links.ts). Kept stable across renders,
  // so raw-HTML blocks do not redraw their links on every pick.
  const openRef = useRef(onOpenAttachment);
  openRef.current = onOpenAttachment;
  const resolveLocalLink = useCallback<LocalLinkResolver>(
    (href) => {
      const attachment = attachmentForLink(href, { attachments: message.attachments ?? [], root: projectRoot, base: message.base_path ?? null });
      if (!attachment) return { kind: 'unavailable', title: NOT_ATTACHED_TITLE };
      return {
        kind: 'open',
        title: openAttachmentTitle(attachmentDisplayPath(attachment, projectRoot)),
        href: attachmentDeepLink(message.thread_id, attachment.id),
        open: () => openRef.current(attachment),
      };
    },
    [message.attachments, message.base_path, message.thread_id, projectRoot],
  );
  const renderFooter = useCallback(
    (question: IndexedQuestion) => {
      const text = footerFor(question.question.key);
      return text ? <span className="ib-qfoot-st">{text}</span> : null;
    },
    [footerFor],
  );
  // Replaced questions: the host's Quiet card in place of the answer card, and
  // the newer card's "Replaces …" line. Kept stable across renders.
  const replacedRef = useRef(renderReplacedCard);
  replacedRef.current = renderReplacedCard;
  const replacesRef = useRef(renderReplacesLine);
  replacesRef.current = renderReplacesLine;
  const questionCard = useCallback(
    (question: IndexedQuestion) => replacedRef.current?.(question.question.key, question.number),
    // A new identity when the questions change, so a card that was just replaced redraws.
    [message.questions],
  );
  const belowPrompt = useCallback(
    (question: IndexedQuestion) => replacesRef.current?.(question.question.key) ?? null,
    [message.questions],
  );
  // Action items: one checklist card per run of adjacent `:::action` blocks, in place of
  // the run's first block; the run's other blocks draw nothing (inbox.css hides their empty
  // wrapper). Prose between two blocks ends a run, so each stays where the agent put it.
  const actionsRef = useRef(renderActions);
  actionsRef.current = renderActions;
  const actionRuns = useMemo(() => {
    const runs = new Map<string, { first: boolean; records: InboxQuestion[] }>();
    const draw = actionsRef.current;
    if (!draw) return runs;
    let run: InboxQuestion[] | null = null;
    for (const block of blocks) {
      const record = block.type === 'directive' && block.directiveKind === 'action' ? draw.recordFor(block) : null;
      if (!record) {
        run = null;
        continue;
      }
      const first = run === null;
      if (run === null) run = [];
      run.push(record);
      runs.set(block.id, { first, records: run });
    }
    return runs;
  }, [blocks, message.actions, renderActions !== undefined]);
  const directiveBlock = useCallback(
    (block: Block) => {
      if (block.directiveKind !== 'action') return undefined;
      const run = actionRuns.get(block.id);
      if (!run) return undefined;
      return run.first ? actionsRef.current?.render(run.records) : null;
    },
    [actionRuns],
  );

  // ── Comments on the text (approval "inbox-message-comments") ──────────────
  // The highlights are drawn once per mount for the comments already saved;
  // a new comment paints itself (the selection becomes its mark), and one the
  // person removes elsewhere (the reply box's list) leaves the text.
  const viewerRef = useRef<ViewerHandle>(null);
  const commentList = useMemo<Annotation[]>(() => (comments ? [...comments.annotations] : NO_ANNOTATIONS), [comments?.annotations]);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const painted = useRef<Set<string>>(new Set());
  const [selectedComment, setSelectedComment] = useState<string | null>(null);
  const selectComment = useCallback((id: string | null) => setSelectedComment((current) => (current === id ? null : id)), []);
  const addComment = useCallback((annotation: Annotation) => {
    painted.current.add(annotation.id);
    void commentsRef.current?.onSave(annotation).then((saved) => {
      if (saved) return;
      painted.current.delete(annotation.id);
      viewerRef.current?.removeHighlight(annotation.id);
    });
  }, []);
  const restoreReport = useCallback((report: { attempted: readonly string[]; unanchored: readonly string[] }) => commentsRef.current?.onUnanchored?.(report), []);
  useEffect(() => {
    if (!comments) return;
    const ids = new Set(commentList.map((a) => a.id));
    for (const id of [...painted.current]) {
      if (ids.has(id)) continue;
      painted.current.delete(id);
      viewerRef.current?.removeHighlight(id);
    }
    const fresh = commentList.filter((a) => !painted.current.has(a.id) && annotationOwnsHighlight(a));
    if (fresh.length === 0) return;
    for (const a of fresh) painted.current.add(a.id);
    // After the Viewer's highlighter is ready (the attachment pane's rule).
    let done = false;
    const frame = requestAnimationFrame(() => {
      done = true;
      viewerRef.current?.applySharedAnnotations(fresh);
      commentsRef.current?.onPainted?.();
    });
    return () => {
      if (done) return;
      cancelAnimationFrame(frame);
      for (const a of fresh) painted.current.delete(a.id);
    };
  }, [comments !== undefined, commentList]);

  // The whole card, per question: only an open or picked question can be
  // answered. A sent one, one a Mark read or the archive closed, and a
  // replaced one draw read-only (no ticks, no Accept recommended, no Skip),
  // even while another question in the same message is still open. The store
  // would take a new pick on a sent question (it goes back to picked), but the
  // window does not offer it (adr/implementation/inbox-thread-state.md, Pick).
  const answerLocked = useCallback(
    (question: IndexedQuestion) => {
      // A message whose questions take no answers now (all sent, none, or closed): every card locked.
      if (readOnly) return true;
      const wire = message.questions?.find((q) => q.key === question.question.key);
      return wire !== undefined && wire.state !== 'open' && wire.state !== 'picked';
    },
    [message.questions, readOnly],
  );

  // A pick not sent yet tags its card "Draft", not "Answered" (the footer says when it was picked);
  // a sent answer, and a question a Mark read closed, keep the card's own tag.
  const statusLabel = useCallback(
    (question: IndexedQuestion, status: QuestionStatus) => {
      if (status !== 'answered' && status !== 'skipped') return undefined;
      const wire = message.questions?.find((q) => q.key === question.question.key);
      return wire && (wire.state === 'open' || wire.state === 'picked') ? NOT_SENT_STATUS : undefined;
    },
    [message.questions],
  );

  return (
    <ImageResolverContext.Provider value={resolveImage}>
    <div className="ib-body" data-message-id={message.id} data-text-comments={comments ? '' : undefined} data-sent-reply={replyParts ? '' : undefined} ref={bodyRef}>
      {refCard}
      {(!replyParts || shown !== '') && (
      <Viewer
        ref={viewerRef}
        blocks={blocks}
        markdown={shown}
        annotations={commentList}
        onAddAnnotation={comments ? addComment : noop}
        onSelectAnnotation={comments ? selectComment : noop}
        selectedAnnotationId={comments ? selectedComment : null}
        textComments={comments !== undefined}
        suggestComment={comments?.suggest}
        allowImages={false}
        onRestoreReport={comments ? restoreReport : undefined}
        mode="selection"
        taterMode={false}
        maxWidth={null}
        stickyActions={false}
        disableCodePathValidation
        imageBaseDir={imageBaseDir}
        onImageClick={onImageClick}
        resolveLocalLink={resolveLocalLink}
        refRepo={refRepo}
        answerOnly
        // `readOnly` is about the question cards (answerLocked locks them); with comments on, the text still takes them.
        readOnly={readOnly && !comments}
        questionAnswers={answers}
        onAnswerQuestion={(_blockId, answer, key) => onPick(key, answer)}
        renderQuestionFooter={renderFooter}
        // The Inbox records no decisions: a `Decision:` line an older agent wrote is context.
        questionDecisionLines={false}
        // The Inbox draws the contract lines (Stakes, Shows, Why, Can't be undone), approval "inbox-decision-mode".
        questionContractLines
        questionReadOnly={answerLocked}
        questionStatusLabel={statusLabel}
        questionPictureBadge={pictureBadge}
        renderQuestionCard={renderReplacedCard ? questionCard : undefined}
        renderQuestionBelowPrompt={renderReplacesLine ? belowPrompt : undefined}
        renderDirectiveBlock={renderActions ? directiveBlock : undefined}
      />
      )}
      {replyParts && sentAnswers && sentAnswers.length > 0 && <SentAnswers groups={sentAnswers} onJump={onJumpQuestion} />}
      {replyParts && restShown && (
        <div data-sent-rest="">
        <Viewer
          blocks={restBlocks}
          markdown={restShown}
          annotations={NO_ANNOTATIONS}
          onAddAnnotation={noop}
          onSelectAnnotation={noop}
          selectedAnnotationId={null}
          allowImages={false}
          mode="selection"
          taterMode={false}
          maxWidth={null}
          stickyActions={false}
          disableCodePathValidation
          imageBaseDir={imageBaseDir}
          onImageClick={onImageClick}
          resolveLocalLink={resolveLocalLink}
          refRepo={refRepo}
          answerOnly
          readOnly
          questionDecisionLines={false}
        />
        </div>
      )}
      {skills && <SkillsLine split={skills} />}
      {tagLabels && (
        <div className="ib-tg-marks" ref={tagLayerRef} aria-hidden="true" data-tag-marks="">
          {tagMarks.map((mark, index) => (
            <span key={index} className="ib-tg-mark" style={{ left: mark.left, top: mark.top, width: mark.size, height: mark.size }}>
              <HostMark host={tagHosts.get(mark.label) ?? null} />
            </span>
          ))}
        </div>
      )}
      {fallback && createPortal(<ImageLightbox src={fallback.src} alt={fallback.alt} onClose={() => setFallback(null)} />, document.body)}
    </div>
    </ImageResolverContext.Provider>
  );
}

export interface ThreadPaneProps {
  /** A line under the subject, from the window (the tour's notifications ask, once more, in the first real thread). */
  notice?: React.ReactNode;
  thread: InboxThread;
  /**
   * The thread's list row's `sent`: the person's reply is the last message
   * (the Inbox's own notes read past), and when the agent read it (by the
   * store's seq, so a reply the agent was not given still reads as unread),
   * or null.
   */
  sent: { at: string; checked_at: string | null; recipients?: InboxSentRecipient[] } | null;
  /** The thread's questions changed through a pick (the response's questions for that message). */
  onQuestions: (messageId: string, questions: InboxQuestion[]) => void;
  /** Something was written (a Send, resolve): read the thread and the list again. */
  onChanged: () => Promise<void>;
  /** Raised each time the Inbox says this thread's reply draft changed (`event: drafts`): the draft is read again. */
  draftChanged?: number;
  onClose: () => void;
  /** The attachment open beside the thread (`#…&file=att_…`), its version, and an annotation to show. */
  file: { id: string; version: 'current' | 'sent'; focus: string | null; linked?: string | null; view?: 'full' | 'side' | null } | null;
  /** `replace`: swap the history entry (stepping between files), so Back returns to the thread in one press. */
  /** `back`: the browser's Back when the entry on screen was opened from `file` (a linked page's Back), else a new entry. */
  onOpenFile: (file: { id: string; version: 'current' | 'sent'; focus: string | null; linked?: string | null; view?: 'full' | 'side' | null } | null, options?: { replace?: boolean; back?: boolean }) => void;
  /** Open the guided review a message carries (the record's 4.2). */
  onOpenGuide: (messageId: string) => void;
  /**
   * Where "new since you looked" starts (folding.ts `lookBoundary`), read
   * from the thread BEFORE the window recorded this look and kept until the
   * person leaves the thread. The window takes it from its own first read,
   * which lands before it records the look. Absent: the pane takes it from
   * the first thread it is given.
   */
  lookSeq?: number | null;
  /**
   * Seen on sight (design record "inbox-new-in-open-thread", approved
   * 2026-10-12): the seq the window's looks this visit covered (the look
   * recorded when the thread opened, raised as arrivals are seen). An agent
   * message after it arrived while the thread was open; once its first lines
   * have been on screen for a second (window in front, nothing over the
   * thread) the pane calls `onSeen` with the seq the look may now cover.
   * Null: the thread carries no seqs (an older Inbox). Absent `onSeen`: off.
   */
  seenThrough?: number | null;
  onSeen?: (throughSeq: number) => void;
  /** Something over the thread from outside the pane (a guided review, a dialog): nothing counts as seen. */
  covered?: boolean;
  /**
   * Whether this thread is visible: called with its id and whether anything
   * covers it (from outside, or a file over it), and with null when the pane
   * goes. Notifications skip a question in the thread on screen (notify.ts).
   */
  onScreenChange?: (state: { threadId: string; covered: boolean } | null) => void;
  /** The thread's list row as it is now: Mark read's state and whether it is offered. Null until the list has it. */
  row?: InboxListRow | null;
  /** Mark read, or move it back (the pressed button). Absent: no Mark read button. */
  onMarkRead?: (read: boolean) => void;
  /**
   * 👍 Looks good on the agent's latest message (`on`), or take it back:
   * silent, nothing is sent; the thread is marked read. `agent` names the
   * agent for the toast. Absent: no Looks good button.
   */
  onAck?: (messageId: string, on: boolean, agent: string) => void;
  /**
   * An action item's Done or Can't do it (`mark`), or its Undo (`null`), approval
   * "inbox-next-actions": the window writes it and shows the toast with
   * Undo. Resolves false when it was refused. Absent: the pane writes it
   * itself and reads the thread again.
   */
  onAction?: (messageId: string, key: string, mark: ActionMark | null, info: { agent: string; prompt: string }) => Promise<boolean>;
  /** Archive (`true`) or Unarchive. Absent: the pane calls the resolve route itself. */
  onArchive?: (archived: boolean) => void;
  /**
   * The thread is pinned to the sidebar (approval "inbox-pinned-threads"), and
   * the header's pin toggle. Absent (an older Inbox keeps no pins): no toggle.
   */
  pinned?: boolean;
  /** Resolves once the pin is written and the list read again (the header waits on it before the next click's request). */
  onPin?: (pinned: boolean) => void | Promise<unknown>;
  /** The thread whose reply box should open (the warning toast's Reply); the pane calls `onReplyOpened` once it has. */
  replyRequest?: string | null;
  onReplyOpened?: () => void;
  /** On a phone the header leads with a Back button named for the screen under the thread ("Inbox", a project). */
  backLabel?: string;
  /** A thread opened from a Board card: the chip naming the card, under the subject (board/CardChip.tsx). */
  cardChip?: React.ReactNode;
  /** A phone: one screen at a time, so an open file takes the whole window (phone.ts). */
  phone?: boolean;
  /**
   * A window too narrow for the list beside the thread (stack.ts): the thread
   * covers the list, and its header leads with the way back to it.
   */
  stacked?: boolean;
  /** A window too narrow for a file beside the thread (stack.ts): an open file takes the whole window. */
  fileStacked?: boolean;
  /**
   * This page came through the tailnet ("Over your tailnet"): "Open in" is a
   * new tab only, never an app on the computer. Null until the settings say
   * where the page is: no "Open in" yet, so a tailnet page never asks for the
   * local app list.
   */
  remote?: boolean | null;
  /**
   * A file open beside the thread on a desktop hides the list and the
   * sidebar: the header then leads with `‹ Inbox` (`backLabel`), which closes
   * the file (through the pane's unsaved-comment question, as the file's ×
   * does) and calls this with the file's name, so the window can bring the
   * list back and put focus on this thread's row. Absent: no such button.
   */
  onBackToList?: (fileName: string | null) => void;
  /** The window's one toast: "Files open side by side now" with Undo, when a picked view becomes the remembered one. */
  onToast?: (toast: Omit<InboxToastModel, 'id'>) => void;
  /**
   * A search result to land on (`#thread=…&msg=…`): the message is unfolded
   * if folded or hidden in the middle fold, scrolled to the centre, focused
   * and ringed (a question's card when the match was in a question), and the
   * query's words are highlighted in it until the first click or key in the
   * thread. `onLanded` then drops `msg=` from the hash. `focus: 'prompt'`
   * (decision mode's "Open the thread", approval "inbox-decide-thread-only"):
   * focus goes to the question's prompt, not the card.
   */
  landing?: { messageId: string; terms: readonly string[]; questionKey: string | null; focus?: 'prompt' } | null;
  onLanded?: () => void;
  /**
   * The Artifacts view is on (approval "inbox-thread-artifacts", `#thread=…&artifacts`):
   * the thread's body is swapped for a grid of every artifact across its messages.
   */
  artifacts?: boolean;
  /** Turn the Artifacts view on or off (the header's button, "Back to the thread"). Absent: no Artifacts button. */
  onArtifacts?: (open: boolean) => void;
  /**
   * Decision mode (experimental, thread only): "Decide these N" at the top of
   * the open-questions list, which opens the dialog scoped to this thread.
   * The window passes it only while two or more of the thread's decisions wait.
   */
  decide?: OpenQuestionsDecide | null;
}

/** The thread's attachments as they are now and the annotations waiting for a Send, kept fresh. */
function useThreadAttachments(threadId: string, revision: unknown) {
  const [model, setModel] = useState<AttachmentsModel | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await inboxApi.attachments(threadId);
      setModel((current) => (current === null || current.serverSession === next.serverSession ? next : current));
    } catch {
      // The thread went away; the pane closes with it.
    }
  }, [threadId]);
  useEffect(() => {
    setModel(null);
  }, [threadId]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  // A file edited on disk shows as changed when the person comes back to the window.
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);
  const patch = useCallback((update: (records: InboxAnnotationRecord[]) => InboxAnnotationRecord[]) => {
    setModel((current) => (current ? { ...current, annotations: update(current.annotations) } : current));
  }, []);
  return { model, load, patch };
}

/**
 * The in-thread New message button (record 5.1 to 5.3) is off since 👍 Looks
 * good (approval "inbox-acknowledge", 2026-10-15). Its route, phone door row
 * and code paths stay, so it comes back by turning this on.
 */
const SHOW_NEW_MESSAGE_BUTTON = false;

/** Where a 👍 Looks good is on its way to the agent (amended 2026-10-16: it is sent through). */
export type AckPillState = 'pending' | 'queued' | 'sending' | 'saved' | 'delivered' | 'not-sent';

/**
 * The line under a 👍: the toast's Undo window still runs (`pending`), the
 * Inbox sent it and a connection wakes the agent with it (`queued`, or
 * `sending` while that session is idle: the same honest words as a reply's
 * line, from the session's connection now, `deliveryLine`), it waits for an
 * agent that only reads the thread (`saved`), or it reached the agent
 * (`delivered`: its turn was delivered, or the agent read it). No Send now: a
 * 👍 asks nothing of the agent, so it never goes into a running turn; it
 * waits for the turn to end. Pure, for the tests.
 */
export function ackPillLine(
  ack: NonNullable<InboxMessageWire['ack']>,
  agent: string,
  wakes: boolean,
  time: (iso: string) => string = whenTime,
  connection?: RecipientConnection | null,
  now: number = Date.now(),
): { state: AckPillState; text: string } {
  if (ack.delivered_at) {
    // Marked by the Inbox to go in by itself: say how it went in (into the running turn, or when it ended).
    const marked = ack.deliver_now_by === 'auto' && ack.deliver_now_at && ack.wait_started_at;
    const auto = !marked
      ? ''
      : ack.delivered_into_turn === false
        ? ` · ${TURN_ENDED_TEXT}`
        : ` · ${autoAfterText(wholeMinutes(ack.wait_started_at!, ack.deliver_now_at!))}`;
    return { state: 'delivered', text: `Delivered to ${agent}, ${time(ack.delivered_at)}${auto}` };
  }
  // The window ended after the person replied, or the agent wrote again: it was not sent.
  if (ack.not_sent === 'replied') return { state: 'not-sent', text: 'not sent: you replied' };
  if (ack.not_sent === 'wrote_again') return { state: 'not-sent', text: `not sent: ${agent} wrote again` };
  const you = `You, ${time(ack.at)} · `;
  if (ack.settled_seq == null) return { state: 'pending', text: `${you}goes to ${agent} in a few seconds` };
  // A 👍 settled before it was sent through (no note) never reaches a wake: it waits for a read.
  if (wakes && ack.note_id) {
    const line = deliveryLine({
      name: agent,
      deliveredAt: null,
      time,
      wakes: true,
      sendingNow: !!ack.deliver_now_at,
      connection,
      // It waits on a busy session: "Undelivered N min"; a 👍 waits for the turn to end (INBOX_AUTO_SEND_ACK_NOTES), no countdown.
      ...waitInputs(connection, ack.note_id, { wait_started_at: ack.wait_started_at, deliver_now_by: ack.deliver_now_by, deliver_now_at: ack.deliver_now_at }),
      ...(INBOX_AUTO_SEND_ACK_NOTES ? {} : { autoSendAfterMs: null }),
      now,
    });
    return { state: line.state === 'sending' ? 'sending' : 'queued', text: `${you}${line.text}` };
  }
  return { state: 'saved', text: `${you}Saved for ${agent}. It sees it when it next reads this thread.` };
}

/** Under a message the person marked 👍 Looks good: when, and where it is on its way to the agent. */
export function AckPill({
  ack,
  agent,
  wakes = false,
  connection,
}: {
  ack: NonNullable<InboxMessageWire['ack']>;
  agent: string;
  wakes?: boolean;
  /** How the agent's session is connected now (the sessions route's `asker.connection`); undefined while unknown. */
  connection?: RecipientConnection | null;
}) {
  // The wait on a busy session is written in whole minutes: its own clock, while the 👍 waits.
  const now = useMinuteClock(!ack.delivered_at && !!ack.note_id);
  const line = ackPillLine(ack, agent, wakes, whenTime, connection, now);
  return (
    <p className="ib-ackpill" data-ack-pill={line.state}>
      <span className="ib-ackchip">
        <span aria-hidden="true">👍</span> {ack.label}
      </span>
      <Tip content={line.state === 'delivered' && ack.delivered_at ? `You marked it ${fullTime(ack.at)}; delivered ${fullTime(ack.delivered_at)}` : fullTime(ack.at)}>
        <span className="ib-ackwhen">{line.text}</span>
      </Tip>
    </p>
  );
}

/**
 * Per thread, a Send whose reply carrying the words went out but could not be
 * confirmed (its answer was lost and the thread could not be read: the Inbox
 * may be down): its key, and what it carried. It holds only while the box
 * keeps exactly those unsent words: it goes when any thread read shows the
 * reply landed (the Send is then finished), when the words change or the box
 * empties, when the person leaves the thread, and after 10 minutes. The next
 * Send of those words first reads the thread for that reply: there, the Send
 * is finished and nothing goes again; not there, it is an ordinary new Send.
 */
interface UnconfirmedSend {
  key: string;
  words: string;
  uploads: string[];
  comments: string[];
  picks: string[];
  at: number;
}
const unconfirmed = new Map<string, UnconfirmedSend>();
const UNCONFIRMED_MS = 10 * 60_000;

/**
 * Whether a reply with this idempotency key is in the thread: 'unknown' when
 * the thread could not be read, 'gone' when the thread no longer exists.
 */
async function replyLanded(threadId: string, key: string): Promise<'yes' | 'no' | 'unknown' | 'gone'> {
  try {
    const read = await inboxApi.thread(threadId);
    return read.thread.messages.some((m) => m.author.kind === 'person' && m.idempotency_key === key) ? 'yes' : 'no';
  } catch (cause) {
    return cause instanceof InboxApiError && cause.status === 404 ? 'gone' : 'unknown';
  }
}

const THREAD_GONE_TEXT = 'This thread was deleted, so nothing was sent.';

export function ThreadPane({ notice, thread, sent, onQuestions, onChanged, draftChanged = 0, onClose, file, onOpenFile, onOpenGuide, lookSeq, seenThrough = null, onSeen, covered = false, onScreenChange, row, onMarkRead, onAck, onAction, onArchive, pinned = false, onPin, replyRequest, onReplyOpened, backLabel = 'Inbox', cardChip, phone = false, stacked = false, fileStacked = false, remote = false, onBackToList, onToast, landing = null, onLanded, artifacts: artifactsRoute = false, onArtifacts, decide = null }: ThreadPaneProps) {
  // "Open in" (OpenIn.tsx): apps on this computer; a new tab only through the tailnet or on a phone.
  const openIn: OpenInSurface | undefined = phone || remote === true ? 'tab' : remote === null ? undefined : 'apps';
  const root = thread.messages[0]!;
  // A thread the person started (compose) is about the agent it is addressed to, never the person.
  const startedTo = root.started_by_person && root.to ? root.to : null;
  const asker = startedTo ? hostName(startedTo.host) : agentName(root.author);
  // Archived (resolved). What an agent wrote after the archive line behaves as
  // an open thread's: its questions are live, Reply goes to it, its files take
  // comments; the thread stays archived. `resolved` is the thread with nothing
  // after the archive: read only, as before.
  const archived = thread.resolved_at !== null;
  const archiveSeq = thread.archive_seq ?? null;
  const afterArchive = (message: InboxMessageWire) => archived && archiveSeq !== null && (message.seq ?? 0) > archiveSeq;
  const liveMessage = (message: InboxMessageWire) => !archived || afterArchive(message);
  const cameBack = archived && thread.messages.some((m) => m.author.kind === 'agent' && afterArchive(m));
  const resolved = archived && !cameBack;
  const agentMessages = thread.messages.filter((m) => m.author.kind === 'agent');
  const lastAgent = agentMessages[agentMessages.length - 1] ?? root;
  // 👍 Looks good (design record "inbox-acknowledge"): on the agent's latest
  // message, offered only while no question in the thread waits on the person
  // (open or picked) and the thread is not archived.
  const ackTarget = agentMessages.at(-1) ?? null;
  // An action item counts like a question here (approval "inbox-next-actions"): the store refuses a 👍 while one waits.
  const questionWaits = agentMessages.some((m) => [...(m.questions ?? []), ...(m.actions ?? [])].some((q) => q.state === 'open' || q.state === 'picked'));
  // Nor once the person wrote back after it (their reply is the answer; its Sent / Delivered line stays).
  const personWroteLast = lastNonNote(thread.messages)?.author.kind === 'person';
  const ackOffered = onAck !== undefined && ackTarget !== null && !archived && !questionWaits && !personWroteLast;
  const ackOn = ackTarget?.ack != null;

  // Action items: Done / Can't do it / Undo, through the window (its toast and Undo) or, without it, straight to the server.
  const markAction = async (messageId: string, key: string, mark: ActionMark | null, agent: string, prompt: string): Promise<boolean> => {
    if (onAction) return onAction(messageId, key, mark, { agent, prompt });
    try {
      await inboxApi.markAction(messageId, key, mark);
      await onChanged();
      return true;
    } catch {
      await onChanged();
      return false;
    }
  };

  // Picks saved at once; shown before the server answers, then from the server.
  const [pending, setPending] = useState<ReadonlyMap<string, QuestionAnswer | null>>(new Map());
  const pickChain = useRef<Promise<void>>(Promise.resolve());
  const revisions = useRef(new Map<string, number>());
  const threadRef = useRef(thread);
  threadRef.current = thread;

  const [box, setBox] = useState<{ open: boolean; text: string }>({ open: false, text: '' });
  /**
   * The reply box's words, kept per thread as a server draft (approval
   * "inbox-reply-drafts"): saved while typing, back when the thread opens.
   */
  const replyDraft = useReplyDraft(thread.thread_id);
  /** The words a Send carries: the box's, or (the box closed) those kept as its draft. */
  const boxWords = box.open ? box.text.trim() : ((replyDraft.conflict ?? replyDraft.draft?.body)?.trim() ?? '');
  /** A draft put back in the box opens it without taking focus (j/k and the page keep working). */
  const restoringRef = useRef(false);
  /** The thread whose draft was put back already (once per visit). */
  const restoredFor = useRef<string | null>(null);
  /**
   * Files pasted into the reply box (the owner: "paste in images … if I'm
   * focused in a reply"): compose's tiles and upload path. They live with the
   * box: Cancel, Escape, a Send and another thread forget them.
   */
  // A paste is said in the thread's polite live region ("Attached pasted-image-….png").
  const replyFiles = useComposeFiles(NO_UPLOADS, { onPasted: (names) => announce(attachedAnnouncement(names)) });
  const replyUploads = replyFiles.uploaded.map((upload) => upload.upload_id);
  // The sessions the reply box's text tags with `@` (approval "inbox-tag-agents"), as the field reports them.
  const [taggedIds, setTaggedIds] = useState<readonly string[]>([]);
  const onTagsChange = useCallback((ids: readonly string[]) => setTaggedIds(ids), []);
  const closeBox = () => {
    // A Send waiting to be confirmed: read back now, so a reply that went leaves no stale "Draft" foot.
    const earlier = unconfirmed.get(thread.thread_id);
    if (earlier) forgetUnconfirmed(earlier, 'closed');
    // Cancel and Escape keep the words as a draft (saved now); Discard drops them.
    replyDraft.flush();
    setBox({ open: false, text: '' });
    setTaggedIds([]);
    replyFiles.reset();
  };
  /**
   * The questions the person chose to skip with this Send ("Skip them" on the
   * chip), as `<message id>/<key>`: the ones the chip counted when it was
   * pressed, so a question that lands later is never skipped. Null, the
   * default: a Send skips nothing (approval "inbox-explicit-skip",
   * 2026-10-21). It holds for one Send.
   */
  const [skipArmed, setSkipArmed] = useState<ReadonlySet<string> | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendKeys = useRef<Map<string, string> | null>(null);
  /**
   * What the last Send that did not finish carried (words, pasted files,
   * annotations). A retry with other contents takes a new key for the reply
   * that carries them, so it is never answered as the earlier reply (which
   * may have gone through) and silently dropped.
   */
  const sendContents = useRef<Map<string, SentContents> | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // The box is read-only while a Send is on its way (approval "inbox-reply-drafts"): the words it carries are
  // the words in the box, and nothing typed meanwhile can be saved as a draft the Send then clears.
  useEffect(() => {
    const el = textRef.current;
    if (el) el.readOnly = sending;
  }, [sending, box.open]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const guardRef = useRef<HTMLDivElement>(null);

  // Replaced questions. A pick the person saved can be superseded while this
  // thread is open; the stale guard then says so before Send, once per
  // replacement. `seenReplaced` is every superseded question this pane has
  // shown (a replacement already on screen when the thread opened is read on
  // its card, so it never raises the guard); `stale` the ones that dropped a
  // pick since, until the person acts on the panel.
  const seenReplaced = useRef<{ threadId: string; ids: Set<string> } | null>(null);
  const [stale, setStale] = useState<string[]>([]);
  const [guard, setGuard] = useState(false);
  useEffect(() => {
    const superseded = thread.messages.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'superseded'));
    const seen = seenReplaced.current;
    if (!seen || seen.threadId !== thread.thread_id) {
      seenReplaced.current = { threadId: thread.thread_id, ids: new Set(superseded.map((q) => `${q.message_id}/${q.key}`)) };
      return;
    }
    const fresh: string[] = [];
    for (const q of superseded) {
      const id = `${q.message_id}/${q.key}`;
      if (seen.ids.has(id)) continue;
      seen.ids.add(id);
      if (q.answer !== null) fresh.push(id);
    }
    if (fresh.length > 0) setStale((current) => [...current, ...fresh.filter((id) => !current.includes(id))]);
  }, [thread]);

  // ── Folding (design record "Land", not in this repo) ──────────────────────
  // Read messages fold to one line; the thread opens at "New since you
  // looked". What is new is decided against the boundary from BEFORE this
  // look (the window's `lookSeq`, else the first thread this pane was given),
  // so the "New" marks last until the person leaves the thread.
  const one = thread.messages.length < 2;
  // The agent sessions this thread involves (approval "inbox-tag-agents"): overlapping marks in the head.
  const participants = useMemo(() => threadParticipants(thread), [thread]);
  const lookRef = useRef<{ threadId: string; seq: number | null } | null>(null);
  if (!lookRef.current || lookRef.current.threadId !== thread.thread_id) lookRef.current = { threadId: thread.thread_id, seq: lookBoundary(thread) };
  const opened = lookSeq !== undefined ? lookSeq : lookRef.current.seq;
  // A reply the person sends during this visit is a look at everything before
  // it (the list's rule), so what it answers stops being new at once.
  const boundary = useMemo(
    () => (opened === null ? null : Math.max(opened, ...thread.messages.filter(isPersonLook).map((m) => m.seq ?? 0))),
    [opened, thread.messages],
  );
  const fresh = useMemo(() => newSinceLook(thread.messages, boundary), [thread.messages, boundary]);
  const showNew = !one && fresh.size > 0;
  // The fold is decided once, when the thread opens: opening a message never
  // makes others appear or disappear.
  const [foldState, setFoldState] = useState<FoldState | null>(null);
  let fold = foldState;
  if (!fold || fold.threadId !== thread.thread_id) {
    const plan = planFolds(thread.messages, fresh, boundary);
    fold = { threadId: thread.thread_id, folded: plan.folded, hidden: plan.hidden, revealed: new Set() };
    setFoldState(fold);
  }
  const foldRef = useRef(fold);
  foldRef.current = fold;
  const hiddenNow = new Set(fold.hidden.flatMap((ids, index) => (fold.revealed.has(index) ? [] : ids)));
  const allOpen = thread.messages.every((m) => !fold.folded.has(m.id)) && hiddenNow.size === 0;
  const sectionRef = useRef<HTMLElement>(null);
  /** After a fold changes: keep the message the person acted on in place, then move focus. */
  const anchorRef = useRef<{ id: string | null; top: number; focus: string | null; folding: boolean } | null>(null);
  /** Stops holding the place put back after a file (threadPlace.ts `holdPlace`); everything that scrolls the thread calls it first. */
  const holdRef = useRef<(() => void) | null>(null);
  const stopHold = () => {
    holdRef.current?.();
    holdRef.current = null;
  };
  useEffect(() => () => holdRef.current?.(), []);
  const [announced, setAnnounced] = useState('');
  const announce = (text: string) => {
    setAnnounced('');
    setTimeout(() => setAnnounced(text), 30);
  };
  const articleOf = (id: string) => bodyRef.current?.querySelector<HTMLElement>(`[data-message-article="${CSS.escape(id)}"]`) ?? null;
  const headOf = (id: string) => articleOf(id)?.querySelector<HTMLElement>('[data-fold-head]') ?? null;
  // The header's attachments band (design record "inbox-attachments-header",
  // variant Count): open per message, never remembered. It starts closed on
  // every visit to a thread, and a message that folds closes its band.
  const [headerFiles, setHeaderFiles] = useState<{ threadId: string; open: ReadonlySet<string> }>(() => ({ threadId: thread.thread_id, open: new Set() }));
  const headerOpen: ReadonlySet<string> = headerFiles.threadId === thread.thread_id ? headerFiles.open : NO_IDS;
  const setHeaderOpen = (id: string, open: boolean) =>
    setHeaderFiles((current) => {
      const ids = new Set(current.threadId === thread.thread_id ? current.open : []);
      if (open) ids.add(id);
      else ids.delete(id);
      return { threadId: thread.thread_id, open: ids };
    });
  /** Escape on the count or inside its band closes the band, focus back on the count; the thread stays open. */
  const closeHeaderOnEscape = (id: string) => (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !headerOpen.has(id)) return;
    event.preventDefault();
    setHeaderOpen(id, false);
    bodyRef.current?.querySelector<HTMLElement>(`[data-header-files="${CSS.escape(id)}"]`)?.focus();
  };
  /**
   * The message the person just opened with its head: its body fades in
   * (inbox.css). Folding is instant, and nothing else that opens messages
   * (the first draw, Expand all, a jump) animates.
   */
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const toggleMessage = (id: string) => {
    const folding = !fold.folded.has(id);
    if (folding) setHeaderOpen(id, false);
    setRevealedId(folding ? null : id);
    anchorRef.current = { id, top: articleOf(id)?.getBoundingClientRect().top ?? 0, focus: id, folding };
    setFoldState((current) => {
      if (!current) return current;
      const folded = new Set(current.folded);
      if (folding) folded.add(id);
      else folded.delete(id);
      return { ...current, folded };
    });
  };
  /** The first message whose top is in view: what is above it may grow, it stays put. */
  const topVisible = (): string | null => {
    const body = bodyRef.current;
    if (!body) return null;
    const top = body.getBoundingClientRect().top;
    const articles = [...body.querySelectorAll<HTMLElement>('[data-message-article]')];
    const found = articles.find((a) => a.getBoundingClientRect().top >= top - 1) ?? articles[articles.length - 1];
    return found?.getAttribute('data-message-article') ?? null;
  };
  const expandAll = () => {
    const id = topVisible();
    anchorRef.current = { id, top: id ? (articleOf(id)?.getBoundingClientRect().top ?? 0) : 0, focus: null, folding: false };
    if (allOpen) {
      const last = thread.messages[thread.messages.length - 1]!;
      // The last real message stays open with it when notes trail it (it carries the reply's line).
      const lastReal = lastNonNote(thread.messages);
      setFoldState((current) => (current ? { ...current, folded: new Set(thread.messages.filter((m) => m !== last && m !== lastReal).map((m) => m.id)), revealed: new Set() } : current));
      setHeaderFiles({ threadId: thread.thread_id, open: new Set([...headerOpen].filter((id) => id === last.id)) });
      announce('Earlier messages folded');
    } else {
      setFoldState((current) => (current ? { ...current, folded: new Set(), revealed: new Set(current.hidden.map((_, index) => index)) } : current));
      announce(`All ${thread.messages.length} messages open`);
    }
  };
  const revealRun = (index: number) => {
    const first = fold.hidden[index]?.[0] ?? null;
    anchorRef.current = { id: null, top: 0, focus: first, folding: false };
    setFoldState((current) => (current ? { ...current, revealed: new Set(current.revealed).add(index) } : current));
    announce(`${plural(fold.hidden[index]?.length ?? 0, 'earlier message')} shown`);
  };
  /** Open a message that is folded or hidden in the middle fold; true when it was. */
  const unfold = useCallback((messageId: string): boolean => {
    const current = foldRef.current;
    const run = current.hidden.findIndex((ids, index) => !current.revealed.has(index) && ids.includes(messageId));
    if (!current.folded.has(messageId) && run < 0) return false;
    setFoldState((state) => {
      if (!state) return state;
      const folded = new Set(state.folded);
      folded.delete(messageId);
      return { ...state, folded, revealed: run < 0 ? state.revealed : new Set(state.revealed).add(run) };
    });
    return true;
  }, []);

  // Replaced-question cards link `#123` refs into the project's repo, as message bodies do.
  const threadRefRepo = useRefRepo(thread.project.repo ?? null);

  /** Scroll to a card or a message, focus it, and ring it briefly; a folded message opens first. */
  const jumpTo = useCallback((target: JumpTarget) => {
    // A place held after a file closed must not pull the thread back while the message unfolds.
    holdRef.current?.();
    holdRef.current = null;
    if (unfold(target.messageId)) {
      requestAnimationFrame(() => jumpNow(target));
      return;
    }
    jumpNow(target);
  }, [unfold]);
  const jumpNow = (target: JumpTarget) => {
    const body = bodyRef.current;
    if (!body) return;
    const element =
      target.kind === 'message'
        ? body.querySelector<HTMLElement>(`[data-message-article="${CSS.escape(target.messageId)}"]`)
        : body.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target.messageId)}"] [data-question-key="${CSS.escape(target.key)}"]`);
    if (!element) return;
    stopHold();
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
    element.focus({ preventScroll: true });
    if (target.kind === 'question') {
      element.classList.remove('ib-q-target-out');
      element.classList.add('ib-q-target');
      setTimeout(() => {
        element.classList.add('ib-q-target-out');
        element.classList.remove('ib-q-target');
        setTimeout(() => element.classList.remove('ib-q-target-out'), 700);
      }, 1400);
    }
  };

  // ── Landing on a search result (`msg=`; the approved "inbox-search" design) ──
  // jumpTo's way to a message (unfold, centre, focus), the ring, and the
  // query's words highlighted in that message with the CSS Custom Highlight
  // API, cleared on the first click or key in the thread.
  const landedOn = useRef<string | null>(null);
  const clearHits = useRef<(() => void) | null>(null);
  /** The message and words the landing highlight is on, while it lasts. */
  const landedHits = useRef<{ messageId: string; terms: readonly string[] } | null>(null);
  /**
   * Drawing comment highlights wraps words in marks, which moves the text the
   * landing highlight's ranges are in: paint it again over the new text.
   */
  const repaintHits = useCallback((messageId: string) => {
    const hits = landedHits.current;
    if (!hits || hits.messageId !== messageId || !clearHits.current) return;
    const article = bodyRef.current?.querySelector<HTMLElement>(`[data-message-article="${CSS.escape(messageId)}"]`);
    if (!article) return;
    clearHits.current();
    clearHits.current = highlightSearchHits(article, hits.terms).clear;
  }, []);
  const landingRef = useRef(landing);
  landingRef.current = landing;
  const onLandedRef = useRef(onLanded);
  onLandedRef.current = onLanded;
  useEffect(() => {
    const target = landingRef.current;
    if (!target) {
      // Landed (msg= dropped): the same result opened again lands again.
      landedOn.current = null;
      return;
    }
    const key = `${thread.thread_id}/${target.messageId}`;
    if (landedOn.current === key) return;
    landedOn.current = key;
    if (!thread.messages.some((m) => m.id === target.messageId)) {
      // Not in this thread (a stale link): nothing to land on.
      onLandedRef.current?.();
      return;
    }
    const land = () => {
      const body = bodyRef.current;
      const article = articleOf(target.messageId);
      if (!body || !article) {
        onLandedRef.current?.();
        return;
      }
      const inMessage = `[data-message-id="${CSS.escape(target.messageId)}"]`;
      const key = target.questionKey ? CSS.escape(target.questionKey) : null;
      const card = key ? body.querySelector<HTMLElement>(`${inMessage} [data-question-key="${key}"]`) : null;
      // An action item is a row of its message's checklist (ActionChecklist), not a question card.
      const actionRow = key && !card ? body.querySelector<HTMLElement>(`${inMessage} [data-action-card="${key}"]`) : null;
      const element = card ?? actionRow ?? article;
      stopHold();
      element.scrollIntoView?.({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      // The card's prompt is what names it (its aria-labelledby): focus it there when asked, else the card. An
      // action row's prompt is its task, the row's toggle.
      const promptId = target.focus === 'prompt' ? card?.getAttribute('aria-labelledby') : null;
      const prompt = promptId
        ? card!.querySelector<HTMLElement>(`#${CSS.escape(promptId)}`)
        : target.focus === 'prompt' && actionRow
          ? actionRow.querySelector<HTMLElement>('[data-action-toggle]')
          : null;
      const focused = prompt ?? element;
      if (!focused.hasAttribute('tabindex')) focused.setAttribute('tabindex', '-1');
      focused.focus({ preventScroll: true });
      element.classList.remove('ib-q-target-out');
      element.classList.add('ib-q-target');
      setTimeout(() => {
        element.classList.add('ib-q-target-out');
        element.classList.remove('ib-q-target');
        setTimeout(() => element.classList.remove('ib-q-target-out'), 700);
      }, 1400);
      clearHits.current?.();
      clearHits.current = highlightSearchHits(article, target.terms).clear;
      landedHits.current = { messageId: target.messageId, terms: target.terms };
      onLandedRef.current?.();
    };
    // A folded message opens first, then the landing measures it. A place held after a file must not pull it back.
    stopHold();
    if (unfold(target.messageId)) requestAnimationFrame(() => requestAnimationFrame(land));
    else requestAnimationFrame(land);
    // articleOf reads the body's ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing?.messageId, landing?.questionKey, thread, unfold]);
  useEffect(() => {
    landedOn.current = null;
  }, [thread.thread_id]);
  // The highlight lasts for the visit: the first click or key in the thread clears it.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const clear = () => {
      clearHits.current?.();
      clearHits.current = null;
      landedHits.current = null;
    };
    section.addEventListener('pointerdown', clear, true);
    section.addEventListener('keydown', clear, true);
    return () => {
      section.removeEventListener('pointerdown', clear, true);
      section.removeEventListener('keydown', clear, true);
    };
  }, []);
  useEffect(
    () => () => {
      clearHits.current?.();
      clearHits.current = null;
    },
    [thread.thread_id],
  );

  // Attachments (step 2): the files as they are now, and the annotations that ride the next Send.
  const { model: files, load: reloadFiles, patch: patchRecords } = useThreadAttachments(thread.thread_id, thread);
  const attachments: InboxAttachmentState[] = files?.attachments ?? [];
  // The images the messages' text shows, captured as files (approval "inbox-image-viewer"): opened, stepped and commented like attachments.
  const inlineImages: InboxAttachmentState[] = useMemo(() => files?.inline_images ?? [], [files]);
  /** Every file the viewer opens: the attached files and the images in the text. */
  const allFiles: InboxAttachmentState[] = useMemo(() => [...attachments, ...inlineImages], [attachments, inlineImages]);
  const records = files?.annotations ?? [];

  // The session that asked, and whether it is still there (only hosts whose
  // sessions poll the Inbox can be known to have ended). It is the session
  // the Send actually reaches: the latest agent message's when words or
  // annotations ride on it, else the last message a pick or a skip answers.
  // Only finished uploads count: a tile still uploading or refused is not what Send carries.
  // What a Send leaves unanswered: every question still open with no pick (one being saved counts as picked).
  const unanswered = thread.messages.flatMap((m) =>
    m.author.kind === 'agent'
      ? (m.questions ?? []).filter((q) => {
          if (q.state !== 'open') return false;
          const id = `${m.id}/${q.key}`;
          return !(pending.has(id) && pending.get(id) !== null);
        }).map((q) => ({ id: `${m.id}/${q.key}`, question: q }))
      : [],
  );
  /** What this Send skips: only what the person chose with "Skip them", while still unanswered. */
  const skipIds = skipArmed ? new Set(unanswered.filter((u) => skipArmed.has(u.id)).map((u) => u.id)) : new Set<string>();
  /** Keep open, the default: this Send leaves every unanswered question open. */
  const keepOpen = skipIds.size === 0;
  const toggleKeepOpen = () => setSkipArmed(keepOpen ? new Set(unanswered.map((u) => u.id)) : null);
  const skipping = !keepOpen;
  const asking = askingSessionOf(thread, { skip: skipIds, carries: boxWords !== '' || records.length > 0 || replyUploads.length > 0 });
  const askerToWatch = asking && askerCanEnd(asking) ? asking.session : null;
  // New message (record 5.x): the project's live sessions, and what the button opened.
  const { model: live, load: loadLive } = useLiveSessions(thread.thread_id, askerToWatch);
  const askerEnded = !resolved && askerHasEnded(asking, live);
  // Tags (approval "inbox-tag-agents"): who the person can tag with `@`, read while the reply box is open.
  const taggable = useTaggable(thread.thread_id, (box.open || !!file) && !resolved);
  const tagOwner = asking?.session ?? taggable?.owner?.session ?? null;
  const tagOpts: TagOption[] = useMemo(() => tagOptions(taggable, tagOwner, thread.project.id, whenTime), [taggable, tagOwner, thread.project.id]);
  // Until the list is read (or from an older Inbox) `@` is plain text.
  const composerTags = useMemo(() => (taggable ? { options: tagOpts, onChange: onTagsChange } : undefined), [taggable, tagOpts, onTagsChange]);
  // The same agents in a file comment's composer (markdown, text and HTML files): a tag there sends the
  // whole reply to that agent, and the composer says so under the field.
  const commentMentions = useMemo<MentionSource | undefined>(
    () =>
      tagOpts.length === 0
        ? undefined
        : {
            people: tagPeople(tagOpts),
            kinds: ['agent'],
            matchDetail: false,
            tokenClassName: TAG_TOKEN_CLASS,
            // A session on an older Plannotator cannot be tagged: nothing is inserted (its row says to update).
            onPickBlocked: () => {},
            renderNotice: (people) => (
              <TagNotes tagged={people.flatMap((p) => tagOpts.filter((o) => o.id === p.id))} owner={tagOpts.find((o) => o.owner) ?? null} where="comment" />
            ),
          },
    [tagOpts],
  );
  const anyOtherLive = asking !== null && othersLive(asking, live).length > 0;
  const noteId = `ib-asker-note-${thread.thread_id}`;
  const conflictId = `ib-draft-conflict-${thread.thread_id}`;
  // The choice at Send, when the session that asked has ended.
  const [route, setRoute] = useState<RouteState>(CLOSED_ROUTE);
  /** What the route choice is for: a reply, or a Re-ask (the same choice, its own words). */
  const [routeFor, setRouteFor] = useState<'reply' | 'reask'>('reply');
  const reaskRef = useRef<HTMLButtonElement>(null);
  const routeForRef = useRef(routeFor);
  routeForRef.current = routeFor;
  useEffect(() => {
    if (!asking) return;
    setRoute((current) => (current.open ? mergeRouteRows(current, asking, live) : current));
    // Only a new read of the live sessions merges; `asking` follows the thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  const [newMessage, setNewMessage] = useState<NewMessageMode>(null);
  const pressNewMessage = async () => {
    if (newMessage?.kind === 'pick' || newMessage?.kind === 'none') {
      setNewMessage(null);
      return;
    }
    const now = await loadLive();
    const sessions = now?.sessions ?? [];
    closeBox();
    setRoute(CLOSED_ROUTE);
    setNewMessage(sessions.length === 0 ? { kind: 'none' } : sessions.length === 1 ? { kind: 'compose', target: sessions[0]! } : { kind: 'pick' });
  };

  const fileRecords = useMemo(() => records.filter(isFileComment), [records]);
  // Comments on the text of agents' messages (approval "inbox-message-comments"), by message.
  const messageComments = useMemo(() => {
    const byMessage = new Map<string, Annotation[]>();
    for (const record of records) {
      if (!record.message) continue;
      byMessage.set(record.message_id, [...(byMessage.get(record.message_id) ?? []), annotationOf(record)]);
    }
    return byMessage;
  }, [records]);
  /** Comments whose words were not found in their message (the reply box's list marks them). */
  const [unanchoredComments, setUnanchoredComments] = useState<ReadonlySet<string>>(NO_IDS);
  const noteUnanchored = useCallback((report: { attempted: readonly string[]; unanchored: readonly string[] }) => {
    setUnanchoredComments((current) => {
      const next = new Set(current);
      for (const id of report.attempted) next.delete(id);
      for (const id of report.unanchored) next.add(id);
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
  }, []);
  // A comment sent or removed is no longer waiting: its unanchored mark goes with it.
  useEffect(() => {
    setUnanchoredComments((current) => {
      if (current.size === 0) return current;
      const waiting = new Set(records.map((r) => r.id));
      const next = new Set([...current].filter((id) => waiting.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [records]);
  /** A message comment's row in the reply box's list: "Claude Code's message, 2:58 PM". */
  const messageCommentName = (record: InboxAnnotationRecord) => {
    const message = thread.messages.find((m) => m.id === record.message_id);
    const who = message ? agentName(message.author) : 'Agent';
    return `${who}'s message, ${whenTime(record.message?.at ?? message?.created_at ?? '')}`;
  };
  const saveMessageComment = async (messageId: string, annotation: Annotation): Promise<boolean> => {
    try {
      const result = await inboxApi.saveMessageAnnotation(messageId, annotation);
      saveRecord(result.annotation);
      return true;
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The comment was not saved.');
      return false;
    }
  };
  /** Something here takes annotations: an attached file, or a guided review's diffs. */
  const takesAnnotations = allFiles.length > 0 || records.length > 0 || thread.messages.some((m) => m.guide);
  /**
   * The open file is full screen (approval "inbox-one-fullscreen"): it fills
   * the window under one floating toolbar, which always starts showing (the
   * Inbox does not follow plan review's shared hide-tools choice). A step
   * keeps it.
   */
  // The view rides the address (`view=full|side`; fileView.ts): a link without it opens by the remembered choice, else by kind.
  const fileAttachment = file ? (allFiles.find((a) => a.id === file.id) ?? null) : null;
  const viewOf = (narrow: boolean) =>
    file ? fileViewFor(fileAttachment ?? { kind: 'file' }, { address: parseFileView(file.view), choice: readFileViewChoice(), narrow }) : 'side';
  /** The view the file is in, as the address carries it (a phone's or a stacked window's room left out). */
  const full = viewOf(false) === 'full';
  /** What the window shows: full screen also wherever there is no room for the file beside the thread. */
  const shownFull = viewOf(phone || fileStacked) === 'full';
  /** The view the open file is in, carried by every route change that keeps the frame (a step, a version, a linked page). */
  const currentView: FileView = full ? 'full' : 'side';
  const fileRef = useRef(file);
  fileRef.current = file;
  /** Switch the open file's view in place (the same history entry). Escape's last rung, a Send: never saved. */
  const setFull = (next: boolean) => {
    const current = fileRef.current;
    if (current) onOpenFile({ ...current, view: next ? 'full' : 'side' }, { replace: true });
  };
  /**
   * The person picked a view with a button: it applies now and to every
   * file opened next. A phone or a stacked window has no such button and
   * saves nothing. `next` is the view on screen when the person pressed the
   * switch's pressed half (it saves the choice, the frame stays). When the
   * remembered choice changes, the window's toast says so once, with Undo:
   * the old choice back and, if the press moved this file and it is still
   * the one open, its old view; another file open by then keeps its frame.
   */
  const pickView = (next: FileView) => {
    const pickedOn = fileRef.current?.id ?? null;
    const viewBefore = currentView;
    setFull(next === 'full');
    if (phone || fileStacked) return;
    const before = readFileViewChoice();
    writeFileViewChoice(next);
    if (before === next) return;
    const lead = next === 'side' ? 'Files open side by side now' : 'Files open full screen now';
    const detail = next === 'side' ? 'until you choose Full screen' : 'until you choose Side by side';
    onToast?.({
      icon: 'check',
      lead,
      detail,
      speech: `${lead}, ${detail}.`,
      onUndo: () => {
        writeFileViewChoice(before);
        if (viewBefore !== next && pickedOn !== null && fileRef.current?.id === pickedOn) setFull(viewBefore === 'full');
      },
    });
  };
  /** Bumped when the person opens a file, so focus moves into its pane. */
  const [paneFocus, setPaneFocus] = useState(0);
  const paneRef = useRef<AttachmentPaneHandle>(null);
  /**
   * The thread's artifacts (artifacts.ts): one list, read by the Artifacts view
   * (newest first) and by the viewer's stepping and its peek (thread order, the
   * guided reviews left out: they open their own reader).
   */
  const artifactList = useMemo(() => threadArtifacts(thread.messages, attachments, inlineImages), [thread.messages, attachments, inlineImages]);
  /** Every file of the thread in thread order: what the pane steps through. */
  const steps = useMemo(() => stepsOf(artifactList), [artifactList]);
  /** The Artifacts view swaps the thread's body for the grid (the messages never change). */
  const artifactsOn = artifactsRoute;
  /** The button shows once the thread's files have loaded and something is there (or the view is open, from a link). */
  const artifactsButton = onArtifacts !== undefined && ((files !== null && artifactList.length > 0) || artifactsOn);
  const artifactsButtonRef = useRef<HTMLButtonElement>(null);
  const artifactsHeadingRef = useRef<HTMLHeadingElement>(null);
  const artifactsBodyRef = useRef<HTMLDivElement>(null);
  /** The tile last opened from the grid: focus comes back to it when its file or guide closes. */
  const artifactOpened = useRef<string | null>(null);
  const openFile = (attachment: Pick<InboxAttachmentState, 'id' | 'kind' | 'ref'>, version: 'current' | 'sent' = 'current', focus: string | null = null, view: FileView | null = null) => {
    // A tile's ⋯ names a view for this file alone. The file already open keeps the view it is in (a comment
    // card in the reply box, its tile again: a one-off view from the ⋯ stays). Else the remembered choice,
    // else today's rule (fileView.ts).
    const kept = file && file.id === attachment.id ? currentView : null;
    onOpenFile({ id: attachment.id, version, focus, view: view ?? kept ?? openingView(attachment) });
  };
  /** A tile, or a link in a message: the file as it is now, focus in its pane (a typed comment in the open file asks first). */
  /** `opening`: called only when the file does open (not after "Keep writing" on a typed comment). */
  const openFromMessage = (attachment: Pick<InboxAttachmentState, 'id' | 'kind' | 'ref'> & { name?: string }, view: FileView | null = null, opening?: () => void) => {
    const go = () => {
      opening?.();
      openFile(attachment, 'current', null, view);
      setPaneFocus((n) => n + 1);
    };
    const pane = paneRef.current;
    if (pane && file && file.id !== attachment.id) pane.leave(attachment.name ?? allFiles.find((a) => a.id === attachment.id)?.name ?? 'that file', go);
    else go();
  };
  const openRecord = (record: InboxAnnotationRecord) => {
    // A comment on a guided review's diff: open that guide.
    if (record.guide) {
      onOpenGuide(record.message_id);
      return;
    }
    // A comment on a message's text: that message, its passage brought into view and rung.
    if (record.message) {
      // A place held after a file must not pull the thread back over the passage (show() scrolls inside rAF).
      stopHold();
      const show = () => {
        stopHold();
        const mark = bodyRef.current?.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(record.message_id)}"] [data-bind-id="${CSS.escape(record.id)}"], [data-message-id="${CSS.escape(record.message_id)}"] [data-highlight-id="${CSS.escape(record.id)}"]`,
        );
        const target = mark ?? articleOf(record.message_id);
        if (!target) return;
        target.scrollIntoView?.({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
        target.classList.remove('ib-q-target-out');
        target.classList.add('ib-q-target');
        setTimeout(() => {
          target.classList.add('ib-q-target-out');
          target.classList.remove('ib-q-target');
          setTimeout(() => target.classList.remove('ib-q-target-out'), 700);
        }, 1400);
      };
      if (unfold(record.message_id)) requestAnimationFrame(() => requestAnimationFrame(show));
      else show();
      return;
    }
    const attachment = allFiles.find((a) => a.id === record.attachment_id);
    if (!attachment) return;
    const go = () => openFile(attachment, record.version === 'current' ? 'current' : 'sent', record.id);
    // Another file than the one open: a typed comment in the open file asks first.
    if (paneRef.current && file && file.id !== attachment.id) paneRef.current.leave(attachment.name, go);
    else go();
  };
  const countsByPath = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of fileRecords) counts.set(record.path, (counts.get(record.path) ?? 0) + 1);
    return counts;
  }, [fileRecords]);
  const saveRecord = useCallback(
    (record: InboxAnnotationRecord) => patchRecords((list) => [...list.filter((r) => r.id !== record.id), record]),
    [patchRecords],
  );
  const dropRecord = useCallback((id: string) => patchRecords((list) => list.filter((r) => r.id !== id)), [patchRecords]);
  const editRecord = async (record: InboxAnnotationRecord, text: string) => {
    try {
      const next = { ...annotationOf(record), text };
      const result = record.guide
        ? await inboxApi.saveGuideAnnotation(record.message_id, next)
        : record.message
          ? await inboxApi.saveMessageAnnotation(record.message_id, next)
          : await inboxApi.saveAnnotation(record.attachment_id, record.version, next);
      saveRecord(result.annotation);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not saved.');
    }
  };
  const removeRecord = async (record: InboxAnnotationRecord) => {
    try {
      await inboxApi.removeAnnotation(record.id);
      dropRecord(record.id);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not removed.');
    }
  };
  /** The annotations as Plannotator's feedback text: each file version's text read now, so line numbers are what the person read. */
  const buildFeedback = async (pending: readonly InboxAnnotationRecord[]): Promise<string> => {
    const texts = new Map<string, string>();
    for (const record of pending) {
      // A guided-review comment carries its own file and lines; a message comment quotes its words.
      if (record.guide || record.message) continue;
      const attachment = allFiles.find((a) => a.id === record.attachment_id) ?? allFiles.find((a) => a.path === record.path);
      if (!attachment) continue;
      const key = `${attachment.id}\0${record.version}`;
      if (texts.has(key)) continue;
      // Code comments carry their own lines and an image has none: only documents need their text read.
      const kind = readInboxAttachmentKind(attachment.kind);
      if (!isInboxTextKind(kind) || kind === 'code') continue;
      try {
        texts.set(key, (await inboxApi.view(attachment.id, record.version === 'current' ? 'current' : 'sent')).text);
      } catch {
        texts.set(key, '');
      }
    }
    return attachmentFeedback(pending, allFiles, texts, thread.project.root, {
      personMessageIds: new Set(thread.messages.filter((m) => m.author.kind === 'person').map((m) => m.id)),
      // A comment that tags agents is marked in the export (approval "inbox-tag-agents").
      tagNames: (ids) => ids.map((id) => tagOpts.find((o) => o.id === id)?.label ?? 'an agent'),
    });
  };

  useEffect(() => {
    // Another thread: nothing of the last one carries over.
    setPending(new Map());
    setBox({ open: false, text: '' });
    replyFiles.reset();
    setError(null);
    setNewMessage(null);
    setStale([]);
    setGuard(false);
    setRoute(CLOSED_ROUTE);
    setSkipArmed(null);
    sendKeys.current = null;
    sendContents.current = null;
    revisions.current.clear();
  }, [thread.thread_id]);

  // The subject in the header once it scrolls away, and the "↓ N new" pill
  // while new messages the person has not seen are below the view (its count:
  // those messages, never everything new this visit).
  const [chrome, setChrome] = useState({ subject: false, pill: 0 });
  /** The new messages the person has had on screen this visit (newBelow): the pill never counts them again. */
  const passed = useRef<{ threadId: string; ids: Set<string> }>({ threadId: thread.thread_id, ids: new Set() });
  const passedIds = useCallback((): Set<string> => {
    if (passed.current.threadId !== thread.thread_id) passed.current = { threadId: thread.thread_id, ids: new Set() };
    return passed.current.ids;
  }, [thread.thread_id]);
  /** Whether what is on screen now counts as shown: the tab visible and nothing over the thread. */
  const showingRef = useRef(true);
  const updateChrome = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const box = body.getBoundingClientRect();
    const subject = body.querySelector<HTMLElement>('.ib-subject');
    const shown = showingRef.current && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
    const next = {
      subject: subject !== null && subject.getBoundingClientRect().bottom < box.top + 4,
      pill: newBelow(body, passedIds(), shown).length,
    };
    setChrome((current) => (current.subject === next.subject && current.pill === next.pill ? current : next));
  }, [passedIds]);

  // ── Seen on sight (design record "inbox-new-in-open-thread", variant A) ──
  // An agent message that arrives while the thread is open counts as seen once
  // its first lines have been on screen for a second, the window in front and
  // nothing over the thread; the window then records the look up to it.
  /** Arrivals the person has seen this visit (kept for the visit: the pill leaves them out). */
  const [sighted, setSighted] = useState<{ threadId: string; ids: ReadonlySet<string> }>(() => ({ threadId: thread.thread_id, ids: new Set() }));
  const sightedIds: ReadonlySet<string> = sighted.threadId === thread.thread_id ? sighted.ids : NO_IDS;
  const arrivals = useMemo(() => (onSeen ? unseenArrivals(thread.messages, seenThrough) : []), [onSeen, thread.messages, seenThrough]);
  /** The arrivals still to be seen (and those seen whose look is not recorded yet): the pill counts these first. */
  const arrivalIds = useMemo(() => new Set(arrivals.map((m) => m.id)), [arrivals]);
  const candidates = arrivals.filter((m) => !sightedIds.has(m.id) && !fold.folded.has(m.id) && !hiddenNow.has(m.id)).map((m) => m.id);
  /** A file over the thread: full screen, or where it cannot sit beside it (a phone, a stacked window). */
  const fileCovers = file !== null && shownFull;
  const arrivalsRef = useRef(arrivals);
  arrivalsRef.current = arrivals;
  const sightedRef = useRef(sightedIds);
  sightedRef.current = sightedIds;
  const sawOne = useCallback(
    (id: string) => {
      if (sightedRef.current.has(id)) return;
      const ids = new Set(sightedRef.current).add(id);
      sightedRef.current = ids;
      setSighted({ threadId: thread.thread_id, ids });
      // The look goes as far as every arrival up to it was seen, never past one that was not.
      const through = lookThrough(arrivalsRef.current, ids);
      if (through !== null) onSeen?.(through);
    },
    [onSeen, thread.thread_id],
  );
  // On a phone the pill sits in the foot and covers none of the thread.
  useSeenOnSight({ bodyRef, candidates, covered: covered || fileCovers || artifactsOn, pill: chrome.pill > 0 && !phone, onSeen: sawOne });
  // The thread on screen, for notifications: a question in it raises nothing while it is visible.
  const screenRef = useRef(onScreenChange);
  screenRef.current = onScreenChange;
  const paneCovered = covered || fileCovers || artifactsOn;
  showingRef.current = !paneCovered;
  useEffect(() => {
    screenRef.current?.({ threadId: thread.thread_id, covered: paneCovered });
  }, [thread.thread_id, paneCovered]);
  useEffect(() => () => screenRef.current?.(null), []);

  // The Artifacts view: opening it moves focus to its heading, leaving it returns focus to the Artifacts
  // button (the messages keep the scroll they had). Only on a change in this pane, never on the first draw
  // (a reload or a link lands where the window puts focus).
  const artifactsWas = useRef(artifactsOn);
  const threadScroll = useRef(0);
  useLayoutEffect(() => {
    if (artifactsWas.current === artifactsOn) return;
    artifactsWas.current = artifactsOn;
    if (artifactsOn) {
      artifactsHeadingRef.current?.focus({ preventScroll: true });
      return;
    }
    if (bodyRef.current) bodyRef.current.scrollTop = threadScroll.current;
    const button = artifactsButtonRef.current;
    if (button) button.focus();
    else bodyRef.current?.querySelector<HTMLElement>('.ib-subject')?.focus({ preventScroll: true });
  }, [artifactsOn]);
  // The thread's scroll, kept while the grid is shown over it.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || artifactsOn) return;
    const keep = () => {
      threadScroll.current = body.scrollTop;
    };
    body.addEventListener('scroll', keep, { passive: true });
    return () => body.removeEventListener('scroll', keep);
  }, [artifactsOn]);
  // ── Your place in the thread, around a file (threadPlace.ts) ──
  // Beside a file the thread is a narrow column, under a full-screen file it is covered, and on a phone or a
  // stacked window it is display:none (WebKit then forgets its scrollTop). Each time that changes, the place
  // on screen is read and put back once the new layout is laid out: the tile or image the person opened at the
  // same distance from the top, else the first thing that was in view. A hidden layout keeps the place it was
  // given, so closing the file brings the thread back where it was. Never the open-time landing (the New
  // divider): that runs once per thread.
  const placeKey = placeLayoutKey({ thread: thread.thread_id, file: fileCovers ? 'covered' : file ? 'side' : 'none', grid: artifactsOn, guide: covered });
  /** The last tile, image or link a click or key in the thread was aimed at, and whether it came from the keyboard. */
  const lastOpener = useRef<{ el: HTMLElement; keyboard: boolean; at: number } | null>(null);
  /** The tile or image the open file was opened from by keyboard: focus goes back to it when the file closes. */
  const returnFocus = useRef<{ el: HTMLElement; selector: string | null } | null>(null);
  /**
   * `saved`: the place to put back. `placedTop`: the scrollTop it was put back at; a scroll elsewhere (the person,
   * `n`, a jump to a card) means the place on screen is the one to read next time, else `saved` is kept as it
   * was (beside a file the thread is narrower and taller, and reading it there would lose what a clamp cost).
   */
  const place = useRef<{ committed: string; read: string | null; saved: ThreadPlace | null; placedTop: number | null }>({ committed: placeKey, read: null, saved: null, placedTop: null });
  // Read in render, not in an effect: by the time any effect runs React has committed the new layout (the
  // thread already narrowed, hidden or uncovered), so the old place can no longer be measured.
  if (place.current.committed !== placeKey && place.current.read !== placeKey) {
    place.current.read = placeKey;
    const was = parsePlaceLayout(place.current.committed);
    const body = bodyRef.current;
    const sameThread = was.thread === thread.thread_id;
    // The opener counts only when it opens the file that is opening now (not a button pressed a moment ago).
    const recent = lastOpener.current && performance.now() - lastOpener.current.at < 2000 ? lastOpener.current : null;
    const opener = sameThread && was.file === 'none' && file && recent && opensFile(recent.el, file.id) ? recent : null;
    stopHold();
    const untouched = was.file !== 'none' && place.current.saved !== null && place.current.placedTop !== null && body !== null && Math.abs(body.scrollTop - place.current.placedTop) <= 1;
    if (!sameThread) place.current.saved = null;
    else if (placeShown(was) && body && !untouched) {
      place.current.saved = capturePlace(body, opener?.el ?? null);
      place.current.placedTop = null;
    }
    // A file opening from the messages on screen: remember what opened it by keyboard, for focus on the way back.
    if (sameThread && was.file === 'none' && file && placeShown(was)) returnFocus.current = opener?.keyboard ? { el: opener.el, selector: placeSelector(opener.el) } : null;
  }
  useLayoutEffect(() => {
    const was = parsePlaceLayout(place.current.committed);
    place.current.committed = placeKey;
    place.current.read = null;
    const now = parsePlaceLayout(placeKey);
    if (placeLayoutKey(was) === placeKey) return;
    const body = bodyRef.current;
    // The file closed: whatever focus it is owed is settled here (the Artifacts grid gives focus back itself).
    const focusBack = now.file === 'none' && was.file !== 'none' ? returnFocus.current : null;
    if (now.file === 'none') returnFocus.current = null;
    if (!body || !placeShown(now)) return;
    const saved = place.current.saved;
    const placed = () => {
      place.current.placedTop = body.scrollTop;
    };
    // A file opening beside the thread moves the thread only when what was opened would leave the view: the
    // narrower column keeps what the person sees above it (the message's head row) where it can.
    if (saved && now.file === 'side' && was.file === 'none' && placeInView(body, saved)) placed();
    else if (saved && restorePlace(body, saved)) {
      placed();
      stopHold();
      holdRef.current = holdPlace(body, saved, placed, undefined, sectionRef.current ?? body);
    }
    // Focus back on what opened the file by keyboard, if nothing else has it.
    if (focusBack) {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        const target = focusBack.el.isConnected && body.contains(focusBack.el) ? focusBack.el : focusBack.selector ? body.querySelector<HTMLElement>(focusBack.selector) : null;
        target?.focus({ preventScroll: true });
      }
    }
    // Only the layout matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onClick = (event: MouseEvent) => {
      const el = openerOf(event.target, body);
      lastOpener.current = el ? { el, keyboard: event.detail === 0, at: performance.now() } : null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const el = openerOf(event.target, body);
      lastOpener.current = el ? { el, keyboard: true, at: performance.now() } : null;
    };
    body.addEventListener('click', onClick, true);
    body.addEventListener('keydown', onKey, true);
    return () => {
      body.removeEventListener('click', onClick, true);
      body.removeEventListener('keydown', onKey, true);
    };
  }, []);

  // A file or a guided review opened from the grid closes: focus back on its tile, unless something took it.
  const gridCovered = file !== null || covered;
  const gridCoveredWas = useRef(gridCovered);
  // A step in the viewer moves on to another file: focus comes back to the tile of the file last open.
  if (file && artifactOpened.current && !artifactOpened.current.startsWith('guide:')) {
    const open = artifactOfFile(artifactList, file.id);
    artifactOpened.current = open ? artifactKey(open) : file.id;
  }
  useEffect(() => {
    const was = gridCoveredWas.current;
    gridCoveredWas.current = gridCovered;
    if (!was || gridCovered || !artifactsOn) return;
    const key = artifactOpened.current;
    if (!key) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      artifactsBodyRef.current?.querySelector<HTMLElement>(`[data-artifact-tile="${CSS.escape(key)}"]`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [gridCovered, artifactsOn]);

  // Arrivals while the thread is open: announced to a screen reader, drawn
  // with a short entrance, and, when the person is at the end of the thread,
  // scrolled into view just far enough to show their first lines.
  const known = useRef<{ threadId: string; ids: Set<string> } | null>(null);
  const atEndRef = useRef(false);
  const [arrived, setArrived] = useState<{ threadId: string; ids: ReadonlySet<string> }>(() => ({ threadId: thread.thread_id, ids: new Set() }));
  const arrivedIds: ReadonlySet<string> = arrived.threadId === thread.thread_id ? arrived.ids : NO_IDS;
  useLayoutEffect(() => {
    const ids = thread.messages.map((m) => m.id);
    const before = known.current;
    known.current = { threadId: thread.thread_id, ids: new Set(ids) };
    if (!before || before.threadId !== thread.thread_id) return;
    const added = thread.messages.filter((m) => m.author.kind === 'agent' && !before.ids.has(m.id));
    if (added.length === 0) return;
    setArrived((current) => ({ threadId: thread.thread_id, ids: new Set([...(current.threadId === thread.thread_id ? current.ids : []), ...added.map((m) => m.id)]) }));
    const first = added[0]!;
    const asks = added.some((m) => (m.questions ?? []).some((q) => q.state === 'open'));
    announce(
      added.length === 1 ? `New message from ${agentName(first.author)}${asks ? ', with a question' : ''}` : `${added.length} new messages${asks ? ', with a question' : ''}`,
    );
    const body = bodyRef.current;
    if (!body || !atEndRef.current) return;
    const article = articleOf(first.id);
    if (!article) return;
    const by = followBy(measureFirstLines(article), body.getBoundingClientRect());
    if (by > 0) {
      stopHold();
      body.scrollBy?.({ top: by, behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    // `announce` and `articleOf` are this render's; only a new thread payload matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const trackEnd = () => {
      atEndRef.current = atEnd(body);
    };
    trackEnd();
    body.addEventListener('scroll', trackEnd, { passive: true });
    body.addEventListener('scroll', updateChrome, { passive: true });
    window.addEventListener('resize', updateChrome);
    document.addEventListener('visibilitychange', updateChrome);
    // The thread's own box changes without a scroll or a window resize when
    // the foot grows (the reply box, the stale guard, the New-message
    // composer) or a file opens beside it.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => updateChrome()) : null;
    resized?.observe(body);
    return () => {
      body.removeEventListener('scroll', trackEnd);
      body.removeEventListener('scroll', updateChrome);
      window.removeEventListener('resize', updateChrome);
      document.removeEventListener('visibilitychange', updateChrome);
      resized?.disconnect();
    };
  }, [updateChrome]);

  // Where the thread opens: at the "New since you looked" divider with the
  // last read line just above it, or at the top when nothing is new. Once per thread.
  const landed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!foldState || foldState.threadId !== thread.thread_id || landed.current === thread.thread_id) return;
    landed.current = thread.thread_id;
    const body = bodyRef.current;
    if (!body) return;
    const divider = body.querySelector<HTMLElement>('[data-new-divider]');
    const above = divider?.previousElementSibling as HTMLElement | null | undefined;
    body.scrollTop = divider ? Math.max(0, (above ? above.offsetTop : divider.offsetTop) - 6) : 0;
  }, [foldState, thread.thread_id]);

  // After a fold or an open: the message the person acted on stays where it
  // was, and keeps focus. Then the header subject and the pill follow. Only
  // when the fold, the thread or the file beside it changed (never on a keystroke in the reply box).
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const body = bodyRef.current;
    if (anchor && body) {
      const article = anchor.id ? articleOf(anchor.id) : null;
      if (article) {
        body.scrollTop += article.getBoundingClientRect().top - anchor.top;
        // A long message folded from below its top: bring its line into view.
        if (anchor.folding && article.getBoundingClientRect().top < body.getBoundingClientRect().top) article.scrollIntoView?.({ block: 'start' });
      }
      const focus = anchor.focus ? headOf(anchor.focus) : null;
      if (focus) {
        focus.focus({ preventScroll: true });
        const r = focus.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        if (r.top < b.top + 8 || r.bottom > b.bottom - 8) focus.scrollIntoView?.({ block: 'nearest' });
      }
    }
    updateChrome();
  }, [foldState, thread, file?.id, updateChrome, sighted, paneCovered]);

  /**
   * n goes to the first new message (at the divider); the pill to what it
   * counts (newBelow): the first arrival not yet seen below the view, else
   * the first message new at the open below it, which is the first new one
   * unless the person has read past it.
   */
  const jumpNew = useCallback((below = false) => {
    const body = bodyRef.current;
    const first = body?.querySelector<HTMLElement>('[data-message-article][data-new]');
    if (!body || !first) return;
    const target = below ? (newBelow(body, passedIds(), false)[0] ?? first) : first;
    const divider = target === first ? body.querySelector<HTMLElement>('[data-new-divider]') : null;
    holdRef.current?.();
    holdRef.current = null;
    (divider ?? target).scrollIntoView?.({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    target.querySelector<HTMLElement>('[data-fold-head]')?.focus({ preventScroll: true });
  }, [passedIds]);

  // j / k move between messages (and the middle fold), n goes to the first
  // new one; Enter and Space are the buttons' own. Never while typing, and
  // never while the Artifacts grid stands in for the messages.
  useEffect(() => {
    if (one || artifactsOn) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (event.key !== 'j' && event.key !== 'k' && event.key !== 'n') return;
      // Words selected in a message: its toolbar takes the letters (a comment starting with them).
      if (selectionToolbarShowing()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target) {
        if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
        if (target.tagName === 'INPUT' && !['radio', 'checkbox'].includes((target as HTMLInputElement).type)) return;
        // Keys aimed at the open file, a dialog or a popover are theirs.
        if (target !== document.body && !sectionRef.current?.contains(target)) return;
        if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      }
      const body = bodyRef.current;
      if (!body) return;
      event.preventDefault();
      if (event.key === 'n') {
        jumpNew();
        return;
      }
      const heads = [...body.querySelectorAll<HTMLElement>('[data-fold-head]')];
      if (heads.length === 0) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const home = active?.closest('[data-message-article], [data-middle-fold]') ?? null;
      let index = heads.findIndex((h) => h === active || (home !== null && h.closest('[data-message-article], [data-middle-fold]') === home));
      if (index < 0) {
        const top = body.getBoundingClientRect().top;
        index = heads.findIndex((h) => h.getBoundingClientRect().top >= top) - (event.key === 'j' ? 1 : 0);
      }
      const next = heads[Math.max(0, Math.min(heads.length - 1, index + (event.key === 'j' ? 1 : -1)))];
      if (next) {
        next.focus({ preventScroll: true });
        next.scrollIntoView?.({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [one, artifactsOn, jumpNew]);

  // Another window (or a phone's Send) saved, sent or discarded this thread's draft, or this one did:
  // its copy here follows. A box with no edits since its last save or read takes the new words (or
  // closes when the draft is gone); a box with edits keeps them, and the conflict shows (replyDraft.ts).
  const reloadDraft = replyDraft.reload;
  const boxRef = useRef(box);
  boxRef.current = box;
  const hasFilesRef = useRef(false);
  hasFilesRef.current = replyFiles.files.length > 0;
  useEffect(() => {
    if (draftChanged === 0) return;
    const local = boxRef.current.open ? boxRef.current.text : null;
    void reloadDraft(local).then((answer) => {
      if (!answer?.replaceBox) return;
      // Typed into meanwhile: those words win, and the next save is refused if the draft moved.
      if (!boxRef.current.open || boxRef.current.text !== local) return;
      if (answer.draft) {
        setBox({ open: true, text: answer.draft.body });
        announce('This reply changed in another window.');
      } else {
        // Sent or discarded elsewhere: nothing of it is left to show (pasted files keep the box open).
        setBox({ open: hasFilesRef.current, text: '' });
        if (!hasFilesRef.current) setTaggedIds([]);
        announce('This reply was sent or discarded in another window.');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftChanged, reloadDraft]);

  // A conflict appears (both windows hold words): said once in the thread's live region.
  const conflictShown = replyDraft.conflict !== null;
  const conflictSentElsewhere = replyDraft.draft === null;
  useEffect(() => {
    if (!conflictShown) return;
    announce(conflictText(conflictSentElsewhere));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflictShown]);

  // The thread's draft, once read, goes back in the box (open, without focus), unless the person already wrote there.
  useEffect(() => {
    if (replyDraft.loadedFor !== thread.thread_id || restoredFor.current === thread.thread_id) return;
    restoredFor.current = thread.thread_id;
    // Words a conflict left unsaved here come back before the draft another window holds.
    const kept = replyDraft.conflict ?? replyDraft.draft?.body ?? null;
    if (kept === null) return;
    setBox((current) => {
      if (current.open && current.text.trim()) return current;
      if (!current.open) restoringRef.current = true;
      return { open: true, text: kept };
    });
  }, [replyDraft.loadedFor, replyDraft.draft, replyDraft.conflict, thread.thread_id]);

  useEffect(() => {
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    if (box.open) textRef.current?.focus();
  }, [box.open]);

  // The update control's restart guard: an unsent reply is the one thing a
  // restart (a page reload) would lose.
  // Words are kept as a draft (and sent as the page goes); only files pasted into the box are not.
  // The restart guard asks while files pasted into the box, or words not saved yet (a save waiting or on
  // its way, words a conflict left unsaved: replyDraftUnsaved, read when the guard asks), would be lost.
  const unsentSubject = thread.subject ?? 'this thread';
  const unsentFiles = box.open && replyFiles.files.length > 0;
  useEffect(() => {
    reportUnsentReply({ subject: unsentSubject, files: unsentFiles });
    return () => reportUnsentReply(null);
  }, [unsentSubject, unsentFiles]);

  const questionById = (id: string): InboxQuestion | undefined => {
    for (const message of threadRef.current.messages) {
      for (const q of message.questions ?? []) if (`${q.message_id}/${q.key}` === id) return q;
    }
    return undefined;
  };

  const pick = (messageId: string, key: string, answer: QuestionAnswer | null) => {
    const id = `${messageId}/${key}`;
    setPending((current) => new Map(current).set(id, answer));
    setError(null);
    pickChain.current = pickChain.current.then(async () => {
      const known = questionById(id);
      const revision = Math.max(revisions.current.get(id) ?? 0, known?.revision ?? 0);
      try {
        const result = await inboxApi.pick(messageId, key, revision, answer);
        for (const q of result.questions) revisions.current.set(`${q.message_id}/${q.key}`, q.revision);
        // A Send waiting on this chain reads the thread right after it, before
        // React draws the saved picks: give it the saved questions now, or it
        // sends a stale revision (refused) or leaves out a note just saved.
        const latest = threadRef.current;
        threadRef.current = { ...latest, messages: latest.messages.map((m) => (m.id === messageId ? { ...m, questions: result.questions } : m)) };
        onQuestions(messageId, result.questions);
      } catch (cause) {
        // The agent replaced the question meanwhile: reading the thread again redraws it as Replaced.
        if (!isSuperseded(cause)) setError(cause instanceof InboxApiError ? cause.message : 'The pick was not saved.');
        await onChanged();
      } finally {
        setPending((current) => {
          if (!current.has(id) || current.get(id) !== answer) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      }
    });
  };

  const answersOf = (message: InboxMessageWire): Map<string, QuestionAnswer> => {
    const out = new Map<string, QuestionAnswer>();
    for (const q of message.questions ?? []) {
      const id = `${message.id}/${q.key}`;
      const answer = pending.has(id) ? pending.get(id)! : q.answer;
      if (answer) out.set(q.key, answer);
    }
    return out;
  };

  const sentAt = (replyId: string | null): string | null => {
    const reply = replyId ? thread.messages.find((m) => m.id === replyId) : undefined;
    return reply ? reply.created_at : null;
  };

  const footerFor = (message: InboxMessageWire) => (key: string): string | null => {
    const q = message.questions?.find((x) => x.key === key);
    if (!q) return null;
    if (q.state === 'sent') {
      const at = sentAt(q.sent_reply_id);
      // The person skipped it with "Skip them" on the Send (approval "inbox-explicit-skip").
      if (q.answer?.skipped && q.answer.by_reply) return at ? `Skipped · ${whenTime(at)}` : 'Skipped';
      return at ? `Sent ${whenTime(at)}` : 'Sent';
    }
    if (q.state === 'closed' && q.set_aside_at) return `Closed unanswered when you marked it read · ${whenTime(q.set_aside_at)}`;
    if (q.state === 'picked' && q.picked_at) return `Picked ${whenTime(q.picked_at)} · in your draft`;
    // Re-ask: the person asked the agent for it again; it stays open until the agent replaces it.
    const reaskedBy = reaskedIn(thread.messages, message.id, q);
    if (reaskedBy) return `Asked again ${whenTime(reaskedBy.created_at)}`;
    return null;
  };

  // What a Send carries: every picked, unsent answer, per message. A pick on a
  // superseded question is never one of them (its state is "superseded").
  const picked = thread.messages.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'picked'));
  const picksCount = picked.length;
  // Picks the agent's replacement dropped since the person's last reply: the
  // reply box shows them struck, never in "N picks".
  const lastReplyAt = thread.messages.filter(isPersonReply).at(-1)?.created_at ?? '';
  const dropped = thread.messages.flatMap((m) =>
    (m.questions ?? []).filter((q) => {
      if (q.state !== 'superseded' || q.answer === null) return false;
      const by = thread.messages.find((x) => x.id === q.superseded_by?.message_id);
      return !by || by.created_at > lastReplyAt;
    }),
  );
  const staleQuestions = stale
    .map((id) => thread.messages.flatMap((m) => m.questions ?? []).find((q) => `${q.message_id}/${q.key}` === id))
    .filter((q): q is InboxQuestion => q !== undefined && q.state === 'superseded');
  /** Acting on the panel: these replacements were seen, so Send goes as asked from now on. */
  const acknowledgeStale = () => {
    setStale([]);
    setGuard(false);
  };
  /** Picks or annotations wait for a Send. */
  const waiting = picksCount > 0 || records.length > 0;
  /** The box is closed and its words are kept as a draft (Cancel or Escape kept them): Edit draft brings them back. */
  const draftKept = !box.open && (replyDraft.draft !== null || replyDraft.conflict !== null);

  // The answers this reply carries, as the cards show them now: a saved pick, or one being
  // saved. The box lists them live (ReplyAnswers); they never go into the words, where a
  // summary written once would go stale as the person picks on and reach the agent twice
  // (the Send carries every answer under "Answers to your questions").
  const draftAnswers: DraftAnswer[] = thread.messages.flatMap((m) =>
    m.author.kind !== 'agent'
      ? []
      : (m.questions ?? []).flatMap((q) => {
          if (q.state !== 'open' && q.state !== 'picked') return [];
          const id = `${m.id}/${q.key}`;
          const answer = pending.has(id) ? pending.get(id)! : q.answer;
          if (!answer || isQuestionAnswerEmpty(answer)) return [];
          return [{ id, messageId: m.id, key: q.key, number: q.position + 1, prompt: q.prompt, answer: draftAnswerWords(answer), messageName: `${agentName(m.author)}'s message, ${whenTime(m.created_at)}` }];
        }),
  );

  // The person's own sent replies are drawn in their words, with the answers they carried as a
  // short list read from the questions (sentReply.ts): never the agent-facing answers section.
  const sentAnswersByReply = useMemo(() => {
    const out = new Map<string, SentAnswerGroup[]>();
    for (const m of thread.messages) {
      if (m.author.kind !== 'person') continue;
      const groups = sentAnswersOf(m, thread.messages, (asked) => `${agentName(asked.author)}'s message, ${whenTime(asked.created_at)}`);
      if (groups.length > 0) out.set(m.id, groups);
    }
    return out;
  }, [thread.messages]);

  const openBox = () => {
    setNewMessage(null);
    setRoute((current) => ({ ...current, open: false, error: null }));
    // A draft's words come back as they were; the picks are listed beside them, never written in.
    const kept = replyDraft.conflict ?? replyDraft.draft?.body ?? '';
    setBox({ open: true, text: kept.trim() ? kept : '' });
    setError(null);
  };

  /** Back from the choice to the reply: the draft and its choice kept, focus at the end of the text. */
  const routeBack = useCallback(() => {
    setRoute((current) => ({ ...current, open: false, error: null }));
    if (routeForRef.current === 'reask') {
      setRouteFor('reply');
      requestAnimationFrame(() => reaskRef.current?.focus());
      return;
    }
    requestAnimationFrame(() => {
      const text = textRef.current;
      if (text) {
        text.focus();
        text.setSelectionRange(text.value.length, text.value.length);
      } else {
        sendRef.current?.focus();
      }
    });
  }, []);

  /**
   * What the person added after a Send that went without its answer (comments, picks, files it did not
   * carry): said plainly, since they are still to send. Null when nothing was added.
   */
  const leftoverText = (earlier: UnconfirmedSend): string | null => {
    const comments = records.filter((r) => !earlier.comments.includes(r.id)).length;
    const picks = picked.filter((q) => !earlier.picks.includes(`${q.message_id}/${q.key}`)).length;
    const files = replyUploads.filter((id) => !earlier.uploads.includes(id)).length;
    const parts = [
      comments > 0 ? `${comments} comment${comments === 1 ? '' : 's'}` : null,
      picks > 0 ? `${picks} pick${picks === 1 ? '' : 's'}` : null,
      files > 0 ? `${files} file${files === 1 ? '' : 's'}` : null,
    ].filter((part): part is string => part !== null);
    if (parts.length === 0) return null;
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
    return `Your reply went. Not sent yet: ${list}. Press Send to send ${parts.length === 1 && !list.endsWith('s') ? 'it' : 'them'}.`;
  };

  /** The remembered unconfirmed Send turned out to have landed: finish it, and say what is still to send. */
  const finishLanded = (earlier: UnconfirmedSend) => {
    unconfirmed.delete(threadRef.current.thread_id);
    const leftover = leftoverText(earlier);
    finishSent(earlier.uploads, true);
    setError(leftover);
    announce(leftover ?? 'Your reply went.');
  };

  /**
   * The remembered unconfirmed Send stops matching (the words changed or emptied, or the box closed): it is
   * forgotten, its own clear of the draft is expected (a refused save is this window's doing, never "another
   * window"), and the thread is read for it, so the line says honestly where the earlier reply is.
   */
  const forgetUnconfirmed = (earlier: UnconfirmedSend, after: 'edited' | 'emptied' | 'closed') => {
    const id = threadRef.current.thread_id;
    unconfirmed.delete(id);
    replyDraft.expectOwnClear(earlier.words);
    const edited = after === 'edited';
    setError(edited ? 'Your earlier reply may have gone; Send sends your edited words as another reply.' : null);
    void replyLanded(id, earlier.key).then(async (landed) => {
      if (threadRef.current.thread_id !== id) return;
      if (landed === 'yes') {
        const line = edited ? 'Your earlier reply went; Send sends your edited words as another reply.' : 'Your reply went.';
        setError(line);
        announce(line);
        // Its clear_draft went with it: a closed box's foot no longer shows a draft of those words.
        if (after === 'closed') await replyDraft.reload(null);
      } else if (landed === 'no') setError(null);
      else if (landed === 'gone') setError(THREAD_GONE_TEXT);
    });
  };

  // A thread read shows the remembered Send's reply landed: finished now (while the box still holds its words),
  // or forgotten.
  useEffect(() => {
    const earlier = unconfirmed.get(thread.thread_id);
    if (!earlier) return;
    if (!thread.messages.some((m) => m.author.kind === 'person' && m.idempotency_key === earlier.key)) return;
    if (box.open && box.text.trim() === earlier.words) {
      finishLanded(earlier);
      void reloadFiles();
    } else {
      // The words changed since (or the box is closed): the earlier reply went, the box's words are new.
      unconfirmed.delete(thread.thread_id);
      replyDraft.expectOwnClear(earlier.words);
      const leftover = leftoverText(earlier);
      const line = box.open && box.text.trim() ? 'Your earlier reply went; Send sends your edited words as another reply.' : (leftover ?? 'Your reply went.');
      setError(line);
      announce(line);
      if (!box.open) void replyDraft.reload(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread]);

  // Leaving the thread forgets it: a later Send is always an ordinary one.
  useEffect(() => {
    const id = thread.thread_id;
    return () => {
      unconfirmed.delete(id);
    };
  }, [thread.thread_id]);

  /**
   * A Send went: the keys and choice reset, the files it carried leave the box (one pasted while it
   * was in flight keeps it open), the box empties, and its words' draft is done with.
   */
  const finishSent = (carriedUploads: readonly string[], carriedWords: boolean) => {
    sendKeys.current = null;
    sendContents.current = null;
    unconfirmed.delete(threadRef.current.thread_id);
    setRoute(CLOSED_ROUTE);
    setSkipArmed(null);
    const carried = new Set(carriedUploads);
    const sentFiles = new Set(replyFiles.current().filter((f) => f.upload && carried.has(f.upload.upload_id)).map((f) => f.key));
    const later = replyFiles.current().some((f) => !sentFiles.has(f.key));
    replyFiles.forget(sentFiles);
    setBox({ open: later, text: '' });
    if (carriedWords) replyDraft.sent();
    else replyDraft.release();
    setTaggedIds([]);
  };

  const send = async (options: { despiteReplaced?: boolean; routed?: boolean } = {}) => {
    if (sending) return;
    // A pick was replaced while the person was answering: nothing goes until they have read that.
    if (staleQuestions.length > 0 && !options.despiteReplaced) {
      setGuard(true);
      return;
    }
    // Pasted files still uploading: nothing goes until they are in.
    if (replyFiles.uploading) {
      setError('Wait for the files to finish uploading.');
      return;
    }
    // The session that asked has ended and another is live: Send asks where
    // the reply goes first (the choice), and sends nothing yet.
    if (askerEnded && anyOtherLive && asking && !options.routed) {
      const empty = picksCount === 0 && records.length === 0 && boxWords === '' && replyUploads.length === 0 && !skipping;
      if (empty) {
        setError('Write a reply or pick an answer first.');
        return;
      }
      setError(null);
      setRoute((current) => mergeRouteRows({ ...current, open: true, error: null, focus: current.focus + 1 }, asking, live));
      return;
    }
    // The choice's answer: another live session takes the reply (never the
    // session that asked, which a plain reply already reaches).
    const chosen =
      options.routed && route.selected && route.selected !== LEAVE && route.selected !== asking?.session
        ? (route.rows.find((row) => row.live.session === route.selected && !row.ended)?.live ?? null)
        : null;
    const to = chosen ? { host: chosen.host, session: chosen.session } : undefined;
    setSending(true);
    setError(null);
    /** Replies of this Send that went (or were already there, a retry's replays). */
    let went = 0;
    let total = 0;
    /** The Send claimed the thread's draft, and whether it went (else the claim is given back). */
    let claimed = false;
    let done = false;
    /** The reply that carries the box's words, once its POST went out (its idempotency key), and why the Send stopped. */
    let wordsKey: string | null = null;
    let failure: unknown = null;
    /** This Send's words, the requests it posts, and the uploads they carry. */
    let sendWords = '';
    const requests: { messageId: string; input: Parameters<typeof inboxApi.reply>[1] }[] = [];
    let sentUploads: string[] = [];
    try {
      await pickChain.current;
      const current = threadRef.current;
      // The box's words, or (the box closed) the words kept as its draft: the foot's Send carries them too.
      // Before anything goes, the draft's saves are answered (a save landing after the Send would bring the
      // words back), and the Send names the `updated_at` its words were saved as, so the server clears that
      // draft only, never a newer one another window saved meanwhile.
      // The Send claims the thread as it starts: the words waiting are saved, every save in flight is
      // answered, and no save of this thread runs until it ends (the box is read-only meanwhile).
      // A Send of these same words earlier could not be confirmed (the Inbox was down): its reply is looked for
      // first. There, that Send is finished and nothing goes again; not there, this is an ordinary new Send.
      const earlier = unconfirmed.get(current.thread_id);
      unconfirmed.delete(current.thread_id);
      if (earlier && Date.now() - earlier.at < UNCONFIRMED_MS && box.open && earlier.words === boxWords) {
        const landed = await replyLanded(current.thread_id, earlier.key);
        if (landed === 'unknown') {
          unconfirmed.set(current.thread_id, earlier);
          setError('Still no answer from the Inbox, so nothing was sent. Try again in a moment.');
          return;
        }
        if (landed === 'gone') {
          setError(THREAD_GONE_TEXT);
          return;
        }
        if (landed === 'yes') {
          // It went. Anything added since stays, named, for an ordinary Send.
          finishLanded(earlier);
          await onChanged();
          await reloadFiles();
          return;
        }
      }
      let words = boxWords;
      let draftSavedAs: string | null = null;
      const savedAs = await replyDraft.claim();
      claimed = true;
      if (box.open) {
        if (words !== '') draftSavedAs = savedAs;
      } else if (replyDraft.conflict !== null) {
        // Words another window's change left unsaved here: they go, and the newer draft stays.
        words = replyDraft.conflict.trim();
      } else {
        // The box is closed: the words as the draft holds them now (another window may have changed them).
        const fresh = await replyDraft.reload(null);
        const kept = fresh === undefined ? replyDraft.draft : fresh.draft;
        words = kept?.body.trim() ?? '';
        draftSavedAs = kept?.updated_at ?? null;
      }
      sendWords = words;
      // Only the questions the person chose to skip, and only while still open (sendTargetsOf reads the
      // thread as it is now): a pick saved meanwhile is sent instead, a question that landed is left open.
      const skip = skipArmed ?? new Set<string>();
      const pendingAnnotations = records;
      const uploads = box.open ? replyUploads : [];
      const carries = words !== '' || pendingAnnotations.length > 0 || uploads.length > 0;
      // One reply per session. The latest agent message rides last only to carry the words, the
      // annotations and the pasted files; with none, a target with nothing to send is left out.
      const plain = sendTargetsOf(current, skip).filter((t, index, all) => t.questions.length > 0 || t.skip.length > 0 || (carries && index === all.length - 1));
      // A comment on another session's message rides a reply to that message (routeSendAnnotations).
      const { targets, carried } = routeSendAnnotations(current, plain, pendingAnnotations);
      if (targets.length === 0) {
        setError('Write a reply or pick an answer first.');
        return;
      }
      const lastId = targets.at(-1)!.message.id;
      // Every tag of this Send (the words' and every carried comment's), once each, on the last reply.
      const sendTags = sendTagsByTarget(
        targets.map((t) => ({ id: t.message.id, owner: t.message.author.kind === 'agent' ? (t.message.author.session ?? null) : null })),
        taggedIds,
        new Map(targets.map((t) => [t.message.id, (carried.get(t.message.id) ?? []).flatMap((r) => commentTags(r))])),
        tagOpts,
      );
      if (!sendKeys.current) sendKeys.current = new Map();
      // One key per session's reply, kept for a retry.
      for (const t of targets) if (!sendKeys.current.has(replyKeyOf(t.message))) sendKeys.current.set(replyKeyOf(t.message), crypto.randomUUID());
      // A retry whose words, files or annotations changed, or that carries a pick or skip the last try did
      // not: each reply carrying them is a new one (a replay of the old key would drop the new answer). A pick
      // that went with the last try and is now sent only leaves the list, which keeps the key.
      const contents = new Map<string, SentContents>(
        targets.map((t) => [
          replyKeyOf(t.message),
          {
            value: JSON.stringify([
              t.message.id,
              t.message.id === lastId ? [words, uploads, sendTags.get(lastId) ?? []] : [],
              (carried.get(t.message.id) ?? []).map((r) => [r.id, r.updated_at]),
            ]),
            answers: sendTargetAnswerIds(t),
          },
        ]),
      );
      for (const id of replyKeysToRenew(sendContents.current, contents)) sendKeys.current.set(id, crypto.randomUUID());
      sendContents.current = contents;
      // The words and the annotations ride the last reply, after its picks;
      // a comment on another session's message rides the reply to it. The
      // skills each reply's words and comments reference ride it too, as one
      // block at its end (skills.ts: a human-only skill's SKILL.md pasted in, its folder named).
      for (const [index, target] of targets.entries()) {
        const last = index === targets.length - 1;
        const own = carried.get(target.message.id) ?? [];
        const annotationsFeedback = own.length > 0 ? await buildFeedback(own) : '';
        const skills = await inboxSkillsBlock([last ? words : '', ...annotationSkillTexts(own)], INBOX_REPLY_SKILL_AUDIENCE);
        const feedback = withSkillsBlock(annotationsFeedback, skills);
        // The agents tagged anywhere in this Send ride the last reply (a tag in a file comment sends the whole reply).
        const tags = sendTags.get(target.message.id) ?? [];
        requests.push({ messageId: target.message.id, input: {
          idempotency_key: sendKeys.current.get(replyKeyOf(target.message)) ?? crypto.randomUUID(),
          words: last ? words : '',
          questions: target.questions,
          ...(target.skip.length > 0 ? { skip: target.skip } : {}),
          ...(feedback ? { feedback } : {}),
          ...(own.length > 0 ? { annotation_ids: own.map((r) => r.id) } : {}),
          // The pasted files ride the reply that carries the words, as attachments.
          ...(last && uploads.length > 0 ? { uploads } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          // The reply that carries the box's words: their draft goes with the Send (that draft only).
          ...(last && words !== '' && draftSavedAs !== null ? { clear_draft: draftSavedAs } : {}),
          // Only a message the ended session asked goes to the session picked;
          // an answer to another session's message still goes to that session.
          ...(to && target.message.author.kind === 'agent' && target.message.author.session === asking?.session ? { to } : {}),
        } });
      }
      // The tiles this Send carries, by the uploads its requests carry: a file pasted while it is in flight stays.
      sentUploads = requests.flatMap((r) => r.input.uploads ?? []);
      total = requests.length;
      for (const request of requests) {
        if (request.input.words) wordsKey = request.input.idempotency_key;
        await inboxApi.reply(request.messageId, request.input);
        went += 1;
      }
      done = true;
      finishSent(sentUploads, words !== '');
      setFull(false);
      await onChanged();
      await reloadFiles();
      // The reply and where it is now sit at the foot of the thread.
      requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
    } catch (cause) {
      failure = cause;
      if (isSuperseded(cause)) {
        // The race: the agent replaced a picked question as the person sent.
        // Nothing went; the thread is read again and the panel says why.
        await onChanged();
        setGuard(true);
        return;
      }
      // The race: the chosen session ended before the reply went. Its row
      // greys and the next live one is selected; the error says what went
      // when an earlier part of this Send already had.
      if (to && cause instanceof InboxApiError && cause.code === 'session_not_live') {
        setRoute((current) => routeRace(current, to.session, { went, total }));
        if (went > 0) await onChanged();
        void loadLive();
        return;
      }
      setError(cause instanceof InboxApiError ? cause.message : 'The reply was not sent. Send again to retry.');
    } finally {
      // Nothing went (or not all of it): the claim is given back and the box's words are saved again.
      // Unless the reply carrying them may have gone (its POST went out and no clear refusal came back,
      // e.g. the answer was lost): the thread is read, and a reply with its key there means it went.
      if (claimed && !done) {
        const refused = failure instanceof InboxApiError && failure.status >= 400 && failure.status < 500;
        let wentAnyway: 'yes' | 'unknown' | 'no' | 'gone' = 'no';
        if (wordsKey !== null && !refused) {
          wentAnyway = await replyLanded(threadRef.current.thread_id, wordsKey);
        }
        if (wentAnyway === 'yes') {
          // It went (and its clear_draft with it): the Send is finished as if its answer had come.
          finishSent(sentUploads, sendWords !== '');
          setError(null);
          announce('Your reply went.');
          void onChanged();
          void reloadFiles();
        } else if (wentAnyway === 'gone') {
          replyDraft.release();
          setError(THREAD_GONE_TEXT);
        } else if (wentAnyway === 'unknown') {
          // Not known (the Inbox may be down): the draft stays as it is on the server, the box keeps the
          // words, and the next Send of them first looks for this reply (unconfirmed).
          replyDraft.release();
          unconfirmed.set(threadRef.current.thread_id, {
            key: wordsKey!,
            words: sendWords,
            uploads: sentUploads,
            comments: requests.flatMap((r) => r.input.annotation_ids ?? []),
            // The picks a reply carries are the questions it names (their saved picks go with it).
            picks: requests.flatMap((r) => (r.input.questions ?? []).map((q) => `${r.messageId}/${q.key}`)),
            at: Date.now(),
          });
          setError('The reply may not have gone. Send again: it looks for this one first, so it is not sent twice.');
        } else {
          replyDraft.release();
          const text = textRef.current?.value ?? '';
          if (text.trim() !== '') replyDraft.save(text);
        }
      }
      setSending(false);
    }
  };

  const resolve = async (next: boolean) => {
    setError(null);
    if (onArchive) {
      onArchive(next);
      return;
    }
    try {
      await inboxApi.resolve(root.id, next);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The thread did not change.');
    }
  };

  // The last message is the person's: say where it is. A New message names
  // the session's host it went to, and is delivered as a turn (step 8). The
  // Inbox's own notes (Mark read's set-aside note, a late Undo's reopened
  // note) are read past: they are not the person's reply, and the line stays
  // on the reply before them.
  const last = lastNonNote(thread.messages) ?? thread.messages[0]!;
  const askedBy = (message: InboxMessageWire) => (message.reply_to ? thread.messages.find((m) => m.id === message.reply_to) : undefined);
  // A reply the person sent to another session names the session that took it
  // ("Claude Code (another session)" when it is the asker's own host).
  const toName = (message: InboxMessageWire, to: { host: string; session: string }) =>
    isRedirected(message) ? redirectedName(to, askedBy(message)) : hostName(to.host);
  // Where the person's last message is addressed: its own `to`, or, for a reply in a thread the
  // person started, the thread's (the server hands it to that session).
  const lastTo = last.author.kind === 'person' && !isInboxNote(last) ? (last.to ?? (startedTo && last.reply_to ? startedTo : null)) : null;
  // The session the person's last reply goes to, when its connection wakes it: a message addressed to a
  // session (`lastTo`), or a reply to an agent message sent through a waking connection (`wakes`).
  const repliedTo = last.author.kind === 'person' && !lastTo ? askedBy(last) : undefined;
  const askedSession = repliedTo?.author.kind === 'agent' && repliedTo.author.session ? repliedTo.author.session : null;
  // Its connection wakes it when the asking message came through one (`wakes`), or, for a message sent
  // another way from such a session (the stdio shim run inside Claude Code), when that session polls now.
  const wakingSession = askedSession && repliedTo?.wakes === true ? askedSession : null;
  const replySession = lastTo?.session ?? askedSession;
  const replyWaiting = !!replySession && !last.delivery && !(lastTo === null && sent?.checked_at);
  // A 👍 the Inbox sent through to a waking session and that session has not taken yet (the person's reply
  // is not the last message then: the 👍 is offered only before it): its line reads the same connection.
  const ackSession = ackTarget?.author.kind === 'agent' && ackTarget.author.session ? ackTarget.author.session : null;
  const ackWaiting = ackSession && ackTarget?.ack?.note_id && !ackTarget.ack.delivered_at && ackTarget.wakes === true ? ackTarget : null;
  const recipientSession = replySession ?? (ackWaiting ? ackSession : null);
  const waitingOnWake = replyWaiting || (!replySession && ackWaiting !== null);
  // How that session is connected now ("Queued", "Sending", Send now), and, for compose, whether it
  // stopped before it took it (after the asker grace). Read every few seconds while the reply waits.
  const { model: pendingLive, load: loadPendingLive } = useLiveSessions(thread.thread_id, recipientSession, waitingOnWake, 3_000);
  const undelivered = !!lastTo && !last.delivery && pendingLive?.asker?.session === lastTo.session && pendingLive.asker.live === false;
  const recipientConnection = pendingLive?.asker?.session === recipientSession ? pendingLive?.asker?.connection : undefined;
  const ackConnection = ackWaiting && !replySession && pendingLive?.asker?.session === ackSession ? pendingLive.asker.connection : undefined;
  // A reply that tags agents (approval "inbox-tag-agents", Lines): one line per tagged session, each with
  // its own state and Send now, under the owner's line. Their connections are read while one still waits.
  const lastTags = last.author.kind === 'person' && !isInboxNote(last) ? messageTags(last) : [];
  const ownerHost = lastTo?.host ?? (repliedTo?.author.kind === 'agent' ? (repliedTo.author.host ?? null) : null);
  const waitingTags = lastTags.filter((t) => t.wakes && !t.delivery).map((t) => t.session);
  const { connections: tagConnections, load: loadTagConnections } = useTagConnections(thread.thread_id, waitingTags, waitingTags.length > 0);
  const tagLines = lastTags.map((tag) => {
    const name = tagName(tag, ownerHost, replySession);
    return { tag, name, line: tagDeliveryLine(tag, name, tagConnections[tag.session], whenTime, last.id) };
  });
  const delivered: DeliveryLine | null =
    last.author.kind !== 'person'
      ? null
      : lastTo
        ? deliveryLine({
            name: last.delivery ? toName(last, last.delivery) : last.to ? toName(last, last.to) : hostName(lastTo.host),
            deliveredAt: last.delivery?.at ?? null,
            time: whenTime,
            // A Codex reply whose `codex queue` ran out of time may not have gone: saved, not queued.
            wakes: !uncertainItem(recipientConnection, last.id),
            sendingNow: !!last.deliver_now_at,
            connection: recipientConnection,
            undelivered: undelivered ? { host: hostName(lastTo.host) } : null,
            ...waitInputs(recipientConnection, last.id, { ...last, into_turn: last.delivery?.into_turn ?? null }),
          })
        : deliveryLine({
            name: asker,
            // A reply that tags agents: the owner's own delivery, never another recipient's.
            deliveredAt: lastTags.length > 0 ? (last.delivery?.at ?? sent?.recipients?.find((r) => r.owner)?.delivered_at ?? null) : (sent?.checked_at ?? null),
            time: whenTime,
            wakes: (wakingSession !== null || (askedSession !== null && recipientConnection != null)) && !uncertainItem(recipientConnection, last.id),
            sendingNow: !!last.deliver_now_at,
            connection: recipientConnection,
            askerEnded: askerEnded && asking ? { name: asking.name } : null,
            ...waitInputs(recipientConnection, last.id, { ...last, into_turn: last.delivery?.into_turn ?? null }),
          });
  // No Send now because that session runs an older plugin than a restart loads (the "Steps" line,
  // owner approval "restart-warning"): only while the reply waits for a working session.
  const restart = delivered?.state === 'queued' && !last.deliver_now_at ? restartNote(recipientConnection) : null;
  // Oh My Pi polls as host `pi`: its runtime names it (owner approval "reload-hosts").
  const restartName =
    restart?.runtime === 'oh-my-pi'
      ? 'Oh My Pi'
      : lastTo
        ? hostName(lastTo.host)
        : repliedTo?.author.kind === 'agent' && repliedTo.author.host
          ? hostName(repliedTo.author.host)
          : asker;
  // The name the waiting band uses ("Claude Code", "Claude Code (another session)").
  const ownerLineName = lastTo
    ? last.to
      ? toName(last, last.to)
      : hostName(lastTo.host)
    : asker;
  const [sendNowState, setSendNowState] = useState<{ id: string; busy: boolean; error: string | null } | null>(null);
  const sendNow = async () => {
    setSendNowState({ id: last.id, busy: true, error: null });
    try {
      await inboxApi.sendNow(last.id);
      setSendNowState({ id: last.id, busy: false, error: null });
      await onChanged();
      void loadPendingLive();
    } catch (cause) {
      setSendNowState({ id: last.id, busy: false, error: cause instanceof InboxApiError ? cause.message : 'It was not sent now. Try again.' });
      void loadPendingLive();
    }
  };
  const sendNowError = sendNowState?.id === last.id ? sendNowState.error : null;
  /** Send now for one tagged session's own line. */
  const [tagSendNow, setTagSendNow] = useState<{ id: string; session: string; busy: boolean; error: string | null } | null>(null);
  const sendTagNow = async (session: string) => {
    setTagSendNow({ id: last.id, session, busy: true, error: null });
    try {
      await inboxApi.sendNow(last.id, session);
      setTagSendNow({ id: last.id, session, busy: false, error: null });
      await onChanged();
      void loadTagConnections();
    } catch (cause) {
      setTagSendNow({ id: last.id, session, busy: false, error: cause instanceof InboxApiError ? cause.message : 'It was not sent now. Try again.' });
      void loadTagConnections();
    }
  };

  const waitingHoldsUp = [...new Set(lastAgent.questions?.filter((q) => q.state === 'open').flatMap((q) => q.holds_up) ?? [])];
  const [holdsOpen, setHoldsOpen] = useState(false);

  // The note sits at the top of the foot before the person replies: with the
  // reply box open, or with something waiting to send, or while the agent's
  // message is the last one. Never over the choice, the stale guard, a New
  // message, or a resolved thread; once the person's reply is the last
  // message, its own line says where it went.
  const showAskerNote =
    askerEnded &&
    asking !== null &&
    !route.open &&
    !(guard && staleQuestions.length > 0) &&
    newMessage?.kind !== 'compose' &&
    (box.open || waiting || last.author.kind !== 'person');

  // Re-ask (approval "inbox-reask"): one note per session that still has an
  // open question here, asking it for them again in one message (reask.ts).
  const reaskList = resolved && !cameBack ? [] : reaskTargets(thread.messages, liveMessage);
  const reaskShown = reaskOffered(reaskList, thread.messages.filter(liveMessage));
  const reaskOpen = reaskList.reduce((n, t) => n + (t.kind === 'reask' ? t.open : 0), 0);
  const reaskActions = reaskList.reduce((n, t) => n + (t.kind === 'reask' ? t.actions : 0), 0);
  const [reasking, setReasking] = useState(false);
  /** One idempotency key per target message, kept for a retry. */
  const reaskKeys = useRef<Map<string, string> | null>(null);
  const sendReask = async (routed = false) => {
    if (reasking || reaskList.length === 0) return;
    const notes = reaskList.filter((t) => t.kind === 'reask');
    // The one session asked has ended and another is live: who asks again is the person's choice, as for a reply.
    const single = notes.length === 1 ? notes[0]! : null;
    const routable = !!single && !!asking && single.session === asking.session && askerEnded && anyOtherLive;
    if (routable && !routed) {
      setError(null);
      setRouteFor('reask');
      setRoute((current) => mergeRouteRows({ ...current, open: true, error: null, focus: current.focus + 1 }, asking!, live));
      return;
    }
    const chosen =
      routed && route.selected && route.selected !== LEAVE && route.selected !== asking?.session
        ? (route.rows.find((row) => row.live.session === route.selected && !row.ended)?.live ?? null)
        : null;
    const to = chosen ? { host: chosen.host, session: chosen.session } : undefined;
    setReasking(true);
    setError(null);
    let went = 0;
    let total = 0;
    try {
      // A pick still being saved goes too: wait for it, then take the targets
      // from the thread as saved (threadRef), not as drawn when Re-ask was
      // pressed: a note just saved has a newer revision, a question just
      // picked is no longer open.
      await pickChain.current;
      const targets = resolved && !cameBack ? [] : reaskTargets(threadRef.current.messages, liveMessage);
      const freshNotes = targets.filter((t) => t.kind === 'reask');
      // The routed note follows the session the person chose for, wherever its latest message is now.
      const routedNote = single ? (freshNotes.find((t) => t.session === single.session) ?? null) : null;
      total = targets.reduce((n, t) => n + (t.kind === 'picks' ? t.replies.length : 1), 0);
      if (!reaskKeys.current) reaskKeys.current = new Map();
      const keyFor = (id: string) => {
        const key = reaskKeys.current!.get(id) ?? crypto.randomUUID();
        reaskKeys.current!.set(id, key);
        return key;
      };
      // A session with only picks: a plain reply carries them, so the Re-ask strands none (owner's rule 2).
      for (const target of targets.filter((t) => t.kind === 'picks')) {
        for (const reply of target.replies) {
          await inboxApi.reply(reply.message.id, { idempotency_key: keyFor(`picks:${reply.message.id}`), words: '', questions: reply.questions });
          went += 1;
        }
      }
      for (const target of freshNotes) {
        await inboxApi.reask(target.message.id, { idempotency_key: keyFor(target.message.id), ...(to && target === routedNote ? { to } : {}) });
        went += 1;
      }
      reaskKeys.current = null;
      setRoute(CLOSED_ROUTE);
      setRouteFor('reply');
      await onChanged();
      requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
    } catch (cause) {
      if (to && cause instanceof InboxApiError && cause.code === 'session_not_live') {
        setRoute((current) => routeRace(current, to.session, { went, total }));
        void loadLive();
        return;
      }
      const why = cause instanceof InboxApiError ? cause.message : 'Try again.';
      setError(went > 0 ? `${went} of ${total} went; the rest did not. ${why}` : `Nothing was asked again. ${why}`);
      if (went > 0) await onChanged();
    } finally {
      setReasking(false);
    }
  };

  // Open questions in this thread (approval "inbox-thread-open-questions", option A): the "N open questions"
  // button lists them (Re-ask at its foot), and a row takes the person to the card (unfolding its message).
  const openQFromServer = resolved && !cameBack ? { questions: [], replaced: 0 } : threadOpenQuestions(thread.messages, liveMessage);
  // A pick still being saved shows on its row at once, as on its card (a Skip from the list goes quiet: "Skipped").
  const openQ = {
    ...openQFromServer,
    questions: openQFromServer.questions.map((q): OpenQuestion => {
      if (!pending.has(q.id)) return q;
      const answer = pending.get(q.id) ?? null;
      return { ...q, picked: answer !== null, question: { ...q.question, answer, state: answer ? 'picked' : 'open' } };
    }),
  };
  /**
   * Skipping from the list (approval "oq-skip-select", variant A): the select
   * mode's button sets each question skipped or not, exactly as the card's own
   * Skip / Unskip does. The same starting answer (the saved or pending pick,
   * else the question's empty answer as the card builds it from the message),
   * the same toggle (skipToggledAnswer, ui's toggleSkip), and the same save
   * (`pick`, serialized per thread): a pick marked skipped that goes with the
   * next Send. Nothing is sent now. A question already as asked is left alone.
   */
  const setSkippedFromList = (questions: readonly OpenQuestion[], skipped: boolean) => {
    for (const q of questions) {
      const message = thread.messages.find((m) => m.id === q.messageId);
      if (!message) continue;
      const current = pending.has(q.id) ? pending.get(q.id)! : (questionById(q.id)?.answer ?? q.question.answer);
      if ((current?.skipped === true) === skipped) continue;
      const base = current ?? emptyAnswerFor(message, q);
      pick(q.messageId, q.key, skipToggledAnswer(base));
    }
  };
  // Shown whenever a question waits, or Re-ask is offered (it lives in the list now, so never out of reach).
  const openQShown = openQuestionsShown(openQ.questions, reaskShown);
  /** Where each listed card sits now: in a folded message, or above or below the middle of the thread's view. */
  const measureOpenQuestions = (): ReadonlyMap<string, OpenQuestionPlace> => {
    const places = new Map<string, OpenQuestionPlace>();
    const body = bodyRef.current;
    const current = foldRef.current;
    const hidden = new Set(current.hidden.flatMap((ids, index) => (current.revealed.has(index) ? [] : ids)));
    const view = body?.getBoundingClientRect() ?? { top: 0, bottom: 0 };
    for (const q of openQ.questions) {
      if (current.folded.has(q.messageId) || hidden.has(q.messageId)) {
        places.set(q.id, 'folded');
        continue;
      }
      const card =
        body?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(q.messageId)}"] [data-question-key="${CSS.escape(q.key)}"]`) ??
        body?.querySelector<HTMLElement>(`[data-message-article="${CSS.escape(q.messageId)}"]`) ??
        null;
      places.set(q.id, placeOf(card?.getBoundingClientRect() ?? null, view));
    }
    return places;
  };

  // The error after a failed Send (or Re-ask) sits ABOVE the button row it belongs to (approval
  // "thread-foot-status-right"), in the two states that have one: the reply box and the closed foot.
  const errorAbove = !resolved && !(guard && staleQuestions.length > 0) && newMessage?.kind !== 'compose' && !(route.open && asking);
  const errorLine = (
    <div className="ib-error" role="alert" data-foot-error={errorAbove ? 'above' : undefined}>
      {error}
    </div>
  );
  // The closed foot's status (draft note, skip chip) describes Send and Edit draft: read with them, though drawn at the row's end.
  const draftNoteId = `ib-foot-draft-${thread.thread_id}`;
  const skipNoteId = `ib-foot-skip-${thread.thread_id}`;
  const footStatusIds = [draftNoteId, waiting && unanswered.length > 0 ? skipNoteId : null].filter(Boolean).join(' ');
  const routeChoice = asking ? (
    <RouteChoice
      kind={routeFor}
      reaskCount={reaskOpen}
      name={`route-${thread.thread_id}`}
      asking={asking}
      project={thread.project.name}
      state={route}
      sending={sending}
      onSelect={(id) => setRoute((current) => ({ ...current, selected: id, error: null }))}
      onSubmit={() => void (routeFor === 'reask' ? sendReask(true) : send({ routed: true }))}
      onBack={routeBack}
      onShowAll={() => setRoute((current) => ({ ...current, showAll: true }))}
    />
  ) : null;

  // While new messages are below the view: a pill that goes to them.
  // On a phone the pill sits over the middle of the foot's row; when a button lies under that middle, above the foot.
  const footRowRef = useRef<HTMLDivElement>(null);
  /**
   * How far the closed foot shortened so the buttons and the draft status share one line (footFit.ts
   * `fitWholeFootRow`: the skip chip, Edit, the open questions count, the draft's words, tighter spacing).
   * Null: no status, no layout, or even the shortest form does not fit (the status wraps above).
   */
  const [rowLevel, setRowLevel] = useState<number | null>(null);
  const footStatusShown = waiting || draftKept;
  const footRowShown = !resolved && !(guard && staleQuestions.length > 0) && newMessage?.kind !== 'compose' && !box.open && !(route.open && asking);
  const rowMax: OpenQuestionsLabelForm = phone ? 'short' : 'full';
  // What the row shows; a change re-fits it (with its width).
  const footSig = [footStatusShown, draftKept, picksCount, records.length, unanswered.length, keepOpen, skipIds.size, openQShown, openQ.questions.length, reaskActions, rowMax, phone].join('|');
  const rowFittedFor = useRef('');
  const fitRowRef = useRef<(force?: boolean) => void>(() => {});
  fitRowRef.current = (force = false) => {
    const row = footRowRef.current;
    if (!row) return;
    const key = `${row.getBoundingClientRect().width}|${footSig}`;
    if (!force && key === rowFittedFor.current) return;
    rowFittedFor.current = key;
    const level = footStatusShown ? fitWholeFootRow(row, rowMax, phone) : null;
    setRowLevel((current) => (current === level ? current : level));
  };
  // Every render (after the open questions button drew itself), and whenever the row's width changes.
  useLayoutEffect(() => fitRowRef.current());
  useEffect(() => {
    const row = footRowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitRowRef.current());
    observer.observe(row);
    // Words measured in a fallback font fit differently once the real one loads.
    void document.fonts?.ready.then(() => fitRowRef.current(true));
    return () => observer.disconnect();
    // The row comes and goes (the reply box, the route choice, the stale guard, compose).
  }, [footRowShown]);
  const [pillAbove, setPillAbove] = useState(false);
  const pillOnRow = showNew && phone && !waiting && !draftKept;
  const placePill = useCallback(() => {
    const row = footRowRef.current;
    const pill = row?.querySelector<HTMLElement>('.ib-npill');
    const buttons = row?.querySelector('[data-foot-buttons]');
    if (!row || !pill || !buttons) return;
    const box = row.getBoundingClientRect();
    if (box.width <= 0) return;
    const size = pill.getBoundingClientRect();
    const hits = pillHitsButtons(box, size, laidOutChildren(buttons).map((el) => el.getBoundingClientRect()));
    setPillAbove((current) => (current === hits ? current : hits));
  }, []);
  // Every render (a button came or went, the count changed) and whenever the row resizes.
  useLayoutEffect(() => {
    if (pillOnRow) placePill();
  });
  useEffect(() => {
    const row = footRowRef.current;
    if (!pillOnRow || !row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => placePill());
    observer.observe(row);
    return () => observer.disconnect();
  }, [pillOnRow, placePill]);
  const newPill = (
    <div className="ib-npill-wrap" data-above={phone && pillAbove ? '' : undefined}>
      <button
        type="button"
        className="ib-npill"
        data-new-pill=""
        data-off={chrome.pill > 0 ? undefined : ''}
        tabIndex={chrome.pill > 0 ? 0 : -1}
        aria-hidden={chrome.pill === 0}
        onClick={() => jumpNew(true)}
      >
        <Icon name="arrowDown" size={15} />
        {Math.max(1, chrome.pill)} new
      </button>
    </div>
  );

  // The warning toast's Reply: the reply box opens, once.
  useEffect(() => {
    if (replyRequest !== thread.thread_id) return;
    onReplyOpened?.();
    openBox();
    // openBox reads this render's picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyRequest, thread.thread_id]);

  // Mark read: pressed while the thread is marked read, offered while something here waits on the person.
  const readAt = row?.read_at ?? null;
  const markReadOffered = !resolved && row != null && onMarkRead !== undefined;
  const markReadEnabled = markReadOffered && canToggleRead(row!);
  const closedByRead = thread.messages.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'closed' && q.set_aside_at));

  const openAttachment = file ? allFiles.find((a) => a.id === file.id) ?? null : null;
  const fileOpen = openAttachment !== null;
  // A file beside the thread hides the list (App.tsx `fileOpen`, from the route, so before the
  // attachments load too): the way back to it leads the header, as on an iPad (approved 2026-10-12).
  const backBesideFile = file !== null && !phone && !stacked && !fileStacked && onBackToList !== undefined;
  const backToList = () => {
    const name = openAttachment?.name ?? null;
    const go = () => {
      onBackToList!(name);
    };
    if (paneRef.current) paneRef.current.leave(null, go);
    else go();
  };

  const archiveButton = (
    <Tip content={archived ? 'Unarchive' : 'Archive: the thread ends; the next message starts a new one'}>
      <button
        type="button"
        className="ib-iconbtn"
        onClick={() => void resolve(!archived)}
        aria-label={archived ? 'Unarchive the thread' : 'Archive the thread'}
        data-archive=""
      >
        <Icon name="archive" />
      </button>
    </Tip>
  );
  // Pin to the sidebar (approval "inbox-pinned-threads"): an icon toggle, the phone's way to pin.
  // One fixed name ("Pin to the sidebar") with `aria-pressed`, so a screen reader hears the state
  // change rather than a new control; only the tooltip's words follow the state.
  // A click shows its state at once and its request waits for the one before it, so a quick
  // pin-then-unpin sends both, in order, and ends where the person left it.
  const [pinWant, setPinWant] = useState<{ thread: string; pinned: boolean } | null>(null);
  const pinChain = useRef<{ thread: string; tail: Promise<unknown>; pending: number }>({ thread: '', tail: Promise.resolve(), pending: 0 });
  const pinShown = pinWant?.thread === thread.thread_id ? pinWant.pinned : pinned;
  // What the last click asked for, read synchronously, so two clicks before a render still alternate.
  const pinWantRef = useRef<{ thread: string; pinned: boolean } | null>(null);
  const togglePin = () => {
    if (!onPin) return;
    const threadId = thread.thread_id;
    const current = pinWantRef.current?.thread === threadId ? pinWantRef.current.pinned : pinShown;
    const next = !current;
    pinWantRef.current = { thread: threadId, pinned: next };
    setPinWant({ thread: threadId, pinned: next });
    const chain = pinChain.current.thread === threadId ? pinChain.current : (pinChain.current = { thread: threadId, tail: Promise.resolve(), pending: 0 });
    chain.pending++;
    chain.tail = chain.tail
      .then(() => onPin(next))
      .catch(() => {})
      .then(() => {
        // The last request answered (and the list was read again): the list's state takes over.
        if (--chain.pending === 0) {
          if (pinWantRef.current?.thread === threadId) pinWantRef.current = null;
          setPinWant((want) => (want?.thread === threadId ? null : want));
        }
      });
  };
  const pinButton = onPin ? (
    <Tip content={pinShown ? 'Unpin from the sidebar' : 'Pin to the sidebar'}>
      <button
        type="button"
        className="ib-iconbtn ib-pinbtn"
        onClick={togglePin}
        aria-pressed={pinShown}
        aria-label="Pin to the sidebar"
        data-pin-toggle=""
      >
        <Icon name="pin" size={16} />
      </button>
    </Tip>
  ) : null;
  const markReadButton = markReadOffered ? (
    <Tip
      content={
        readAt !== null
          ? 'Move it back to the top'
          : markReadEnabled
            ? `Out of the top until ${asker} writes again. Its waiting questions close unanswered.`
            : 'Nothing here waits on you'
      }
    >
      <button type="button" className="ib-hbtn" data-mark-read="" aria-pressed={readAt !== null} disabled={!markReadEnabled} onClick={() => onMarkRead!(readAt === null)}>
        <Icon name="checkCircle" size={16} />
        <span className="ib-hbtn-l">{readAt !== null ? 'Read' : 'Mark read'}</span>
        <kbd className="ib-kbd ib-wide">E</kbd>
      </button>
    </Tip>
  ) : null;

  return (
    <>
    <section
      ref={sectionRef}
      className={`ib-pane${fileOpen ? ' ib-withfile' : ''}`}
      aria-label={thread.subject ?? 'Thread'}
      data-thread-id={thread.thread_id}
    >
      <div className="ib-phead" data-artifacts-on={artifactsOn ? '' : undefined}>
        {/* A phone leads with the way back to the list; Archive sits at the right, where the close was. */}
        {phone && artifactsOn ? (
          // On a phone Artifacts is a screen of its own: its way back is to the thread (the browser's Back, so the swipe agrees).
          <>
            <button type="button" className="ib-pback" onClick={() => onArtifacts?.(false)} aria-label="Back to the thread" data-artifacts-phone-back="">
              <Icon name="chevL" size={18} />
              <span className="ib-pback-l">Thread</span>
            </button>
            <span className="ib-art-ph-title" aria-hidden="true">
              Artifacts
            </span>
            {artifactList.length > 0 && (
              <span className="ib-art-ph-n" aria-hidden="true">
                {artifactList.length}
              </span>
            )}
          </>
        ) : phone ? (
          <button type="button" className="ib-pback" onClick={onClose} aria-label={`Back to ${backLabel}`} data-phone-back="">
            <Icon name="chevL" size={18} />
            <span className="ib-pback-l">{backLabel}</span>
          </button>
        ) : (
          <>
            {/* A stacked thread covers the list: the way back to it leads, where the list was. */}
            {stacked && (
              <>
                <Tip content={`Back to ${backLabel}`}>
                  <button type="button" className="ib-pback" onClick={onClose} aria-label={`Back to ${backLabel}`} data-stack-back="">
                    <Icon name="chevL" size={16} />
                    <span className="ib-pback-l">{backLabel}</span>
                  </button>
                </Tip>
                <span className="ib-vsep" aria-hidden="true" />
              </>
            )}
            {/* A file beside the thread hides the list: the same way back leads; it closes the file. */}
            {backBesideFile && (
              <>
                <Tip content={openAttachment ? `Close ${openAttachment.name} and show the list` : `Back to ${backLabel}`}>
                  <button type="button" className="ib-pback" onClick={backToList} aria-label={`Back to ${backLabel}`} data-file-back="">
                    <Icon name="chevL" size={16} />
                    <span className="ib-pback-l">{backLabel}</span>
                  </button>
                </Tip>
                <span className="ib-vsep" aria-hidden="true" />
              </>
            )}
          </>
        )}
        {/* Mark read leads, furthest from the close, with its label and its E; everything at the right is an icon
            with a tooltip (approval "inbox-thread-artifacts"): Artifacts, Expand / Fold all, Archive, then the close.
            A phone keeps the same order after its way back. */}
        {phone && artifactsOn ? null : (
          <>
            {markReadButton}
            {one && !artifactsOn ? (
              <span className="ib-sp" />
            ) : (
              // The subject, once it has scrolled away, and always over the Artifacts grid (the heading stays the one a screen reader reads).
              <span className="ib-phsubj" dir="auto" data-header-subject="" data-on={chrome.subject || artifactsOn ? '' : undefined} aria-hidden="true">
                {thread.subject ?? '(no subject)'}
              </span>
            )}
            {pinButton}
            {artifactsButton && (
              <Tip content={artifactsOn ? 'Back to the thread' : 'Artifacts: every file, image and guided review in this thread'}>
                <button
                  ref={artifactsButtonRef}
                  type="button"
                  className="ib-iconbtn ib-artbtn"
                  aria-label={`Artifacts, ${artifactList.length}`}
                  aria-pressed={artifactsOn}
                  onClick={() => onArtifacts?.(!artifactsOn)}
                  data-artifacts-button=""
                >
                  <Icon name="artifacts" size={17} />
                  <span className="ib-artbtn-n" aria-hidden="true">
                    {artifactList.length}
                  </span>
                </button>
              </Tip>
            )}
            {!one && !artifactsOn && (
              <Tip content={allOpen ? 'Fold the earlier messages' : 'Expand all messages'}>
                <button
                  type="button"
                  className="ib-iconbtn"
                  data-expand-all=""
                  onClick={expandAll}
                  aria-label={allOpen ? 'Fold the earlier messages' : 'Expand all messages'}
                >
                  <Icon name={allOpen ? 'collapse' : 'expand'} size={16} />
                </button>
              </Tip>
            )}
            {archiveButton}
            {phone || stacked || backBesideFile ? null : (
              <>
                <span className="ib-vsep" aria-hidden="true" />
                <Tip content="Close">
                  <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close the thread">
                    <Icon name="x" />
                  </button>
                </Tip>
              </>
            )}
          </>
        )}
      </div>
      {/* The Artifacts view swaps the messages out (kept mounted, so folds, scroll and the reply box stay as left). */}
      <div className={`ib-pbody${one ? '' : ' ib-folding'}`} ref={bodyRef} hidden={artifactsOn}>
        {/* A focus target (the way back's fallback, a stacked thread), never a tab stop. */}
        <h2 className="ib-subject" dir="auto" tabIndex={-1}>{thread.subject ?? '(no subject)'}</h2>
        {cardChip ? <div className="ib-tmeta" data-thread-card-row="">{cardChip}</div> : null}
        {notice}
        {startedTo && (
          <div className="ib-tmeta" data-started-by="">
            <span>You started this thread</span>
            <span className="ib-tdot" aria-hidden="true" />
            <span>
              to {hostName(startedTo.host)} in <bdi>{thread.project.name}</bdi>
            </span>
          </div>
        )}
        {readAt !== null && !resolved && (
          <div className="ib-readline" data-read-line="">
            <Icon name="checkCircle" size={16} />
            <div>
              <span>
                Read {whenTime(readAt)}. It stays out of the top until {asker} writes again.
              </span>
              {closedByRead.length > 0 && (
                <>
                  <br />
                  <span>
                    {closedByRead.length === 1 ? '1 question was' : `${closedByRead.length} questions were`} closed unanswered; {asker} is told not to wait on{' '}
                    {closedByRead.length === 1 ? 'it' : 'them'}.
                  </span>
                </>
              )}
            </div>
            {onMarkRead && (
              <button type="button" onClick={() => onMarkRead(false)} data-move-back="">
                Move back
              </button>
            )}
          </div>
        )}
        {!one && (
          <div className="ib-tmeta" data-thread-meta="">
            {participants.length > 1 && (
              <>
                <span className="ib-tg-hwho" data-thread-participants="">
                  <TagStack participants={participants} />
                  <span>{participantsWords(participants)}</span>
                </span>
                <span className="ib-tdot" aria-hidden="true" />
              </>
            )}
            <span>{plural(thread.messages.length, 'message')}</span>
            <span className="ib-tdot" aria-hidden="true" />
            <span>{spanWords(root.created_at, thread.messages[thread.messages.length - 1]!.created_at)}</span>
            {showNew && (
              <>
                <span className="ib-tdot" aria-hidden="true" />
                <b>{fresh.size} new since you looked</b>
              </>
            )}
          </div>
        )}
        {thread.messages.flatMap((message, index) => {
          const before: React.ReactNode[] = [];
          // The middle of a long read run: one "N earlier messages" in place of its messages.
          const run = fold.hidden.findIndex((ids, i) => !fold.revealed.has(i) && ids[0] === message.id);
          if (run >= 0) {
            const n = fold.hidden[run]!.length;
            before.push(
              <div className="ib-mfold" key={`fold-${run}`} data-middle-fold="">
                <button type="button" className="ib-mfold-b" data-fold-head="" onClick={() => revealRun(run)} aria-label={`Show ${plural(n, 'earlier message')}`}>
                  <span>
                    <Icon name="stack" size={14} />
                    {plural(n, 'earlier message')}
                  </span>
                </button>
              </div>,
            );
          }
          if (hiddenNow.has(message.id)) return before;
          const isNew = showNew && fresh.has(message.id);
          // "New since you looked", above the first new message (not above the first message of the thread).
          if (isNew && index > 0 && thread.messages.findIndex((m) => fresh.has(m.id)) === index) {
            before.push(
              <div className="ib-newdiv" key="new-divider" data-new-divider="" role="separator" aria-label={`New since you looked: ${plural(fresh.size, 'message')}`}>
                New since you looked
              </div>,
            );
          }
          const isAgent = message.author.kind === 'agent';
          const name = isAgent ? agentName(message.author) : 'You';
          // The day too when it is not today, and the whole moment on hover.
          const time = whenTime(message.created_at);
          const fullWhen = fullTime(message.created_at);
          const open = one || !fold.folded.has(message.id);
          if (!open) {
            const holdings = holdingsOf(message, {
              delivered: isDelivered(message, root),
              picked: (q) => {
                const id = `${message.id}/${q.key}`;
                return pending.has(id) ? pending.get(id) !== null : q.state === 'picked';
              },
            });
            const snippet = foldSnippet(message, thread.messages);
            const label = `${name}, ${time}${isNew ? ', new' : ''}${holdings.length > 0 ? `. ${holdings.map((h) => h.say).join(', ')}` : ''}. ${snippetText(snippet)}`;
            before.push(
              <article
                className="ib-message ib-folded"
                key={message.id}
                data-author={message.author.kind}
                data-message-article={message.id}
                data-folded=""
                data-new={isNew ? '' : undefined}
                data-sighted={sightedIds.has(message.id) ? '' : undefined}
                data-arrival={arrivalIds.has(message.id) ? '' : undefined}
                data-arrived={arrivedIds.has(message.id) ? '' : undefined}
                tabIndex={-1}
              >
                <button type="button" className={`ib-fline${isNew ? ' ib-fl-unread' : ''}`} data-fold-head="" aria-expanded={false} aria-label={label} onClick={() => toggleMessage(message.id)}>
                  {isAgent ? (
                    <AuthorMark author={message.author} big />
                  ) : (
                    <span className="ib-mk ib-big">
                      <Icon name="reply" />
                    </span>
                  )}
                  <Tip content={name} cut>
                    <span className="ib-fl-nm">{name}</span>
                  </Tip>
                  {/* An answers snippet is shortened (each prompt cut at a word): its whole text always; words only while cut. */}
                  <Tip content={snippetText(snippet)} cut={snippet.kind !== 'answers'}>
                    <span className="ib-fl-sn" dir="auto" data-snippet={snippet.kind}>
                      <SnippetText snippet={snippet} />
                    </span>
                  </Tip>
                  <HoldingChips holdings={holdings} />
                  <Tip content={fullWhen}>
                    <span className="ib-fl-tm">
                      {isNew && <span className="ib-newtag">New</span>}
                      {time}
                    </span>
                  </Tip>
                </button>
              </article>,
            );
            return before;
          }
          const questions = message.questions ?? [];
          // Nothing left to answer: every question is sent or was superseded.
          const allSent = questions.length > 0 && questions.every((q) => q.state !== 'open' && q.state !== 'picked');
          const replacedCard = (key: string, number: number) => {
            const q = questions.find((x) => x.key === key);
            const replacement = q ? replacementOf(thread.messages, q) : null;
            if (!q || !replacement) return undefined;
            const answer = pending.has(`${message.id}/${key}`) ? (pending.get(`${message.id}/${key}`) ?? null) : q.answer;
            return <ReplacedQuestionCard question={q} number={number} total={questions.length} replacement={replacement} answer={answer} onJump={jumpTo} refRepo={threadRefRepo} />;
          };
          const replacesLine = (key: string) => {
            const q = questions.find((x) => x.key === key);
            const old = q ? replacedBy(thread.messages, q) : [];
            return old.length > 0 ? <ReplacesLine old={old} onJump={jumpTo} /> : null;
          };
          // An agent message with files says so in its header (design record
          // "inbox-attachments-header", variant Count): a count in the "to you"
          // line opens the same tiles as the foot, in a band under the sender.
          const messageFiles = isAgent && (message.attachments?.length ?? 0) > 0 ? attachments.filter((a) => a.message_id === message.id) : [];
          const fileCount = isAgent ? Math.max(message.attachments?.length ?? 0, messageFiles.length) : 0;
          const filesOpen = fileCount > 0 && headerOpen.has(message.id);
          const bandId = `ib-hatts-${message.id}`;
          const count =
            fileCount > 0 ? (
              <AttachmentsCount
                messageId={message.id}
                count={fileCount}
                changed={changedCount(messageFiles)}
                open={filesOpen}
                controls={bandId}
                onToggle={() => setHeaderOpen(message.id, !filesOpen)}
                onKeyDown={closeHeaderOnEscape(message.id)}
              />
            ) : null;
          // The open message's head is the folded line (design record
          // "inbox-polish", item 5): one row, the same 24 px mark and name in
          // the same place, so opening a message moves nothing the person
          // clicked. Only the third column changes (where it was sent, to
          // whom, the attachments count) and the body appears below. In a
          // multi-message thread the fold button lies under the row as its
          // hit area: the row holds buttons of its own (the count, Reply), and
          // a button cannot hold them. The row's text is hidden from screen
          // readers there, since the button's label says it.
          const hide = one ? undefined : true;
          // A reply that tags agents names them after its owner ("to Claude Code · tagged Pi, Codex").
          const sentTags = messageTags(message);
          const ownerOfSent = message.to ?? (askedBy(message)?.author.kind === 'agent' ? askedBy(message)!.author : null);
          const toWords = (
            <>
              to {isAgent ? 'you' : message.to ? toName(message, message.to) : asker}
              {isAgent && askerEnded && message.id === asking?.message.id && <SessionEndedMark />}
              {sentTags.length > 0 && (
                <span data-tagged-names="">
                  {' · tagged '}
                  {sentTags.map((t) => tagName(t, ownerOfSent && 'host' in ownerOfSent ? ownerOfSent.host : null, ownerOfSent && 'session' in ownerOfSent ? ownerOfSent.session : null)).join(', ')}
                </span>
              )}
            </>
          );
          const foldLabel = `${name}, ${time}${isNew ? ', new' : ''}. Fold this message`;
          const revealed = revealedId === message.id;
          before.push(
            <article
              className="ib-message"
              key={message.id}
              data-author={message.author.kind}
              data-message-article={message.id}
              data-open={one ? undefined : ''}
              data-new={isNew ? '' : undefined}
              data-sighted={sightedIds.has(message.id) ? '' : undefined}
              data-arrival={arrivalIds.has(message.id) ? '' : undefined}
              data-arrived={arrivedIds.has(message.id) ? '' : undefined}
              tabIndex={-1}
            >
              <div className="ib-fline ib-is-open" data-open-head="" data-revealed={revealed ? '' : undefined}>
                {!one && (
                  <button
                    type="button"
                    className="ib-fl-hit"
                    data-fold-head=""
                    aria-expanded={true}
                    aria-label={foldLabel}
                    onClick={() => toggleMessage(message.id)}
                  />
                )}
                <span className="ib-a11y-skip" aria-hidden={hide}>
                  {isAgent ? (
                    <AuthorMark author={message.author} big />
                  ) : (
                    <span className="ib-mk ib-big">
                      <Icon name="reply" />
                    </span>
                  )}
                </span>
                <Tip content={one ? name : null} cut>
                  <span className="ib-fl-nm ib-who" aria-hidden={hide}>
                    <bdi>{name}</bdi>
                  </span>
                </Tip>
                {/* The project gives way first; "to you", the session-ended mark and the count never shrink (the row wraps instead). */}
                <span className="ib-fl-meta">
                  <span className="ib-fl-in" aria-hidden={hide}>
                    in <bdi>{thread.project.name}</bdi>{' '}
                  </span>
                  <span className="ib-fl-to" aria-hidden={hide}>
                    <span className="ib-to-sep">·</span> <span className="ib-to">{toWords}</span>
                  </span>
                  {count && <span className="ib-fl-files">{count}</span>}
                </span>
                <span className="ib-fl-chips" />
                <span className="ib-fl-tm">
                  {isNew && <span className="ib-newtag">New</span>}
                  <Tip content={fullWhen}>
                    <span data-full-when="">{time}</span>
                  </Tip>
                  {isAgent && liveMessage(message) && (
                    <Tip content="Reply">
                      <button type="button" className="ib-mut" onClick={() => openBox()} aria-label="Reply">
                        <Icon name="reply" size={15} />
                      </button>
                    </Tip>
                  )}
                </span>
              </div>
              <div className="ib-msg" data-revealed={revealed ? '' : undefined}>
                {count && (
                  <div className="ib-hatts" id={bandId} role="region" aria-label="Attachments in this message" hidden={!filesOpen} onKeyDown={closeHeaderOnEscape(message.id)} data-header-band={message.id}>
                    {filesOpen && (
                      <>
                        <AttachmentTiles
                          attachments={messageFiles}
                          annotationCounts={countsByPath}
                          onOpen={openFromMessage}
                          onOpenAs={phone || fileStacked ? undefined : openFromMessage}
                          openId={file && !full && !phone && !fileStacked ? file.id : null}
                          placement="header"
                          openIn={openIn}
                        />
                        <p className="ib-hatts-note">Also at the end of the message.</p>
                      </>
                    )}
                  </div>
                )}
                {(message.reask?.length ?? 0) > 0 ? (
                  <ReaskNote
                    message={message}
                    agent={message.to ? toName(message, message.to) : reaskNoteAgent(askedBy(message)?.author, asker)}
                    picks={thread.messages.reduce((n, m) => n + (m.questions ?? []).filter((q) => q.sent_reply_id === message.id).length, 0)}
                  />
                ) : (
                <MessageBody
                  message={message}
                  sentAnswers={message.author.kind === 'person' ? (sentAnswersByReply.get(message.id) ?? NO_SENT_ANSWERS) : undefined}
                  onJumpQuestion={jumpTo}
                  projectRoot={thread.project.root}
                  repo={thread.project.repo ?? null}
                  onOpenAttachment={openFromMessage}
                  onOpenInlineImage={(image) => openFromMessage(image)}
                  readOnly={!isAgent || !liveMessage(message) || questions.length === 0 || allSent}
                  answers={answersOf(message)}
                  onPick={(key, answer) => pick(message.id, key, answer)}
                  footerFor={footerFor(message)}
                  renderReplacedCard={replacedCard}
                  renderReplacesLine={replacesLine}
                  renderActions={
                    isAgent && (message.actions?.length ?? 0) > 0
                      ? {
                          recordFor: (block) => actionForBlock(message.body, message.actions, block),
                          render: (records) => (
                            <ActionChecklist
                              actions={records}
                              agent={name}
                              readOnly={!liveMessage(message)}
                              onMark={(action, mark) => markAction(message.id, action.key, mark, name, action.prompt)}
                            />
                          ),
                        }
                      : undefined
                  }
                  comments={
                    isAgent && liveMessage(message)
                      ? {
                          annotations: messageComments.get(message.id) ?? NO_ANNOTATIONS,
                          onSave: (annotation) => saveMessageComment(message.id, annotation),
                          onUnanchored: noteUnanchored,
                          onPainted: () => repaintHits(message.id),
                        }
                      : undefined
                  }
                />
                )}
                {/* An agent's files, and the person's own (compose): the same tiles and viewers. */}
                {(message.attachments?.length ?? 0) > 0 && (
                  <AttachmentTiles
                    attachments={attachments.filter((a) => a.message_id === message.id)}
                    annotationCounts={countsByPath}
                    onOpen={openFromMessage}
                    onOpenAs={phone || fileStacked ? undefined : openFromMessage}
                    openId={file && !full && !phone && !fileStacked ? file.id : null}
                    openIn={openIn}
                  />
                )}
                {message.guide && <GuideCard guide={message.guide} onOpen={() => onOpenGuide(message.id)} />}
                {isAgent && message.ack && (
                  <AckPill ack={message.ack} agent={name} wakes={message.wakes === true} connection={message.id === ackWaiting?.id ? ackConnection : undefined} />
                )}
                {message === lastAgent && liveMessage(lastAgent) && waitingHoldsUp.length > 0 && (
                  <div className="ib-waitfoot">
                    <b>Waiting on this answer</b>
                    <span className="ib-badge ib-b-hold">Holds up {waitingHoldsUp.length}</span>
                    <span className="ib-sp" />
                    <button type="button" className="ib-mut" onClick={() => setHoldsOpen((v) => !v)} aria-expanded={holdsOpen}>
                      {holdsOpen ? 'Hide' : 'Show'} <Icon name={holdsOpen ? 'chevR' : 'chevD'} size={14} />
                    </button>
                  </div>
                )}
                {message === lastAgent && holdsOpen && waitingHoldsUp.length > 0 && (
                  <ul className="ib-holds">
                    {waitingHoldsUp.map((held) => (
                      <li key={held}>{held}</li>
                    ))}
                  </ul>
                )}
                {message === last && delivered && tagLines.length > 0 && (
                  // Lines (approval "inbox-tag-agents"): the owner first, then each tagged session, each with its own state.
                  <ul className="ib-tg-dl" data-tag-lines="" tabIndex={-1}>
                    <li data-tag-line={replySession ?? ''} data-delivery={delivered.state} data-owner="">
                      <HostMark host={ownerHost} />
                      {delivered.wait ? <UndeliveredText wait={delivered.wait} name={ownerLineName} /> : <span className="ib-dl-text">{delivered.text}</span>}
                      {delivered.sendNow && (
                        <button type="button" className="ib-sendnow" data-send-now="" disabled={sendNowState?.id === last.id && sendNowState.busy} onClick={() => void sendNow()}>
                          Send now
                        </button>
                      )}
                    </li>
                    {tagLines.map(({ tag, name, line }) => (
                      <li key={tag.session} data-tag-line={tag.session} data-delivery={line.state}>
                        <HostMark host={tag.host} />
                        {line.wait ? <UndeliveredText wait={line.wait} name={name} /> : <span className="ib-dl-text">{line.text}</span>}
                        {line.sendNow && (
                          <button
                            type="button"
                            className="ib-sendnow"
                            data-send-now={tag.session}
                            aria-label={`Send now to ${name}`}
                            disabled={tagSendNow?.id === last.id && tagSendNow.session === tag.session && tagSendNow.busy}
                            onClick={() => void sendTagNow(tag.session)}
                          >
                            Send now
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {message === last && tagSendNow?.id === last.id && tagSendNow.error && (
                  <p className="ib-error" role="alert" data-send-now-error="">
                    {tagSendNow.error}
                  </p>
                )}
                {message === last && delivered?.wait && tagLines.length === 0 && (
                  // Waiting on a busy agent (approval "inbox-busy-agent-reply"): the band, with its own minute clock.
                  <UndeliveredBand
                    wait={delivered.wait}
                    name={ownerLineName}
                    onSendNow={delivered.sendNow ? () => void sendNow() : null}
                    sending={sendNowState?.id === last.id && sendNowState.busy}
                    restart={restart}
                    restartName={restartName}
                  />
                )}
                {message === last && delivered && !delivered.wait && tagLines.length === 0 && (
                  // tabIndex -1: Send to another session puts focus here once it moved the message.
                  <div className="ib-delivered" data-delivery={delivered.state} data-auto={delivered.autoAfterMin !== undefined ? '' : undefined} tabIndex={-1}>
                    <span className="ib-dl-main">
                      <Icon
                        name={delivered.state === 'undelivered' ? 'warn' : delivered.ended || delivered.state === 'queued' ? 'clock' : delivered.state === 'sending' ? 'send' : 'check'}
                        size={14}
                      />
                      <span className="ib-dl-text">{delivered.text}</span>
                    </span>
                    {delivered.sendNow && (
                      <Tip content="Put it into the running turn now: the agent reads it at its next step, without waiting for the turn to end.">
                        <button
                          type="button"
                          className="ib-sendnow"
                          data-send-now=""
                          disabled={sendNowState?.id === last.id && sendNowState.busy}
                          onClick={() => void sendNow()}
                        >
                          Send now
                        </button>
                      </Tip>
                    )}
                    {restart && <RestartLine note={restart} name={restartName} />}
                  </div>
                )}
                {message === last && sendNowError && (
                  <p className="ib-error" role="alert" data-send-now-error="">
                    {sendNowError}
                  </p>
                )}
                {message === last && delivered?.state === 'undelivered' && lastTo && (
                  <SendToAnotherSession
                    messageId={last.id}
                    ended={lastTo}
                    project={thread.project.name}
                    live={pendingLive}
                    onReload={loadPendingLive}
                    onMoved={onChanged}
                  />
                )}
              </div>
            </article>,
          );
          return before;
        })}
        {showNew && !phone && newPill}
        <div className="ib-sr" aria-live="polite" data-fold-live="">
          {announced}
        </div>
      </div>
      {artifactsOn && (
        <div className="ib-pbody ib-artbody" ref={artifactsBodyRef}>
          <ArtifactsView
            ref={artifactsHeadingRef}
            artifacts={files === null ? null : artifactList}
            annotationCounts={countsByPath}
            openId={file && !shownFull ? file.id : null}
            // Focus comes back to the tile only when it did open (a typed comment's "Keep writing" keeps the file).
            onOpen={(artifact) => openFromMessage(artifact.attachment, null, () => (artifactOpened.current = artifactKey(artifact)))}
            onOpenGuide={(artifact) => {
              artifactOpened.current = artifactKey(artifact);
              onOpenGuide(artifact.messageId);
            }}
            onOpenAs={phone || fileStacked ? undefined : (artifact, view) => openFromMessage(artifact.attachment, view, () => (artifactOpened.current = artifactKey(artifact)))}
            onBack={phone ? undefined : () => onArtifacts?.(false)}
            openIn={openIn}
            phone={phone}
          />
        </div>
      )}
      <div className="ib-pfoot" hidden={artifactsOn}>
        {/* One status region, always mounted, so a screen reader announces the note when it appears. */}
        <div role="status" id={noteId} data-asker-note="">
          {showAskerNote && asking && <AskerEndedNote asking={asking} project={thread.project.name} anyLive={anyOtherLive} />}
        </div>
        {cameBack && (
          <div className="ib-acts ib-archnote" data-came-back="">
            <span className="ib-st">Archived · {asker} wrote after you archived it. Your reply goes to it; the thread stays archived.</span>
            <button type="button" className="ib-btn" onClick={() => void resolve(false)}>
              Unarchive
            </button>
          </div>
        )}
        {resolved ? (
          <div className="ib-acts">
            <span className="ib-st">Archived. The next message from {asker} starts a new thread.</span>
            <button type="button" className="ib-btn" onClick={() => void resolve(false)}>
              Unarchive
            </button>
          </div>
        ) : guard && staleQuestions.length > 0 ? (
          <StaleGuard
            ref={guardRef}
            questions={staleQuestions}
            thread={thread}
            words={boxWords}
            otherPicks={picksCount}
            annotations={records.length}
            onAnswerNew={(target) => {
              acknowledgeStale();
              requestAnimationFrame(() => jumpTo(target));
            }}
            onSendAnyway={() => {
              acknowledgeStale();
              void send({ despiteReplaced: true });
            }}
            onKeepEditing={() => {
              acknowledgeStale();
              requestAnimationFrame(() => (sendRef.current ?? textRef.current)?.focus());
            }}
          />
        ) : newMessage?.kind === 'compose' ? (
          <NewMessageComposer
            key={newMessage.target.session}
            thread={thread}
            target={newMessage.target}
            onCancel={() => setNewMessage(null)}
            onSent={async () => {
              setNewMessage(null);
              await onChanged();
              requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
            }}
          />
        ) : box.open ? (
          <>
            <DraftHead
              label={`Reply to ${asker} in ${thread.project.name}`}
              savedAt={box.text.trim() ? (replyDraft.draft?.updated_at ?? null) : null}
              conflict={
                replyDraft.conflict !== null
                  ? {
                      id: conflictId,
                      text: conflictText(conflictSentElsewhere),
                      onKeepMine: () => {
                        replyDraft.keepMine(box.text);
                        announce('Your words are saved.');
                        requestAnimationFrame(() => textRef.current?.focus());
                      },
                      onDiscard: () => {
                        // Only this window's words go: the other window's draft stays and comes into the box.
                        const theirs = replyDraft.takeTheirs();
                        setBox({ open: true, text: theirs });
                        announce(theirs.trim() ? 'Your words were discarded; the other window’s are in the box.' : 'Your words were discarded.');
                        requestAnimationFrame(() => textRef.current?.focus());
                      },
                    }
                  : null
              }
              onDiscard={() => {
                replyDraft.discard();
                closeBox();
                announce('Draft discarded.');
              }}
            />
            {staleQuestions.length > 0 && <ChangedNotice questions={staleQuestions} thread={thread} onJump={jumpTo} />}
            <div
              className="ib-rbox"
              // A paste that carries files (a screenshot, a copied image) attaches them; text pastes as text.
              onPaste={(event) => {
                if (replyFiles.paste(event)) setError(null);
              }}
            >
              <InboxComposerField
                textareaRef={textRef}
                ariaLabel={`Reply to ${asker}`}
                ariaDescribedBy={[showAskerNote ? noteId : null, replyDraft.conflict !== null ? conflictId : null].filter(Boolean).join(' ') || undefined}
                placeholder="Write a reply"
                destination="your reply"
                tags={composerTags}
                value={box.text}
                onChange={(text) => {
                  // Read-only while a Send is on its way: the words it carries are the words in the box.
                  if (sending) return;
                  // The words changed (or emptied): a Send waiting to be confirmed no longer matches them.
                  const earlier = unconfirmed.get(thread.thread_id);
                  if (earlier && text.trim() !== earlier.words) forgetUnconfirmed(earlier, text.trim() === '' ? 'emptied' : 'edited');
                  setBox({ open: true, text });
                  replyDraft.save(text);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    // With the choice open, the shortcut goes to it.
                    if (route.open) setRoute((current) => ({ ...current, focus: current.focus + 1 }));
                    else void send();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    if (route.open) routeBack();
                    else closeBox();
                  }
                }}
              />
              {replyFiles.files.length > 0 && (
                <div className="ib-rfiles" data-reply-files="">
                  <ComposeFileTiles
                    files={replyFiles.files}
                    onRemove={(key) => {
                      replyFiles.remove(key);
                      // The × goes with its tile: focus stays in the reply.
                      textRef.current?.focus();
                    }}
                  />
                </div>
              )}
              {draftAnswers.length > 0 && <ReplyAnswers answers={draftAnswers} onJump={jumpTo} />}
              {(draftAnswers.length > 0 || dropped.length > 0 || takesAnnotations || unanswered.length > 0) && (
                <div className={`ib-rfoot${keepOpen ? ' ib-keep' : ''}`}>
                  {/* The answers the list above shows, a pick still being saved included, so the two numbers agree. */}
                  {draftAnswers.length > 0 && (
                    <span className="ib-rchip" data-picks-chip="">
                      <Icon name="check" size={13} />
                      {plural(draftAnswers.length, 'pick')}
                    </span>
                  )}
                  <SkipChip count={keepOpen ? unanswered.length : skipIds.size} keepOpen={keepOpen} onToggle={toggleKeepOpen} />
                  {dropped.length > 0 && (
                    <Tip content="Replaced; this pick won't be sent">
                      <span className="ib-rchip ib-dropped" data-dropped-picks-chip="">
                        {dropped.length} {dropped.length === 1 ? 'pick' : 'picks'} on a replaced question
                      </span>
                    </Tip>
                  )}
                  {takesAnnotations && (
                    <AnnotationsChip
                      records={records}
                      attachments={allFiles}
                      onEdit={editRecord}
                      onRemove={removeRecord}
                      onOpen={openRecord}
                      messageName={messageCommentName}
                      unanchored={unanchoredComments}
                    />
                  )}
                </div>
              )}
            </div>
            <div className="ib-sr" role="status">
              {skipping ? `${plural(skipIds.size, 'question')} will be skipped when you send.` : ''}
            </div>
            {route.open && asking ? (
              routeChoice
            ) : (
              <>
              {error && errorLine}
              <div className="ib-acts">
                <button type="button" className="ib-btn ib-pri" ref={sendRef} onClick={() => void send()} disabled={sending}>
                  <Icon name="send" size={15} />
                  Send
                </button>
                <button type="button" className="ib-btn ib-ghost" onClick={closeBox}>
                  Cancel
                </button>
                <span className="ib-sp" />
                {/* A phone has no way to paste a picture into the reply (iOS offers no Paste for an image in a plain
                    text field), so it gets an attach button: the photo library or Files, into the same tiles,
                    upload path and names as a paste. A desktop stays paste-only (the owner's choice). */}
                {phone && (
                  <Tip content="Attach files">
                    <label className="ib-rattach" aria-label="Attach files">
                      <Icon name="clip" size={19} />
                      <input
                        type="file"
                        multiple
                        accept="image/*,*/*"
                        className="ib-sr"
                        data-reply-attach=""
                        onChange={(event) => {
                          if (event.target.files) replyFiles.attach(event.target.files);
                          event.target.value = '';
                          setError(null);
                        }}
                      />
                    </label>
                  </Tip>
                )}
                {/* The in-thread New message button is off (approval "inbox-acknowledge"); its route and code stay. */}
                {SHOW_NEW_MESSAGE_BUTTON && !archived && <NewMessageButton live={live} mode={newMessage} onClick={() => void pressNewMessage()} />}
              </div>
              </>
            )}
          </>
        ) : route.open && asking ? (
          routeChoice
        ) : (
          <>
          {error && errorLine}
          {/* Buttons on the left in today's order, the draft status and the skip chip at the right end (approval
              "thread-foot-status-right", option A). Too narrow for one line, the status takes its own line ABOVE the
              buttons (wrap-reverse; one item per line aligns to the start), so it never wraps between them. */}
          <div className="ib-acts ib-footrow" data-foot-row="" data-fit={rowLevel ? footRowTokens(rowLevel, phone) : undefined} ref={footRowRef}>
            <div className="ib-footbtns" data-foot-buttons="">
              {(waiting || draftKept) && (
                <button type="button" className="ib-btn ib-pri" ref={sendRef} onClick={() => void send()} disabled={sending} aria-describedby={footStatusIds}>
                  <Icon name="send" size={15} />
                  Send
                </button>
              )}
              <button
                type="button"
                className="ib-btn"
                onClick={() => openBox()}
                data-edit-draft={waiting || draftKept ? '' : undefined}
                data-reply-button=""
                aria-describedby={waiting || draftKept ? footStatusIds : undefined}
              >
                <Icon name={waiting || draftKept ? 'pen' : 'reply'} size={15} />
                {/* Short of room, "Edit", and on a phone the pencil alone (footFit.ts): the words stay as hidden text,
                    so the name is "Edit draft". */}
                {waiting || draftKept ? (
                  <span>
                    Edit<span className="ib-fl"> draft</span>
                  </span>
                ) : (
                  'Reply'
                )}
              </button>
              {/* The thread's open questions (approval "inbox-thread-open-questions"): a list that takes the person to each
                  card, with Re-ask at its foot (owner, 2026-10-23: the open questions again, in one message per session). */}
              {openQShown && (
                <OpenQuestionsButton
                  questions={openQ.questions}
                  actions={reaskActions}
                  reask={
                    reaskShown
                      ? { label: reaskItemLabel(reaskOpen), tooltip: reaskTooltip(reaskList), busy: reasking, onReask: () => void sendReask() }
                      : null
                  }
                  decide={decide}
                  triggerRef={reaskRef}
                  phone={phone}
                  measure={measureOpenQuestions}
                  onPick={(q) => jumpTo({ kind: 'question', messageId: q.messageId, key: q.key })}
                  onSetSkipped={setSkippedFromList}
                  rowForm={rowLevel !== null && footStatusShown ? footRowOpenQuestionsForm(rowLevel, rowMax) : null}
                />
              )}
              {/* 👍 Looks good beside Reply: sent to the agent after the Undo window; hidden while a question waits. */}
              {ackOffered && !waiting && !draftKept && (
                <Tip
                  content={
                    ackOn
                      ? 'Take back Looks good'
                      : `Tells ${agentName(ackTarget!.author)} you read it and need nothing more. Moves to Quiet until it writes again.`
                  }
                >
                  <button type="button" className="ib-btn ib-ack" data-ack="" aria-pressed={ackOn} onClick={() => onAck!(ackTarget!.id, !ackOn, agentName(ackTarget!.author))}>
                    <span className="ib-ack-emoji" aria-hidden="true">
                      👍
                    </span>
                    Looks good
                  </button>
                </Tip>
              )}
              {/* The in-thread New message button is off (approval "inbox-acknowledge", 2026-10-15): Reply and compose cover it.
                  Its route, door row and code stay; turn SHOW_NEW_MESSAGE_BUTTON on to bring it back. */}
              {SHOW_NEW_MESSAGE_BUTTON && !archived && <NewMessageButton live={live} mode={newMessage} onClick={() => void pressNewMessage()} />}
            </div>
            {(waiting || draftKept) && (
              <div className="ib-footstatus" data-foot-status="">
                <DraftFootNote id={draftNoteId} unsent={{ reply: draftKept, picks: picksCount, comments: records.length }} />
                {waiting && unanswered.length > 0 && (
                  <span className={keepOpen ? 'ib-keep' : undefined}>
                    <SkipChip id={skipNoteId} count={keepOpen ? unanswered.length : skipIds.size} keepOpen={keepOpen} onToggle={toggleKeepOpen} />
                  </span>
                )}
              </div>
            )}
            {/* A phone has no room to float the pill over the messages (it sat on a sender's row): it sits in this
                row's empty middle, laid over it, so the foot and the thread's view keep their size and Reply stays put.
                When a button sits under that middle (Reply, Re-ask and the open questions), it floats just above the
                foot instead, never over a button. With Send waiting (picks or kept words), no pill. */}
            {showNew && phone && !waiting && !draftKept && newPill}
          </div>
          </>
        )}
        {!archived && (
          <NewMessagePopover
            thread={thread}
            asker={asker}
            askerHost={root.author.kind === 'agent' ? root.author.host : null}
            live={live}
            mode={newMessage}
            onPick={(target) => setNewMessage({ kind: 'compose', target })}
            onReplyInstead={() => openBox()}
            onClose={() => setNewMessage(null)}
          />
        )}
        {error && !errorAbove && errorLine}
      </div>
    </section>
    {openAttachment && (
      <AttachmentPane
        ref={paneRef}
        attachment={openAttachment}
        attachments={allFiles}
        // The files' annotations only: a guided-review comment is on the guide's diff, not on a file.
        records={fileRecords}
        mentionSource={commentMentions}
        agent={asker}
        projectName={thread.project.name}
        projectRoot={thread.project.root}
        repo={thread.project.repo ?? null}
        version={file!.version}
        onVersion={(version) => onOpenFile({ id: openAttachment.id, version, focus: null, view: currentView })}
        full={shownFull}
        fullLocked={phone || fileStacked}
        phone={phone}
        openIn={openIn}
        steps={steps}
        // A step keeps the frame the person is in, and replaces the route.
        onStep={(attachmentId, version) => onOpenFile({ id: attachmentId, version, focus: null, view: currentView }, { replace: true })}
        // A link in an attached HTML page to another file of the thread: a new entry, so Back returns to the page; the frame stays.
        onOpenLinked={(attachmentId) => onOpenFile({ id: attachmentId, version: 'current', focus: null, view: currentView })}
        // A page the attached page links to: in the route (`linked=`), so each one is a history entry and Back steps back through them.
        linked={file!.linked ?? null}
        onLinked={(linked, options) => onOpenFile({ id: openAttachment.id, version: file!.version, focus: null, linked, view: currentView }, options)}
        onToggleFull={(pick) => {
          if (pick) pickView(full ? 'side' : 'full');
          else setFull(!full);
        }}
        // The switch's pressed half: the view on screen becomes the choice; the frame stays.
        onKeepView={() => pickView(currentView)}
        focusId={file!.focus}
        focusRequest={paneFocus}
        fromPerson={thread.messages.find((m) => m.id === openAttachment.message_id)?.author.kind === 'person'}
        readOnly={(() => {
          const owner = thread.messages.find((m) => m.id === openAttachment.message_id) ?? root;
          // The person does not comment on their own upload.
          return !liveMessage(owner) || owner.author.kind === 'person';
        })()}
        onSaved={saveRecord}
        onRemoved={dropRecord}
        onOpenAt={(attachmentId, version, focus) => onOpenFile({ id: attachmentId, version, focus, view: currentView }, { replace: true })}
        onClose={() => {
          onOpenFile(null);
        }}
        strip={{
          picks: picksCount,
          annotations: records.length,
          onWriteReply: () => {
            setFull(false);
            openBox();
          },
        }}
      />
    )}
    </>
  );
}

/**
 * What a Send does with the questions left unanswered (approval
 * "inbox-explicit-skip", 2026-10-21): by default "3 questions stay open ·
 * Skip them"; after Skip them, "↷ 3 questions will be skipped · Keep open",
 * for that one Send. Nothing when none is unanswered.
 */
function SkipChip({ count, keepOpen, onToggle, id }: { count: number; keepOpen: boolean; onToggle: () => void; id?: string }) {
  if (count === 0) return null;
  const them = count === 1 ? 'it' : 'them';
  return (
    <span className="ib-skipchip" data-skip-chip={keepOpen ? 'keep' : 'skip'}>
      {/* The icon and the sentence are one item, so where the chip wraps (a narrow reply box) the icon stays with its words. */}
      <span className="ib-skip-s" id={id}>
        {!keepOpen && <Icon name="forward" size={14} />}
        {/* Short of room, the foot's row drops the middle words ("1 open", "Skip"; footFit.ts, inbox.css): they leave
            only the eye, so the description and the button's name keep them, and the text reads the same. */}
        <span>
          {formatCount(count)}
          <span className="ib-fl">{keepOpen ? ` question${count === 1 ? ' stays' : 's stay'}` : ` question${count === 1 ? '' : 's'} will be`}</span>
          {keepOpen ? ' open' : ' skipped'}
        </span>
      </span>
      <button type="button" onClick={onToggle} data-skip-toggle="">
        {keepOpen ? (
          <>
            Skip<span className="ib-fl"> {them}</span>
          </>
        ) : (
          'Keep open'
        )}
      </button>
    </span>
  );
}

/**
 * One Inbox message as a run of Messages bubbles: words, pictures, question
 * cards, file and link cards, the guided review. Agent messages sit on the
 * left in grey; the person's on the right in the palette's brand colour.
 */
import { cloneElement, isValidElement, useMemo, useState, type ReactElement } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Reaction } from '@halftone/design-system/primitives/reaction';
import { Button } from '@halftone/design-system/primitives/button/button';
import { Text } from '@halftone/design-system/typography/text';
import { Caption } from '@halftone/design-system/typography/caption';
import { answerWords, replyWords } from '@inbox/folding';
import { formatBytes } from '@inbox/format';
import { inboxAgentName, type InboxMessageWire, type InboxQuestion, type InboxThread } from '@plannotator/core/inbox-types';
import type { InboxAttachment } from '@plannotator/core/inbox-attachments';
import { bodyParts, imageUrl, type Part } from './body';
import { QuestionCard } from './QuestionCard';
import { Glyph } from './marks';
import type { IconName } from '@inbox/icons';

declare global {
  interface Window {
    __INBOX_WINDOW__?: string;
  }
}

/** The real Inbox window, for what the prototype hands off (a file, a guided review). */
export function windowLink(hash: string): string {
  return `${window.__INBOX_WINDOW__ ?? '/'}#${hash}`;
}

function renderMarkdown(markdown: string, message: InboxMessageWire): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  // Inline pictures go through the Inbox's own image route; remote ones never load.
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  doc.querySelectorAll('img').forEach((img) => {
    const url = imageUrl(message, img.getAttribute('src') ?? '');
    if (url) img.setAttribute('src', url);
    else img.replaceWith(doc.createTextNode(`[${img.getAttribute('alt') || 'image'}]`));
    img.setAttribute('style', 'max-width:100%;border-radius:10px');
  });
  doc.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return doc.body.innerHTML;
}

export function TextBubble({ side, tail, corner, children }: { side: 'theirs' | 'mine'; tail: boolean; corner?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      data-side={side}
      data-tail={tail}
      className={`msg-bubble text-body-base ${side === 'mine' ? 'bg-brand-solid text-on-brand-solid-foreground' : 'bg-component text-primary-foreground'}`}
    >
      {children}
      {corner}
    </div>
  );
}

function ImageBubble({ src, alt, onOpen }: { src: string; alt: string; onOpen: (src: string, alt: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(src, alt)} className="block max-w-[min(20rem,78%)] overflow-hidden rounded-2xl border border-border-subtle bg-component focus-visible:outline-2" aria-label={`Open picture: ${alt || 'image'}`}>
      <img src={src} alt={alt} className="block h-auto max-h-80 w-auto max-w-full" loading="lazy" />
    </button>
  );
}

function Gallery({ images, onOpen }: { images: { src: string; alt: string }[]; onOpen: (src: string, alt: string) => void }) {
  return (
    <div className={`grid w-full max-w-[24rem] gap-1 overflow-hidden rounded-2xl ${images.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`} aria-label={`${images.length} pictures`}>
      {images.map((img) => (
        <button key={img.src} type="button" onClick={() => onOpen(img.src, img.alt)} className="block aspect-[3/4] overflow-hidden bg-component" aria-label={`Open picture: ${img.alt || 'image'}`}>
          <img src={img.src} alt={img.alt} className="size-full object-cover" loading="lazy" />
        </button>
      ))}
    </div>
  );
}

const KIND_ICON: Record<string, IconName> = { markdown: 'doc', text: 'doc', code: 'code', html: 'globe', mermaid: 'diagram', graphviz: 'diagram', pdf: 'doc', video: 'film', image: 'photo', file: 'download' };
const KIND_WORD: Record<string, string> = { markdown: 'Markdown', text: 'Text', code: 'Code', html: 'Web page', mermaid: 'Diagram', graphviz: 'Diagram', pdf: 'PDF', video: 'Video', image: 'Image', file: 'File' };

/** A file as Messages draws a link preview: an icon tile, the name, what it is. */
function FileCard({ attachment, threadId }: { attachment: InboxAttachment; threadId: string }) {
  const kind = String(attachment.kind);
  return (
    <a
      href={windowLink(`thread=${threadId}&file=${attachment.id}`)}
      target="_blank" data-link-unstyled
      rel="noreferrer"
      className="flex w-full max-w-[22rem] items-center gap-3 rounded-2xl bg-component px-3 py-2.5 hover:bg-component-hover"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-container text-secondary-foreground shadow-default">
        <Glyph name={KIND_ICON[kind] ?? 'doc'} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <Text size="sm" weight="medium" truncate>
          {attachment.name}
        </Text>
        <Caption color="tertiary" size="lg">
          {KIND_WORD[kind] ?? 'File'} · {formatBytes(attachment.size)}
        </Caption>
      </span>
      <Glyph name="external" size={14} className="text-tertiary-foreground" />
    </a>
  );
}

/** A web link the agent wrote, drawn as a card under its bubble (nothing is fetched). */
function LinkCard({ href }: { href: string }) {
  let host = href;
  let path = '';
  try {
    const url = new URL(href);
    host = url.hostname;
    path = url.pathname === '/' ? '' : url.pathname;
  } catch {
    /* keep the text */
  }
  return (
    <a href={href} data-link-unstyled target="_blank" rel="noopener noreferrer" className="flex w-full max-w-[22rem] flex-col overflow-hidden rounded-2xl bg-component hover:bg-component-hover">
      <span className="flex h-20 items-center justify-center bg-component-hover text-tertiary-foreground">
        <Glyph name="globe" size={28} />
      </span>
      <span className="px-3 py-2">
        <Text size="sm" weight="medium" truncate>
          {host}
        </Text>
        <Caption color="tertiary" size="lg" className="truncate">
          {path || href}
        </Caption>
      </span>
    </a>
  );
}

function GuideCard({ message }: { message: InboxMessageWire }) {
  const guide = message.guide!;
  return (
    <div className="w-full max-w-[24rem] overflow-hidden rounded-2xl border border-border-default bg-container shadow-default">
      <div className="flex items-center gap-3 border-b border-border-subtle bg-brand-subtle px-3 py-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-brand-solid text-on-brand-solid-foreground">
          <Glyph name="book" size={20} />
        </span>
        <div className="min-w-0">
          <Caption color="brand" size="lg" weight="medium">
            Guided review
          </Caption>
          <Text size="base" weight="medium" truncate>
            {guide.title}
          </Text>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <Caption color="secondary" size="lg">
          {guide.sections} chapters · {guide.files} files · <span className="text-positive-foreground">+{guide.additions}</span>{' '}
          <span className="text-danger-foreground">−{guide.deletions}</span>
        </Caption>
        <Button as="a" size="sm" variant="primary" shape="pill" href={windowLink(`thread=${message.thread_id}&guide=${message.id}`)} target="_blank" rel="noreferrer">
          Open review
        </Button>
      </div>
    </div>
  );
}

export interface MessageRunProps {
  message: InboxMessageWire;
  thread: InboxThread;
  /** The last bubble of a sender's group gets the tail. */
  tailOnLast: boolean;
  showName: boolean;
  onChanged: () => void;
  onOpenImage: (src: string, alt: string) => void;
  /** 👍 is allowed here (the thread's latest agent message, nothing open). */
  canAck: boolean;
  onAck: (on: boolean) => void;
}

export function MessageRun({ message, thread, tailOnLast, showName, onChanged, onOpenImage, canAck, onAck }: MessageRunProps) {
  const mine = message.author.kind === 'person';
  const [hover, setHover] = useState(false);
  const parts: Part[] = useMemo(() => (mine ? [] : bodyParts(message.body)), [mine, message.body]);
  const questions = (message.questions ?? []).filter((q) => q.kind !== 'action');
  const items: React.ReactNode[] = [];

  if (mine) {
    const words = replyWords(message.body).trim();
    const answered = thread.messages.flatMap((m) => (m.questions ?? []).filter((q) => q.sent_reply_id === message.id));
    if (words || answered.length > 0) {
      items.push(
        <TextBubble key="w" side="mine" tail={false}>
          {words && <div className="whitespace-pre-wrap">{words}</div>}
          {answered.length > 0 && <AnswerList questions={answered} spaced={Boolean(words)} />}
        </TextBubble>,
      );
    }
    for (const att of message.attachments ?? []) items.push(<FileCard key={att.id} attachment={att} threadId={thread.thread_id} />);
  } else {
    parts.forEach((part, i) => {
      if (part.kind === 'text') {
        items.push(
          <TextBubble key={`t${i}`} side="theirs" tail={false}>
            <div className="msg-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(part.markdown, message) }} />
          </TextBubble>,
        );
        for (const href of part.links) items.push(<LinkCard key={`l${i}${href}`} href={href} />);
      } else if (part.kind === 'image') {
        // Pictures next to each other become one gallery, as Messages groups photos sent together.
        if (parts[i - 1]?.kind === 'image') return;
        const run: { src: string; alt: string }[] = [];
        for (let j = i; parts[j]?.kind === 'image'; j += 1) {
          const p = parts[j] as Extract<Part, { kind: 'image' }>;
          const url = imageUrl(message, p.src);
          if (url) run.push({ src: url, alt: p.alt });
        }
        if (run.length === 1) items.push(<ImageBubble key={`i${i}`} src={run[0]!.src} alt={run[0]!.alt} onOpen={onOpenImage} />);
        else if (run.length > 1) items.push(<Gallery key={`g${i}`} images={run} onOpen={onOpenImage} />);
        else items.push(<TextBubble key={`i${i}`} side="theirs" tail={false}>[{part.alt || 'remote image'}]</TextBubble>);
      } else if (part.directive === 'action') {
        const action = message.actions?.[part.index];
        if (action) items.push(<ActionCard key={`a${i}`} action={action} />);
      } else {
        const q = questions[part.index];
        if (q) items.push(<QuestionCard key={q.key} question={q} number={part.index + 1} total={questions.length} onChanged={onChanged} />);
      }
    });
    for (const att of message.attachments ?? []) {
      if (String(att.kind) === 'image') items.push(<ImageBubble key={att.id} src={`/api/inbox/attachments/${att.id}/image`} alt={att.name} onOpen={onOpenImage} />);
      else items.push(<FileCard key={att.id} attachment={att} threadId={thread.thread_id} />);
    }
    if (message.guide) items.push(<GuideCard key="guide" message={message} />);
  }
  if (items.length === 0) return null;

  // The tail and the tapback go on the run's last plain bubble (Messages puts both there).
  const acked = Boolean(!mine && message.ack && !message.ack.not_sent);
  const lastText = items.map((n) => isValidElement(n) && n.type === TextBubble).lastIndexOf(true);
  const corner = acked ? (
    <span
      className="absolute -top-3 -right-3 z-10 flex size-7 items-center justify-center rounded-full border-2 border-container-recessed bg-brand-solid text-[13px] shadow-default"
      title={`You reacted 👍 ${message.ack!.label}`}
      aria-label={`You reacted 👍 ${message.ack!.label}`}
    >
      👍
    </span>
  ) : canAck && hover ? (
    <span className="absolute -top-4 -right-2 z-20 translate-x-full">
      <Reaction aria-label="React 👍 Looks good: marks it read and tells the agent" onClick={() => onAck(true)} className="bg-modal shadow-default">
        <Reaction.Emoji>👍</Reaction.Emoji>
        <span className="text-caption-lg">Looks good</span>
      </Reaction>
    </span>
  ) : null;
  if (lastText >= 0) {
    const el = items[lastText] as ReactElement<{ tail: boolean; corner?: React.ReactNode }>;
    items[lastText] = cloneElement(el, { tail: tailOnLast && lastText === items.length - 1, corner: mine ? undefined : corner });
  }
  return (
    <div
      className={`relative flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}
      data-message-id={message.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => canAck && onAck(!acked)}
    >
      {showName && !mine && (
        <Caption color="tertiary" size="lg" className="ms-3">
          {inboxAgentName(message.author)}
        </Caption>
      )}
      {items}
    </div>
  );
}

function AnswerList({ questions, spaced }: { questions: InboxQuestion[]; spaced: boolean }) {
  return (
    <ul className={`flex flex-col gap-0.5 ${spaced ? 'mt-1.5 border-t border-current/25 pt-1.5' : ''}`}>
      {questions.map((q) => (
        <li key={q.key} className="text-body-sm">
          <span className="opacity-75">{q.prompt.replace(/[?.:]+$/, '')} → </span>
          <span className="font-medium">{q.answer ? answerWords(q.answer) : '—'}</span>
        </li>
      ))}
    </ul>
  );
}

function ActionCard({ action }: { action: InboxQuestion }) {
  return (
    <div className="w-full max-w-[24rem] rounded-2xl border border-border-default bg-container p-3 shadow-default">
      <Caption color="tertiary" size="lg" className="flex items-center gap-1">
        <Glyph name="todo" size={13} /> Only you can do this
      </Caption>
      <Text size="base" weight="medium" className="mt-1">
        {action.prompt}
      </Text>
    </div>
  );
}

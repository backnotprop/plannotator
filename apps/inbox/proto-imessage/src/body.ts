/**
 * A message body as Messages draws it: a run of bubbles. Text runs stay
 * markdown; an image alone on its line becomes its own picture bubble; each
 * `:::question` / `:::action` block becomes a card where the agent put it;
 * web links in the text get a link card after their bubble.
 */
import { findDirectiveBlocks } from '@plannotator/core/question-block';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';

export type Part =
  | { kind: 'text'; markdown: string; links: string[] }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'directive'; directive: string; index: number };

const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const URL = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

export function bodyParts(body: string): Part[] {
  const lines = body.split('\n');
  const blocks = findDirectiveBlocks(body).filter((b) => /^(question|question-multi|question-text|action)$/.test(b.directiveKind));
  const parts: Part[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const markdown = buffer.join('\n').trim();
    buffer = [];
    if (!markdown) return;
    parts.push({ kind: 'text', markdown, links: [...new Set(markdown.match(URL) ?? [])] });
  };
  const counters: Record<string, number> = { q: 0, a: 0 };
  for (let i = 0; i < lines.length; i += 1) {
    const block = blocks.find((b) => b.startLine === i + 1);
    if (block) {
      flush();
      const isAction = block.directiveKind === 'action';
      parts.push({ kind: 'directive', directive: block.directiveKind, index: isAction ? counters.a++ : counters.q++ });
      i = block.endLine - 1;
      continue;
    }
    const image = lines[i]!.match(IMAGE_LINE);
    if (image) {
      flush();
      parts.push({ kind: 'image', alt: image[1] ?? '', src: image[2]! });
      continue;
    }
    buffer.push(lines[i]!);
  }
  flush();
  return parts;
}

/** Where a picture's bytes come from: its captured copy, else the message's own image route. */
export function imageUrl(message: InboxMessageWire, src: string): string | null {
  if (/^(https?:)?\/\//i.test(src)) return null; // remote pictures never load in the Inbox
  const captured = message.inline_images?.find((img) => img.ref === src);
  if (captured) return `/api/inbox/attachments/${encodeURIComponent(captured.id)}/image`;
  return `/api/inbox/messages/${encodeURIComponent(message.id)}/image?path=${encodeURIComponent(src)}`;
}

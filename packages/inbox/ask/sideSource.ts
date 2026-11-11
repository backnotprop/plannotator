/** One bracketed line per quote, sent to the agent in front of the question; the box and transcript show only the clean quote. */
import { inboxAgentName } from '@plannotator/core/inbox-types';
import type { Annotation, Block } from '@plannotator/ui/types';

export function sideTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function headingBefore(blocks: readonly Block[], blockId: string): string | null {
  const at = blocks.findIndex((block) => block.id === blockId);
  for (let i = at - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.type === 'heading' && block.content.trim()) return block.content.trim();
  }
  return null;
}

const COMMENT_MAX = 300;
const clip = (text: string) => (text.length > COMMENT_MAX ? `${text.slice(0, COMMENT_MAX)}…` : text);

function commentsOn(annotations: readonly Annotation[], selected: string): string[] {
  const words = selected.trim();
  if (!words) return [];
  const out: string[] = [];
  for (const annotation of annotations) {
    const marked = annotation.originalText?.trim();
    if (!marked || !(words.includes(marked) || marked.includes(words))) continue;
    if (annotation.type === 'COMMENT' && annotation.text?.trim()) out.push(` The person's comment on these words: "${clip(annotation.text.trim())}"`);
    else if (annotation.type === 'DELETION') out.push(' The person marked these words to remove.');
  }
  return out;
}

interface Where {
  selected: string;
  blockId: string;
  blocks: readonly Block[];
  annotations: readonly Annotation[];
}

export function messageSideSource(message: { id: string; created_at: string; author: { kind: string; host?: string | null; name?: string | null } }, where: Where): string {
  const sender = message.author.kind === 'agent' ? `${inboxAgentName(message.author)}'s message` : 'the person\'s message';
  const heading = where.blockId ? headingBefore(where.blocks, where.blockId) : null;
  const under = heading ? `, under "${heading}"` : '';
  return `[Quoted from ${sender} ${message.id} (${sideTime(message.created_at)})${under}.${commentsOn(where.annotations, where.selected).join('')}]`;
}

export function fileSideSource(
  file: { name: string; path: string; named_path: string | null; sent_at: string; changed_since_sent: boolean },
  version: 'current' | 'sent',
  where: Where,
): string {
  const which =
    version === 'sent' ? `the version sent ${sideTime(file.sent_at)}` : file.changed_since_sent ? `the current version, changed since it was sent ${sideTime(file.sent_at)}` : 'the version sent, unchanged';
  const block = where.blockId ? where.blocks.find((b) => b.id === where.blockId) : undefined;
  const line = block ? `, line ${block.startLine}` : '';
  const heading = where.blockId ? headingBefore(where.blocks, where.blockId) : null;
  const under = heading ? `, under "${heading}"` : '';
  return `[Quoted from ${file.name} (${file.named_path ?? file.path}, attached to this thread; ${which})${line}${under}.${commentsOn(where.annotations, where.selected).join('')}]`;
}

import { inboxUrl } from './inboxUrl';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ATTACHMENT_FEEDBACK_HEADING, SENT_VERSION_SUFFIX, exportFileLabel } from './attachments';
import { inboxMarkupName } from './images';

const TOKEN_PREFIX = '.inbox-reply/';
const FILE_TOKEN = /^\.inbox-reply\/file\/(att_[0-9A-Za-z]+)\/(current|sent)$/;
const MARKUP_TOKEN = /^\.inbox-reply\/markup\/([0-9a-f]{64}\.(?:png|jpg|webp))$/;

export interface ReplyFileContext {
  files: readonly InboxAttachmentState[];
  projectRoot: string;
  personMessageIds: ReadonlySet<string>;
  replyAt?: string;
}

export interface ReplyFileTarget {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
}

const IMAGE_IN_MESSAGE = /^(.*) \(image in (your|my) [^()]*message(?: \d+)?\)$/;

export function replyFeedbackFile(label: string, context: ReplyFileContext): ReplyFileTarget | null {
  const { files, projectRoot, personMessageIds } = context;
  let base = label.trim();
  let sent = false;
  for (const suffix of Object.values(SENT_VERSION_SUFFIX)) {
    if (!base.endsWith(suffix)) continue;
    base = base.slice(0, -suffix.length);
    sent = true;
    break;
  }
  if (!base) return null;
  const labelOf = (file: InboxAttachmentState) => {
    const mine = file.ref !== undefined && personMessageIds.has(file.message_id);
    return exportFileLabel(file, projectRoot, files, mine);
  };
  let candidates = files.filter((file) => labelOf(file) === base);
  if (candidates.length === 0) {
    const match = IMAGE_IN_MESSAGE.exec(base);
    if (match) candidates = files.filter((file) => file.ref === match[1] && personMessageIds.has(file.message_id) === (match[2] === 'my'));
  }
  const before = context.replyAt ? candidates.filter((file) => file.sent_at <= context.replyAt!) : candidates;
  const attachment = [...before].sort((a, b) => b.sent_at.localeCompare(a.sent_at))[0];
  if (!attachment) return null;
  const version = sent || attachment.unavailable !== null ? 'sent' : 'current';
  return { attachment, version };
}

function linkable(text: string): boolean {
  if (text.includes('\\') || text.includes('\n')) return false;
  let depth = 0;
  for (const ch of text) {
    if (ch === '[') depth++;
    else if (ch === ']' && --depth < 0) return false;
  }
  return depth === 0;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const MARKUP_LINE = /^(\s*[-*] )\[([^\[\]\n\\]+)\] (`[^`\n]+`)\s*$/;

export function linkReplyFeedback(markdown: string, context: ReplyFileContext): string {
  if (!markdown.includes(`# ${ATTACHMENT_FEEDBACK_HEADING.title}`)) return markdown;
  const lines = markdown.split('\n');
  let inSection = false;
  let fence: string | null = null;
  let changed = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const opener = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener) {
      fence = opener;
      continue;
    }
    if (line === `# ${ATTACHMENT_FEEDBACK_HEADING.title}`) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^---\s*$/.test(line) || /^# /.test(line)) {
      inSection = false;
      continue;
    }
    if (line.startsWith('## ')) {
      const label = line.slice(3).trimEnd();
      const target = linkable(label) ? replyFeedbackFile(label, context) : null;
      if (!target) continue;
      lines[index] = `## [${label}](${TOKEN_PREFIX}file/${target.attachment.id}/${target.version})`;
      changed = true;
      continue;
    }
    const markup = MARKUP_LINE.exec(line);
    if (markup) {
      const name = inboxMarkupName(markup[3]!.slice(1, -1));
      if (!name) continue;
      lines[index] = `${markup[1]}[${markup[2]}](${TOKEN_PREFIX}markup/${name})`;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : markdown;
}

export type ReplyLink = { kind: 'file'; attachment: InboxAttachmentState; version: 'current' | 'sent' } | { kind: 'markup'; src: string };

export function resolveReplyLink(href: string, files: readonly InboxAttachmentState[]): ReplyLink | null {
  if (!href.startsWith(TOKEN_PREFIX)) return null;
  const file = FILE_TOKEN.exec(href);
  if (file) {
    const attachment = files.find((a) => a.id === file[1]);
    return attachment ? { kind: 'file', attachment, version: file[2] as 'current' | 'sent' } : null;
  }
  const markup = MARKUP_TOKEN.exec(href);
  return markup ? { kind: 'markup', src: inboxUrl(`/markups/${markup[1]}`) } : null;
}

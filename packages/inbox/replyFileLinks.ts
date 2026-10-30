/**
 * The files named in the person's own sent reply, as links (the owner's ask,
 * 2026-10-29: "When I comment on an image… or any attachment in the same
 * way… the reply body should ideally make a link for me to click").
 *
 * A Send carries the comments on files as Plannotator's feedback text
 * (`attachmentFeedback`): under "# Feedback on the attached files", one
 * `## <file>` heading per file and version, and a drawing on an image as an
 * "Attached images" line naming its path in the data dir. That text is what
 * the agent gets and it is kept as it is. When the window draws the reply,
 * each heading that names a file of the thread becomes a link that opens
 * that file beside the thread (the version the comments were on), and each
 * drawing's name a link that shows the drawing, in place of its data-dir
 * path (a path that names no drawing the Inbox kept stays). Display only.
 *
 * The heading is matched against the thread's files by the label the export
 * wrote for them (`exportFileLabel`), so nothing is guessed from a bare name.
 * A heading that names no file the thread still has stays plain text: never
 * a dead link. A file whose current bytes cannot be opened now (moved,
 * deleted) links to the version that was sent, which always can.
 */
import { inboxUrl } from './inboxUrl';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ATTACHMENT_FEEDBACK_HEADING, SENT_VERSION_SUFFIX, exportFileLabel } from './attachments';
import { inboxMarkupName } from './images';

/** Where a link the reply's text was given points: `.inbox-reply/file/<attachment id>/<version>` or `.inbox-reply/markup/<sha256>.png`. */
const TOKEN_PREFIX = '.inbox-reply/';
const FILE_TOKEN = /^\.inbox-reply\/file\/(att_[0-9A-Za-z]+)\/(current|sent)$/;
const MARKUP_TOKEN = /^\.inbox-reply\/markup\/([0-9a-f]{64}\.(?:png|jpg|webp))$/;

export interface ReplyFileContext {
  /** Every file of the thread: the attached files and the images the messages showed. */
  files: readonly InboxAttachmentState[];
  projectRoot: string;
  /** The person's own messages (their images are "image in my … message"). */
  personMessageIds: ReadonlySet<string>;
  /** When the reply was sent: a heading names a file sent before it. */
  replyAt?: string;
}

export interface ReplyFileTarget {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
}

/** `design/hero.png (image in your 11:22 AM message)`, or with seconds, or a place: the src as written. */
const IMAGE_IN_MESSAGE = /^(.*) \(image in (your|my) [^()]*message(?: \d+)?\)$/;

/**
 * The file a heading of the feedback names, and the version its comments
 * were on, or null when the thread has no such file now. `label` is the
 * heading's text as the export wrote it.
 */
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
    // An image in a message's text, its time written in another time zone or a tie broken otherwise: by its src.
    // "my": an image in one of the person's own messages; "your": in an agent's.
    const match = IMAGE_IN_MESSAGE.exec(base);
    if (match) candidates = files.filter((file) => file.ref === match[1] && personMessageIds.has(file.message_id) === (match[2] === 'my'));
  }
  // The same file attached again later: the one sent last before the reply.
  const before = context.replyAt ? candidates.filter((file) => file.sent_at <= context.replyAt!) : candidates;
  const attachment = [...before].sort((a, b) => b.sent_at.localeCompare(a.sent_at))[0];
  if (!attachment) return null;
  // The file as it is now when the comments were on it, unless it can no longer be opened.
  const version = sent || attachment.unavailable !== null ? 'sent' : 'current';
  return { attachment, version };
}

/** Link text drawn as written: only a label whose brackets pair up and that has no backslash keeps its link. */
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
/** A drawing on an image, as the export lists it: `- [name] \`<data dir>/inbox/markups/<sha256>.png\``. */
const MARKUP_LINE = /^(\s*[-*] )\[([^\[\]\n\\]+)\] (`[^`\n]+`)\s*$/;

/**
 * The reply's text with the feedback's file headings and drawings made into
 * links the window resolves (`resolveReplyLink`). Only the "Feedback on the
 * attached files" section is read, outside code fences; the text is returned
 * unchanged when nothing in it resolves.
 */
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
    // The section ends at the export's closing rule or the next top heading (the guided review's).
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
      // The link shows the drawing, so its long data-dir path (the agent's, kept in the stored text) is not drawn too.
      lines[index] = `${markup[1]}[${markup[2]}](${TOKEN_PREFIX}markup/${name})`;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : markdown;
}

export type ReplyLink = { kind: 'file'; attachment: InboxAttachmentState; version: 'current' | 'sent' } | { kind: 'markup'; src: string };

/** What a link `linkReplyFeedback` wrote opens, or null for any other link (and for a file the thread no longer has). */
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

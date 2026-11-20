/**
 * The feedback suite: the text a Send carries for the person's comments on
 * attached files, and the comments the window makes on code lines and on a
 * picture. scripts/mobile/vectors.ts writes vectors/feedback.json from it.
 *
 * The window builds that text in the browser (packages/inbox/attachments.ts
 * `attachmentFeedback`, over packages/ui/utils/parser.ts
 * `exportLinkedDocAnnotations`). The phone builds the same text itself, so a
 * Send made with the computer away already holds it; this suite is what holds
 * the phone's text to the window's, byte for byte. Each case is run through
 * the window's own functions, never a copy of them.
 */
import type { InboxAnnotationRecord, InboxAttachmentState } from '../../packages/core/inbox-attachments';
import { attachmentFeedback, codeCommentAnnotation, codeHash, imageCommentAnnotation } from '../../packages/inbox/attachments';
import { markupWords } from '../../packages/inbox/markup';
import { prototypeNames, type PrototypeMessage, type PrototypeQuestion } from '../../packages/inbox/prototypes';
import { readRepoText } from './lib';

export const FEEDBACK_FIXTURE = 'apps/mobile/contract/fixtures/feedback.json';

type FileCase = { id: string; path: string; name: string; kind: string; sent_sha256?: string; message_id?: string };
type RecordCase = { id: string; attachment_id: string; version: string; annotation: Record<string, unknown> };
/** `messages`: the thread's messages as the window reads prototypes from them (prototypes.ts `prototypeNames`). */
type FeedbackCase = { name: string; note: string; project_root: string; attachments: FileCase[]; texts: Record<string, string>; records: RecordCase[]; messages?: (PrototypeMessage & { questions?: (PrototypeQuestion & { kind?: string })[] })[] };
type Fixture = {
  cases: FeedbackCase[];
  code_comments: { line_start: number; line_end: number; code: string; text: string }[];
  /** A long run of one letter for a case's `code`, so the fixture stays readable: `{ repeat: "x", times: 5000 }`. */
  long_code_comments: { line_start: number; line_end: number; repeat: string; times: number; text: string }[];
  image_comments: { name: string; words: string; markup: { path: string; name: string } | null }[];
  hashes: string[];
};

function stateOf(file: FileCase): InboxAttachmentState {
  return {
    id: file.id, path: file.path, name: file.name, kind: file.kind, sent_sha256: file.sent_sha256 ?? 'a'.repeat(64), size: 0, sent_at: '2026-11-20T10:00:00.000Z', sent_mtime: '2026-11-20T10:00:00.000Z',
    message_id: file.message_id ?? 'msg_FEEDBACK', changed_since_sent: false, unavailable: null, current: null,
  } as unknown as InboxAttachmentState;
}

function recordOf(record: RecordCase, files: FileCase[], index: number): InboxAnnotationRecord {
  const file = files.find((f) => f.id === record.attachment_id);
  const at = new Date(Date.UTC(2026, 10, 20, 10, 0, index)).toISOString();
  return {
    id: record.id, project_id: 'prj_FEEDBACK', thread_id: 'msg_FEEDBACK', message_id: file?.message_id ?? 'msg_FEEDBACK', attachment_id: record.attachment_id, path: file?.path ?? '',
    version: record.version, annotation: record.annotation, created_at: at, updated_at: at, removed_at: null, sent_reply_id: null,
  };
}

/** A made annotation without the two fields the maker stamps itself (its id and the clock). */
function made(annotation: object): Record<string, unknown> {
  const { id: _id, createdA: _at, ...rest } = annotation as Record<string, unknown>;
  return rest;
}

export function feedbackVectors(about: string): unknown {
  const fixture = JSON.parse(readRepoText(FEEDBACK_FIXTURE)) as Fixture;
  const code = [...fixture.code_comments, ...fixture.long_code_comments.map((c) => ({ line_start: c.line_start, line_end: c.line_end, code: c.repeat.repeat(c.times), text: c.text }))];
  return {
    about,
    cases: fixture.cases.map((c) => {
      const texts = new Map(Object.entries(c.texts).map(([key, text]) => [key.replace('|', '\0'), text]));
      const records = c.records.map((record, index) => recordOf(record, c.attachments, index));
      const names = c.messages ? prototypeNames(c.messages, c.project_root) : undefined;
      return {
        ...c,
        ...(names ? { prototype_names: Object.fromEntries(names.attachments) } : {}),
        feedback: attachmentFeedback(records, c.attachments.map(stateOf), texts, c.project_root, names ? { prototypeNames: names } : {}),
      };
    }),
    code_comments: code.map((c) => ({
      ...c,
      annotation: made(codeCommentAnnotation({ id: 'x', lineStart: c.line_start, lineEnd: c.line_end, text: c.text, code: c.code, createdA: 0 })),
    })),
    image_comments: fixture.image_comments.map((c) => ({
      ...c,
      annotation: made(imageCommentAnnotation({ id: 'x', name: c.name, text: markupWords(c.words, c.markup !== null), markup: c.markup, createdA: 0 })),
    })),
    hashes: fixture.hashes.map((text) => ({ text, hash: codeHash(text) })),
  };
}

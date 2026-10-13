/**
 * Plannotator Inbox attachments: the browser-safe shapes and the file rules
 * that need no filesystem.
 *
 * An agent attaches files to a message by path (`send_message`'s
 * `attachments`). At send time the Inbox records each file's absolute
 * realpath, copies its bytes into a content-addressed blob
 * (`inbox/blobs/<sha256>`, the version it sent) and writes one attachment
 * record on the message. The window and agents reach a file ONLY by its
 * attachment id, never by a path: the current file as it is on disk now, or
 * the sent version from the blob. Any regular file the agent can read is
 * taken, from anywhere on disk (owner, 2026-10-10: "make it very accessible
 * and ergonomic for an agent to point out a file so it shows"), with no size
 * bound (owner, 2026-10-06 and 2026-10-10: no caps). The one refusal is the
 * dotenv family (`.env`, `.env.*` outside the annotatable docs such as
 * `.env.example`): the Inbox keeps a copy of what it was sent.
 *
 * The kind says how the window shows the file. Annotatable documents keep
 * their viewers by extension (markdown, text, HTML, Mermaid, Graphviz);
 * everything else is decided from the bytes at send time
 * (packages/shared/inbox/attachments.ts): an image by its magic bytes
 * (`image`), a PDF by `%PDF-` (`pdf`), UTF-8 text with no NUL (`code`, shown
 * with line comments), anything else `file` (offered as a download). A
 * document whose bytes are not text is a `file` too.
 *
 * The person's annotations on an attachment are stored per attachment and
 * version (`inbox/projects/<key>/annotations.jsonl`): `version` is "current"
 * (the file on disk, whatever its bytes are now, so a draft survives the
 * agent's edit and re-anchors by its text, the #1710 lesson) or the sent
 * blob's sha256.
 */

import { diagramRenderKindForPath, isAnnotatableDocPath, isDotenvFileName } from "./annotatable";
import { CODE_FILE_REGEX } from "./code-file";
import { ulid } from "./inbox-types";

/**
 * How the window draws a file: Plannotator's viewer for its type. `code` (a
 * source file, a script, or any other UTF-8 text) is drawn as a code view
 * with line comments; `image` inline in the message and in an image viewer;
 * `pdf` and `file` are offered as downloads.
 *
 * Strictly additive: a reader that meets a kind it does not know (an older
 * window reading a newer store, a newer kind on a phone) treats it as `file`,
 * a download (`readInboxAttachmentKind`).
 */
export type InboxAttachmentKind = "markdown" | "text" | "html" | "mermaid" | "graphviz" | "code" | "image" | "pdf" | "file";

const KNOWN_KINDS: ReadonlySet<string> = new Set(["markdown", "text", "html", "mermaid", "graphviz", "code", "image", "pdf", "file"]);

/** A kind as a reader should treat it: a value it does not know is `file` (a download). */
export function readInboxAttachmentKind(kind: unknown): InboxAttachmentKind {
  return typeof kind === "string" && KNOWN_KINDS.has(kind) ? (kind as InboxAttachmentKind) : "file";
}

/** Kinds whose bytes are text, read through the `view` route. */
export function isInboxTextKind(kind: unknown): boolean {
  const k = readInboxAttachmentKind(kind);
  return k !== "image" && k !== "pdf" && k !== "file";
}

/** Kinds the person can comment on (every viewer kind; a PDF and a plain file are downloads). */
export function isInboxAnnotatableKind(kind: unknown): boolean {
  const k = readInboxAttachmentKind(kind);
  return k !== "pdf" && k !== "file";
}

export interface InboxAttachment {
  /** `att_<ULID>`. */
  id: string;
  /** The file's absolute realpath at send time: the only path ever read. */
  path: string;
  /** The path as the agent named it (absolute) when it differs from `path` (a symlink). */
  named_path: string | null;
  /** The file name, for display. */
  name: string;
  kind: InboxAttachmentKind;
  /** The sha256 of the bytes sent: the blob `inbox/blobs/<sent_sha256>`. */
  sent_sha256: string;
  /** Size in bytes of the sent version. */
  size: number;
  /** When it was sent (the message's time). */
  sent_at: string;
  /** The file's mtime when it was sent. */
  sent_mtime: string;
  /** The sniffed content type of the sent bytes (images: `image/png`, ...; PDF: `application/pdf`). Added with the image and pdf kinds. */
  media_type?: string;
  /** An image's size in pixels, from its header, when it parses. */
  width?: number;
  height?: number;
}

/** Why the current file cannot be opened (the sent version always can). */
export type InboxAttachmentUnavailable =
  | { code: "attachment_missing"; message: string }
  | { code: "attachment_changed_type"; message: string };

/** An attachment as the window reads it: the record plus the file as it is now. */
export interface InboxAttachmentState extends InboxAttachment {
  message_id: string;
  /** The file on disk now, or null when it cannot be opened (`unavailable` says why). */
  current: { sha256: string; size: number; mtime: string } | null;
  /** The current bytes differ from the sent ones. */
  changed_since_sent: boolean;
  unavailable: InboxAttachmentUnavailable | null;
}

/** "current", or the sent blob's sha256. */
export type InboxAnnotationVersion = string;

/**
 * Where a comment on a guided review's diff sits: a file of the guide's
 * patch, one side of it, and a line range in that side's numbering (the
 * review app's line comment). Set on the record instead of an attachment.
 */
export interface InboxGuideCommentTarget {
  /** The guided review's title, as the message carries it. */
  title: string;
  /** The file, as the guide's patch names it. */
  file: string;
  /** `new`: the changed file's lines; `old`: the original's. */
  side: "old" | "new";
  line_start: number;
  line_end: number;
}

/**
 * One annotation of the person's, stored until it rides a Send: on an
 * attachment, or (with `guide`) on the diff of the guided review a message
 * carries.
 */
export interface InboxAnnotationRecord {
  /** The annotation's own id (Plannotator's `Annotation.id`). */
  id: string;
  project_id: string;
  thread_id: string;
  message_id: string;
  /** The attachment it is on; empty for a guided-review comment (`guide` set). */
  attachment_id: string;
  /** The attachment's realpath, or a guided-review comment's file as the patch names it: with `version`, the draft's key. */
  path: string;
  /** For a guided-review comment, the sha256 of the guide snapshot it was made on. */
  version: InboxAnnotationVersion;
  /** Set on a comment on a guided review's diff (additive: an older reader sees a record whose attachment it cannot find). */
  guide?: InboxGuideCommentTarget;
  /** Plannotator's `Annotation` (attachments) or the review app's `CodeAnnotation` (guided reviews), as the viewer made it (opaque to the store beyond the checks). */
  annotation: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  /** The person's reply that carried it, or null while it waits for a Send. */
  sent_reply_id: string | null;
}

export const INBOX_ANNOTATION_CURRENT = "current";

/**
 * The largest text the window reads whole (the `view` and raw routes). A
 * text or code file over it is attached as a `file` (a download), and a text
 * file that grew past it after it was sent answers `413
 * attachment_too_large`, which the window shows as its Download card. This
 * bounds what is read into memory, not what attaches.
 */
export const INBOX_VIEW_MAX_BYTES = 16 * 1024 * 1024;

const ATTACHMENT_ID_RE = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;
/** An annotation id the viewer mints: short, and safe in a URL path segment. */
const ANNOTATION_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function inboxAttachmentId(now?: number): string {
  return `att_${ulid(now)}`;
}

export function isInboxAttachmentId(value: unknown): value is string {
  return typeof value === "string" && ATTACHMENT_ID_RE.test(value);
}

export function isInboxAnnotationId(value: unknown): value is string {
  return typeof value === "string" && ANNOTATION_ID_RE.test(value);
}

export function isInboxAnnotationVersion(value: unknown): value is InboxAnnotationVersion {
  return value === INBOX_ANNOTATION_CURRENT || (typeof value === "string" && SHA256_RE.test(value));
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** A source file or script by its name: the code-file set annotate links to (`CODE_FILE_REGEX`). */
function isCodeName(name: string): boolean {
  return CODE_FILE_REGEX.test(name);
}

/**
 * The one name rule: the dotenv family is never attached (it holds secrets,
 * and the Inbox keeps a copy of what it was sent). Checked on the named path,
 * on its realpath, and again whenever the current file is served, by the
 * window's routes and the phone's door alike. Null when the name passes.
 */
export function inboxAttachmentNameRefusal(path: string): string | null {
  const name = baseName(path);
  if (isDotenvFileName(name)) return ".env files are never attached (they hold secrets).";
  return null;
}

/**
 * The viewer a file's NAME asks for: a document kind by extension, `code` for
 * a source file or script, else `file`. The send path decides the final kind
 * from the bytes too (`decideInboxAttachmentKind` in
 * packages/shared/inbox/attachments.ts). A name both sets know (`.json`,
 * `.yaml`) stays text.
 */
export function inboxAttachmentKind(path: string): InboxAttachmentKind {
  const name = baseName(path);
  if (/\.html?$/i.test(name)) return "html";
  const diagram = diagramRenderKindForPath(name);
  if (diagram) return diagram;
  if (/\.mdx?$/i.test(name)) return "markdown";
  if (isAnnotatableDocPath(name)) return "text";
  if (isCodeName(name)) return "code";
  return "file";
}

/**
 * Whether bytes read as text: valid UTF-8 with no NUL byte. A `code`
 * attachment must (a binary file under a source name is refused at send).
 */
export function isInboxTextBytes(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const MEDIA_LABELS: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "image/avif": "AVIF",
  "image/bmp": "BMP",
  "image/x-icon": "ICO",
  "image/svg+xml": "SVG",
};

/** The kind as a tile names it: "Markdown", "HTML", "PNG image", "PDF", "ZIP file". An unknown kind reads as a file. */
export function inboxAttachmentKindLabel(kind: InboxAttachmentKind | string, name: string, mediaType?: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1];
  switch (readInboxAttachmentKind(kind)) {
    case "markdown":
      return "Markdown";
    case "html":
      return "HTML";
    case "mermaid":
      return "Mermaid";
    case "graphviz":
      return "Graphviz";
    case "text":
      return ext && ext.toLowerCase() !== "txt" ? ext.toUpperCase() : "Text";
    case "code":
      return ext ? `Code (.${ext.toLowerCase()})` : `Code (${name})`;
    case "image": {
      const label = (mediaType && MEDIA_LABELS[mediaType]) ?? ext?.toUpperCase();
      return label ? `${label} image` : "Image";
    }
    case "pdf":
      return "PDF";
    default:
      return ext ? `${ext.toUpperCase()} file` : "File";
  }
}

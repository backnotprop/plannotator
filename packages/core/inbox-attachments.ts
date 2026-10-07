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
 * the sent version from the blob. Annotate's file rules apply, without its
 * size bound (owner, 2026-10-06: no caps): the annotatable extension set,
 * `.env` refused, regular files only.
 *
 * The person's annotations on an attachment are stored per attachment and
 * version (`inbox/projects/<key>/annotations.jsonl`): `version` is "current"
 * (the file on disk, whatever its bytes are now, so a draft survives the
 * agent's edit and re-anchors by its text, the #1710 lesson) or the sent
 * blob's sha256.
 */

import { diagramRenderKindForPath, isAnnotatableDocPath } from "./annotatable";
import { ulid } from "./inbox-types";

/** How the window draws a file: Plannotator's viewer for its type. */
export type InboxAttachmentKind = "markdown" | "text" | "html" | "mermaid" | "graphviz";

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

/** One annotation of the person's on an attachment, stored until it rides a Send. */
export interface InboxAnnotationRecord {
  /** The annotation's own id (Plannotator's `Annotation.id`). */
  id: string;
  project_id: string;
  thread_id: string;
  message_id: string;
  attachment_id: string;
  /** The attachment's realpath: with `version`, the draft's key. */
  path: string;
  version: InboxAnnotationVersion;
  /** Plannotator's `Annotation`, as the viewer made it (opaque to the store). */
  annotation: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  /** The person's reply that carried it, or null while it waits for a Send. */
  sent_reply_id: string | null;
}

export const INBOX_ANNOTATION_CURRENT = "current";

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

/**
 * Annotate's file rules on a name, without the size bound: `.env` is refused
 * (it holds secrets, and the Inbox keeps a copy of what it was sent), and only
 * the annotatable extensions open (plain text, config and data formats,
 * diagram sources, HTML). Null when the name passes.
 */
export function inboxAttachmentNameRefusal(path: string): string | null {
  const name = baseName(path);
  if (name === ".env" || /^\.env$/i.test(name)) return ".env files are never attached (they hold secrets).";
  if (!isAnnotatableDocPath(name)) {
    return "not a file the Inbox can open (markdown, plain text, config and data files, Mermaid and Graphviz sources, HTML).";
  }
  return null;
}

/** The viewer for a file, by its extension. */
export function inboxAttachmentKind(path: string): InboxAttachmentKind {
  const name = baseName(path);
  if (/\.html?$/i.test(name)) return "html";
  const diagram = diagramRenderKindForPath(name);
  if (diagram) return diagram;
  if (/\.mdx?$/i.test(name)) return "markdown";
  return "text";
}

/** The kind as a tile names it: "Markdown", "HTML", "Mermaid". */
export function inboxAttachmentKindLabel(kind: InboxAttachmentKind, name: string): string {
  switch (kind) {
    case "markdown":
      return "Markdown";
    case "html":
      return "HTML";
    case "mermaid":
      return "Mermaid";
    case "graphviz":
      return "Graphviz";
    case "text": {
      const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1];
      return ext && ext.toLowerCase() !== "txt" ? ext.toUpperCase() : "Text";
    }
  }
}

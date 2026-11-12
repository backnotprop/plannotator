import type { InboxAnnotationRecord, InboxAttachmentState } from "./inbox-attachments";
import type { InboxGuideRef } from "./inbox-types";

export const INBOX_SURFACE_BRIDGE_VERSION = 1 as const;

export type SurfaceAnnotation = Record<string, unknown>;

export interface SurfaceOpenAttachment {
  v: 1;
  type: "open_attachment";
  attachment: InboxAttachmentState;
  version: string;
  text: string;
  html: string | null;
  annotations: InboxAnnotationRecord[];
  focus: string | null;
}

export interface SurfaceOpenGuide {
  v: 1;
  type: "open_guide";
  message_id: string;
  guide: InboxGuideRef;
  snapshot: unknown;
  reviewed: boolean[] | null;
}

export interface SurfaceOpenSection {
  v: 1;
  type: "open_section";
  section: number | null;
}

export interface SurfaceSetWrap {
  v: 1;
  type: "set_wrap";
  wrap: boolean;
}

export interface SurfaceSetMode {
  v: 1;
  type: "set_mode";
  mode: "annotate" | "interact";
}

export interface SurfaceStepPin {
  v: 1;
  type: "step_pin";
  direction: "parent" | "child";
}

export interface SurfaceSetAppearance {
  v: 1;
  type: "set_appearance";
  theme: "light" | "dark";
  text_scale: number;
}

export interface SurfaceCommitAnnotation {
  v: 1;
  type: "commit_annotation";
  annotation: InboxAnnotationRecord;
}

export interface SurfaceRemoveAnnotation {
  v: 1;
  type: "remove_annotation";
  id: string;
}

export interface SurfaceExportFeedback {
  v: 1;
  type: "export_feedback";
  id: string;
  annotations: InboxAnnotationRecord[];
  attachments: InboxAttachmentState[];
  texts: { attachment_id: string; version: string; text: string }[];
  project_root: string;
}

export interface SurfaceCommentSelection {
  v: 1;
  type: "comment_selection";
}

export type SurfaceShellMessage =
  | SurfaceCommentSelection
  | SurfaceExportFeedback
  | SurfaceOpenAttachment
  | SurfaceOpenGuide
  | SurfaceOpenSection
  | SurfaceSetWrap
  | SurfaceSetMode
  | SurfaceStepPin
  | SurfaceSetAppearance
  | SurfaceCommitAnnotation
  | SurfaceRemoveAnnotation;

export interface SurfaceReady {
  v: 1;
  type: "ready";
  bridge: typeof INBOX_SURFACE_BRIDGE_VERSION;
  build: string;
}

export interface SurfaceSelection {
  v: 1;
  type: "selection";
  quote: string | null;
  draft: SurfaceAnnotation | null;
}

export interface SurfacePin {
  v: 1;
  type: "pin";
  target: { label: string; selector: string };
  draft: SurfaceAnnotation;
}

export interface SurfaceDraft {
  v: 1;
  type: "draft";
  target: { kind: "block" | "node" | "edge"; label: string };
  draft: SurfaceAnnotation;
}

export interface SurfaceAnnotationTapped {
  v: 1;
  type: "annotation";
  id: string;
}

export interface SurfaceReviewed {
  v: 1;
  type: "reviewed";
  message_id: string;
  reviewed: boolean[];
}

export interface SurfaceSection {
  v: 1;
  type: "section";
  message_id: string;
  section: number | null;
  sections: number;
}

export interface SurfaceLink {
  v: 1;
  type: "link";
  href: string;
}

export interface SurfaceFeedback {
  v: 1;
  type: "feedback";
  id: string;
  text: string;
}

export interface SurfaceError {
  v: 1;
  type: "error";
  code: SurfaceErrorCode;
  message: string;
}

export type SurfaceErrorCode = "bridge_version" | "bad_message" | "guide_invalid";

export type SurfaceMessage =
  | SurfaceReady
  | SurfaceSelection
  | SurfacePin
  | SurfaceDraft
  | SurfaceAnnotationTapped
  | SurfaceReviewed
  | SurfaceSection
  | SurfaceLink
  | SurfaceFeedback
  | SurfaceError;

const SHELL_TYPES: ReadonlySet<string> = new Set<SurfaceShellMessage["type"]>([
  "comment_selection",
  "export_feedback",
  "open_attachment",
  "open_guide",
  "open_section",
  "set_wrap",
  "set_mode",
  "step_pin",
  "set_appearance",
  "commit_annotation",
  "remove_annotation",
]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function readSurfaceShellMessage(value: unknown): { ok: true; message: SurfaceShellMessage } | { ok: false; code: SurfaceErrorCode; message: string } {
  if (!isObject(value) || typeof value.type !== "string") return { ok: false, code: "bad_message", message: "A bridge message is an object with a type." };
  if (value.v !== INBOX_SURFACE_BRIDGE_VERSION) {
    return { ok: false, code: "bridge_version", message: `This surface speaks bridge version ${INBOX_SURFACE_BRIDGE_VERSION}, not ${String(value.v)}.` };
  }
  if (!SHELL_TYPES.has(value.type)) return { ok: false, code: "bad_message", message: `Unknown message type "${value.type}".` };
  const bad = (what: string) => ({ ok: false as const, code: "bad_message" as const, message: `${value.type}: ${what}` });
  switch (value.type) {
    case "export_feedback":
      if (typeof value.id !== "string" || typeof value.project_root !== "string") return bad("id and project_root are strings.");
      if (!Array.isArray(value.annotations) || !Array.isArray(value.attachments) || !Array.isArray(value.texts)) return bad("annotations, attachments and texts are lists.");
      break;
    case "open_attachment":
      if (!isObject(value.attachment) || typeof value.attachment.kind !== "string") return bad("attachment is missing.");
      if (typeof value.text !== "string" || typeof value.version !== "string") return bad("text and version are strings.");
      if (value.attachment.kind === "html" && typeof value.html !== "string") return bad("an HTML attachment carries html.");
      if (!Array.isArray(value.annotations)) return bad("annotations is a list.");
      break;
    case "open_guide":
      if (typeof value.message_id !== "string" || !isObject(value.snapshot)) return bad("message_id and snapshot are required.");
      break;
    case "open_section":
      if (value.section !== null && !(Number.isInteger(value.section) && (value.section as number) >= 0)) return bad("section is an index or null.");
      break;
    case "set_wrap":
      if (typeof value.wrap !== "boolean") return bad("wrap is a boolean.");
      break;
    case "set_mode":
      if (value.mode !== "annotate" && value.mode !== "interact") return bad('mode is "annotate" or "interact".');
      break;
    case "step_pin":
      if (value.direction !== "parent" && value.direction !== "child") return bad('direction is "parent" or "child".');
      break;
    case "set_appearance":
      if (value.theme !== "light" && value.theme !== "dark") return bad('theme is "light" or "dark".');
      if (typeof value.text_scale !== "number" || !(value.text_scale > 0)) return bad("text_scale is a positive number.");
      break;
    case "commit_annotation":
      if (!isObject(value.annotation) || typeof value.annotation.id !== "string" || !isObject(value.annotation.annotation)) return bad("annotation is the door's record.");
      break;
    case "remove_annotation":
      if (typeof value.id !== "string") return bad("id is a string.");
      break;
  }
  return { ok: true, message: value as unknown as SurfaceShellMessage };
}

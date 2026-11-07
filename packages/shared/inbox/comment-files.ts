import type { InboxAnnotationRecord, InboxAttachment } from "@plannotator/core/inbox-types";
import { readInboxUpload } from "./uploads";
import { InboxError } from "./schema";

export interface CommentFile {
  id: string;
  name: string;
}

export function checkCommentFiles(dir: string, value: unknown): CommentFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InboxError("validation_error", "annotation.files: a list of uploaded files.", { field: "annotation.files" });
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    const id = entry && typeof entry === "object" && "id" in entry ? entry.id : undefined;
    const upload = typeof id === "string" ? readInboxUpload(dir, id) : null;
    if (!upload || seen.has(upload.upload_id)) throw new InboxError("validation_error", "annotation.files: each file must name a different pending upload.", { field: "annotation.files" });
    seen.add(upload.upload_id);
    return { id: upload.upload_id, name: upload.name };
  });
}

export function commentFilesOf(record: InboxAnnotationRecord): CommentFile[] {
  const files = record.annotation.files;
  if (!Array.isArray(files)) return [];
  return files.filter((file): file is CommentFile => !!file && typeof file === "object" && typeof file.id === "string" && typeof file.name === "string");
}

export function commentFilesFeedback(records: readonly InboxAnnotationRecord[], uploads: readonly unknown[], attachments: readonly InboxAttachment[]): string {
  const byId = new Map(uploads.map((id, index) => [id, attachments[index]]));
  return records.flatMap((record) => {
    const files = commentFilesOf(record).flatMap((file) => {
      const attachment = byId.get(file.id);
      return attachment ? [`- ${attachment.name}: ${attachment.path}`] : [];
    });
    if (files.length === 0) return [];
    const text = typeof record.annotation.text === "string" ? record.annotation.text : "";
    return [`Files for global comment ${record.id}${text ? ` (${text})` : ""}:\n${files.join("\n")}`];
  }).join("\n\n");
}

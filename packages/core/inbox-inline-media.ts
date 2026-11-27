export type InboxInlineMediaKind = "audio" | "video";

const KINDS: Readonly<Record<string, InboxInlineMediaKind>> = {
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  aac: "audio",
  flac: "audio",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
};

export const INBOX_INLINE_MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function inboxInlineMediaKind(src: string): InboxInlineMediaKind | null {
  const path = src.replace(/[?#].*$/s, "");
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : (KINDS[name.slice(dot + 1).toLowerCase()] ?? null);
}

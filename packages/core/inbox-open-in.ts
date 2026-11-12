import { readInboxAttachmentKind } from "./inbox-attachments";
import type { OpenInKind, OpenInPlatform } from "./open-in-apps";

export const INBOX_OPEN_IN_DEFAULT_APP = "default";

const DEFAULT_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "apng", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);

const DEFAULT_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "m4v", "mov", "webm"]);

const DEFAULT_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(["mp3", "m4a", "m4b", "mp4", "wav", "ogg", "oga", "opus", "flac", "aac", "weba", "webm"]);

const DEFAULT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "toml", "log"]);

export interface InboxOpenInPolicy {
  browser: boolean;
  editors: boolean;
  systemDefault: boolean;
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function inboxOpenInPolicy(attachment: { kind: unknown; path: string }, platform: OpenInPlatform): InboxOpenInPolicy {
  const kind = readInboxAttachmentKind(attachment.kind);
  const ext = extensionOf(attachment.path);
  switch (kind) {
    case "html":
      return { browser: true, editors: true, systemDefault: false };
    case "markdown":
    case "text":
      return { browser: false, editors: true, systemDefault: platform !== "linux" && DEFAULT_TEXT_EXTENSIONS.has(ext) };
    case "code":
    case "mermaid":
    case "graphviz":
      return { browser: false, editors: true, systemDefault: false };
    case "image":
      return { browser: false, editors: false, systemDefault: DEFAULT_IMAGE_EXTENSIONS.has(ext) };
    case "video":
      return { browser: false, editors: false, systemDefault: DEFAULT_VIDEO_EXTENSIONS.has(ext) };
    case "audio":
      return { browser: false, editors: false, systemDefault: DEFAULT_AUDIO_EXTENSIONS.has(ext) };
    case "pdf":
      return { browser: false, editors: false, systemDefault: ext === "pdf" };
    default:
      return { browser: false, editors: false, systemDefault: false };
  }
}

export function inboxOpenInAllows(policy: InboxOpenInPolicy, app: { id: string; kind?: OpenInKind }): boolean {
  if (app.id === INBOX_OPEN_IN_DEFAULT_APP) return policy.systemDefault;
  if (app.kind === "file-manager") return true;
  if (app.kind === "editor") return policy.editors;
  return false;
}

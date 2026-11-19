import { inboxInlineMediaKind } from "@plannotator/core/inbox-inline-media";
import { INBOX_INLINE_IMAGES_MAX, yieldToLoop } from "@plannotator/shared/inbox/inline-images";
import { inboxMessageMediaRefsInOrder, inboxMessageRemoteImageRefsInOrder } from "@plannotator/shared/inbox/message-images";
import { openInboxMessageMedia } from "@plannotator/shared/inbox/message-media";

const MEDIA_NOT_SHOWN_REASONS: Record<string, string> = {
  image_missing: "not a readable file (a folder, a pipe or a device)",
  image_unreadable: "Plannotator can't read this file; on macOS the app running it may need to be allowed",
  image_read_failed: "could not be read",
  not_media: "not a sound or video file",
  image_too_large: "over 2 GB",
  image_hidden: "a .env file, or in a hidden folder of the home folder such as ~/.ssh",
  validation_error: "not a file path",
};
const MEDIA_NOT_YET_REASON = "does not exist yet; it plays once written there";
const MEDIA_REMOTE_REASON = "remote sounds and videos never play in the Inbox";
export const MEDIA_NOT_SHOWN_MAX = 10;

export interface MediaNotShown {
  ref: string;
  reason: string;
  not_yet?: true;
}

export async function mediaNotShown(body: string, where: { root: string; base: string | null }): Promise<MediaNotShown[]> {
  const out: MediaNotShown[] = [];
  for (const [index, ref] of inboxMessageMediaRefsInOrder(body).slice(0, INBOX_INLINE_IMAGES_MAX).entries()) {
    if (index > 0) await yieldToLoop();
    const opened = await openInboxMessageMedia({ body, root: where.root, base: where.base, path: ref, anywhere: true }).catch(() => null);
    if (opened?.ok) {
      await opened.handle.close().catch(() => {});
      continue;
    }
    const code = opened?.code ?? "image_read_failed";
    if (code === "image_missing" && opened?.notYet) out.push({ ref, reason: MEDIA_NOT_YET_REASON, not_yet: true });
    else if (MEDIA_NOT_SHOWN_REASONS[code]) out.push({ ref, reason: MEDIA_NOT_SHOWN_REASONS[code] });
  }
  for (const ref of inboxMessageRemoteImageRefsInOrder(body)) {
    if (inboxInlineMediaKind(ref)) out.push({ ref, reason: MEDIA_REMOTE_REASON });
  }
  return out;
}

function named(list: readonly MediaNotShown[], withReason: boolean): string {
  const shown = list.slice(0, MEDIA_NOT_SHOWN_MAX).map(({ ref, reason }) => (withReason ? `${ref} (${reason})` : ref)).join("; ");
  return list.length > MEDIA_NOT_SHOWN_MAX ? `${shown}; …and ${list.length - MEDIA_NOT_SHOWN_MAX} more` : shown;
}

export function mediaNotShownText(list: readonly MediaNotShown[]): string {
  const never = list.filter((media) => !media.not_yet);
  const later = list.filter((media) => media.not_yet);
  let text = "";
  if (never.length === 1) text += ` This sound or video will not play: ${named(never, true)}. Put it in a plain folder as a real sound or video under 2 GB and link that path.`;
  if (never.length > 1) text += ` ${never.length} sounds or videos will not play: ${named(never, true)}. Put each in a plain folder as a real sound or video under 2 GB and link that path.`;
  if (later.length === 1) text += ` This sound or video does not exist yet: ${named(later, false)}; it plays once written there.`;
  if (later.length > 1) text += ` ${later.length} sounds or videos do not exist yet: ${named(later, false)}; they play once written there.`;
  return text;
}

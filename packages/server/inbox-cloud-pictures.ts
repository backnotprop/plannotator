/**
 * A paired cloud agent's pictures (the agent door, inbox-agent-door.ts): every picture in what it writes comes from a
 * file it attached in the same send, never from a path on this computer, wherever the picture is named.
 *
 *  - At send (`sendAgentMessage`, inbox-mcp.ts): the door always sets `inlineImageFiles` for a cloud agent (empty when
 *    it attached nothing), and the pictures of the body that is actually sent (its own, or submit_guide's guide intent
 *    in its place) are matched to those files here, by name. One that names no attached file refuses the send
 *    (`image_path_refused`) before anything is written; a matched file is captured from the Inbox's own copy.
 *  - After: the message's author is a cloud agent (`isInboxCloudAuthor`, packages/core/inbox-cloud.ts), so the
 *    background capture (inbox-message-images.ts) skips it, and the image route serves only what was captured at send.
 */

import { matchAgentBodyPictures } from "@plannotator/shared/inbox/agent-pictures";
import { InboxError } from "@plannotator/shared/inbox/schema";

/** A file a cloud agent attached in this send: its upload id, the name it was sent with, and the Inbox's copy. */
export interface InboxCloudSendFile {
  id: string;
  name: string;
  /** The Inbox's own copy of the bytes (its blob), the only place the picture is read from. */
  path: string;
}

export function inboxImagePathRefusedText(src: string): string {
  return `body: ![…](${src}) names no file attached in this send, and the Inbox opens no path for a cloud agent. Attach the picture in this send and name it by its file name: ![alt](shot.png) with { "name": "shot.png", "data": "<base64>" } in attachments (plannotator inbox call does this for a path on your own disk).`;
}

/**
 * The pictures `body` shows, each with the attached file it names (the capture's `files`), and the attachments left to
 * show below the message (the ones no picture names). Throws `image_path_refused` for a src that names none.
 */
export function inboxCloudSendPictures(
  body: string,
  files: readonly InboxCloudSendFile[],
  attachments: readonly string[] | undefined,
): { pictures: Map<string, { path: string; name: string }>; attachments: string[] | undefined } {
  const { pictures, unmatched } = matchAgentBodyPictures(body, files);
  if (unmatched.length > 0) throw new InboxError("image_path_refused", inboxImagePathRefusedText(unmatched[0]!), { field: "body" });
  const used = new Set([...pictures.values()].map((file) => file.id));
  const shown = new Map([...pictures].map(([src, file]) => [src, { path: file.path, name: file.name }] as const));
  const left = attachments?.filter((id) => !used.has(id));
  return { pictures: shown, attachments: left && left.length > 0 ? left : undefined };
}

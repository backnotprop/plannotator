/**
 * Pictures a paired cloud agent sent as bytes (the agent door, inbox-agent-door.ts). A cloud agent's message reads
 * pictures as a local agent's does, from the person's disk by the path its body writes; and a picture whose src names
 * a picture file it attached as bytes in the same send (`![chart](chart.png)` with `{ "name": "chart.png", … }`, which
 * `plannotator inbox call` sends for a path on the agent's own machine) shows that file first, wherever a file of that
 * name is on the person's disk.
 *
 *  - At send (`sendAgentMessage`, inbox-mcp.ts): the pictures of the body actually sent (its own, or submit_guide's
 *    guide intent in its place) are matched to those files by name, captured from the Inbox's own copy, and kept out
 *    of the tiles below the message (a picture whose capture fails is attached below instead, so no file is lost).
 *  - After: the message's image route serves a picture captured from such bytes from that copy
 *    (inbox-message-images.ts `inboxPictureFromUpload`); every other picture as for any agent.
 */

import { matchAgentBodyPictures } from "@plannotator/shared/inbox/agent-pictures";

/** A file an agent attached as bytes in this send: its upload id, the name it was sent with, its kind, the Inbox's copy. */
export interface InboxSendUpload {
  id: string;
  name: string;
  kind: string;
  /** The Inbox's own copy of the bytes (its blob), where a picture of it is read from. */
  path: string;
}

/**
 * The pictures `body` shows from files attached as bytes in this send (by the src as written, each with its file),
 * and the attachments left to show below the message (the ones no picture names). A src that names none is read from
 * the person's disk, as for a local agent.
 */
export function inboxSendUploadPictures(
  body: string,
  uploads: readonly InboxSendUpload[],
  attachments: readonly string[] | undefined,
): { pictures: Map<string, InboxSendUpload>; attachments: string[] | undefined } {
  const { pictures } = matchAgentBodyPictures(body, uploads.filter((upload) => upload.kind === "image"));
  const used = new Set([...pictures.values()].map((file) => file.id));
  const left = attachments?.filter((id) => !used.has(id));
  return { pictures, attachments: left && left.length > 0 ? left : undefined };
}

/**
 * A cloud agent's pictures in a message's body (the owner, 2026-11-21: "They need to have the same access as a local
 * agent to the inbox"). A local agent writes `![alt](path)` and the Inbox copies the file from its disk. A cloud agent
 * runs elsewhere, so the Inbox opens no path for it: each picture its body shows names a file it attached in the same
 * send, by that file's name (`![shot](shot.png)` with `{ "name": "shot.png", … }`), as a question's prototype names an
 * attached HTML page. That file shows in the body where it is written, not again below the message.
 *
 * - The agent door matches them (`matchAgentBodyPictures`, packages/server/inbox-agent-door.ts) by name only: nothing
 *   here or there reads a path, and a src that names no attached file refuses the send.
 * - `plannotator inbox call` with a pairing (`planAgentBodyPictures`, apps/hook/server/inbox-call-command.ts) lets the
 *   agent write the same `![alt](path)` a local agent writes: each picture's file on the agent's own disk is sent with
 *   the message, and the src renamed to that file's name where the name alone would not find it.
 */

import { basename, extname, resolve } from "node:path";
import { inboxMessageImageRefsInOrder, pathCandidates, renameInboxMessageImageSources } from "./message-images";

export interface AgentAttachedFile {
  /** The upload's id (`upl_…`). */
  id: string;
  /** The name it was sent with. */
  name: string;
}

/** The names a src may mean: as written, without `?query` or `#fragment`, percent-decoded, without `./`, its file name. */
function namesOf(src: string): Set<string> {
  const names = new Set<string>();
  for (const candidate of pathCandidates(src.trim())) {
    names.add(candidate.replace(/^\.\//, ""));
    names.add(basename(candidate.replace(/\\/g, "/")));
  }
  return names;
}

/**
 * The pictures `body` shows (outside code, each once, in text order), each with the one file of `attached` it names
 * (`pictures`), and the srcs that name none, or more than one (`unmatched`).
 */
export function matchAgentBodyPictures(body: string, attached: readonly AgentAttachedFile[]): { pictures: Map<string, AgentAttachedFile>; unmatched: string[] } {
  const pictures = new Map<string, AgentAttachedFile>();
  const unmatched: string[] = [];
  for (const src of inboxMessageImageRefsInOrder(body)) {
    const names = namesOf(src);
    const hits = attached.filter((file) => names.has(file.name));
    if (hits.length === 1) pictures.set(src, hits[0]!);
    else unmatched.push(src);
  }
  return { pictures, unmatched };
}

/**
 * The pictures a paired agent's body shows from its own disk: `files` to send with the message (each path, under a
 * name no other file of the send has), and the body with a src renamed where its file name alone would not find its
 * file. A path the send already attaches (`attachments`, as the agent wrote them) is not sent twice: the picture names
 * that file. A src that is no file here is left as it is (the door then says it names no attached file).
 */
export function planAgentBodyPictures(
  body: string,
  attachments: readonly unknown[],
  cwd: string,
  isFile: (path: string) => boolean,
): { body: string; files: { path: string; name: string }[] } {
  const names = new Map<string, string>();
  for (const item of attachments) {
    if (typeof item === "string") {
      const path = resolve(cwd, item);
      if (![...names.values()].includes(basename(path))) names.set(path, basename(path));
    } else if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      names.set(`\u0000${names.size}`, (item as { name: string }).name);
    }
  }
  const taken = new Set(names.values());
  const files: { path: string; name: string }[] = [];
  const rename = new Map<string, string>();
  for (const src of inboxMessageImageRefsInOrder(body)) {
    const path = pathCandidates(src.trim()).map((candidate) => resolve(cwd, candidate)).find(isFile);
    if (!path) continue;
    let name = names.get(path);
    if (name === undefined) {
      const ext = extname(path);
      const stem = basename(path, ext);
      name = basename(path);
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${ext}`;
      taken.add(name);
      names.set(path, name);
      files.push({ path, name });
    }
    if (!namesOf(src).has(name)) rename.set(src, name);
  }
  return { body: renameInboxMessageImageSources(body, rename), files };
}

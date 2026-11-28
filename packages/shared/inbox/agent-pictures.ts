/**
 * A paired cloud agent's pictures in a message's body (the owner, 2026-11-21: "They need to have the same access as a
 * local agent to the inbox"). A local agent writes `![alt](path)` and the Inbox copies the file from the person's disk;
 * a cloud agent's body does the same. A picture on the agent's own machine is sent as bytes with the message instead,
 * and its src names that file (`![shot](shot.png)` with `{ "name": "shot.png", … }`), which then shows first.
 *
 * - The door's send matches them (`matchAgentBodyPictures`, from `sendAgentMessage` in packages/server/inbox-mcp.ts,
 *   on the body actually sent: its own, or a guide's intent in its place) by name; a src that names no file sent is
 *   read from the person's disk, as a local agent's.
 * - `plannotator inbox call` with a pairing (`planAgentBodyPictures`, apps/hook/server/inbox-call-command.ts) sends
 *   each picture whose path is a file on the agent's own machine with the message, the src renamed to that file's name
 *   where the name alone would not find it; any other src is left as it is, for the person's disk.
 */

import { basename, extname, resolve } from "node:path";
import { inboxMessageImageRefsInOrder, pathCandidates, renameInboxMessageImageSources } from "./message-images";

export interface AgentAttachedFile {
  /** The upload's id (`upl_…`). */
  id: string;
  /** The name it was sent with. */
  name: string;
}

/** A path from a root (`/…`, `~/…`, `\\…`, `C:\…`): it names one file on the person's computer, never a file sent by its name. */
const fromRoot = (path: string) => /^(?:[/\\~]|[A-Za-z]:[/\\])/.test(path);

/**
 * The names a src may mean: as written, without `?query` or `#fragment`, percent-decoded, without `./`, and, for a
 * relative path or a bare name, its file name. A path from a root means only itself: `![](/Users/x/site/logo.png)`
 * is that file on the person's disk, not a `logo.png` sent with the message.
 */
function namesOf(src: string): Set<string> {
  const names = new Set<string>();
  for (const candidate of pathCandidates(src.trim())) {
    names.add(candidate.replace(/^\.\//, ""));
    if (!fromRoot(candidate)) names.add(basename(candidate.replace(/\\/g, "/")));
  }
  return names;
}

/**
 * The pictures `body` shows (outside code, each once, in text order), each with the one file of `attached` it names
 * (`pictures`), and the srcs that name none, or more than one (`unmatched`).
 */
export function matchAgentBodyPictures<File extends AgentAttachedFile>(body: string, attached: readonly File[]): { pictures: Map<string, File>; unmatched: string[] } {
  const pictures = new Map<string, File>();
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
 * that file. A src that is no file here is left as it is: the Inbox reads it on the person's computer.
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

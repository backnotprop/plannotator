/**
 * Plannotator Inbox: the face each agent's icon shows (core `inbox-types.ts` ("Agent faces")), saved for every window.
 *
 *   inbox/agent-faces.json   { v: 1, rev, faces: { [agent id]: { face, sessions, name? } } }, the latest choice last,
 *                            0600, written whole (temp, then rename)
 *
 * A file outside the store's JSONL, as pins are: a face is window furniture and never enters the event log, which
 * agents' cursors, the phone relay and search read. At most INBOX_AGENT_FACES_KEPT agents (the oldest choice goes),
 * so the file stays a few kilobytes however many sessions come and go; an ended agent keeps its face, so its old
 * threads still show it. The agent's own mark is stored only beside a name the person gave it (Rename… on its
 * sidebar row), which lives in the same entry so a continued session keeps it as it keeps its face.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkInboxProjectName,
  cleanInboxFaceSessions,
  INBOX_AGENT_FACES_KEPT,
  INBOX_AGENT_FACE_SESSIONS_MAX,
  isInboxAgentFace,
  isInboxAgentFaceId,
  readInboxAgentFaces,
  type InboxAgentFaceChange,
  type InboxAgentFaceEntry,
  type InboxAgentFacesWire,
} from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const INBOX_AGENT_FACES_FILE = "agent-faces.json";

/** The faces on disk. A file that does not parse reads as none (and is moved aside on the next write). */
export function readInboxAgentFacesFile(inboxDirPath: string): InboxAgentFacesWire & { state: "missing" | "ok" | "bad" | "newer" } {
  let raw: string;
  try {
    raw = readFileSync(join(inboxDirPath, INBOX_AGENT_FACES_FILE), "utf8");
  } catch (e) {
    return { faces: Object.create(null), rev: 0, state: (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "bad" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { faces: Object.create(null), rev: 0, state: "bad" };
  }
  const file = value as { v?: unknown; rev?: unknown; faces?: unknown } | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) return { faces: Object.create(null), rev: 0, state: "bad" };
  if (typeof file.v === "number" && file.v > 1) return { faces: Object.create(null), rev: 0, state: "newer" };
  if (file.v !== 1) return { faces: Object.create(null), rev: 0, state: "bad" };
  const rev = typeof file.rev === "number" && Number.isSafeInteger(file.rev) && file.rev > 0 ? file.rev : 0;
  return { faces: readInboxAgentFaces(file.faces), rev, state: "ok" };
}

function writeFile(inboxDirPath: string, faces: Record<string, InboxAgentFaceEntry>, rev: number, state: "missing" | "ok" | "bad" | "newer"): void {
  const file = join(inboxDirPath, INBOX_AGENT_FACES_FILE);
  if (state === "newer") throw new InboxError("agent_faces_newer", "agent-faces.json was written by a newer Plannotator; update Plannotator to change agent icons.");
  mkdirSync(inboxDirPath, { recursive: true });
  if (state === "bad") renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, rev, faces })}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/** The latest `INBOX_AGENT_FACES_KEPT` entries (insertion order is choice order). */
function capped(faces: Record<string, InboxAgentFaceEntry>): Record<string, InboxAgentFaceEntry> {
  const keys = Object.keys(faces);
  if (keys.length <= INBOX_AGENT_FACES_KEPT) return faces;
  const out = Object.create(null) as Record<string, InboxAgentFaceEntry>;
  for (const key of keys.slice(-INBOX_AGENT_FACES_KEPT)) out[key] = faces[key]!;
  return out;
}

/** The checks on a change (`POST /api/inbox/agent-faces`). */
export function checkInboxAgentFaceChange(body: Record<string, unknown>): InboxAgentFaceChange {
  if (body.adopt !== undefined) {
    const adopt = body.adopt;
    if (!adopt || typeof adopt !== "object" || Array.isArray(adopt) || Object.keys(adopt).length > INBOX_AGENT_FACES_KEPT) {
      throw new InboxError("validation_error", `adopt: { [agent id]: face }, at most ${INBOX_AGENT_FACES_KEPT}.`, { field: "adopt" });
    }
    const out: Record<string, never> = {};
    for (const [key, face] of Object.entries(adopt as Record<string, unknown>)) if (isInboxAgentFaceId(key) && isInboxAgentFace(face)) (out as Record<string, unknown>)[key] = face;
    return { adopt: out };
  }
  if (!isInboxAgentFaceId(body.agent)) throw new InboxError("validation_error", "agent: the agent's id.", { field: "agent" });
  if (body.sessions !== undefined && (!Array.isArray(body.sessions) || body.sessions.length > INBOX_AGENT_FACE_SESSIONS_MAX * 2)) {
    throw new InboxError("validation_error", "sessions: the agent's session ids.", { field: "sessions" });
  }
  const sessions = cleanInboxFaceSessions(body.sessions, body.agent);
  // A given name (Rename…): empty or only spaces is none (Reset name).
  if (body.face === undefined && body.name !== undefined) {
    if (body.name !== null && typeof body.name !== "string") throw new InboxError("validation_error", "name: the agent's name, or null.", { field: "name" });
    if (body.name === null || body.name.trim() === "") return { agent: body.agent, name: null, sessions };
    const checked = checkInboxProjectName(body.name);
    if (!checked.ok) throw new InboxError("validation_error", `name ${checked.message}`, { field: "name" });
    return { agent: body.agent, name: checked.name, sessions };
  }
  if (!isInboxAgentFace(body.face)) throw new InboxError("validation_error", "face: one of the agent icon's faces.", { field: "face" });
  return { agent: body.agent, face: body.face, sessions };
}

/**
 * The faces, read once and kept in memory (every write goes through here), with what changes them. `onChange` hears
 * each save (the windows' `event: agent-faces`).
 */
export function createInboxAgentFacesFile(inboxDirPath: string, onChange: (wire: InboxAgentFacesWire) => void) {
  let cached: ReturnType<typeof readInboxAgentFacesFile> | null = null;
  /** Every id an entry names (key or session) → its key: a poll's link check is one lookup. */
  let index: Map<string, string> | null = null;
  const now = () => (cached ??= readInboxAgentFacesFile(inboxDirPath));
  const indexNow = () => {
    if (index) return index;
    index = new Map();
    for (const [key, entry] of Object.entries(now().faces)) {
      index.set(key, key);
      for (const session of entry.sessions) if (!index.has(session)) index.set(session, key);
    }
    return index;
  };
  const save = (faces: Record<string, InboxAgentFaceEntry>): InboxAgentFacesWire => {
    const was = now();
    const rev = was.rev + 1;
    const kept = capped(faces);
    writeFile(inboxDirPath, kept, rev, was.state);
    cached = { faces: kept, rev, state: "ok" };
    index = null;
    const wire = { faces: kept, rev };
    onChange(wire);
    return wire;
  };
  const copy = () => Object.assign(Object.create(null), now().faces) as Record<string, InboxAgentFaceEntry>;

  return {
    wire(): InboxAgentFacesWire {
      const { faces, rev } = now();
      return { faces, rev };
    },
    /**
     * One agent's face or given name: kept as its latest choice (moved last); its own mark and no name, forgotten. A
     * face change keeps the name and a name change keeps the face.
     */
    change(change: InboxAgentFaceChange): InboxAgentFacesWire {
      const faces = copy();
      if ("adopt" in change) {
        // This browser's faces from before the Inbox kept them: an agent another window already chose for keeps its face.
        let added = false;
        for (const [key, face] of Object.entries(change.adopt)) {
          if (face === "agent" || faces[key] || indexNow().has(key)) continue;
          faces[key] = { face, sessions: [] };
          added = true;
        }
        return added ? save(faces) : this.wire();
      }
      const before = faces[change.agent];
      // An entry kept for one of these sessions (from before the conversation continued) is this agent now: it fills
      // what this change does not set and this agent's own entry lacks.
      const merged = (change.sessions ?? []).map((session) => (session !== change.agent ? faces[session] : undefined)).filter((entry) => entry !== undefined);
      delete faces[change.agent];
      for (const session of change.sessions ?? []) if (session !== change.agent && faces[session]) delete faces[session];
      const face = "face" in change ? change.face : (before?.face ?? merged.find((entry) => entry.face !== "agent")?.face ?? "agent");
      const name = "name" in change ? change.name : (before?.name ?? merged.find((entry) => entry.name)?.name ?? null);
      if (face !== "agent" || name) {
        faces[change.agent] = { face, sessions: cleanInboxFaceSessions([...(before?.sessions ?? []), ...(change.sessions ?? [])], change.agent), ...(name ? { name } : {}) };
      }
      if (!before && merged.length === 0 && !faces[change.agent]) return this.wire();
      return save(faces);
    },
    /**
     * A session the Inbox heard (a poll) that is the same agent as `related()` (the sessions its conversation continues,
     * its launch's id; asked only when there is something to link): linked to the entry that names one of them, so its threads show that face after it ended too.
     * One map lookup when nothing is to link; a write only the first time.
     */
    link(session: string, related: () => readonly string[]): void {
      if (!isInboxAgentFaceId(session)) return;
      const map = indexNow();
      if (map.size === 0 || map.has(session)) return;
      const key = related()
        .map((id) => map.get(id))
        .find((found) => found !== undefined);
      if (!key) return;
      const faces = copy();
      const entry = faces[key]!;
      faces[key] = { ...entry, sessions: cleanInboxFaceSessions([...entry.sessions, session], key) };
      try {
        save(faces);
      } catch {
        // Not saved (a newer file, a full disk): the window still finds it through the agents' list while it is live.
      }
    },
    /**
     * The uploaded pictures changed (one added or removed, packages/server/inbox-agent-icons.ts): a save with the same
     * faces, so the count moves and every window hears it (the wire carries the pictures).
     */
    touch(): InboxAgentFacesWire {
      return save(copy());
    },
    /** A removed picture: every agent that showed it goes back to its own mark and keeps a given name; one save, or none. */
    dropFace(face: string): InboxAgentFacesWire {
      const faces = copy();
      let dropped = false;
      for (const [key, entry] of Object.entries(faces)) {
        if (entry.face !== face) continue;
        if (entry.name) faces[key] = { ...entry, face: "agent" };
        else delete faces[key];
        dropped = true;
      }
      return dropped ? save(faces) : this.wire();
    },
    /** The faces agents show now (an uploaded picture in use is never the one the cap removes). */
    shown(): Set<string> {
      return new Set(Object.values(now().faces).flatMap((entry) => (entry.face === "agent" ? [] : [entry.face])));
    },
    /** Tests: forget what was read. */
    forget(): void {
      cached = null;
      index = null;
    },
  };
}

export type InboxAgentFacesFile = ReturnType<typeof createInboxAgentFacesFile>;

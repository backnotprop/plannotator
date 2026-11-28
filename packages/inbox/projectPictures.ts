/**
 * The Inbox's projects as the window last read them, for letter marks (letterMarks.tsx): each one's name (a Board card
 * names only an id) and when its picture was set (Set picture…), the browser's cache key for the picture. Learnt from
 * every list read (api.ts), so a picture set in another window shows here at the next read.
 */
import { useSyncExternalStore } from 'react';
import type { MarksChoice } from './listLook';
import { inboxUrl, machineOf } from './inboxUrl';

interface KnownProject {
  name: string;
  /** When its picture was set (Set picture…), from the Inbox's projects; absent when none. */
  picture?: number;
}
const projects = new Map<string, KnownProject>();
let projectsVersion = 0;
const projectListeners = new Set<() => void>();

function notifyProjects(): void {
  projectsVersion++;
  for (const listener of projectListeners) listener();
}

/** A row as `learnProjects` reads it: its project and the agent sessions in it. */
interface SessionsRow {
  project: { id: string; name: string };
  author: { kind: string; session?: string | null };
  addressee?: { session?: string | null } | null;
  participants?: readonly { session?: string | null }[];
}

/**
 * The project of each agent session, by the rows reads brought: an agent's project tile (agents/projectFace.tsx) for an
 * agent the Agents list no longer names. One rule, whatever order rows come in: a project the session wrote a thread
 * in over one it was only addressed or took part in, and among those the lowest project id. So a session in threads
 * of two projects keeps one tile, and a read that brings nothing new changes nothing (and redraws nothing).
 */
const sessionProjects = new Map<string, { id: string; name: string; rank: 0 | 1 }>();
// Its own listeners: a new session redraws the agents' tiles, never every letter mark.
const sessionListeners = new Set<() => void>();

export function sessionProjectOf(session: string): { id: string; name: string } | null {
  const held = sessionProjects.get(session);
  return held ? { id: held.id, name: held.name } : null;
}

/** Hear each read that taught a session's project (agents/projectFace.tsx). Returns the way to stop. */
export function onSessionProjects(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => void sessionListeners.delete(listener);
}

function notifySessions(): void {
  for (const listener of [...sessionListeners]) listener();
}

/** The Inbox's projects as a list read brought them: their names and when each one's picture was set; `rows`: its sessions' projects. */
export function learnProjects(list: readonly { id: string; name: string; picture?: number }[], rows: readonly SessionsRow[] = []): void {
  let sessionsChanged = false;
  for (const row of rows) {
    const sessions: [string | null | undefined, 0 | 1][] = [
      [row.author.kind === 'agent' ? row.author.session : null, 0],
      [row.addressee?.session, 1],
      ...(row.participants ?? []).map((p): [string | null | undefined, 1] => [p.session, 1]),
    ];
    for (const [session, rank] of sessions) {
      if (!session) continue;
      const before = sessionProjects.get(session);
      if (before?.id === row.project.id) {
        // The same project: a better rank or a new name is kept; the rest is what it was.
        if (before.name === row.project.name && before.rank <= rank) continue;
      } else if (before && (before.rank < rank || (before.rank === rank && before.id < row.project.id))) continue;
      sessionProjects.set(session, { id: row.project.id, name: row.project.name, rank: before?.id === row.project.id ? (Math.min(before.rank, rank) as 0 | 1) : rank });
      sessionsChanged = true;
    }
  }
  if (sessionsChanged) notifySessions();
  let changed = false;
  for (const project of list) {
    const before = projects.get(project.id);
    const picture = typeof project.picture === 'number' ? project.picture : undefined;
    if (before && before.name === project.name && before.picture === picture) continue;
    projects.set(project.id, picture === undefined ? { name: project.name } : { name: project.name, picture });
    changed = true;
  }
  if (changed) notifyProjects();
}

/** A project's name, or null (one no list has named yet). */
export function knownProjectName(projectId: string): string | null {
  return projects.get(projectId)?.name ?? null;
}

/** Whether the project has a picture someone set (the project menu offers to take it away). */
export function hasSetPicture(projectId: string): boolean {
  return projects.get(projectId)?.picture !== undefined;
}

export function useKnownProjects(): number {
  return useSyncExternalStore(
    (listener) => {
      projectListeners.add(listener);
      return () => projectListeners.delete(listener);
    },
    () => projectsVersion,
    () => projectsVersion,
  );
}

/**
 * The project picture's address, or null when there is nothing to ask for: no picture set and both picture switches
 * off. A linked machine's project asks that machine, through this Inbox's forward (`inboxUrl`). `v` is the browser's
 * cache key: it changes when a picture is set or taken away, or a switch moves. `logo=1` asks for the repo's logo
 * whatever the saved look says, so a look drawn before it is saved (the list dialog's Detailed card) shows its logos,
 * and its picture is the one the list then keeps in the cache. GitHub pictures the Inbox takes from the saved look only.
 */
export function projectPictureUrl(projectId: string, marks: MarksChoice): string | null {
  if (!projectId) return null;
  const set = projects.get(projectId)?.picture;
  if (set === undefined && !marks.logo && !marks.github) return null;
  return inboxUrl(`/projects/${encodeURIComponent(projectId)}/picture`, `v=${set ?? 0}-${marks.logo ? 1 : 0}${marks.github ? 1 : 0}${marks.logo ? '&logo=1' : ''}`, machineOf(projectId));
}

/** Tests only. */
export function resetKnownProjectsForTests(): void {
  projects.clear();
  sessionProjects.clear();
  notifyProjects();
  notifySessions();
}

/** The most Set picture… sends: the Inbox refuses more (PROJECT_PICTURE_MAX_BYTES on the server). */
export const PICTURE_MAX_BYTES = 512 * 1024;

/**
 * A picked file as the data: URL the Inbox takes, or the approved refusal: a file over 512 KB (a phone photo) is
 * refused here, before it is read, so a big file is never read into memory or sent.
 */
export async function pictureFromFile(file: Blob): Promise<{ picture: string } | { refused: string }> {
  if (file.size > PICTURE_MAX_BYTES) return { refused: 'Picture: at most 512 KB.' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return { picture: `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}` };
}

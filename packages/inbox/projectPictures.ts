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
  /** Its folder and its git origin (`owner/repo`), for Ask an agent to draw it. */
  root?: string;
  repo?: string;
  /** The look picked in its mark's picker: `hue:<n>`, `repo` or `github`. */
  look?: string;
}
const projects = new Map<string, KnownProject>();
let projectsVersion = 0;
const projectListeners = new Set<() => void>();

function notifyProjects(): void {
  projectsVersion++;
  for (const listener of projectListeners) listener();
}

/** A row as `learnProjects` reads it: its project and the agent sessions in it, its title and when it moved. */
interface SessionsRow {
  project: { id: string; name: string };
  thread_id?: string;
  thread_name?: string | null;
  subject?: string | null;
  last_at?: string;
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

/** The newest threads' titles a read brought, kept per project and per agent session: Ask an agent to draw it names them. */
const RECENT_KEPT = 5;
let recentByProject = new Map<string, readonly string[]>();
let recentBySession = new Map<string, readonly string[]>();

function learnRecent(rows: readonly SessionsRow[]): void {
  const titled = rows
    .flatMap((row) => {
      const title = (row.thread_name || row.subject || '').trim();
      return title ? [{ row, title, at: row.last_at ?? '' }] : [];
    })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const seen = new Set<string>();
  const byProject = new Map<string, string[]>();
  const bySession = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, title: string) => {
    const list = map.get(key) ?? [];
    if (list.length < RECENT_KEPT && !list.includes(title)) list.push(title);
    map.set(key, list);
  };
  for (const { row, title } of titled) {
    // A starred thread can come twice in one read (its section and the stars).
    if (row.thread_id && seen.has(row.thread_id)) continue;
    if (row.thread_id) seen.add(row.thread_id);
    add(byProject, row.project.id, title);
    const sessions = [row.author.kind === 'agent' ? row.author.session : null, row.addressee?.session, ...(row.participants ?? []).map((p) => p.session)];
    for (const session of new Set(sessions)) if (session) add(bySession, session, title);
  }
  if (rows.length > 0) {
    recentByProject = byProject;
    recentBySession = bySession;
  }
}

/** What the window knows about a project for Ask an agent to draw it: its name, folder, origin and newest threads' titles. */
export function projectFacts(projectId: string): { name: string; folder: string | null; repo: string | null; recent: readonly string[] } | null {
  const known = projects.get(projectId);
  if (!known) return null;
  return { name: known.name, folder: known.root || null, repo: known.repo || null, recent: recentByProject.get(projectId) ?? [] };
}

/** The newest threads' titles an agent's sessions wrote, were addressed in, or took part in. */
export function sessionRecentTitles(sessions: readonly string[]): string[] {
  const out: string[] = [];
  for (const session of sessions) for (const title of recentBySession.get(session) ?? []) if (out.length < RECENT_KEPT && !out.includes(title)) out.push(title);
  return out;
}

/** The Inbox's projects as a list read brought them: their names and when each one's picture was set; `rows`: its sessions' projects. */
export function learnProjects(list: readonly { id: string; name: string; picture?: number; root?: string; repo?: string; look?: string }[], rows: readonly SessionsRow[] = []): void {
  learnRecent(rows);
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
    const root = typeof project.root === 'string' ? project.root : (before?.root ?? undefined);
    const repo = typeof project.repo === 'string' ? project.repo : (before?.repo ?? undefined);
    const look = typeof project.look === 'string' ? project.look : undefined;
    if (before && before.name === project.name && before.picture === picture && before.root === root && before.repo === repo && before.look === look) continue;
    projects.set(project.id, { name: project.name, ...(picture !== undefined ? { picture } : {}), ...(root ? { root } : {}), ...(repo ? { repo } : {}), ...(look ? { look } : {}) });
    changed = true;
  }
  if (changed) notifyProjects();
}

/** A project's name, or null (one no list has named yet). */
export function knownProjectName(projectId: string): string | null {
  return projects.get(projectId)?.name ?? null;
}

/** Whether the project has a picture or a look someone set (the project menu and the picker offer to take it away). */
export function hasSetPicture(projectId: string): boolean {
  const known = projects.get(projectId);
  return known?.picture !== undefined || known?.look !== undefined;
}

/** The look picked for a project in its mark's picker (`hue:<n>`, `repo`, `github`), or null. */
export function projectLookOf(projectId: string): string | null {
  return projects.get(projectId)?.look ?? null;
}

/** The hue picked for a project's letters (0 to 7), or null: the name's own. */
export function projectHueOf(projectId: string): number | null {
  const hue = /^hue:([0-7])$/.exec(projects.get(projectId)?.look ?? '');
  return hue ? Number(hue[1]) : null;
}

/** One picture source's address for the picker's place (`source=repo|github`), on the Inbox that has the project. */
export function projectSourceUrl(projectId: string, source: 'repo' | 'github'): string {
  return inboxUrl(`/projects/${encodeURIComponent(projectId)}/picture`, `source=${source}`, machineOf(projectId));
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
  const look = projects.get(projectId)?.look;
  // A picked hue is letters alone; a picked source is asked for whatever the switches say.
  if (look?.startsWith('hue:')) return null;
  if (set === undefined && !look && !marks.logo && !marks.github) return null;
  return inboxUrl(`/projects/${encodeURIComponent(projectId)}/picture`, `v=${set ?? 0}-${marks.logo ? 1 : 0}${marks.github ? 1 : 0}${look ? `-${look}` : ''}${marks.logo ? '&logo=1' : ''}`, machineOf(projectId));
}

/** Tests only. */
export function resetKnownProjectsForTests(): void {
  projects.clear();
  recentByProject = new Map();
  recentBySession = new Map();
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

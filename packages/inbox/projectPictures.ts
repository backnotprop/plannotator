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

/** The Inbox's projects as a list read brought them: their names and when each one's picture was set. */
export function learnProjects(list: readonly { id: string; name: string; picture?: number }[]): void {
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
 * The project picture's address on this Inbox, or null when there is nothing to ask for: no picture set and both
 * picture switches off, or a linked machine's project (its pictures stay on that machine). The query is only the
 * browser's cache key: it changes when a picture is set or taken away, or a switch moves. Which pictures the Inbox
 * may use it reads from the saved look itself.
 */
export function projectPictureUrl(projectId: string, marks: MarksChoice): string | null {
  if (!projectId || machineOf(projectId)) return null;
  const set = projects.get(projectId)?.picture;
  if (set === undefined && !marks.logo && !marks.github) return null;
  return inboxUrl(`/projects/${encodeURIComponent(projectId)}/picture`, `v=${set ?? 0}-${marks.logo ? 1 : 0}${marks.github ? 1 : 0}`);
}

/** Tests only. */
export function resetKnownProjectsForTests(): void {
  projects.clear();
  notifyProjects();
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

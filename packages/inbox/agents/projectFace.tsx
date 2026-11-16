/**
 * An agent's icon from its project's name (approval "inbox-generated-agent-icons", 2026-11-15; the record is
 * `.product/approved/inbox-generated-agent-icons/`). A solid tile in one of the letter marks' eight hues, the project's
 * letters in the page's lightest colour (letterMarks.tsx `projectLetters`, `LetterMark` solid), and the agent's own
 * mark as a small badge on its corner from 20 px up (CSS: a container query on the tile, so a 16 px mark shows the
 * tile alone). A name with no letter and no emoji draws the agent's own mark.
 *
 * Two ways to it: the face `project`, picked in the face picker ("From the project name", FaceFan.tsx), and Settings →
 * Rows' Agent icons "From the project name" (`agentProjectIcons`), which draws it for every agent with no face picked.
 * With that setting on, the agent's own mark picked by hand is kept as `mark` (core inbox-types.ts, "Agent faces"), so
 * it stays; with the setting at its default nothing changes: `agent` is the own mark, never kept, as before.
 *
 * The project: the Agents list's (an agent and every session it was), else the rows' (the project each session wrote
 * in, projectPictures.ts `sessionProjectOf`). Named as the window names it (`setWindowProjectNames`, app/useListView.ts:
 * "api · work" where two folders share a name), the letters from the name before " · ". The hue is keyed on the
 * lowercased label, so it is the same on every machine; projects on screen that would draw the same letters in the
 * same hue are sorted by that key and each next one steps three hues round the wheel until it is free.
 */
import { useEffect, useState } from 'react';
import { HostMark as UiHostMark } from '@plannotator/ui/components/inbox-thread/icons';
import type { AgentFace } from './faceChoices';
import { HUES, LetterMark, hueOf, projectLetters, type Letters } from '../letterMarks';
import { inboxAgentsFlat, inboxAgentsNow, onInboxAgentsSet } from '../agentsList';
import { onSessionProjects, sessionProjectOf } from '../projectPictures';

/** The picker's words for the face (its accessible name and tooltip). */
export const PROJECT_FACE_LABEL = 'From the project name';

/** The face an agent shows: its kept one, with `projectDefault` (the Rows setting) deciding what none shows. */
export function shownAgentFace(kept: AgentFace, projectDefault: boolean): AgentFace {
  if (kept === 'mark') return 'agent';
  if (kept === 'agent' && projectDefault) return 'project';
  return kept;
}

/** The face to keep for a choice in the picker: what none shows is kept as none; the own mark under the setting as `mark`. */
export function keptAgentFace(chosen: AgentFace, projectDefault: boolean): AgentFace {
  if (chosen === (projectDefault ? 'project' : 'agent')) return 'agent';
  if (chosen === 'agent') return 'mark';
  return chosen;
}

// ── the projects the window knows, and who listens ──

type Project = { id: string | null; name: string };
let windowNames: ReadonlyMap<string, string> = new Map();
let byAgent: Map<string, Project> | null = null;
let hues: Map<string, number> | null = null;
let version = 0;
let watching = false;
const listeners = new Set<() => void>();

function changed(): void {
  hues = null;
  version++;
  for (const listener of [...listeners]) listener();
}

/** The window's one name per project (app/useListView.ts `projectNames`): the tiles' labels and the projects on screen. */
export function setWindowProjectNames(names: ReadonlyMap<string, string>): void {
  if (names === windowNames) return;
  const same = names.size === windowNames.size && [...names].every(([id, name]) => windowNames.get(id) === name);
  windowNames = names;
  // The list draws a new map at every change; only a different name redraws the tiles.
  if (!same) changed();
}

function watch(): void {
  if (watching) return;
  watching = true;
  onInboxAgentsSet(() => {
    byAgent = null;
    changed();
  });
  onSessionProjects(changed);
}

/** Every id of a listed agent (its id, its session, the sessions it continues) → its project. */
function agentProjects(): Map<string, Project> {
  watch();
  if (byAgent) return byAgent;
  byAgent = new Map();
  for (const agent of inboxAgentsFlat(inboxAgentsNow())) {
    if (!agent.project) continue;
    for (const id of [agent.id, agent.session, ...(agent.continues ?? [])]) if (!byAgent.has(id)) byAgent.set(id, agent.project);
  }
  return byAgent;
}

const labelOf = (project: Project) => (project.id ? windowNames.get(project.id) : undefined) || project.name;

/** The project label of an agent, by any id it has; null when nothing says where it works. */
export function agentProjectLabel(agent: string | null | undefined): string | null {
  if (!agent) return null;
  const project = agentProjects().get(agent) ?? sessionProjectOf(agent);
  return project ? labelOf(project) : null;
}

// ── the hue ──

/** The hue's key: the whole label, spaces folded, lowercased the same way everywhere. */
export const projectSeed = (label: string) => label.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

/**
 * Each label's hue (0 to 7) among `labels`: its own (`hueOf` of its key), but when labels with the same letters share
 * a hue, sorted by key, the first keeps it and each next one steps three hues until it is free.
 */
export function projectHues(labels: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  const groups = new Map<string, string[]>();
  for (const label of new Set(labels)) {
    const key = projectLetters(label).text;
    groups.set(key, [...(groups.get(key) ?? []), label]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (projectSeed(a) < projectSeed(b) ? -1 : projectSeed(a) > projectSeed(b) ? 1 : 0));
    const taken = new Set<number>();
    for (const label of group) {
      let hue = hueOf(projectSeed(label));
      for (let step = 0; step < HUES && taken.has(hue); step++) hue = (hue + 3) % HUES;
      taken.add(hue);
      out.set(label, hue);
    }
  }
  return out;
}

/** A label's hue among the projects on screen (the window's names and the Agents list's). */
function hueFor(label: string): number {
  hues ??= projectHues([...windowNames.values(), ...[...agentProjects().values()].map(labelOf)]);
  return hues.get(label) ?? hueOf(projectSeed(label));
}

function subscribe(listener: () => void): () => void {
  watch();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * The tile an agent would draw: its label and letters, or null (no project known, or a name with nothing to draw).
 *
 * Plain state, never `useSyncExternalStore` (as agentsList.ts `useInboxAgents`): a list read sets the agents and the
 * sessions' projects mid-read, and a store would draw at once, before the read moves a snoozed row to its band; the
 * row menu would then see its write land with the row still on screen and drop focus to the page (rowMenu.test.tsx).
 */
export function useAgentProjectTile(agent: string | null | undefined): { label: string; letters: Letters; hue: number } | null {
  const [, setSeen] = useState(version);
  useEffect(() => {
    const read = () => setSeen(version);
    // A change between the first draw and this subscription.
    read();
    return subscribe(read);
  }, []);
  const label = agentProjectLabel(agent);
  if (!label) return null;
  const letters = projectLetters(label);
  return letters.kind === 'none' ? null : { label, letters, hue: hueFor(label) };
}

/**
 * The tile in a mark's box (icons.tsx `.ib-mk`, its sizes): the project's letters, and `host`'s own mark on the
 * corner where the box is 20 px or more. Decorative, as every mark: the agent's name is in words beside it.
 */
export function ProjectTile({ tile, host, big, badge = true }: { tile: { label: string; letters: Letters; hue: number }; host: string | null | undefined; big?: boolean; badge?: boolean }) {
  return (
    <span className={`ib-mk${big ? ' ib-big' : ''} ib-face ib-pf`} data-agent-face="project">
      <LetterMark name={tile.label} seed={projectSeed(tile.label)} letters={tile.letters} hue={tile.hue} solid className="ib-pf-t" />
      {badge && (
        <span className="ib-pf-b" aria-hidden="true">
          <UiHostMark host={host} />
        </span>
      )}
    </span>
  );
}

/** An agent's project tile, or its own mark when the tile has nothing to draw. */
export function ProjectFaceMark({ agent, host, big, badge = true }: { agent: string | null | undefined; host: string | null | undefined; big?: boolean; badge?: boolean }) {
  const tile = useAgentProjectTile(agent);
  return tile ? <ProjectTile tile={tile} host={host} big={big} badge={badge} /> : <UiHostMark host={host} big={big} />;
}

/** Tests: forget the window's names and the Agents list's projects. */
export function resetProjectFaces(): void {
  windowNames = new Map();
  byAgent = null;
  changed();
}

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
 * in, projectPictures.ts `sessionProjectOf`). Its letters and its hue come from the project's own name alone (lowercased,
 * NFC), so a tile is the same colour on every machine and never changes because another project appeared, a filter
 * changed or the list reordered (review of #3503, 2026-11-16: stability won over stepping the hue of same-letter
 * projects apart). A linked machine from before tiles keeps its agents' own marks (`useProjectDefault`).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { HostMark as UiHostMark } from '@plannotator/ui/components/inbox-thread/icons';
import type { AgentFace } from './faceChoices';
import { LetterMark, hueOf, projectLetters, useRowMarks, type Letters } from '../letterMarks';
import { useAgentFace, useAgentTakesTiles } from './agentFaces';
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

/**
 * Whether "From the project name" draws this agent when it has no face picked: the Rows setting is on and the machine
 * the agent is on keeps a tile choice (agentFaces.ts `useAgentTakesTiles`). A linked machine from before tiles could not
 * keep the own mark picked back, so its agents keep their own marks there and are offered no tile.
 */
export function useProjectDefault(agent: string | null | undefined): boolean {
  const { projectIcons } = useRowMarks();
  const takes = useAgentTakesTiles(agent);
  return projectIcons && takes;
}

/** The face an agent's icon draws now: its kept face, with the Rows setting deciding what none shows. */
export function useShownAgentFace(agent: string | null | undefined): AgentFace {
  const kept = useAgentFace(agent);
  const projectDefault = useProjectDefault(agent);
  return agent ? shownAgentFace(kept, projectDefault) : kept;
}

// ── the projects the window knows, and who listens ──

type Project = { id: string | null; name: string };
export type ProjectTileLook = { label: string; letters: Letters; hue: number };
let byAgent: Map<string, Project> | null = null;
let version = 0;
let watching = false;
const listeners = new Set<() => void>();

function changed(): void {
  version++;
  for (const listener of [...listeners]) listener();
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

/** The project's name for an agent, as the list names it, by any id it has; null when nothing says where it works. */
export function agentProjectLabel(agent: string | null | undefined): string | null {
  if (!agent) return null;
  return (agentProjects().get(agent) ?? sessionProjectOf(agent))?.name ?? null;
}

// ── the hue ──

/**
 * The hue's key: the project's own name (its folder's or repository's), spaces folded, NFC, lowercased the same way
 * everywhere. Never what is added after " · " to tell it apart: the Inbox names a project "api · work" only while
 * another folder is also named "api" (shared/inbox/project-name.ts), and a window adds " · <machine>" for a linked
 * machine's; so the colour is the same on every machine, whatever else is there.
 */
export const projectSeed = (name: string) => name.normalize('NFC').trim().replace(/\s+/g, ' ').split(' · ')[0]!.trim().toLocaleLowerCase('en-US');

const tiles = new Map<string, ProjectTileLook | null>();

/**
 * A project's tile: its letters and its hue, both from its name alone (`projectSeed`), so a tile never changes colour
 * because another project appeared, two folders came to share a name, the list was filtered by machine or reordered.
 * Two projects whose names hash alike share a hue; the name beside the tile tells them apart. Null: a name with nothing
 * to draw.
 */
export function projectTileOf(name: string): ProjectTileLook | null {
  // Letters take the name before " · " too (letterMarks.tsx `projectLetters`).
  const held = tiles.get(name);
  if (held !== undefined) return held;
  const letters = projectLetters(name);
  const tile = letters.kind === 'none' ? null : { label: name, letters, hue: hueOf(projectSeed(name)) };
  if (tiles.size > 500) tiles.clear();
  tiles.set(name, tile);
  return tile;
}

function subscribe(listener: () => void): () => void {
  watch();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * The tile an agent would draw, or null (no project known, or a name with nothing to draw). Null `agent`: none, and
 * nothing heard (an icon that shows no tile asks for none).
 *
 * Plain state, never `useSyncExternalStore` (as agentsList.ts `useInboxAgents`): a list read sets the agents and the
 * sessions' projects mid-read, and a store would draw at once, before the read moves a snoozed row to its band; the
 * row menu would then see its write land with the row still on screen and drop focus to the page (rowMenu.test.tsx).
 */
export function useAgentProjectTile(agent: string | null | undefined): ProjectTileLook | null {
  const [, setSeen] = useState(version);
  const on = !!agent;
  useEffect(() => {
    if (!on) return;
    const read = () => setSeen(version);
    // A change between the first draw and this subscription.
    read();
    return subscribe(read);
  }, [on]);
  const name = agentProjectLabel(agent);
  return name ? projectTileOf(name) : null;
}

/**
 * The tile in a mark's box (icons.tsx `.ib-mk`, its sizes): the project's letters, and `host`'s own mark on the
 * corner where the box is 20 px or more. Decorative, as every mark: the agent's name is in words beside it.
 */
export function ProjectTile({ tile, host, big, badge = true, children }: { tile: ProjectTileLook; host: string | null | undefined; big?: boolean; badge?: boolean; children?: ReactNode }) {
  return (
    <span className={`ib-mk${big ? ' ib-big' : ''} ib-face ib-pf`} data-agent-face="project">
      <LetterMark name={tile.label} seed={projectSeed(tile.label)} letters={tile.letters} hue={tile.hue} solid split className="ib-pf-t" />
      {badge && (
        <span className="ib-pf-b" aria-hidden="true">
          <UiHostMark host={host} />
        </span>
      )}
      {children}
    </span>
  );
}

/** An agent's project tile, or its own mark when the tile has nothing to draw. */
export function ProjectFaceMark({ agent, host, big, badge = true, children }: { agent: string | null | undefined; host: string | null | undefined; big?: boolean; badge?: boolean; children?: ReactNode }) {
  const tile = useAgentProjectTile(agent);
  return tile ? (
    <ProjectTile tile={tile} host={host} big={big} badge={badge}>
      {children}
    </ProjectTile>
  ) : (
    <UiHostMark host={host} big={big}>
      {children}
    </UiHostMark>
  );
}

/** Tests: forget the Agents list's projects. */
export function resetProjectFaces(): void {
  byAgent = null;
  tiles.clear();
  changed();
}

/**
 * The Swarm badge's one source of truth (docs/agent-guides/inbox-compose.md, "Swarm"): the badge is on exactly while
 * the words being written carry the `/swarm` skill (`/swarm` or `$swarm`, read as the composer and the Send read every
 * skill reference, `findSkillReferenceTokens`). A press puts the reference in, or takes every one out; typing it
 * yourself turns the badge on the same way. At Send the window pastes the skill's text (@plannotator/core/swarm-skill)
 * like any built-in, and the server makes the thread a swarm from that block (packages/shared/inbox/swarm-start.ts).
 */
import { SWARM_SKILL, type SwarmSkillContext } from '@plannotator/core/swarm-skill';
import { findSkillReferenceTokens, type SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { hostLabel } from '../compose/model';

const ONLY_SWARM: SkillCatalogEntry[] = [{ name: SWARM_SKILL.name, root: 'plannotator', humanOnly: true }];

/** The words carry `/swarm`. */
export function carriesSwarm(text: string): boolean {
  return findSkillReferenceTokens(text, ONLY_SWARM).length > 0;
}

/** The words with `/swarm` at their end (unchanged when they carry it already). */
export function withSwarm(text: string): string {
  if (carriesSwarm(text)) return text;
  const ref = `/${SWARM_SKILL.name} `;
  if (text.trim() === '') return ref;
  return /\s$/.test(text) ? `${text}${ref}` : `${text} ${ref}`;
}

/** The words without any `/swarm` reference, each taken out with one space beside it. */
export function withoutSwarm(text: string): string {
  let out = text;
  for (const token of findSkillReferenceTokens(text, ONLY_SWARM).reverse()) {
    let start = token.start;
    let end = token.end;
    if (out[end] === ' ') end++;
    else if (start > 0 && out[start - 1] === ' ') start--;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/** The badge's press: on puts `/swarm` in the words, off takes it out. */
export function swarmWordsFor(text: string, on: boolean): string {
  return on ? withSwarm(text) : withoutSwarm(text);
}

/**
 * An agent as `/swarm`'s text names it: its kind ("Codex", `hostLabel`), then where it works: "Codex (ledger · Mac
 * mini)", "Claude Code (ledger)", or the kind alone.
 */
export function swarmAgentName(kind: string, where: readonly (string | null | undefined)[] = []): string {
  const at = where.filter((part): part is string => !!part && part.trim() !== '').join(' · ');
  return at ? `${kind} (${at})` : kind;
}

/** A host's kind, for `swarmAgentName`. */
export const swarmAgentKind = (host: string | null): string => (host ? hostLabel(host) : 'Agent');

export type { SwarmSkillContext };

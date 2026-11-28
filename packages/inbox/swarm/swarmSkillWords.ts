/**
 * The Swarm badge's one source of truth (docs/agent-guides/inbox-swarm.md, "Starting a swarm"): the badge is on exactly
 * while the words being written carry the `/swarm` skill (`/swarm` or `$swarm`, read as the composer and the Send read
 * every skill reference, `findSkillReferenceTokens`). A press puts the reference in, or takes every one out; typing it
 * yourself turns the badge on the same way. At Send the window pastes the skill's approved text
 * (@plannotator/core/swarm-skill) like any built-in, and the server makes the thread a swarm from that block
 * (packages/shared/inbox/swarm-start.ts).
 */
import { SWARM_SKILL } from '@plannotator/core/swarm-skill';
import { findSkillReferenceTokens, type SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';

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

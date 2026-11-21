/**
 * Linear hover cards, a ref card provider (packages/ui/utils/refCardProviders.ts).
 * A pasted `https://linear.app/<workspace>/issue/ENG-123/<slug>`,
 * and in the Inbox a bare `ENG-123` of one of the workspace's teams, get the
 * same hover card as a PR or issue link. Browser-safe: the link parser, the
 * bare-identifier pattern and the card's Linear fields. The fetch is
 * packages/server/inbox-linear-cards.ts; the card is
 * packages/ui/components/LinearRefCardView.tsx.
 */
import type { ForgeRef, ForgeRefCardData } from "./forge-ref-card";

/**
 * A Linear issue, as its link names it: `owner` is the workspace's URL key,
 * `repo` the team key, `number` the issue's number (`ENG-123`). Shaped like a
 * `ForgeRef` so the hover card's cache and controller take it unchanged.
 */
export interface LinearRef {
  platform: "linear";
  host: "linear.app";
  owner: string;
  repo: string;
  number: number;
  kind: "issue";
}

/** Which bare identifiers (`ENG-123`) a host links to Linear: the workspace's URL key and its team keys. */
export interface LinearIssueRefs {
  workspace: string;
  teams: string[];
}

/** A Linear issue's own fields on the card (its workflow state is finer than `state`). */
export interface LinearCardFields {
  /** `ENG-123`. */
  identifier: string;
  /** The team's name ("Development"). */
  team: string;
  /** The workflow state as the team names it ("In Review"), its type and colour (six hex digits, no `#`). */
  stateName: string;
  stateType: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | null;
  stateColor: string;
  /** "Urgent", "High", "Medium", "Low", or null for no priority. */
  priority: string | null;
  project: string | null;
  estimate: number | null;
}

/** A Linear card's data: the forge card's shape (`platform: "linear"`, `repo` the team key) with `linear`. */
export type LinearCardData = Omit<ForgeRefCardData, "platform"> & { platform: "linear"; linear: LinearCardFields };

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export const LINEAR_TEAM_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}$/;
const IDENTIFIER = /^([A-Za-z][A-Za-z0-9]{0,9})-([1-9]\d{0,8})$/;

/**
 * Read a Linear issue link back into a ref, or null:
 * `https://linear.app/<workspace>/issue/<TEAM-123>(/<slug>)`. Only https, no
 * credentials, no port, and the host exactly linear.app.
 */
export function parseLinearRefUrl(href: string): LinearRef | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname.toLowerCase() !== "linear.app") return null;
  const [workspace, issue, identifier] = url.pathname.split("/").filter(Boolean);
  if (!workspace || issue !== "issue" || !identifier || !NAME.test(workspace)) return null;
  const m = IDENTIFIER.exec(identifier);
  if (!m) return null;
  return { platform: "linear", host: "linear.app", owner: workspace.toLowerCase(), repo: m[1]!.toUpperCase(), number: Number(m[2]), kind: "issue" };
}

/** The ref as the hover card's seam carries it (a `ForgeRef` whose `platform` is "linear" at runtime). */
export function linearAsForgeRef(ref: LinearRef): ForgeRef {
  return ref as unknown as ForgeRef;
}

/** The ref is a Linear one (whatever its static type). */
export function isLinearRef(ref: { platform: string }): ref is { platform: "linear" } {
  return ref.platform === "linear";
}

/** The issue's link for a bare identifier. */
export function linearIssueUrl(workspace: string, identifier: string): string {
  return `https://linear.app/${encodeURIComponent(workspace)}/issue/${identifier}`;
}

/**
 * The bare identifiers of these teams in a piece of prose: uppercase as Linear
 * writes them, at a word boundary, never inside a path or a longer token. Only
 * these keys link, so `UTF-8` or `ISO-9001` stay text. `previousChar` is the
 * character before `text` (a match at 0 after a word character is not one).
 */
export function findLinearIdentifiers(text: string, refs: LinearIssueRefs, previousChar = ""): { start: number; end: number; identifier: string }[] {
  const teams = refs.teams.filter((t) => LINEAR_TEAM_KEY.test(t));
  if (teams.length === 0) return [];
  const pattern = new RegExp(`(?<![\\w/.-])(${teams.join("|")})-([1-9]\\d{0,8})(?![\\w-])`, "g");
  const found: { start: number; end: number; identifier: string }[] = [];
  for (const m of text.matchAll(pattern)) {
    const i = m.index!;
    if (i === 0 && /[\w/.-]/.test(previousChar)) continue;
    found.push({ start: i, end: i + m[0].length, identifier: m[0] });
  }
  return found;
}

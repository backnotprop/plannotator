/**
 * Skill catalog transport: fetches the catalog (default: `GET /api/skills`)
 * and caches it in memory for a short window so the composer never hits the
 * filesystem per keystroke, while staying ephemeral — nothing is persisted to
 * cookies, config, or storage, and every page session re-reads the catalog
 * from disk via the server.
 *
 * The transport is a host seam (see packages/ui/CLAUDE.md): hosts embedding
 * `@plannotator/ui` with their own backend install a replacement via
 * `setSkillCatalogTransport` / `configurePlannotatorUI({ skillCatalogTransport })`.
 * The default reproduces today's behavior byte-for-byte.
 *
 * Never throws and never rejects: any failure (endpoint missing on a host,
 * network error, malformed payload, a throwing host transport) yields an empty
 * catalog, which renders the composer's `/` and `$` as plain typing.
 *
 * This module also lazily fetches the SKILL.md contents of referenced
 * HUMAN-ONLY skills (default: `GET /api/skills/content?name=`) so the export
 * can inject their instructions — see primeSkillContentsForExport below and
 * skillReferenceExportBlock in utils/skillReferences.ts. Same posture: its
 * failures degrade to the name + directory fallback, never an error.
 */

import type { SkillCatalogEntry, SkillExportContent, SkillRootId } from './skillReferences';
import {
  extractSkillReferences,
  registerSkillContentForExport,
  resetSkillContentsForExport,
  setSkillCatalogForExport,
} from './skillReferences';

const CATALOG_TTL_MS = 30_000;

/**
 * Host-override seam for the catalog request. Must resolve to the raw entry
 * list; failures may reject or throw — the cache layer degrades them to [].
 */
export type SkillCatalogTransport = () => Promise<SkillCatalogEntry[]>;

function normalizeEntry(raw: unknown): SkillCatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, root, description, humanOnly, dir } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name) return null;
  const rootId: SkillRootId =
    root === 'claude' || root === 'codex' || root === 'universal' ? root : 'universal';
  return {
    name,
    root: rootId,
    ...(typeof description === 'string' && description ? { description } : {}),
    humanOnly: humanOnly === true,
    ...(typeof dir === 'string' && dir ? { dir } : {}),
  };
}

const defaultTransport: SkillCatalogTransport = async () => {
  const res = await fetch('/api/skills');
  if (!res.ok) return [];
  const data = (await res.json()) as { skills?: unknown };
  if (!Array.isArray(data.skills)) return [];
  return data.skills.map(normalizeEntry).filter((s): s is SkillCatalogEntry => s !== null);
};

let transport: SkillCatalogTransport = defaultTransport;

export function setSkillCatalogTransport(next: SkillCatalogTransport): void {
  transport = next;
}

export function resetSkillCatalogTransport(): void {
  transport = defaultTransport;
}

async function requestCatalog(): Promise<SkillCatalogEntry[]> {
  try {
    const skills = await transport();
    return Array.isArray(skills)
      ? skills.map(normalizeEntry).filter((s): s is SkillCatalogEntry => s !== null)
      : [];
  } catch {
    return [];
  }
}

let cached: { at: number; skills: SkillCatalogEntry[] } | null = null;
let inflight: Promise<SkillCatalogEntry[]> | null = null;
// Bumped by resetSkillCatalogCache. A request that resolves after a reset (or
// after being superseded) must neither populate the cache nor register the
// export catalog — otherwise a late-resolving stale request overwrites a newer
// value, and a reset leaves an outstanding request that "revives" dead state.
let generation = 0;

/** Fetch the catalog (deduped in-flight, cached for CATALOG_TTL_MS). */
export function fetchSkillCatalog(): Promise<SkillCatalogEntry[]> {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return Promise.resolve(cached.skills);
  }
  if (inflight) return inflight;

  const startedIn = generation;
  const promise = requestCatalog().then((skills) => {
    if (startedIn !== generation) {
      // Cache was reset while this request was outstanding: report what we
      // got, but do not let a dead request write shared state.
      return skills;
    }
    if (inflight === promise) inflight = null;
    // An empty result is not cached as authoritative when a previous fetch
    // succeeded — a transient failure must not blank an established catalog.
    if (skills.length > 0 || !cached || cached.skills.length === 0) {
      cached = { at: Date.now(), skills };
    } else {
      cached = { at: Date.now(), skills: cached.skills };
    }
    setSkillCatalogForExport(cached.skills);
    return cached.skills;
  });
  inflight = promise;
  return promise;
}

/** The last fetched catalog, without triggering a request. */
export function getCachedSkillCatalog(): SkillCatalogEntry[] {
  return cached?.skills ?? [];
}

/**
 * Fire-and-forget warm-up so export enrichment works even when a comment with
 * references arrives without the composer opening this session (draft restore,
 * annotation-panel edits).
 */
export function primeSkillCatalog(): void {
  void fetchSkillCatalog();
}

/**
 * Test-only: drop the cache and the export registry, and invalidate any
 * outstanding request so it can no longer write shared state when it lands.
 */
export function resetSkillCatalogCache(): void {
  generation++;
  cached = null;
  inflight = null;
  contentRequests.clear();
  reportedContentNames.clear();
  setSkillCatalogForExport([]);
  resetSkillContentsForExport();
}

// ---------------------------------------------------------------------------
// Human-only skill contents (lazy, per referenced skill)
// ---------------------------------------------------------------------------

/**
 * Host-override seam for the content request (see skillCatalogTransport
 * above). Must resolve to the raw `{ name, dir, path, content, truncated }`
 * record for one skill, or null/undefined when unavailable; failures may
 * reject or throw — the cache layer degrades them to "no content", which
 * exports as the name + directory fallback.
 */
export type SkillContentTransport = (name: string) => Promise<unknown>;

const defaultContentTransport: SkillContentTransport = async (name) => {
  const res = await fetch(`/api/skills/content?name=${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { skill?: unknown };
  return data.skill ?? null;
};

let contentTransport: SkillContentTransport = defaultContentTransport;

export function setSkillContentTransport(next: SkillContentTransport): void {
  contentTransport = next;
}

export function resetSkillContentTransport(): void {
  contentTransport = defaultContentTransport;
}

function normalizeSkillContent(raw: unknown): SkillExportContent | null {
  if (!raw || typeof raw !== 'object') return null;
  const { content, truncated, dir, path } = raw as Record<string, unknown>;
  if (typeof content !== 'string' || !content) return null;
  if (typeof dir !== 'string' || !dir) return null;
  if (typeof path !== 'string' || !path) return null;
  return { content, truncated: truncated === true, dir, path };
}

// One request per skill name per session (a failure is cached as "no content"
// and not retried; the export's name + directory fallback covers it). Cleared
// by resetSkillCatalogCache alongside the catalog itself.
const contentRequests = new Map<string, Promise<boolean>>();

// Names whose registered content has already been reported to a caller as
// "changed". A cached request stays resolved-true forever, so the "changed"
// signal must be edge-triggered: without this set, every re-prime re-reports
// the same landing, and callers that bump a re-render generation on `true`
// (packages/editor/App.tsx) spin into an unbounded render loop. Cleared by
// resetSkillCatalogCache alongside the requests.
const reportedContentNames = new Set<string>();

/**
 * Fetch and register the SKILL.md contents for every HUMAN-ONLY skill the
 * given comment texts reference, so skillReferenceExportBlock can inject them.
 * Lazy by design: only referenced human-only skills are fetched — model-
 * invocable skills export as names the agent can invoke itself, so shipping
 * every body up front would be pure bloat.
 *
 * Resolves true only when content newly landed in the registry — i.e. at
 * least one referenced skill's content is registered and has not been
 * reported by a previous call (callers use that to re-render memoized
 * exports, so the signal must be edge-triggered, never level-triggered).
 * Never rejects.
 */
export async function primeSkillContentsForExport(
  texts: Array<string | undefined | null>,
): Promise<boolean> {
  try {
    const catalog = await fetchSkillCatalog();
    if (catalog.length === 0) return false;

    const names = new Set<string>();
    for (const text of texts) {
      if (!text) continue;
      for (const ref of extractSkillReferences(text, catalog)) {
        if (ref.humanOnly) names.add(ref.name);
      }
    }
    if (names.size === 0) return false;

    const nameList = [...names];
    const results = await Promise.all(
      nameList.map((name) => {
        let request = contentRequests.get(name);
        if (!request) {
          const startedIn = generation;
          request = (async () => {
            try {
              const skill = normalizeSkillContent(await contentTransport(name));
              if (!skill) return false;
              // A reset while this request was outstanding: report what we
              // got, but never let a dead request write shared state.
              if (startedIn !== generation) return false;
              registerSkillContentForExport(name, skill);
              return true;
            } catch {
              return false;
            }
          })();
          contentRequests.set(name, request);
        }
        return request;
      }),
    );
    // Edge-triggered: only content that landed and has never been reported
    // counts as a change. Concurrent callers awaiting the same request race
    // for the report; exactly one wins, which is enough to bump the caller's
    // generation once.
    let changed = false;
    for (let i = 0; i < nameList.length; i++) {
      if (results[i] && !reportedContentNames.has(nameList[i])) {
        reportedContentNames.add(nameList[i]);
        changed = true;
      }
    }
    return changed;
  } catch {
    return false;
  }
}

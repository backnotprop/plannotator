import type { SkillCatalogEntry, SkillExportContent, SkillRootId } from './skillReferences';
import {
  extractSkillReferences,
  registerSkillContentForExport,
  resetSkillContentsForExport,
  setSkillCatalogForExport,
} from './skillReferences';

const CATALOG_TTL_MS = 30_000;

export type SkillCatalogTransport = () => Promise<SkillCatalogEntry[]>;

function normalizeEntry(raw: unknown): SkillCatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, root, description, humanOnly, dir } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name) return null;
  const rootId: SkillRootId =
    root === 'claude' || root === 'codex' || root === 'universal' || root === 'plannotator' ? root : 'universal';
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

let exportRegistration = true;

export function setSkillCatalogExportRegistration(on: boolean): void {
  exportRegistration = on;
  if (!on) setSkillCatalogForExport([]);
}

let cached: { at: number; skills: SkillCatalogEntry[] } | null = null;
let inflight: Promise<SkillCatalogEntry[]> | null = null;
let generation = 0;

export function fetchSkillCatalog(): Promise<SkillCatalogEntry[]> {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return Promise.resolve(cached.skills);
  }
  if (inflight) return inflight;

  const startedIn = generation;
  const promise = requestCatalog().then((skills) => {
    if (startedIn !== generation) {
      return skills;
    }
    if (inflight === promise) inflight = null;
    if (skills.length > 0 || !cached || cached.skills.length === 0) {
      cached = { at: Date.now(), skills };
    } else {
      cached = { at: Date.now(), skills: cached.skills };
    }
    if (exportRegistration) setSkillCatalogForExport(cached.skills);
    return cached.skills;
  });
  inflight = promise;
  return promise;
}

export function getCachedSkillCatalog(): SkillCatalogEntry[] {
  return cached?.skills ?? [];
}

export function primeSkillCatalog(): void {
  void fetchSkillCatalog();
}

export function resetSkillCatalogCache(): void {
  generation++;
  cached = null;
  inflight = null;
  contentRequests.clear();
  reportedContentNames.clear();
  setSkillCatalogForExport([]);
  resetSkillContentsForExport();
}

const reloadListeners = new Set<() => void>();

export function reloadSkillCatalog(): void {
  resetSkillCatalogCache();
  for (const listener of [...reloadListeners]) listener();
}

export function onSkillCatalogReload(listener: () => void): () => void {
  reloadListeners.add(listener);
  return () => {
    reloadListeners.delete(listener);
  };
}

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

export function normalizeSkillContent(raw: unknown): SkillExportContent | null {
  if (!raw || typeof raw !== 'object') return null;
  const { content, truncated, dir, path } = raw as Record<string, unknown>;
  if (typeof content !== 'string' || !content) return null;
  if (typeof dir !== 'string' || !dir) return null;
  if (typeof path !== 'string' || !path) return null;
  return { content, truncated: truncated === true, dir, path };
}

const contentRequests = new Map<string, Promise<boolean>>();

const reportedContentNames = new Set<string>();

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

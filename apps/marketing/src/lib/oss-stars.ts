// The star counts in the Spaces header: the total beside "Open source"
// ("Open source ★ 20.4k") and each repository's count in its drop-down.
// They are read at build time from one snapshot checked into the repository
// (src/data/oss-stars.json, written by `bun apps/marketing/scripts/oss-stars.ts`),
// never from the visitor's browser. A missing or unreadable snapshot gives
// null, and the header then shows its words without counts.

export interface OssStars {
  /** Stars summed over every repository in the set. */
  total: number;
  /** How many repositories the total covers. */
  repoCount: number;
  /** The day the snapshot was taken, YYYY-MM-DD (UTC). */
  fetchedAt: string;
  /** Stars per repository, keyed "owner/name" in lower case. */
  repos: Record<string, number>;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** The snapshot file's text, or undefined when there is none. Null when it cannot be used. */
export function readOssStars(raw: string | undefined): OssStars | null {
  if (typeof raw !== 'string') return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { total, repoCount, fetchedAt, repos: list } = data as Record<string, unknown>;
  if (!isCount(total) || !isCount(repoCount) || repoCount < 1 || !isDay(fetchedAt)) return null;
  // A repository entry that cannot be read is left out: its row shows no count.
  const repos: Record<string, number> = {};
  for (const entry of Array.isArray(list) ? list : []) {
    const { repo, stars } = (entry ?? {}) as Record<string, unknown>;
    if (typeof repo === 'string' && isCount(stars)) repos[repo.toLowerCase()] = stars;
  }
  return { total, repoCount, fetchedAt, repos };
}

/** 950 → "950", 20436 → "20.4k", 128449 → "128.4k", 1234567 → "1.2M". Rounded, one decimal. */
export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  const k = Math.round(n / 100) / 10;
  if (k < 1000) return `${k.toFixed(1)}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
}

/** 20436 → "20,436", the same on every build machine. */
export function exactStars(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "2026-11-22" → "22 Nov 2026", the same on every build machine. */
export function snapshotDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export const OSS_ORG_URL = 'https://github.com/plannotator';

/** The drop-down's repositories, in order, with the line each one shows. The first is the lead card. */
export const OSS_MENU_REPOS = [
  { repo: 'backnotprop/plannotator', line: 'The workspace to stay in the loop and on top of agents' },
  {
    repo: 'plannotator/effective-html',
    line: 'Agent skills for useful HTML artifacts, wireframes, interactive prototypes, plans, and diagrams.',
  },
  { repo: 'plannotator/herdr-annotate', line: 'Annotate terminal text, review documents and agent replies in Herdr' },
  { repo: 'plannotator/artifact-server', line: 'Open source alternative to Claude artifacts.' },
  { repo: 'plannotator/plannotator-tui', line: 'Annotate Markdown in the terminal' },
  { repo: 'plannotator/talkto', line: 'Message boards for AI agents' },
] as const;

export interface OssMenuRepo {
  name: string;
  href: string;
  line: string;
  /** "14,366", or null when the snapshot has no count for it. */
  count: string | null;
  /** What a screen reader hears after the count, and its tooltip. */
  said: string | null;
}

/**
 * What the header's "Open source" drop-down shows and says. The trigger's
 * label is its one accessible name, so the visible count is hidden from
 * screen readers. With no snapshot: the words alone, no counts.
 */
export function ossMenu(stars: OssStars | null) {
  const day = stars ? snapshotDay(stars.fetchedAt) : null;
  const entry = ({ repo, line }: { repo: string; line: string }): OssMenuRepo => {
    const n = stars?.repos[repo.toLowerCase()];
    const count = n === undefined ? null : exactStars(n);
    return {
      name: repo.slice(repo.indexOf('/') + 1),
      href: `https://github.com/${repo}`,
      line,
      count,
      said: count === null ? null : `${count} GitHub stars as of ${day}`,
    };
  };
  const [lead, ...rows] = OSS_MENU_REPOS.map(entry);
  if (!stars) {
    return { count: null, label: 'Open source', summary: null, lead, rows, all: 'All repositories on GitHub' };
  }
  const across = `${exactStars(stars.total)} stars across ${stars.repoCount} repositories`;
  return {
    count: formatStars(stars.total),
    label: `Open source, ${across}`,
    summary: `${across}, as of ${day}`,
    lead,
    rows,
    all: `All ${stars.repoCount} repositories on GitHub`,
  };
}

/** A total this far below the committed one is more likely a broken read than real. */
export const MAX_DROP = 0.2;

/**
 * Why a fresh snapshot must not replace the committed one, or null when it may.
 * An organisation that lists no repositories, or a total more than MAX_DROP
 * below the committed snapshot's (when that one is readable), is refused;
 * `force` lets the drop through, never an empty organisation.
 */
export function snapshotRefusal(
  next: { total: number; orgRepos: Record<string, number> },
  previous: OssStars | null,
  force = false,
): string | null {
  const empty = Object.entries(next.orgRepos).filter(([, n]) => n === 0).map(([org]) => org);
  if (empty.length) return `GitHub listed no public repositories for ${empty.join(', ')}; nothing written.`;
  if (!force && previous && next.total < previous.total * (1 - MAX_DROP)) {
    return `The new total ${exactStars(next.total)} is more than ${MAX_DROP * 100}% below the committed ${exactStars(previous.total)}; nothing written. Run again with --force if it is right.`;
  }
  return null;
}

// The star count in the Spaces page's top strip ("Open source ★ 20.4k").
// It is read at build time from a snapshot checked into the repository
// (src/data/oss-stars.json, written by `bun apps/marketing/scripts/oss-stars.ts`),
// never from the visitor's browser. A missing or unreadable snapshot gives
// null, and the page then shows the link without a count.

export interface OssStars {
  /** Stars summed over every repository in the set. */
  total: number;
  /** How many repositories the total covers. */
  repoCount: number;
  /** The day the snapshot was taken, YYYY-MM-DD (UTC). */
  fetchedAt: string;
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
  const { total, repoCount, fetchedAt } = data as Record<string, unknown>;
  if (!isCount(total) || !isCount(repoCount) || repoCount < 1 || !isDay(fetchedAt)) return null;
  return { total, repoCount, fetchedAt };
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

/**
 * What the link shows and says. The label is the link's one accessible name;
 * the tooltip goes on the hidden count, so a screen reader says the number once.
 * With no snapshot: the words alone, no count.
 */
export function ossStarsLink(stars: OssStars | null) {
  const newTab = 'Opens in a new tab';
  if (!stars) return { count: null, label: `Open source. ${newTab}`, title: null };
  const said = `${exactStars(stars.total)} stars on GitHub as of ${snapshotDay(stars.fetchedAt)}`;
  return { count: formatStars(stars.total), label: `Open source: ${said}. ${newTab}`, title: said };
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

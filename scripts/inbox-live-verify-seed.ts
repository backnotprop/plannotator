/**
 * The live verifier's stores (tests/live-verify/inbox-live.verify.ts): the seeded history its checks run on top of.
 *
 * small, 10k, 100k: scripts/inbox-large-store.ts's random world, as before (100k is 3,000 threads of about 33
 * messages: a deep store with a short list).
 *
 * wide: 30,000 threads and 100,000 messages, the storage budget's shape (30,580 threads per 100k messages), so the
 * verifier's numbers and the store's budget numbers describe the same store. Every thread is put in a section on
 * purpose (spike X3): see WIDE_SECTIONS for the split and why.
 *
 * Every size also gets one long thread (LONG_THREAD_MESSAGES short agent messages, all read) for LV-27.
 *
 * Node-safe (Playwright imports it), scratch data dirs only (inbox-large-store refuses a real one).
 */
import { seedInboxSearchWorld, type SeedShape, type ThreadPlan } from './inbox-large-store';
import type { InboxStore } from '../packages/shared/inbox/store';

export type LiveSize = 'small' | '10k' | '100k' | 'wide';

export const LIVE_SIZES: Record<LiveSize, SeedShape> = {
  small: { threads: 40, messages: 400, projects: 4, textBytes: 1 * 1024 * 1024 },
  '10k': { threads: 300, messages: 10_000, projects: 12, textBytes: 18 * 1024 * 1024 },
  '100k': { threads: 3000, messages: 100_000, projects: 40, textBytes: 120 * 1024 * 1024 },
  // The same messages and text as 100k, ten times the threads.
  wide: { threads: 30_000, messages: 100_000, projects: 40, textBytes: 120 * 1024 * 1024 },
};

export const LONG_THREAD_MESSAGES = 300;

/**
 * Spike X3's assumed split of a large, long-used store (the owner's real store is off limits, so this is a model,
 * not a measurement). Shares of all threads:
 * - archived 10 %: people archive some threads, most just let them go Quiet;
 * - of the 90 % listed, Quiet 80 % (the plan's figure), and above it 20 %:
 *   - New 13 %: agent reports never opened. Nothing ages a row out of New (only a look or Mark read moves it), so
 *     every report the person skimmed past in the list stays there; this is the band that grows with history;
 *   - Waiting 3 %, Holding up work 1.2 %, Stopped 0.8 %: questions an agent asked and nobody answered (the agent
 *     moved on, the session ended); Stopped and Holding are rarer because agents mark few questions that way;
 *   - Sent 2 %: the person replied and the agent never read it (its session had ended).
 * Rows above Quiet lean recent: a thread's chance of sitting above Quiet grows from 0.4x to 1.6x the mean from the
 * oldest thread to the newest (people deal with fresh threads, old ones pile up unopened at a lower rate).
 * Half of the Waiting/Holding/Stopped rows were looked at (not bold), as a person sees a question and leaves it.
 * One Quiet row in ten had a question and was Marked read (Quiet by `read_at`), the rest were simply read.
 */
export const WIDE_SECTIONS = { archived: 0.1, listed: { quiet: 0.8, new: 0.13, waiting: 0.03, holding: 0.012, stopped: 0.008, sent: 0.02 } } as const;

type Placed = 'archived' | keyof typeof WIDE_SECTIONS.listed;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const question = (kind: 'stopped' | 'holding' | 'waiting' | 'plain', t: number) =>
  [
    ':::question',
    `Which way should thread ${t} go?`,
    ...(kind === 'stopped' ? ['Stopped: the next step cannot start without this.'] : kind === 'holding' ? ['Holds up: the release notes; the rollout.'] : []),
    '',
    '- [ ] The first way',
    '- [ ] The second way',
    ':::',
  ].join('\n');

/** Each thread's place for the wide store: deterministic, with the recency lean above. */
export function wideSections(threads: number, seed = 11): Placed[] {
  const random = rng(seed);
  const listed = WIDE_SECTIONS.listed;
  const above = 1 - listed.quiet;
  const out: Placed[] = [];
  for (let t = 0; t < threads; t++) {
    if (random() < WIDE_SECTIONS.archived) {
      out.push('archived');
      continue;
    }
    // 0.4x the mean for the oldest thread, 1.6x for the newest (mean 1x).
    const lean = 0.4 + 1.2 * (threads > 1 ? t / (threads - 1) : 1);
    if (random() >= above * lean) {
      out.push('quiet');
      continue;
    }
    let r = random() * above;
    let placed: Placed = 'new';
    for (const k of ['new', 'waiting', 'holding', 'stopped', 'sent'] as const) {
      if (r < listed[k]) {
        placed = k;
        break;
      }
      r -= listed[k];
    }
    out.push(placed);
  }
  return out;
}

function widePlan(threads: number): ThreadPlan {
  const placed = wideSections(threads);
  const random = rng(23);
  const markedRead = new Set<number>();
  for (let t = 0; t < threads; t++) if (placed[t] === 'quiet' && random() < 0.1) markedRead.add(t);
  return {
    question(t, m, count) {
      if (m !== count - 1) return null;
      const p = placed[t]!;
      if (p === 'stopped' || p === 'holding' || p === 'waiting') return question(p, t);
      return markedRead.has(t) ? question('plain', t) : null;
    },
    finish(store, root, last, t) {
      const p = placed[t]!;
      if (p === 'archived') store.resolveThread(root, true);
      else if (p === 'quiet') {
        if (markedRead.has(t)) store.markRead(root, true);
        else store.markSeen(root);
      } else if (p === 'sent') {
        store.markSeen(root);
        store.sendReply(last, { words: `Thanks, go ahead with ${t}.`, idempotency_key: `wide-sent-${t}` });
      } else if (p !== 'new' && t % 2 === 0) store.markSeen(root);
    },
  };
}

/** The long thread LV-27 opens: short agent messages, all read (they fold behind "Show 20 earlier"). */
function seedLongThread(store: InboxStore): string {
  const project = store.ensureProject({ name: 'long-thread', root: '/src/long-thread' });
  const author = { kind: 'agent' as const, host: 'claude-code', session: 'ses_long', name: null };
  let root: string | null = null;
  for (let i = 0; i < LONG_THREAD_MESSAGES; i++) {
    const message = store.sendMessage({
      project_id: project.id,
      author,
      subject: root ? null : 'A long thread: three hundred steps of one migration',
      body: `Step ${i + 1} of the migration. ${'The batch moved, the counts match, the next batch is queued. '.repeat(1 + (i % 4))}`,
      reply_to: root,
      thread: root ? null : 'long-thread',
    }).message;
    root ??= message.id;
  }
  store.markSeen(root!);
  return root!;
}

export interface LiveWorld {
  /** LV-27's thread. */
  longThread: string;
  /** Rows per section of the seeded list (archived counted apart), as the store's list rules place them. */
  sections: Record<string, number>;
}

export function seedLiveWorld(dataDir: string, size: LiveSize): LiveWorld {
  const shape = LIVE_SIZES[size];
  const { store } = seedInboxSearchWorld(dataDir, shape, 1, { share: 0, kind: 'ids' }, size === 'wide' ? widePlan(shape.threads) : undefined);
  const longThread = seedLongThread(store);
  const sections: Record<string, number> = {};
  for (const row of store.listRows()) {
    const key = row.resolved_at !== null ? 'archived' : row.section;
    sections[key] = (sections[key] ?? 0) + 1;
  }
  return { longThread, sections };
}

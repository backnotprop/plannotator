/**
 * Link two of the person's computers through a third (docs/agent-guides/inbox-machines.md, "Link two computers
 * through a third"; shapes and detection in core inbox-link-through.ts). Mark `link-through`.
 *
 * Three roles, each a door route only a linked computer's token reaches (`DOOR_OWN_ROUTES` in inbox-devices.ts):
 *  - the broker (Studio, linked to both) keeps a job per pair the person clicked Link for, here or on one of the two
 *    (`link-through-ask`, held in that computer's outbox while Studio is away). Once both are online it asks one for
 *    a link code (`link-through-offer`) and hands it to the other (`link-through-introduce`). The code is held in
 *    memory for that one request: nothing of it is written here, and the tokens the two then mint never pass here.
 *  - the code's maker (Mini) opens an introduction's offer on its door: a secret only (no six digits), bound to the
 *    computer it is for and the one that introduced it, alive two minutes by Mini's own clock. The device it makes is
 *    provisional: it reaches only health, link-back and unlink, only a link-back from that computer completes it, and
 *    it is revoked unless that link is saved within two minutes (inbox-devices.ts, `INTRODUCED_DEVICE_MS`).
 *  - the taker (Laptop) runs the ordinary link with that code (`link` in inbox-machines.ts): it redeems it at Mini's
 *    door, checks Mini's health answers with Mini's id, and links back with a code of its own. The result is the link
 *    a person makes by hand.
 *
 * Every one of the three is refused without the mark of a press in a window there (`X-Plannotator-Window`), and an
 * introduction (`intro`) is taken once. Its freshness is the code's life on Mini's clock, so the computers' clocks
 * need not agree. Jobs are kept in `inbox/link-through.json` (0600, temp file then rename); the introductions seen,
 * in memory, a bounded number per broker.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LINK_THROUGH_MARK, linkThroughPairs, linkThroughRows, linkThroughText, type LinkThroughAsk, type LinkThroughPeerFacts, type LinkThroughView, type LinkThroughWire, type LinkThroughWireJob } from "@plannotator/core/inbox-link-through";
import { isInboxId } from "@plannotator/core/inbox-types";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { parseLinkOffer } from "./inbox-links";
import type { OutboxEntry } from "./inbox-outbox";

/** Laptop → Studio: link me with that computer of yours. */
export const LINK_THROUGH_ASK_ROUTE = "link-through-ask";
/** Studio → Mini: a link code for that computer of mine. */
export const LINK_THROUGH_OFFER_ROUTE = "link-through-offer";
/** Studio → Laptop: here is that computer's link code; link. */
export const LINK_THROUGH_INTRODUCE_ROUTE = "link-through-introduce";
/** This Inbox's own writes: the forward never carries them. */
export const LINK_THROUGH_ROUTES: ReadonlySet<string> = new Set([LINK_THROUGH_ASK_ROUTE, LINK_THROUGH_OFFER_ROUTE, LINK_THROUGH_INTRODUCE_ROUTE]);

/**
 * Introductions seen, per broker: at most this many, each for at most a day. An introduction replayed after it left
 * the list (or after a restart) meets a dead code: the one it carries was redeemed or ran out on its maker's clock, and
 * a code request opens only another two-minute code for the same computer, answered to the broker alone.
 */
const SEEN_PER_BROKER = 32;
const SEEN_KEPT_MS = 24 * 60 * 60_000;
const OFFER_MS = 15_000;
/** The taker's link: its pairing, its health read and its way back, each up to 15 s or 30 s. */
const INTRODUCE_MS = 75_000;
/** A job that could not reach one of the two is tried again by itself this much later, doubling; then it says so. */
const RETRY_MS = 15_000;
const TRIES = 3;
const INTRO_ID = /^lt_[0-9a-f]{32}$/;
const FILE = "link-through.json";

export const LINK_THROUGH_WINDOW_ONLY = { error: "Two computers are linked from a click in an Inbox window.", code: "window_only" } as const;

interface Job extends LinkThroughWireJob {
  id: string;
  /** Who clicked: "here", or the computer that asked. */
  by: string;
  at: number;
  tries: number;
  /** Not tried again before this (a job that could not reach one of the two). */
  next: number;
}

interface ThroughFile {
  v: 1;
  jobs: Job[];
}

/** One of this Inbox's links, as the module needs it. */
export interface LinkThroughPeer extends LinkThroughPeerFacts {
  /** Where this Inbox reaches its door (its link's address): a fallback for a code or a way back with none. */
  url: string;
}

/** A door route's answer: status and body. */
export interface LinkThroughAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface LinkThroughContext {
  dataDir: string;
  selfId: () => string;
  /** This Inbox's links, each with its state and its list's marks and `link_through`. */
  peers: () => LinkThroughPeer[];
  /** A request to a linked computer's door, with the window's mark (`X-Plannotator-Window: 1`). */
  request: (machine: string, route: string, body: Record<string, unknown>, timeoutMs: number) => Promise<Response>;
  /** Hold an ask in the outbox for `via` (the window's mark, this Inbox's own write), sent now when it is online. */
  hold: (via: string, body: Record<string, unknown>) => void;
  /** This Inbox's newest ask per computer and broker: still held (`why` null), or refused there (its words). */
  held: () => LinkThroughAsk[];
  /** The ordinary link (inbox-machines.ts `link`): redeem a code, link back. */
  link: (input: { link: string; address?: string; back?: string }) => Promise<unknown>;
  /** Open an introduction's offer on this door, for `forId`, introduced by `by`, and its link code (a secret only). */
  introOffer: (forId: string, by: string) => { link: string };
  /** This Inbox's door on the tailnet, or null. */
  ownAddress: () => string | null;
  /** Read these links' lists again (after a link: their `link_through` moved). */
  refresh: (ids: string[]) => Promise<void>;
  /** The rows changed: the windows and the links hear it. */
  changed: () => void;
  now?: () => number;
  /** Where the test sandbox flag is read (`PLANNOTATOR_TEST_SANDBOX`). Default `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * This Inbox's link-through asks for one linked computer (`via`), from its outbox entries: per computer asked for,
 * the newest one, while it is held, or with the words it was refused with there.
 */
export function linkThroughAsks(entries: readonly OutboxEntry[], via: { id: string; name: string }): LinkThroughAsk[] {
  const newest = new Map<string, OutboxEntry>();
  for (const entry of entries) {
    if (entry.route !== LINK_THROUGH_ASK_ROUTE || typeof entry.body.with !== "string") continue;
    const kept = newest.get(entry.body.with);
    if (!kept || entry.n > kept.n) newest.set(entry.body.with, entry);
  }
  const asks: LinkThroughAsk[] = [];
  for (const [withId, entry] of newest) {
    if (entry.state === "queued" || entry.state === "sending") asks.push({ via: via.id, with: withId, why: null });
    else if (entry.state === "refused") {
      const words = linkThroughText((entry.answer as { error?: unknown } | null)?.error, 300);
      asks.push({ via: via.id, with: withId, why: words || `${via.name} answered ${entry.status ?? "with a refusal"}.` });
    } else if (entry.state === "parked" || entry.state === "dropped") {
      // Given up on, or its link went: the outbox's own words for it (outboxLine in packages/inbox/machines.ts), and Link again.
      const mayHave = entry.state === "parked" || entry.notice?.kind === "may_have_been_delivered" || entry.left;
      asks.push({ via: via.id, with: withId, why: mayHave ? `May have been delivered. Check on ${via.name}.` : `${via.name} was unlinked before it went.` });
    }
  }
  return asks;
}

const newIntro = () => `lt_${randomBytes(16).toString("hex")}`;
const pairOf = (job: { a: string; c: string }, x: string, y: string) => (job.a === x && job.c === y) || (job.a === y && job.c === x);

export function createLinkThrough(context: LinkThroughContext) {
  const now = context.now ?? Date.now;
  const path = join(inboxDir(context.dataDir), FILE);
  let file: ThroughFile = { v: 1, jobs: [] };
  if (existsSync(path)) {
    try {
      const read = JSON.parse(readFileSync(path, "utf8")) as Partial<ThroughFile>;
      file = { v: 1, jobs: Array.isArray(read.jobs) ? read.jobs.filter(isJob) : [] };
    } catch {
      const aside = `${path}.unreadable-${now()}`;
      renameSync(path, aside);
      console.error(`Plannotator Inbox: ${path} could not be read; moved to ${aside}.`);
    }
  }
  // A job mid-way when this Inbox stopped tries again.
  for (const job of file.jobs) if (job.state === "linking") job.state = "waiting";
  /** The introductions each broker sent that were taken here, oldest first. In memory only (SEEN_PER_BROKER). */
  const seenBy = new Map<string, Map<string, number>>();
  const sandbox = !!(context.env ?? process.env).PLANNOTATOR_TEST_SANDBOX;
  let running = false;
  let again = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const save = () => {
    const dir = inboxDir(context.dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  };

  const peer = (id: string) => context.peers().find((p) => p.id === id) ?? null;
  const takes = (p: LinkThroughPeer | null): p is LinkThroughPeer => !!p && p.marks.includes(LINK_THROUGH_MARK) && p.wire !== null;
  /** Either of the two names the other as linked: the job is done, whoever made the link. */
  const linkedTogether = (a: LinkThroughPeer | null, c: LinkThroughPeer | null) => !!a && !!c && (!!a.wire?.links.some((l) => l.id === c.id) || !!c.wire?.links.some((l) => l.id === a.id));

  /** Jobs whose computer is no longer linked here go; so do those whose two are linked now. */
  const settle = (): boolean => {
    const before = file.jobs.length;
    file.jobs = file.jobs.filter((job) => {
      const a = peer(job.a);
      const c = peer(job.c);
      return !!a && !!c && !linkedTogether(a, c);
    });
    return file.jobs.length !== before;
  };

  /** The list's `link_through`, to a linked computer's token: this Inbox's links and its jobs. */
  const wire = (): LinkThroughWire => ({
    links: context.peers().map((p) => ({ id: p.id, name: p.name, through: p.marks.includes(LINK_THROUGH_MARK), away: p.state !== "online" && p.state !== "connecting" })),
    pending: file.jobs.map(({ a, c, state, why }) => ({ a, c, state, why })),
  });

  const view = (): LinkThroughView => {
    const peers = context.peers();
    return { pairs: linkThroughPairs(peers, file.jobs), through: linkThroughRows(context.selfId(), peers, context.held()) };
  };

  // ── The broker ──

  /** Start (or start again) a job for two of this Inbox's links. */
  const startJob = (a: string, c: string, by: string): Job => {
    const existing = file.jobs.find((job) => pairOf(job, a, c));
    if (existing) {
      if (existing.state === "failed") Object.assign(existing, { state: "waiting", why: null, tries: 0, next: 0 });
      save();
      return existing;
    }
    const job: Job = { id: newIntro(), a, c, by, at: now(), state: "waiting", why: null, tries: 0, next: 0 };
    file.jobs.push(job);
    save();
    return job;
  };

  const tick = () => {
    if (running) {
      again = true;
      return;
    }
    if (settle()) {
      save();
      context.changed();
    }
    if (!file.jobs.some((job) => job.state === "waiting")) return;
    running = true;
    void run()
      .catch((error) => console.error(`Plannotator Inbox: linking two computers: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          tick();
        }
      });
  };

  const armRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const due = file.jobs.filter((job) => job.state === "waiting" && job.next > now()).map((job) => job.next);
    if (due.length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      tick();
    }, Math.min(...due) - now() + 10);
    (retryTimer as { unref?: () => void }).unref?.();
  };

  const run = async () => {
    for (const job of [...file.jobs]) {
      if (job.state !== "waiting" || job.next > now()) continue;
      const a = peer(job.a);
      const c = peer(job.c);
      if (!takes(a) || !takes(c) || a.state !== "online" || c.state !== "online") continue;
      job.state = "linking";
      save();
      context.changed();
      const outcome = await attempt(job, a, c);
      if (!file.jobs.includes(job)) continue;
      if (outcome.kind === "done") {
        await context.refresh([job.a, job.c]).catch(() => {});
        file.jobs = file.jobs.filter((j) => j !== job);
      } else if (outcome.kind === "failed") {
        Object.assign(job, { state: "failed", why: outcome.why });
      } else {
        job.tries += 1;
        if (job.tries >= TRIES) Object.assign(job, { state: "failed", why: outcome.why });
        else Object.assign(job, { state: "waiting", next: now() + RETRY_MS * 2 ** (job.tries - 1) });
      }
      save();
      context.changed();
    }
    armRetry();
  };

  type Outcome = { kind: "done" } | { kind: "failed"; why: string } | { kind: "again"; why: string };

  const answerOf = async (response: Response): Promise<{ status: number; body: Record<string, unknown> }> => ({
    status: response.status,
    body: ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
  });
  const refusal = (answer: { status: number; body: Record<string, unknown> }, name: string): Outcome => {
    const why = linkThroughText(answer.body.error, 300) || `${name} answered ${answer.status}.`;
    // An older Inbox's door does not know the route; a 4xx is that computer's word; anything else may pass.
    if (answer.status === 404) return { kind: "failed", why: `Update Plannotator on ${name} to link it this way.` };
    return answer.status >= 400 && answer.status < 500 ? { kind: "failed", why } : { kind: "again", why };
  };

  /** One introduction: a link code from `c`, handed to `a`. The code lives in this function only. */
  const attempt = async (job: Job, a: LinkThroughPeer, c: LinkThroughPeer): Promise<Outcome> => {
    const intro = newIntro();
    let offered: { status: number; body: Record<string, unknown> };
    try {
      offered = await answerOf(await context.request(c.id, LINK_THROUGH_OFFER_ROUTE, { intro, for: { id: a.id, name: a.name } }, OFFER_MS));
    } catch {
      return { kind: "again", why: `${c.name} did not answer.` };
    }
    if (offered.status === 409 && offered.body.code === "already_linked") return { kind: "done" };
    if (offered.status !== 200) return refusal(offered, c.name);
    const code = typeof offered.body.link === "string" ? offered.body.link : "";
    if (parseLinkOffer(code)?.id !== c.id) return { kind: "failed", why: `${c.name} did not give a link code for itself.` };
    let taken: { status: number; body: Record<string, unknown> };
    try {
      taken = await answerOf(
        // Where this Inbox reaches each, for two Inboxes on one computer in a test only: the taker takes it nowhere else.
        await context.request(a.id, LINK_THROUGH_INTRODUCE_ROUTE, { intro, link: code, with: { id: c.id, name: c.name }, ...(sandbox ? { address: c.url, back: a.url } : {}) }, INTRODUCE_MS),
      );
    } catch {
      return { kind: "again", why: `${a.name} did not answer.` };
    }
    if (taken.status === 200 || taken.status === 201) return { kind: "done" };
    return refusal(taken, a.name);
  };

  // ── The door routes (a linked computer's token; `from` is the computer it belongs to) ──

  /**
   * An introduction's id: taken once from its broker. Null when it may be taken. No time is compared: the code it
   * opens or carries lives two minutes on its maker's clock, so two computers whose clocks disagree still link.
   */
  const introRefusal = (from: string, body: Record<string, unknown>): LinkThroughAnswer | null => {
    const intro = typeof body.intro === "string" ? body.intro : "";
    if (!INTRO_ID.test(intro)) return { status: 422, body: { error: "intro: an introduction's id.", code: "validation_error" } };
    if (seenBy.get(from)?.has(intro)) return { status: 409, body: { error: "This introduction was already used.", code: "introduction_used" } };
    return null;
  };
  const seen = (from: string, body: Record<string, unknown>) => {
    const kept = seenBy.get(from) ?? new Map<string, number>();
    const cut = now() - SEEN_KEPT_MS;
    for (const [intro, at] of kept) if (at < cut) kept.delete(intro);
    kept.set(String(body.intro), now());
    // The oldest first out (a Map keeps the order they were taken).
    while (kept.size > SEEN_PER_BROKER) kept.delete(kept.keys().next().value!);
    seenBy.set(from, kept);
  };
  /** The broker names `other` as one of its links, as its list says (read once more when it does not). */
  const brokerNames = async (broker: string, other: string): Promise<boolean> => {
    const named = () => !!peer(broker)?.wire?.links.some((l) => l.id === other);
    if (!named()) await context.refresh([broker]).catch(() => {});
    return named();
  };
  const otherId = (value: unknown): string | null => {
    const id = value && typeof value === "object" ? (value as { id?: unknown }).id : null;
    return isInboxId("ibx", id) ? id : null;
  };

  /** Laptop asks this Inbox (Studio) to link it with `with`, one of Studio's links. */
  const asked = (from: string | null, window: boolean, body: Record<string, unknown>): LinkThroughAnswer => {
    if (!from) return { status: 404, body: { error: "Not found", code: "not_found" } };
    if (!window) return { status: 403, body: { ...LINK_THROUGH_WINDOW_ONLY } };
    const withId = isInboxId("ibx", body.with) ? body.with : null;
    if (!withId || withId === from || withId === context.selfId()) return { status: 422, body: { error: "with: one of this computer's links.", code: "validation_error" } };
    const c = peer(withId);
    if (!c) return { status: 404, body: { error: "That computer is not linked here.", code: "machine_not_linked" } };
    if (linkedTogether(peer(from), c)) return { status: 200, body: { linked: true } };
    const job = startJob(from, withId, from);
    context.changed();
    queueMicrotask(tick);
    return { status: 200, body: { job: { a: job.a, c: job.c, state: job.state } } };
  };

  /** Studio asks this Inbox (Mini) for a link code for `for`, another of Studio's links. */
  const offerFor = async (from: string | null, window: boolean, body: Record<string, unknown>): Promise<LinkThroughAnswer> => {
    if (!from) return { status: 404, body: { error: "Not found", code: "not_found" } };
    if (!window) return { status: 403, body: { ...LINK_THROUGH_WINDOW_ONLY } };
    const used = introRefusal(from, body);
    if (used) return used;
    const forId = otherId(body.for);
    if (!forId || forId === context.selfId() || forId === from) return { status: 422, body: { error: "for: another computer.", code: "validation_error" } };
    // Taken before anything is awaited, so two copies arriving together cannot both pass.
    seen(from, body);
    if (peer(forId)) return { status: 409, body: { error: "Already linked.", code: "already_linked" } };
    if (!(await brokerNames(from, forId))) return { status: 409, body: { error: "That computer is not linked to the one introducing it.", code: "not_linked_there" } };
    // Bound on the door's own offer, for `forId` alone, and dropped if `from` is unlinked before it completes.
    return { status: 200, body: { link: context.introOffer(forId, from).link } };
  };

  /** Studio hands this Inbox (Laptop) `with`'s link code: link, as a person pasting it would. */
  const introduce = async (from: string | null, window: boolean, body: Record<string, unknown>): Promise<LinkThroughAnswer> => {
    if (!from) return { status: 404, body: { error: "Not found", code: "not_found" } };
    if (!window) return { status: 403, body: { ...LINK_THROUGH_WINDOW_ONLY } };
    const used = introRefusal(from, body);
    if (used) return used;
    const withId = otherId(body.with);
    const parsed = typeof body.link === "string" ? parseLinkOffer(body.link) : null;
    if (!withId || withId === context.selfId() || withId === from || !parsed?.secret || parsed.id !== withId) {
      return { status: 422, body: { error: "link: that computer's own link code.", code: "validation_error" } };
    }
    // Taken before anything is awaited, so two copies arriving together cannot both pass.
    seen(from, body);
    if (peer(withId)) return { status: 200, body: { linked: true } };
    if (!(await brokerNames(from, withId))) return { status: 409, body: { error: "That computer is not linked to the one introducing it.", code: "not_linked_there" } };
    // An address from the broker is taken only inside a test sandbox (two Inboxes on one computer), as loopback is
    // (inbox-transport-tailnet.ts): anywhere else the code's own tailnet address, and this Inbox's own way back.
    const address = !sandbox || parsed.tailnet ? undefined : typeof body.address === "string" ? body.address : undefined;
    const back = !sandbox || context.ownAddress() ? undefined : typeof body.back === "string" ? body.back : undefined;
    try {
      await context.link({ link: body.link as string, ...(address ? { address } : {}), ...(back ? { back } : {}) });
    } catch (error) {
      if (error instanceof InboxError) return { status: 409, body: { error: error.message, code: error.code } };
      throw error;
    }
    return { status: 201, body: { linked: true } };
  };

  // ── The window's routes ──

  /** On Studio: link two of its links. */
  const linkHere = (a: string, c: string): LinkThroughAnswer => {
    const x = peer(a);
    const y = peer(c);
    if (!x || !y || a === c) return { status: 404, body: { error: "Both computers must be linked to this one.", code: "machine_not_linked" } };
    const able = (p: LinkThroughPeer) => p.marks.includes(LINK_THROUGH_MARK) && p.wire !== null;
    const older = !able(x) ? x : !able(y) ? y : null;
    if (older) return { status: 409, body: { error: `Update Plannotator on ${older.name} to link it this way.`, code: "machine_needs_update" } };
    if (linkedTogether(x, y)) return { status: 200, body: { linked: true } };
    const job = startJob(a, c, "here");
    context.changed();
    queueMicrotask(tick);
    return { status: 200, body: { job: { a: job.a, c: job.c, state: job.state } } };
  };

  /** On Laptop: ask `via` to link it with `withId`. */
  const askVia = (via: string, withId: string): LinkThroughAnswer => {
    const p = peer(via);
    if (!p) return { status: 404, body: { error: "That computer is not linked.", code: "machine_not_linked" } };
    if (withId === context.selfId() || peer(withId)) return { status: 200, body: { linked: true } };
    if (!takes(p) || !p.wire!.links.some((l) => l.id === withId)) return { status: 404, body: { error: `That computer is not linked to ${p.name}.`, code: "not_linked_there" } };
    if (!context.held().some((ask) => ask.via === via && ask.with === withId && ask.why === null)) context.hold(via, { with: withId, idempotency_key: `link-through:${withId}:${newIntro()}` });
    context.changed();
    return { status: 200, body: { asked: true } };
  };

  return {
    wire,
    view,
    tick: () => queueMicrotask(tick),
    asked,
    offerFor,
    introduce,
    linkHere,
    askVia,
    /** `broker` is no longer linked: the introductions it sent are forgotten with it. */
    forgetBroker: (broker: string) => {
      seenBy.delete(broker);
    },
    stop: () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}

export type InboxLinkThrough = ReturnType<typeof createLinkThrough>;

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<Job>;
  return (
    typeof job.id === "string" &&
    isInboxId("ibx", job.a) &&
    isInboxId("ibx", job.c) &&
    (job.state === "waiting" || job.state === "linking" || job.state === "failed") &&
    typeof job.by === "string" &&
    typeof job.at === "number" &&
    typeof job.tries === "number" &&
    typeof job.next === "number"
  );
}

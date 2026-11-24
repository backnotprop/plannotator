/**
 * Link two of the person's computers through a third (docs/agent-guides/inbox-machines.md, "Link two computers
 * through a third"; shapes and detection in core inbox-link-through.ts). Mark `link-through`.
 *
 * Three roles, each a door route only a linked computer's token reaches (`DOOR_OWN_ROUTES` in inbox-devices.ts):
 *  - the broker (Studio, linked to both) keeps a job per pair the person clicked Link for, here or on one of the two
 *    (`link-through-ask`, held in that computer's outbox while Studio is away). Once both are online it asks one for
 *    a link code (`link-through-offer`) and hands it to the other (`link-through-introduce`). The code is held in
 *    memory for that one request: nothing of it is written here, and the tokens the two then mint never pass here.
 *  - the code's maker (Mini) opens an ordinary machine offer, as Show link code does, and remembers which computer it
 *    is for: the link-back that completes it must come from that computer (`linkBackRefusal`).
 *  - the taker (Laptop) runs the ordinary link with that code (`link` in inbox-machines.ts): it redeems it at Mini's
 *    door, checks Mini's health answers with Mini's id, and links back with a code of its own. The result is the link
 *    a person makes by hand.
 *
 * Every one of the three is refused without the mark of a press in a window there (`X-Plannotator-Window`), and an
 * introduction (`intro`) is taken once, and only while it is fresh. Jobs and the introductions seen are kept in
 * `inbox/link-through.json` (0600, temp file then rename).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LINK_THROUGH_MARK, linkThroughPairs, linkThroughRows, linkThroughText, type LinkThroughPeerFacts, type LinkThroughView, type LinkThroughWire, type LinkThroughWireJob } from "@plannotator/core/inbox-link-through";
import { isInboxId } from "@plannotator/core/inbox-types";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { parseLinkOffer } from "./inbox-links";

/** Laptop → Studio: link me with that computer of yours. */
export const LINK_THROUGH_ASK_ROUTE = "link-through-ask";
/** Studio → Mini: a link code for that computer of mine. */
export const LINK_THROUGH_OFFER_ROUTE = "link-through-offer";
/** Studio → Laptop: here is that computer's link code; link. */
export const LINK_THROUGH_INTRODUCE_ROUTE = "link-through-introduce";
/** This Inbox's own writes: the forward never carries them. */
export const LINK_THROUGH_ROUTES: ReadonlySet<string> = new Set([LINK_THROUGH_ASK_ROUTE, LINK_THROUGH_OFFER_ROUTE, LINK_THROUGH_INTRODUCE_ROUTE]);

/** An introduction is taken only this long either side of its making, by the taker's clock (a link code lives 10 minutes). */
export const LINK_THROUGH_FRESH_MS = 15 * 60_000;
/** Introductions seen are kept this long, so a replay is refused across a restart. */
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
  seen: Record<string, number>;
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
  /** This Inbox's asks still held, by computer. */
  held: () => { via: string; with: string }[];
  /** The ordinary link (inbox-machines.ts `link`): redeem a code, link back. */
  link: (input: { link: string; address?: string; back?: string }) => Promise<unknown>;
  /** Open an ordinary machine offer here (Show link code's), and its link code. */
  offer: () => { link: string; expires_at: string };
  /** This Inbox's door on the tailnet, or null. */
  ownAddress: () => string | null;
  /** The device a machine offer was redeemed for, once it was. */
  offerDevice: (secret: string) => string | null;
  /** Read these links' lists again (after a link: their `link_through` moved). */
  refresh: (ids: string[]) => Promise<void>;
  /** The rows changed: the windows and the links hear it. */
  changed: () => void;
  now?: () => number;
}

const newIntro = () => `lt_${randomBytes(16).toString("hex")}`;
const pairOf = (job: { a: string; c: string }, x: string, y: string) => (job.a === x && job.c === y) || (job.a === y && job.c === x);

export function createLinkThrough(context: LinkThroughContext) {
  const now = context.now ?? Date.now;
  const path = join(inboxDir(context.dataDir), FILE);
  let file: ThroughFile = { v: 1, jobs: [], seen: {} };
  if (existsSync(path)) {
    try {
      const read = JSON.parse(readFileSync(path, "utf8")) as Partial<ThroughFile>;
      file = { v: 1, jobs: Array.isArray(read.jobs) ? read.jobs.filter(isJob) : [], seen: read.seen && typeof read.seen === "object" ? { ...read.seen } : {} };
    } catch {
      const aside = `${path}.unreadable-${now()}`;
      renameSync(path, aside);
      console.error(`Plannotator Inbox: ${path} could not be read; moved to ${aside}.`);
    }
  }
  // A job mid-way when this Inbox stopped tries again.
  for (const job of file.jobs) if (job.state === "linking") job.state = "waiting";
  /** Link codes this Inbox made for an introduction: the computer each is for, until it expires. In memory only. */
  const offersFor = new Map<string, { for: string; until: number }>();
  let running = false;
  let again = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const save = () => {
    const cut = now() - SEEN_KEPT_MS;
    for (const [intro, at] of Object.entries(file.seen)) if (typeof at !== "number" || at < cut) delete file.seen[intro];
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
    const at = new Date(now()).toISOString();
    let offered: { status: number; body: Record<string, unknown> };
    try {
      offered = await answerOf(await context.request(c.id, LINK_THROUGH_OFFER_ROUTE, { intro, at, for: { id: a.id, name: a.name } }, OFFER_MS));
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
        await context.request(a.id, LINK_THROUGH_INTRODUCE_ROUTE, { intro, at, link: code, with: { id: c.id, name: c.name }, address: c.url, back: a.url }, INTRODUCE_MS),
      );
    } catch {
      return { kind: "again", why: `${a.name} did not answer.` };
    }
    if (taken.status === 200 || taken.status === 201) return { kind: "done" };
    return refusal(taken, a.name);
  };

  // ── The door routes (a linked computer's token; `from` is the computer it belongs to) ──

  /** An introduction's id and time: taken once, and only while fresh. Null when it may be taken. */
  const introRefusal = (body: Record<string, unknown>): LinkThroughAnswer | null => {
    const intro = typeof body.intro === "string" ? body.intro : "";
    if (!INTRO_ID.test(intro)) return { status: 422, body: { error: "intro: an introduction's id.", code: "validation_error" } };
    if (file.seen[intro] !== undefined) return { status: 409, body: { error: "This introduction was already used.", code: "introduction_used" } };
    const at = typeof body.at === "string" ? Date.parse(body.at) : NaN;
    if (!Number.isFinite(at) || Math.abs(now() - at) > LINK_THROUGH_FRESH_MS) {
      return { status: 409, body: { error: "This introduction is too old. Click Link again.", code: "introduction_stale" } };
    }
    return null;
  };
  const seen = (body: Record<string, unknown>) => {
    file.seen[String(body.intro)] = now();
    save();
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
    const stale = introRefusal(body);
    if (stale) return stale;
    const forId = otherId(body.for);
    if (!forId || forId === context.selfId() || forId === from) return { status: 422, body: { error: "for: another computer.", code: "validation_error" } };
    if (peer(forId)) {
      seen(body);
      return { status: 409, body: { error: "Already linked.", code: "already_linked" } };
    }
    if (!(await brokerNames(from, forId))) return { status: 409, body: { error: "That computer is not linked to the one introducing it.", code: "not_linked_there" } };
    seen(body);
    const opened = context.offer();
    const secret = parseLinkOffer(opened.link)?.secret;
    if (secret) offersFor.set(secret, { for: forId, until: Date.parse(opened.expires_at) || now() + LINK_THROUGH_FRESH_MS });
    return { status: 200, body: { link: opened.link } };
  };

  /** Studio hands this Inbox (Laptop) `with`'s link code: link, as a person pasting it would. */
  const introduce = async (from: string | null, window: boolean, body: Record<string, unknown>): Promise<LinkThroughAnswer> => {
    if (!from) return { status: 404, body: { error: "Not found", code: "not_found" } };
    if (!window) return { status: 403, body: { ...LINK_THROUGH_WINDOW_ONLY } };
    const stale = introRefusal(body);
    if (stale) return stale;
    const withId = otherId(body.with);
    const parsed = typeof body.link === "string" ? parseLinkOffer(body.link) : null;
    if (!withId || withId === context.selfId() || withId === from || !parsed?.secret || parsed.id !== withId) {
      return { status: 422, body: { error: "link: that computer's own link code.", code: "validation_error" } };
    }
    if (peer(withId)) {
      seen(body);
      return { status: 200, body: { linked: true } };
    }
    if (!(await brokerNames(from, withId))) return { status: 409, body: { error: "That computer is not linked to the one introducing it.", code: "not_linked_there" } };
    seen(body);
    const address = parsed.tailnet ? undefined : typeof body.address === "string" ? body.address : undefined;
    const back = context.ownAddress() ? undefined : typeof body.back === "string" ? body.back : undefined;
    try {
      await context.link({ link: body.link as string, ...(address ? { address } : {}), ...(back ? { back } : {}) });
    } catch (error) {
      if (error instanceof InboxError) return { status: 409, body: { error: error.message, code: error.code } };
      throw error;
    }
    return { status: 201, body: { linked: true } };
  };

  /**
   * Mini's check of a link-back on a device a link code made for an introduction: it must come from the computer the
   * code was for. Null: take it (a code from Show link code, or the right computer).
   */
  const linkBackRefusal = (deviceId: string, offeredId: string | null): string | null => {
    for (const [secret, entry] of offersFor) {
      if (entry.until < now() - 60_000) {
        offersFor.delete(secret);
        continue;
      }
      if (context.offerDevice(secret) !== deviceId) continue;
      offersFor.delete(secret);
      return offeredId === entry.for ? null : "This link code was made for another computer.";
    }
    return null;
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
    if (!context.held().some((ask) => ask.via === via && ask.with === withId)) context.hold(via, { with: withId, idempotency_key: `link-through:${withId}:${newIntro()}` });
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
    linkBackRefusal,
    linkHere,
    askVia,
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

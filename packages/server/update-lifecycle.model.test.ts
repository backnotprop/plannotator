/**
 * Model-based tests of the update and "What's new" lifecycle: the model of
 * spec/update-lifecycle.qnt (in TypeScript, the same state and the same
 * rules, cited there by file:line) next to the REAL code, driven through the
 * same actions by fast-check (`fc.commands`):
 *
 *   - the Inbox's update control (createInboxUpdates, inbox-updates.ts) with an
 *     injected clock, its health tick called by the test, and its binary probe
 *     reading a file in the sandbox that installs replace by rename;
 *   - the release check, the notes fetch and the lock (update-check.ts,
 *     auto-update.ts), on a sandboxed data dir;
 *   - a fake GitHub on loopback (the "latest release" redirect and the
 *     releases API), whose release body changes from GitHub's generated one to
 *     the written notes, and which goes offline on command;
 *   - a fake installer that does what the detached wrapper does to the data
 *     dir (its lock line naming a real process group, the result file, the
 *     lock's removal) and replaces the "binary" by rename; never install.sh,
 *     never a release binary.
 *
 * After every action the real button, the real "What's new" link and the
 * requests GitHub saw must equal the model's, and the safety properties that
 * hold on main are checked on the real code. The properties the code breaks
 * today are `test.todo`, each named after its finding in the PR #2338
 * description; `bun test --todo` runs them (a todo that passes fails, saying
 * the bug is fixed).
 *
 * F1 (the 0.28.37 bug) is fixed by PR #2337, and F2-F4 by the PR after it
 * (the spec's WHATS_NEW_FIX), so their tests are ordinary tests. The model
 * reads which #2337 rules the code under test has
 * (RELEASE_NOTES_PENDING_RETRY_MS) and follows them; the F2-F4 rules it
 * always follows.
 *
 * Runs: PLANNOTATOR_MODEL_RUNS (default 100 per property).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { saveConfig } from "@plannotator/shared/config";
import * as updateCheck from "@plannotator/shared/update-check";
import {
  fetchLatestFromPage,
  fetchLatestRelease,
  fetchReleaseByTag,
  fetchReleaseNotesFor,
  forgetUnwrittenUpdateStateForTests,
  readUpdateState,
  runReleaseCheck,
  type FetchReleaseResult,
} from "@plannotator/shared/update-check";
import { acquireUpdateLock, autoUpdatePaths, startManualUpdate, thisLockMachine, type InstallerLaunch } from "./auto-update";
import { createInboxUpdates, INBOX_UPDATING_TICK_MS, type InboxUpdates } from "./inbox-updates";

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const RUNS = Number(process.env.PLANNOTATOR_MODEL_RUNS) || 100;
/** PR #2337's young-release retry, when the code under test has it. */
const NOTES_FIX = "RELEASE_NOTES_PENDING_RETRY_MS" in updateCheck;
const NOTES_PENDING_RETRY = 15;
const NOTES_YOUNG = 2 * 24 * 60;

const ver = (v: number) => `0.30.${v}`;

// ---------------------------------------------------------------------------
// The model (spec/update-lifecycle.qnt, the parts these actions reach)
// ---------------------------------------------------------------------------

type Phase = "spawned" | "locked" | "downloaded" | "replaced" | "done" | "dead";
interface ModelInstaller {
  v: number;
  person: boolean;
  phase: Phase;
  at: number; // started (minutes)
}
interface Model {
  now: number; // minutes
  published: number;
  pubAt: Record<number, number>;
  body: Record<number, "generated" | "ours">;
  oursAt: Record<number, number>;
  netUp: boolean;
  netEverDown: boolean;
  netDowns: number;
  netBackAt: number;
  checksOn: boolean;
  checksOnSince: number;
  latest: number;
  latestAt: number;
  rcAt: number;
  rcFailed: boolean;
  notes: Record<number, "none" | "empty" | "content">;
  /** notesFetch; `quick`: a failure's retryOnline (15 minutes once a release check answered after it). */
  nf: Record<number, { at: number; failed: boolean; pub: number; quick?: boolean }>;
  inboxVer: number;
  /** whatsNewPending (0: none). */
  wnPending: number;
  pendingV: number;
  pendingPerson: boolean;
  resultV: number;
  resultCode: number;
  lock: { kind: "bare" | "wrapper"; at: number; owner: number } | null;
  binV: number;
  ib: { alive: boolean; runs: number; updated: number; onDisk: number; startedAt: number; lastTick: number };
  inst: ModelInstaller[];
  pageRequests: number;
  tagRequests: Record<number, number>;
}

const isRunning = (i: ModelInstaller) => i.phase === "spawned" || i.phase === "locked" || i.phase === "downloaded" || i.phase === "replaced";

function initialModel(): Model {
  return {
    now: 0,
    published: 1,
    pubAt: { 1: 0 },
    body: { 1: "ours" },
    oursAt: { 1: 0 },
    netUp: true,
    netEverDown: false,
    netDowns: 0,
    netBackAt: 0,
    checksOn: true,
    checksOnSince: 0,
    latest: 0,
    latestAt: -1,
    rcAt: -1,
    rcFailed: false,
    notes: {},
    nf: {},
    inboxVer: 1,
    wnPending: 0,
    pendingV: 0,
    pendingPerson: false,
    resultV: 0,
    resultCode: 0,
    lock: null,
    binV: 1,
    ib: { alive: false, runs: 0, updated: 0, onDisk: 0, startedAt: 0, lastTick: -1 },
    inst: [],
    pageRequests: 0,
    tagRequests: {},
  };
}

const DAY = 24 * 60;
const lockExpired = (m: Model) => !!m.lock && (m.now - m.lock.at >= 60 || m.lock.at - m.now >= 60);
const holderGone = (m: Model) => !!m.lock && m.lock.kind === "wrapper" && !isRunning(m.inst[m.lock.owner]!);
// A wrapper lock whose install still runs holds past the hour, up to a day (AUTO_UPDATE_LOCK_LIVE_MAX_MS).
const liveLock = (m: Model) =>
  !!m.lock && m.lock.kind === "wrapper" && isRunning(m.inst[m.lock.owner]!) && Math.abs(m.now - m.lock.at) < DAY;
const lockHeldView = (m: Model) => !!m.lock && !holderGone(m) && (!lockExpired(m) || liveLock(m));
const canAcquire = (m: Model) => !lockHeldView(m);

function uiState(m: Model): string {
  if (!m.ib.alive) return "none";
  if (m.ib.onDisk && m.ib.onDisk !== m.ib.runs) return "ready";
  if (lockHeldView(m)) return "updating";
  if (m.pendingPerson && m.pendingV > m.ib.runs && m.resultV === m.pendingV && m.resultCode !== 0) return "failed";
  if (!m.checksOn || !m.latest || m.latest <= m.ib.runs) return "none";
  return "available";
}

function checkDue(m: Model, fresh: number): boolean {
  if (m.latest > 0 && m.latestAt <= m.now && m.now - m.latestAt < fresh) return false;
  if (m.rcAt < 0 || m.rcAt > m.now) return true;
  return m.now - m.rcAt >= (m.rcFailed ? 10 : Math.min(fresh, 10));
}

function releaseCheck(m: Model, fresh: number, force: boolean): void {
  if (!force && (!m.checksOn || !checkDue(m, fresh))) return;
  if (m.netUp) {
    m.pageRequests++;
    m.latest = m.published;
    m.latestAt = m.now;
    m.rcAt = m.now;
    m.rcFailed = false;
  } else {
    m.rcAt = m.now;
    m.rcFailed = true;
  }
}

const young = (r: { pub: number }, now: number) => r.pub >= 0 && Math.abs(now - r.pub) < NOTES_YOUNG;

function notesDue(m: Model, v: number): boolean {
  const r = m.nf[v];
  if (!r || r.at > m.now) return true;
  if (r.failed) return m.now - r.at >= (r.quick && m.latestAt > r.at ? NOTES_PENDING_RETRY : 360);
  return m.now - r.at >= (NOTES_FIX && young(r, m.now) ? NOTES_PENDING_RETRY : 1440);
}

const fetchable = (m: Model, v: number) => v === m.ib.runs || v === m.latest || v === m.ib.onDisk || v === m.pendingV;

/** ensureNotes: claim, ask GitHub for the tag, save what it says (the tests settle every request). */
function ensureNotes(m: Model, v: number): void {
  if ((m.notes[v] ?? "none") === "content" || !m.checksOn || !fetchable(m, v) || !notesDue(m, v)) return;
  const prev = m.nf[v];
  const keep = NOTES_FIX && !!prev && !prev.failed && young(prev, m.now);
  m.nf[v] = { at: m.now, failed: false, pub: keep ? prev!.pub : -1 };
  if (!m.netUp || v > m.published) {
    if (m.netUp) m.tagRequests[v] = (m.tagRequests[v] ?? 0) + 1;
    // A failure retries 15 minutes after it once a release check answered, unless one answered between it and the failure before.
    m.nf[v] = { at: m.now, failed: true, pub: -1, quick: !(prev?.failed && m.latestAt > prev.at) };
    return;
  }
  m.tagRequests[v] = (m.tagRequests[v] ?? 0) + 1;
  if (m.body[v] === "ours") {
    m.notes[v] = "content";
    m.nf[v] = { at: m.now, failed: false, pub: -1 };
  } else {
    m.notes[v] = "empty";
    if (NOTES_FIX) m.nf[v] = { at: m.now, failed: false, pub: m.pubAt[v]! };
  }
}

function link(m: Model): number {
  const v = m.ib.updated;
  if (!m.ib.alive || !v) return 0;
  if (m.notes[v] === "content") return v;
  if (!m.checksOn) return 0;
  return notesDue(m, v) ? v : 0;
}

/** A lock that no longer holds (its holder gone, or past its hour) is released and the install recorded failed. */
function reap(m: Model): void {
  if (!m.lock || lockHeldView(m)) return;
  m.lock = null;
  if (m.pendingV && m.resultV !== m.pendingV) {
    m.resultV = m.pendingV;
    m.resultCode = -1;
  }
}

function tick(m: Model, fresh: number): void {
  m.ib.onDisk = m.binV;
  releaseCheck(m, fresh, false);
  if (m.latest > m.ib.runs && m.notes[m.latest] !== "content") ensureNotes(m, m.latest);
  if (m.ib.updated && m.notes[m.ib.updated] !== "content") ensureNotes(m, m.ib.updated);
  m.ib.lastTick = m.now;
  // The link offered with readable notes: a later start on this version no longer shows it.
  if (m.ib.updated && m.notes[m.ib.updated] === "content" && m.wnPending === m.ib.updated) m.wnPending = 0;
}

function startInbox(m: Model): void {
  const runs = m.binV;
  const newer = m.inboxVer > 0 && runs > m.inboxVer;
  const owed = newer || (m.inboxVer === runs && m.wnPending === runs);
  if (newer) m.wnPending = runs;
  m.ib = { alive: true, runs, updated: owed ? runs : 0, onDisk: runs, startedAt: m.now, lastTick: m.now };
  m.inboxVer = runs;
  tick(m, 1);
}

function launch(m: Model, v: number, person: boolean): boolean {
  if (!canAcquire(m)) return false;
  m.inst.push({ v, person, phase: "spawned", at: m.now });
  // launchInstaller names the spawned wrapper in the lock at once.
  m.lock = { kind: "wrapper", at: m.now, owner: m.inst.length - 1 };
  m.resultV = 0;
  m.resultCode = 0;
  m.pendingV = v;
  m.pendingPerson = person;
  return true;
}

function finishModel(m: Model, index: number, code: number): void {
  const ins = m.inst[index]!;
  ins.phase = "done";
  m.resultV = ins.v;
  m.resultCode = code;
  // The wrapper removes the lock only while it is still its own.
  if (m.lock?.owner === index) m.lock = null;
}

// ---------------------------------------------------------------------------
// The real world: a sandboxed data dir, a fake GitHub, the real Inbox control
// ---------------------------------------------------------------------------

interface Real {
  dataDir: string;
  binary: string;
  clock: number;
  gh: ReturnType<typeof Bun.serve>;
  github: { published: number; body: Record<number, string>; pubAt: Record<number, number>; netUp: boolean };
  pageRequests: number;
  tagRequests: Record<number, number>;
  inflight: number;
  updates: InboxUpdates | null;
  tickNow: (() => void) | null;
  launches: InstallerLaunch[];
  holders: (ChildProcess | null)[];
  /** Automatic requests (page or tag) made while update checks were off. */
  offRequests: number;
  /** Check now is running: the person's own request, not an automatic one. */
  explicit: boolean;
  checksOn: boolean;
  pageTimes: number[];
  tagTimes: Record<number, number[]>;
}

const NOTES = (v: number) => `## What's New in v${ver(v)}\n\nWhat ${ver(v)} brings.\n\n## Install / Update\n\ncurl ...\n`;
const GENERATED = "## What's Changed\n\n* a PR by someone in #1\n";

function startGitHub(real: Real) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/backnotprop/plannotator/releases/latest") {
        real.pageRequests++;
        if (!real.explicit) real.pageTimes.push(real.clock);
        if (!real.checksOn && !real.explicit) real.offRequests++;
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${real.gh.port}/backnotprop/plannotator/releases/tag/v${ver(real.github.published)}` },
        });
      }
      const tag = /^\/api\/repos\/backnotprop\/plannotator\/releases\/tags\/v0\.30\.(\d+)$/.exec(path);
      if (tag) {
        const v = Number(tag[1]);
        real.tagRequests[v] = (real.tagRequests[v] ?? 0) + 1;
        (real.tagTimes[v] ??= []).push(real.clock);
        if (!real.checksOn) real.offRequests++;
        if (v > real.github.published) return Response.json({ message: "Not Found" }, { status: 404 });
        return Response.json({
          tag_name: `v${ver(v)}`,
          draft: false,
          prerelease: false,
          published_at: new Date(T0 + real.github.pubAt[v]! * MIN).toISOString(),
          body: real.github.body[v],
        });
      }
      // The API's latest (the fallback when the page fails): never reached while online.
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
}

/** The machine's network: offline throws before anything leaves; only loopback is ever reached. */
function netFetch(real: Real): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (!real.github.netUp) throw new TypeError("fetch failed: offline");
    const url = String(input instanceof Request ? input.url : input).replace("https://api.github.com/repos/", `http://127.0.0.1:${real.gh.port}/api/repos/`);
    if (!url.startsWith(`http://127.0.0.1:${real.gh.port}/`)) throw new Error(`the test never leaves loopback: ${url}`);
    return fetch(url, init);
  }) as typeof fetch;
}

function track<T>(real: Real, job: Promise<T>): Promise<T> {
  real.inflight++;
  return job.finally(() => {
    real.inflight--;
  });
}

const sources = (real: Real) => ({
  fetchReleasePage: (): Promise<FetchReleaseResult> =>
    track(real, fetchLatestFromPage(`http://127.0.0.1:${real.gh.port}/backnotprop/plannotator/releases/latest`, netFetch(real))),
  fetchRelease: (): Promise<FetchReleaseResult> =>
    track(real, fetchLatestRelease(`http://127.0.0.1:${real.gh.port}/api/repos/backnotprop/plannotator/releases/latest`, netFetch(real))),
});

/** Wait until every request the real code started has answered and its follow-ups ran. */
async function settle(real: Real): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (let quiet = 0; quiet < 4 && Date.now() < deadline; ) {
    await new Promise((resolve) => setImmediate(resolve));
    quiet = real.inflight === 0 ? quiet + 1 : 0;
  }
  if (real.inflight !== 0) throw new Error("a request never answered");
}

function writeBinary(real: Real, v: number): void {
  // Like install.sh: staged beside the target, then one rename (a new inode, so the probe runs again).
  const staged = `${real.binary}.new.${process.pid}`;
  writeFileSync(staged, `plannotator ${ver(v)}\n`);
  renameSync(staged, real.binary);
}

function startReal(real: Real): void {
  const updates = createInboxUpdates({
    dataDir: real.dataDir,
    version: ver(Number(/0\.30\.(\d+)/.exec(readFileSync(real.binary, "utf-8"))![1])),
    binaryPath: real.binary,
    healthTickMs: 60_000,
    now: () => real.clock,
    ...sources(real),
    fetchReleaseTag: (v) => track(real, fetchReleaseByTag(v, netFetch(real))),
    // Release images too: every request stays on loopback (the fake notes have none today).
    fetchImage: ((input: string | URL | Request, init?: RequestInit) => track(real, netFetch(real)(input, init))) as typeof fetch,
    isManaged: () => true,
    listSessions: () => [],
    probeVersion: async (path) => /^plannotator\s+(\S+)/.exec(readFileSync(path, "utf-8"))?.[1] ?? null,
    launchInstaller: fakeLaunch(real),
    onChange: () => {},
  });
  // The health tick is called by the test (an Advance), never by a timer.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void) => {
    real.tickNow = fn;
    return realSetInterval(() => {}, 2 ** 30);
  }) as typeof setInterval;
  try {
    updates.start();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  real.updates = updates;
}

function stopReal(real: Real): void {
  real.updates?.stop();
  real.updates = null;
  real.tickNow = null;
}

/**
 * Move the lock's mtime back by `minutes` (its checks read the wall clock).
 * A file's mtime has sub-millisecond precision and can be up to 1 ms ahead
 * of Date.now() (whole milliseconds), so a lock aged exactly to the model's
 * 60 minutes could still read as 59:59.999 when the check runs within that
 * millisecond: count the age from no later than now, never from ahead of it.
 */
function ageLock(real: Real, minutes: number): void {
  const lock = autoUpdatePaths(real.dataDir).lock;
  if (!existsSync(lock)) return;
  const at = Math.min(statSync(lock).mtimeMs, Date.now()) - minutes * MIN;
  utimesSync(lock, at / 1000, at / 1000);
}

function holderLine(pid: number): string {
  const m = thisLockMachine();
  return `pid=${pid} group=${pid} host=${m.host} boot=${m.boot} pidns=${m.pidns}\n`;
}

/** Write the holder's line into the lock, its mtime past the 5 s hand-off. */
function writeHolderLine(lock: string, holder: ChildProcess): void {
  writeFileSync(lock, holderLine(holder.pid!));
  const at = (Date.now() - 10_000) / 1000;
  utimesSync(lock, at, at);
}

/** launchInstaller's stand-in: a real process group in place of the wrapper, named in the lock right away as launchInstaller does. */
function fakeLaunch(real: Real): (launch: InstallerLaunch) => void {
  return (launch) => {
    real.launches.push(launch);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true }); // inbox-guard: own child
    real.holders.push(holder);
    writeHolderLine(launch.lockPath, holder);
  };
}

// ---------------------------------------------------------------------------
// The actions (each: the model's step, then the same step on the real code)
// ---------------------------------------------------------------------------

type World = { m: Model; r: Real };
type Cmd = fc.AsyncCommand<Model, Real>;

class Publish implements Cmd {
  check = (m: Model) => m.published < 3;
  async run(m: Model, r: Real) {
    const v = ++m.published;
    m.pubAt[v] = m.now;
    m.body[v] = "generated";
    r.github.published = v;
    r.github.pubAt[v] = m.now;
    r.github.body[v] = GENERATED;
  }
  toString = () => "Publish";
}

class WriteNotes implements Cmd {
  constructor(readonly v: number) {}
  check = (m: Model) => this.v <= m.published && m.body[this.v] === "generated";
  async run(m: Model, r: Real) {
    m.body[this.v] = "ours";
    m.oursAt[this.v] = m.now;
    r.github.body[this.v] = NOTES(this.v);
  }
  toString = () => `WriteNotes(${this.v})`;
}

class Advance implements Cmd {
  constructor(readonly minutes: number) {}
  // As in the spec: a spawned wrapper writes its lock line (its first command) before time moves on, or is killed.
  check = (m: Model) => !m.inst.some((i) => i.phase === "spawned");
  async run(m: Model, r: Real) {
    m.now += this.minutes;
    r.clock += this.minutes * MIN;
    ageLock(r, this.minutes);
    if (m.ib.alive) {
      tick(m, 10);
      r.tickNow!();
      await settle(r);
    }
  }
  toString = () => `Advance(${this.minutes}m)`;
}

class PageLoad implements Cmd {
  check = (m: Model) => m.ib.alive;
  async run(m: Model, r: Real) {
    tick(m, 1);
    r.updates!.nudge();
    await settle(r);
  }
  toString = () => "PageLoad";
}

class CheckNow implements Cmd {
  check = (m: Model) => m.ib.alive;
  async run(m: Model, r: Real) {
    releaseCheck(m, 10, true);
    r.explicit = true;
    try {
      await r.updates!.checkNow();
      await settle(r);
    } finally {
      r.explicit = false;
    }
  }
  toString = () => "CheckNow";
}

/** Another process's release check (a session start). */
class CliCheck implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    releaseCheck(m, 10, false);
    await runReleaseCheck({ dataDir: r.dataDir, now: () => r.clock, enabled: () => r.checksOn, ...sources(r) });
    await settle(r);
  }
  toString = () => "CliCheck";
}

class NetToggle implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    m.netUp = !m.netUp;
    if (!m.netUp) m.netEverDown = true;
    if (!m.netUp) m.netDowns++;
    else m.netBackAt = m.now;
    r.github.netUp = m.netUp;
  }
  toString = () => "NetToggle";
}

class ToggleChecks implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    m.checksOn = !m.checksOn;
    if (m.checksOn) m.checksOnSince = m.now;
    r.checksOn = m.checksOn;
    saveConfig({ updateCheck: m.checksOn });
  }
  toString = () => "ToggleChecks";
}

class UpdateNow implements Cmd {
  check = (m: Model) => m.ib.alive && (uiState(m) === "available" || uiState(m) === "failed") && m.latest > m.ib.runs;
  async run(m: Model, r: Real) {
    const launched = launch(m, m.latest, true);
    const outcome = r.updates!.updateNow();
    expect(outcome.outcome).toBe(launched ? "launched" : "locked");
  }
  toString = () => "UpdateNow";
}

/** The newest running install takes its next step, as the detached wrapper and install.sh do. */
class InstallerStep implements Cmd {
  constructor(readonly ok: boolean) {}
  check = (m: Model) => m.inst.some(isRunning);
  async run(m: Model, r: Real) {
    const index = m.inst.map(isRunning).lastIndexOf(true);
    const ins = m.inst[index]!;
    const lock = autoUpdatePaths(r.dataDir).lock;
    if (ins.phase === "spawned") {
      // The wrapper's first line: the same process group and machine launchInstaller wrote.
      ins.phase = "locked";
      m.lock = { kind: "wrapper", at: m.now, owner: index };
      writeHolderLine(lock, r.holders[index]!);
    } else if (ins.phase === "locked") {
      if (m.netUp) ins.phase = "downloaded";
      else await this.finish(m, r, index, 75);
    } else if (ins.phase === "downloaded") {
      ins.phase = "replaced";
      m.binV = ins.v;
      writeBinary(r, ins.v);
    } else if (ins.phase === "replaced") {
      await this.finish(m, r, index, this.ok ? 0 : 1);
    }
  }
  async finish(m: Model, r: Real, index: number, code: number) {
    const ins = m.inst[index]!;
    finishModel(m, index, code);
    const paths = autoUpdatePaths(r.dataDir);
    writeFileSync(`${paths.result}.tmp`, JSON.stringify({ version: `v${ver(ins.v)}`, exitCode: code }) + "\n");
    renameSync(`${paths.result}.tmp`, paths.result);
    // The wrapper's release_lock: only while the lock still names it.
    if (existsSync(paths.lock) && readFileSync(paths.lock, "utf-8") === holderLine(r.holders[index]!.pid!)) rmSync(paths.lock);
    await killHolder(r, index);
  }
  toString = () => `InstallerStep(${this.ok ? "ok" : "fails"})`;
}

/** SIGKILL of the install's whole process group, at any step. */
class KillInstaller implements Cmd {
  check = (m: Model) => m.inst.some(isRunning);
  async run(m: Model, r: Real) {
    const index = m.inst.map(isRunning).lastIndexOf(true);
    m.inst[index]!.phase = "dead";
    await killHolder(r, index);
  }
  toString = () => "KillInstaller";
}

class Restart implements Cmd {
  check = (m: Model) => m.ib.alive && uiState(m) === "ready";
  async run(m: Model, r: Real) {
    m.ib.alive = false;
    startInbox(m);
    stopReal(r);
    startReal(r);
    await settle(r);
  }
  toString = () => "Restart";
}

class QuitInbox implements Cmd {
  check = (m: Model) => m.ib.alive;
  async run(m: Model, r: Real) {
    m.ib.alive = false;
    stopReal(r);
  }
  toString = () => "QuitInbox";
}

class StartInbox implements Cmd {
  check = (m: Model) => !m.ib.alive;
  async run(m: Model, r: Real) {
    startInbox(m);
    startReal(r);
    await settle(r);
  }
  toString = () => "StartInbox";
}

async function killHolder(r: Real, index: number): Promise<void> {
  const holder = r.holders[index];
  if (!holder || holder.exitCode !== null || holder.signalCode !== null) return;
  const gone = new Promise((resolve) => holder.once("exit", resolve));
  holder.kill("SIGKILL"); // inbox-guard: own child
  await gone;
}

const MINUTES = [1, 5, 10, 15, 30, 60, 360, 1440];
// fc.commands picks uniformly among these: the ordinary flow (publish, tick,
// update, install, restart) is listed more than once so a run reaches it; the
// disruptions once each.
const anyCommand = [
  fc.constant(new Publish()),
  fc.integer({ min: 2, max: 3 }).map((v) => new WriteNotes(v)),
  fc.integer({ min: 2, max: 3 }).map((v) => new WriteNotes(v)),
  fc.constantFrom(...MINUTES).map((d) => new Advance(d)),
  fc.constantFrom(...MINUTES).map((d) => new Advance(d)),
  fc.constantFrom(...MINUTES).map((d) => new Advance(d)),
  fc.constant(new PageLoad()),
  fc.constant(new CheckNow()),
  fc.constant(new CliCheck()),
  fc.constant(new NetToggle()),
  fc.constant(new ToggleChecks()),
  fc.constant(new UpdateNow()),
  fc.constant(new UpdateNow()),
  fc.boolean().map((ok) => new InstallerStep(ok)),
  fc.boolean().map((ok) => new InstallerStep(ok)),
  fc.boolean().map((ok) => new InstallerStep(ok)),
  fc.boolean().map((ok) => new InstallerStep(ok)),
  fc.constant(new KillInstaller()),
  fc.constant(new Restart()),
  fc.constant(new Restart()),
  fc.constant(new QuitInbox()),
  fc.constant(new StartInbox()),
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let saved: Record<string, string | undefined> = {};
const ENV = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_UPDATE_CHECK", "PLANNOTATOR_UPDATE_API_URL", "PLANNOTATOR_UPDATE_LATEST_URL"];
let worlds: Real[] = [];
let idleDataDir = "";
const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  // Never unset: a config read before newWorld() resolves to this empty sandbox, never ~/.plannotator.
  idleDataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-update-model-idle-")));
  process.env.PLANNOTATOR_DATA_DIR = idleDataDir;
  // "Updating…" polls every 2 s on a real timer; the test ticks by itself.
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
    ms === INBOX_UPDATING_TICK_MS ? realSetTimeout(() => {}, 2 ** 30) : realSetTimeout(fn, ms, ...rest)) as typeof setTimeout;
});

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout;
  for (const r of worlds.splice(0)) await disposeWorld(r);
  rmSync(idleDataDir, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function newWorld(): World {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-update-model-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const binary = join(dataDir, "bin-plannotator");
  const r: Real = {
    dataDir,
    binary,
    clock: T0,
    gh: undefined as unknown as ReturnType<typeof Bun.serve>,
    github: { published: 1, body: { 1: NOTES(1) }, pubAt: { 1: 0 }, netUp: true },
    pageRequests: 0,
    tagRequests: {},
    inflight: 0,
    updates: null,
    tickNow: null,
    launches: [],
    holders: [],
    offRequests: 0,
    explicit: false,
    checksOn: true,
    pageTimes: [],
    tagTimes: {},
  };
  r.gh = startGitHub(r);
  writeBinary(r, 1);
  // The Inbox ran 1 before (inboxVersion), so a start on a newer binary is "just updated".
  writeFileSync(join(dataDir, "update-state.json"), JSON.stringify({ inboxVersion: ver(1) }) + "\n");
  worlds.push(r);
  return { m: initialModel(), r };
}

async function disposeWorld(r: Real): Promise<void> {
  stopReal(r);
  for (let i = 0; i < r.holders.length; i++) await killHolder(r, i);
  r.gh.stop(true);
  forgetUnwrittenUpdateStateForTests(r.dataDir);
  rmSync(r.dataDir, { recursive: true, force: true });
}

/** The real code says what the model says: the button, the link, the requests GitHub saw. */
function conforms(m: Model, r: Real): void {
  // A refresh is what every tick ends with (it reaps a lock whose holder is gone).
  // Only a running Inbox reaps (the spec's tick); with none, the dead lock stays.
  if (r.updates) {
    r.updates.refresh();
    reap(m);
  }
  const state = r.updates?.current()?.state ?? "none";
  expect({ state, link: r.updates?.updated() ?? null }).toEqual({ state: uiState(m), link: link(m) ? ver(link(m)) : null });
  expect({ page: r.pageRequests, tags: r.tagRequests }).toEqual({ page: m.pageRequests, tags: m.tagRequests });
  expect(existsSync(autoUpdatePaths(r.dataDir).lock)).toBe(!!m.lock);
}

/** Run the commands on a fresh world, checking `after` after each one. */
async function runModel(cmds: Iterable<Cmd>, after: (m: Model, r: Real) => void): Promise<void> {
  const world = newWorld();
  try {
    for (const cmd of cmds) {
      if (!cmd.check(world.m)) continue;
      await cmd.run(world.m, world.r);
      after(world.m, world.r);
    }
  } finally {
    worlds = worlds.filter((w) => w !== world.r);
    await disposeWorld(world.r);
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/** Holds on main: the code follows the model, and the safety properties hold on the real code. */
function safety(m: Model, r: Real): void {
  conforms(m, r);
  // Nothing is fetched automatically while update checks are off (Check now is the person's own request).
  expect(r.offRequests).toBe(0);
  // No request loops: the release page at most once a minute, one release's notes at most every 15 minutes.
  const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!);
  for (const gap of gaps(r.pageTimes)) expect(gap).toBeGreaterThanOrEqual(MIN);
  for (const times of Object.values(r.tagTimes)) for (const gap of gaps(times)) expect(gap).toBeGreaterThanOrEqual(NOTES_PENDING_RETRY * MIN);
  // A stale lock is recovered: "Updating…" with no install alive never lasts an hour.
  if (r.updates?.current()?.state === "updating" && !m.inst.some(isRunning)) expect(m.now - m.lock!.at).toBeLessThan(60);
  // The binary is always a complete file.
  expect(readFileSync(r.binary, "utf-8")).toMatch(/^plannotator 0\.30\.\d+\n$/);
}

/** F1, the 0.28.37 bug: within the run that started on v, the link shows 30 minutes after the written notes. */
function whatsNewWithinRun(m: Model, r: Real): void {
  conforms(m, r);
  const v = m.ib.updated;
  if (!m.ib.alive || !v || !m.checksOn || m.netEverDown || m.body[v] !== "ours") return;
  if (m.oursAt[v]! - m.pubAt[v]! > 60) return; // CI writes the notes within the hour
  const since = Math.max(m.oursAt[v]!, m.ib.startedAt, m.checksOnSince);
  if (m.ib.lastTick - since < 30) return;
  expect(r.updates!.updated()).toBe(ver(v));
}

/**
 * F3: the same after one network outage of any length, counted from the
 * network's return. Every run on v counts, not only the first (F4: a
 * restart before the notes were readable keeps the link).
 */
function whatsNewAfterOutage(m: Model, r: Real): void {
  conforms(m, r);
  const v = m.ib.updated;
  if (!m.ib.alive || !v || !m.checksOn || !m.netUp || m.netDowns > 1 || m.body[v] !== "ours") return;
  if (m.oursAt[v]! - m.pubAt[v]! > 60) return;
  const since = Math.max(m.oursAt[v]!, m.ib.startedAt, m.checksOnSince, m.netBackAt);
  if (m.ib.lastTick - since < 30) return;
  expect(r.updates!.updated()).toBe(ver(v));
}

/** F5 and F6: never two installers; "Updating…" only while an install runs; a failed install the person started shows. */
function installsAndLocks(m: Model, r: Real): void {
  conforms(m, r);
  // A second install starts only beside one that has run for a day (a hung install never holds the lock for good).
  const running = m.inst.filter(isRunning);
  for (const older of running.slice(0, -1)) expect(m.now - older.at).toBeGreaterThanOrEqual(DAY);
  const state = r.updates?.current()?.state;
  if (state === "updating") expect(m.inst.some(isRunning)).toBe(true);
}

const focused = [
  fc.constant(new Publish()),
  fc.integer({ min: 2, max: 3 }).map((v) => new WriteNotes(v)),
  fc.constantFrom(1, 10, 15, 30, 60, 360).map((d) => new Advance(d)),
  fc.constant(new PageLoad()),
  fc.constant(new UpdateNow()),
  fc.constant(new InstallerStep(true)),
  fc.constant(new InstallerStep(true)),
  fc.constant(new Restart()),
];

describe("update lifecycle: the code follows the model (spec/update-lifecycle.qnt)", () => {
  test(
    "button, What's new link and GitHub requests equal the model's after every action; no fetch while checks are off; no request loop; a stale lock clears within the hour",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.commands(anyCommand, { maxCommands: 60, size: "xlarge" }), (cmds) => runModel([new StartInbox(), ...cmds], safety)),
        { numRuns: RUNS },
      );
    },
    120_000,
  );

  test(
    "the same through the install flow: Update now, the installer's steps, a kill, Ready, Restart",
    async () => {
      const installFlow = [
        fc.constant(new Publish()),
        fc.integer({ min: 2, max: 3 }).map((v) => new WriteNotes(v)),
        fc.constantFrom(1, 10, 15, 30, 60, 360).map((d) => new Advance(d)),
        fc.constantFrom(1, 10, 15, 30, 60, 360).map((d) => new Advance(d)),
        fc.constant(new PageLoad()),
        fc.constant(new UpdateNow()),
        fc.constant(new UpdateNow()),
        fc.boolean().map((ok) => new InstallerStep(ok)),
        fc.boolean().map((ok) => new InstallerStep(ok)),
        fc.boolean().map((ok) => new InstallerStep(ok)),
        fc.boolean().map((ok) => new InstallerStep(ok)),
        fc.constant(new KillInstaller()),
        fc.constant(new Restart()),
        fc.constant(new Restart()),
        fc.constant(new Restart()),
        fc.constant(new NetToggle()),
        fc.constant(new QuitInbox()),
        fc.constant(new StartInbox()),
      ];
      await fc.assert(
        fc.asyncProperty(fc.commands(installFlow, { maxCommands: 60, size: "xlarge" }), (cmds) => runModel([new StartInbox(), ...cmds], safety)),
        { numRuns: RUNS },
      );
    },
    120_000,
  );
});

describe("update lifecycle: properties the code breaks today (findings: the PR #2338 description)", () => {
  // F1. Fixed by PR #2337 (the 15-minute retry for a young release): an ordinary test now, guarding it.
  // The seed is pinned: a random seed misses the narrow F1 path in about half the runs, and a miss would
  // read as "fixed". With this seed the code before #2337 fails after 5 runs; the two F1 traces below
  // fail on any seed.
  test(
    "[FINDINGS F1] after an update, the What's new link shows within 30 minutes of the written notes (fixed by #2337)",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.commands([fc.constant(new StartInbox()), ...focused], { maxCommands: 30, size: "large" }),
          (cmds) => runModel([new StartInbox(), ...cmds], whatsNewWithinRun),
        ),
        { numRuns: RUNS * 8, seed: 1818629354 },
      );
    },
    300_000,
  );

  // F3 and F4 in any order: a network outage before, during or after the update, Inbox quits and starts.
  // Not pinned to a seed: the minimal traces below guard F3 and F4 on any seed; this explores around them
  // (with F3's rule removed it fails within about 100 runs, with F4's in most seeds).
  test(
    "[FINDINGS F3, F4] after an update, the What's new link shows within 30 minutes of the network's return, in any run on that version",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.commands(
            [
              fc.constant(new Publish()),
              fc.integer({ min: 2, max: 3 }).map((v) => new WriteNotes(v)),
              fc.constantFrom(1, 10, 15, 30, 60, 360).map((d) => new Advance(d)),
              fc.constantFrom(1, 10, 15, 30, 60, 360).map((d) => new Advance(d)),
              fc.constant(new CliCheck()),
              fc.constant(new UpdateNowFromCli()),
              fc.constant(new InstallerStep(true)),
              fc.constant(new InstallerStep(true)),
              fc.constant(new InstallerStep(true)),
              fc.constant(new InstallerStep(true)),
              fc.constant(new NetToggle()),
              fc.constant(new NetToggle()),
              fc.constant(new QuitInbox()),
              fc.constant(new StartInbox()),
            ],
            { maxCommands: 40, size: "xlarge" },
          ),
          // Release 2 is known before any Inbox runs, so the update is reachable from the first command.
          (cmds) => runModel([new Publish(), new CliCheck(), ...cmds], whatsNewAfterOutage),
        ),
        { numRuns: RUNS * 4 },
      );
    },
    300_000,
  );

  // F5 and F6: fixed by PR #2342.
  test(
    "[FINDINGS F5, F6] never two installers (within a day), and Updating… only while an install runs",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.commands(
            [
              fc.constant(new Publish()),
              fc.constantFrom(1, 10, 60).map((d) => new Advance(d)),
              fc.constant(new UpdateNow()),
              fc.boolean().map((ok) => new InstallerStep(ok)),
              fc.constant(new KillInstaller()),
              fc.constant(new Restart()),
            ],
            { maxCommands: 25, size: "large" },
          ),
          (cmds) => runModel([new StartInbox(), ...cmds], installsAndLocks),
        ),
        { numRuns: RUNS * 4 },
      );
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------
// The minimal traces of the findings (the PR #2338 description), on the real code
// ---------------------------------------------------------------------------

describe("the minimal traces (findings: the PR #2338 description)", () => {
  // F1 as the 0.28.37 report saw it: the Inbox starts on the new version while the release still
  // carries GitHub's generated body.
  test("[FINDINGS F1] started on the new version before the notes were written: the link shows once they are (fixed by #2337)", async () => {
    await runModel(
      [new Publish(), new CliCheck(), new UpdateNowFromCli(), new InstallerStep(true), new InstallerStep(true), new InstallerStep(true), new InstallerStep(true), new StartInbox(), new WriteNotes(2), new Advance(30), new Advance(30)],
      (m, r) => {
        conforms(m, r);
        if (m.now >= 60) expect(r.updates!.updated()).toBe(ver(2));
      },
    );
  });

  // F1 the way the model found it: the Inbox on 1 fetched 2's notes for the update dialog while the
  // body was generated; the person updated later that day.
  test("[FINDINGS F1] notes fetched before the update while generated: the link shows after the update (fixed by #2337)", async () => {
    await runModel(
      [new StartInbox(), new Publish(), new Advance(10), new WriteNotes(2), new UpdateNow(), new InstallerStep(true), new InstallerStep(true), new InstallerStep(true), new Advance(1), new Restart(), new Advance(30), new Advance(30)],
      (m, r) => {
        conforms(m, r);
        if (m.ib.runs === 2 && m.ib.lastTick - m.ib.startedAt >= 30) expect(r.updates!.updated()).toBe(ver(2));
      },
    );
  });

  // F2: a request for the notes that never answered (its process quit) blocked them 24 h. Fixed: the
  // claim is marked in flight, and a claim still marked is asked again after 15 minutes.
  test("[FINDINGS F2] a notes request abandoned by a process that quit is asked again within 15 minutes", async () => {
    const world = newWorld();
    world.r.github.published = 2;
    world.r.github.pubAt[2] = 0;
    world.r.github.body[2] = NOTES(2);
    void fetchReleaseNotesFor({
      version: ver(2),
      dataDir: world.r.dataDir,
      now: () => T0,
      enabled: () => true,
      fetchRelease: () => new Promise<never>(() => {}), // the process quits before GitHub answers
    });
    expect(readUpdateState(world.r.dataDir).notesFetch?.[ver(2)]?.attemptedAt).toBe(T0);
    const next = await fetchReleaseNotesFor({
      version: ver(2),
      dataDir: world.r.dataDir,
      now: () => T0 + 15 * MIN,
      enabled: () => true,
      fetchRelease: (v) => fetchReleaseByTag(v, netFetch(world.r)),
    });
    expect(next.outcome).toBe("fetched");
  });

  // F3: one failed request at the start (offline for a moment) hid the link 6 h. Fixed: a failure that
  // may have been the network is asked again 15 minutes after it once a release check answers.
  test("[FINDINGS F3] after a network blip at the first fetch, the link shows within 30 minutes of the network's return", async () => {
    await runModel(
      [new Publish(), new WriteNotes(2), new CliCheck(), new UpdateNowFromCli(), new InstallerStep(true), new InstallerStep(true), new InstallerStep(true), new InstallerStep(true), new NetToggle(), new StartInbox(), new NetToggle(), new Advance(30), new Advance(30)],
      (m, r) => {
        conforms(m, r);
        if (m.now >= 60) expect(r.updates!.updated()).toBe(ver(2));
      },
    );
  });

  // F4: the link was for the run that started on the new version only; a restart before the notes
  // were readable lost it for good. Fixed: whatsNewPending keeps it until offered with readable notes.
  test("[FINDINGS F4] What's new survives an Inbox restart before the notes were readable", async () => {
    await runModel(
      [new Publish(), new CliCheck(), new UpdateNowFromCli(), new InstallerStep(true), new InstallerStep(true), new InstallerStep(true), new InstallerStep(true), new StartInbox(), new QuitInbox(), new StartInbox(), new WriteNotes(2), new Advance(30), new Advance(30)],
      (m, r) => {
        conforms(m, r);
        if (m.now >= 60) expect(r.updates!.updated()).toBe(ver(2));
      },
    );
  });

  // F5: an install that runs past the lock's hour (install.sh's binary download has no time limit)
  // loses its lock to the next Update now while its process group is alive. Fixed by PR #2342.
  test("[FINDINGS F5] a lock past its hour whose wrapper's process group is alive is not taken", async () => {
    const world = newWorld();
    const lock = autoUpdatePaths(world.r.dataDir).lock;
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true }); // inbox-guard: own child
    world.r.holders.push(holder);
    writeFileSync(lock, holderLine(holder.pid!));
    const at = (Date.now() - 61 * MIN) / 1000;
    utimesSync(lock, at, at);
    expect(acquireUpdateLock(lock)).toBe(false);
  });

  // F6: the install died before the wrapper wrote its line (or on Windows, at any point): "Updating…"
  // for an hour with no way to retry, then the failure is never shown. Fixed by PR #2342.
  test("[FINDINGS F6] an Update now whose install died shows Failed (with Try again), not Updating… for an hour", async () => {
    await runModel(
      [new StartInbox(), new Publish(), new Advance(10), new UpdateNow(), new KillInstaller(), new Advance(1), new Advance(60)],
      (m, r) => {
        conforms(m, r);
        if (m.inst[0]?.phase === "dead") expect(r.updates!.current()?.state).toBe("failed");
      },
    );
  });
});

/** `plannotator update` or a review window's Update: the same lock and launch, no Inbox needed. */
class UpdateNowFromCli implements Cmd {
  check = (m: Model) => m.latest > m.binV;
  async run(m: Model, r: Real) {
    launch(m, m.latest, true);
    startManualUpdate({
      currentVersion: ver(m.binV),
      dataDir: r.dataDir,
      now: () => r.clock,
      platform: process.platform,
      isManaged: () => true,
      launchInstaller: fakeLaunch(r),
    });
  }
  toString = () => "UpdateNowFromCli";
}


/**
 * The Antigravity wake: the person's reply, message or tag for an Antigravity
 * conversation goes into it through Antigravity's own agent API,
 * `agentapi send-message <conversation id> <text>` (agy CLI 1.5.9, App
 * 2.32.1). An idle conversation starts a turn with it at once; a running turn
 * reads it at its next step. It lands as a system message, never as the
 * person's typing, and nothing runs inside the conversation, so it never makes
 * the conversation busy.
 *
 * The conversation comes from its MCP calls (`_meta`, packages/core/
 * inbox-antigravity.ts). The language server that holds it and its token come
 * from:
 *  - the App's and the IDE's own hub file, `~/.gemini/antigravity/daemon/
 *    hub_<port>.json` and `~/.gemini/antigravity-ide/daemon/…` (pid, port,
 *    token; read at each send, so an App restart is followed);
 *  - for the CLI, which publishes nothing, the hand-over the agent wrote with
 *    `plannotator inbox antigravity` (inbox/antigravity/links/<id>.json, 0600;
 *    apps/hook/server/inbox-antigravity-command.ts). It lasts as long as that
 *    agy process.
 * Before a send the server is asked for the conversation
 * (`get-conversation-metadata`): `send-message` answers 0 for any id, even one
 * no conversation has, so its exit says nothing on its own.
 *
 *  - every call is a new message (no dedupe), so each item is claimed once on
 *    disk (`inbox/antigravity-wake/<item id>.<conversation>/`, mkdir before the
 *    call) and never sent twice, across restarts too;
 *  - exit 0 after the conversation was found is delivered;
 *  - a call whose outcome is not known (it ran out of time, the Inbox stopped
 *    while it ran, an answer that is not one of the known refusals) is read
 *    back from the conversation's transcript, where each received message is
 *    a step with its text: found is delivered, else it stays claimed and the
 *    window says it is saved for the agent's next read;
 *  - a refusal that sent nothing (no server there, a token it no longer
 *    takes) is tried again on the next look; a CLI hand-over whose agy is gone
 *    is ended, and the conversation is alive again when it hands over again
 *    or calls the Inbox;
 *  - while a reply waits on a server that is not there (the App closed, a CLI
 *    conversation that has not handed over), the hub files and hand-overs are
 *    looked at again every few seconds, files only;
 *  - a conversation the servers answer they do not have is asked for again
 *    only after a wait that doubles (15 s up to 5 min), or at once when a hub
 *    file or a hand-over changes; its reply keeps waiting. A conversation's
 *    calls ask at most once per 15 s;
 *  - a hand-over whose agy is gone (its pid, else its port) is removed on each
 *    pass (packages/shared/inbox/antigravity-links.ts).
 *
 * The token never leaves this module: it is passed in the environment of the
 * one `agentapi` run, never in an argument, a log line, an event or a store
 * record.
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_ANTIGRAVITY_DATA_DIRS,
  INBOX_ANTIGRAVITY_HOST,
  INBOX_ANTIGRAVITY_LINKS_FOLDER,
  antigravityConversationOfCall,
  antigravityLoopbackAddress,
  isAntigravityConversationId,
  isAntigravityToken,
  type InboxAntigravityLink,
  type InboxAntigravityProduct,
  type InboxMessage,
} from "@plannotator/core/inbox-types";
import { antigravityPidAlive, pruneAntigravityLinks } from "@plannotator/shared/inbox/antigravity-links";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { agentHomeAllowed, type AgentEnvironment } from "./inbox-agents";
import { codexQueueMessage } from "./inbox-codex-wake";

/** One `agentapi` call may take this long. */
export const INBOX_ANTIGRAVITY_SEND_TIMEOUT_MS = 30_000;
/** How long an agent's send_message waits to learn whether its conversation can be reached. */
const LOOKUP_TIMEOUT_MS = 3_000;
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** While a reply waits on a server that is not there, how often the hub files and hand-overs are looked at. */
const WAIT_CHECK_MS = 5_000;
/** How long a lookup's answer stands for a conversation's own calls (each Inbox tool call asks whether it is woken). */
const LOOKUP_FRESH_MS = 15_000;
/** A conversation the servers answer they do not have: asked for again after this, doubling up to the max. */
const MISSING_FIRST_MS = 15_000;
const MISSING_MAX_MS = 5 * 60_000;
/** The most of a transcript read back (its end): a received message is a recent step. */
const TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;

/** The App's own agent API client (macOS), used when no product wrote its `bin/agentapi`. */
export const INBOX_ANTIGRAVITY_APP_CLIENT = "/Applications/Antigravity.app/Contents/Resources/bin/language_server";

/** The folder of claims under `inbox/`. */
const WAKE_DIR = "antigravity-wake";

/** A server that holds conversations, with its token. */
interface Server {
  address: string;
  token: string;
  via: "hub" | "link";
  product: InboxAntigravityProduct;
}

type Asked = "found" | "absent" | "refused" | "unreachable";

/** A refusal that sent nothing: no server there, or a token it does not take. */
const NOT_SENT = /connection refused|ANTIGRAVITY_LS_ADDRESS is not set|Unauthenticated|missing CSRF|invalid CSRF|no such host/i;
const NOT_FOUND = /NotFound|not_found|trajectory not found/i;

/** What `agentapi` printed: its JSON answer, or null. */
function answerOf(stdout: string): { response?: Record<string, unknown>; error?: unknown } | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as { response?: Record<string, unknown>; error?: unknown }) : null;
  } catch {
    return null;
  }
}

/** The end of a file, as text (at most `max` bytes); null when it cannot be read. */
function tailOf(path: string, max: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, max);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface InboxAntigravityWake {
  /** Whether a message from this host and session, sent by a call with this `_meta`, wakes it: a server that holds the conversation answers. */
  wakes(host: unknown, session: unknown, meta: unknown): Promise<boolean>;
  /** `alive` (a conversation a server holds), `dead` (its server is gone or no longer has it), null (not known). */
  status(session: string): "alive" | "dead" | null;
  /** The conversation called an Inbox tool: it is there. */
  noteToolCall(session: string, meta: unknown): void;
  /** A send whose outcome is not known and not found in the transcript: saved for the agent's next read. */
  uncertain(session: string, itemId: string): boolean;
  uncertainItems(session: string): string[];
  /** Whether this Inbox has an agent API client to run (the agents list's row). */
  canWake(): boolean;
  sweep(): Promise<void>;
  stop(): void;
}

export function createInboxAntigravityWake(options: {
  store: InboxStore;
  environment: AgentEnvironment;
  commandOf: (item: InboxMessage, session: string) => InboxReplyCommand;
  /** An item not to hand at all (a steps-only Tidy wake once steps are off: the server withdraws it). */
  skip?: (item: InboxMessage, session: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
  sendTimeoutMs?: number;
  lookupTimeoutMs?: number;
  waitCheckMs?: number;
  /** The App's own client besides the products' `bin/agentapi`. Default: INBOX_ANTIGRAVITY_APP_CLIENT on macOS, never under the test sandbox. */
  appClients?: readonly string[];
}): InboxAntigravityWake {
  const { store, environment } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => void process.stderr.write(`Inbox: ${line}\n`));
  const stopping = new AbortController();
  const claimRoot = join(store.dir, WAKE_DIR);
  const linksDir = join(store.dir, ...INBOX_ANTIGRAVITY_LINKS_FOLDER);
  const gemini = join(environment.homeDir, ".gemini");
  const dataDirOf = (product: InboxAntigravityProduct) => join(gemini, INBOX_ANTIGRAVITY_DATA_DIRS[product]);
  // A test run reads Antigravity's files only in a scratch home (never the person's real ~/.gemini).
  const homeOk = () => agentHomeAllowed(environment);

  // ── The client ──
  const clientFor = (product: InboxAntigravityProduct | null): string[] | null => {
    const shims = environment.platform === "win32" ? ["agentapi.cmd", "agentapi.bat", "agentapi.exe"] : ["agentapi"];
    const order: InboxAntigravityProduct[] = product ? [product, ...(["cli", "app", "ide"] as const).filter((p) => p !== product)] : ["cli", "app", "ide"];
    if (homeOk()) {
      for (const p of order) {
        for (const name of shims) {
          const path = join(dataDirOf(p), "bin", name);
          if (existsSync(path)) return environment.platform === "win32" ? [path] : ["/bin/sh", path];
        }
      }
    }
    const agy = environment.which("agy") ?? (homeOk() ? [join(environment.homeDir, ".local", "bin", "agy")].find((path) => existsSync(path)) ?? null : null);
    if (agy) return [agy, "agentapi"];
    const apps = options.appClients ?? (environment.platform === "darwin" && !process.env.PLANNOTATOR_TEST_SANDBOX ? [INBOX_ANTIGRAVITY_APP_CLIENT] : []);
    const app = apps.find((path) => existsSync(path));
    return app ? [app, "agentapi"] : null;
  };
  const run = (server: Server, args: readonly string[], timeoutMs: number) => {
    const client = clientFor(server.product);
    if (!client) return Promise.resolve({ exitCode: 127, timedOut: false, stdout: "", stderr: "no agentapi client" });
    return environment.run([...client, ...args], {
      timeoutMs,
      signal: stopping.signal,
      cwd: environment.homeDir,
      env: { ANTIGRAVITY_LS_ADDRESS: server.address, ANTIGRAVITY_CSRF_TOKEN: server.token },
    });
  };

  // ── The servers ──
  const hubs = (product: "app" | "ide"): Server[] => {
    if (!homeOk()) return [];
    const dir = join(dataDirOf(product), "daemon");
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => /^hub_\d+\.json$/.test(name));
    } catch {
      return [];
    }
    const found: { server: Server; at: number }[] = [];
    for (const name of names) {
      try {
        const path = join(dir, name);
        const hub = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; httpPort?: unknown; csrfToken?: unknown };
        const address = antigravityLoopbackAddress(`localhost:${hub.httpPort}`);
        // A file left by an earlier launch names a pid that is gone.
        if (!address || !isAntigravityToken(hub.csrfToken) || !antigravityPidAlive(hub.pid)) continue;
        found.push({ server: { address, token: hub.csrfToken, via: "hub", product }, at: statSync(path).mtimeMs });
      } catch {
        // Not a hub file this build reads.
      }
    }
    return found.sort((a, b) => b.at - a.at).map((one) => one.server);
  };
  const linkPath = (conversation: string) => join(linksDir, `${conversation.toLowerCase()}.json`);
  const linkOf = (conversation: string): Server | null => {
    try {
      const link = JSON.parse(readFileSync(linkPath(conversation), "utf8")) as Partial<InboxAntigravityLink>;
      const address = antigravityLoopbackAddress(link.address);
      if (!address || !isAntigravityToken(link.token) || link.conversation?.toLowerCase() !== conversation.toLowerCase()) return null;
      return { address, token: link.token, via: "link", product: "cli" };
    } catch {
      return null;
    }
  };
  /** The files that say where servers are, as a value: a hand-over or an App launch changes it. */
  const serversMark = (): string => {
    const parts: string[] = [];
    try {
      for (const name of readdirSync(linksDir).sort()) parts.push(`${name}:${statSync(join(linksDir, name)).mtimeMs}`);
    } catch {
      // None yet.
    }
    if (homeOk()) {
      for (const product of ["app", "ide"] as const) {
        try {
          const daemon = join(dataDirOf(product), "daemon");
          for (const name of readdirSync(daemon).sort()) parts.push(`${product}/${name}:${statSync(join(daemon, name)).mtimeMs}`);
        } catch {
          // Not installed, or not running yet.
        }
      }
    }
    return parts.join("\n");
  };

  /** What each conversation's calls said its product is. */
  const products = new Map<string, InboxAntigravityProduct>();
  const candidates = (conversation: string): Server[] => {
    const product = products.get(conversation) ?? null;
    const link = product === null || product === "cli" ? linkOf(conversation) : null;
    const hubList = product === "cli" ? [] : product ? hubs(product) : [...hubs("app"), ...hubs("ide")];
    return [...(link ? [link] : []), ...hubList];
  };
  const ask = async (server: Server, conversation: string, timeoutMs: number): Promise<Asked> => {
    const said = await run(server, ["get-conversation-metadata", conversation], timeoutMs);
    if (said.timedOut) return "unreachable";
    const answer = answerOf(said.stdout);
    if (said.exitCode === 0 && answer && !answer.error && answer.response && "conversationMetadata" in answer.response) return "found";
    const words = `${typeof answer?.error === "string" ? answer.error : ""} ${said.stderr}`;
    if (NOT_FOUND.test(words)) return "absent";
    if (NOT_SENT.test(words)) return "refused";
    return "unreachable";
  };
  /** The server that holds the conversation now, and whether a hand-over for it was refused (its agy is gone). */
  const find = async (conversation: string, timeoutMs: number): Promise<{ server: Server | null; linkGone: boolean; unreachable: boolean; asked: number }> => {
    let linkGone = false;
    let unreachable = false;
    let count = 0;
    for (const server of candidates(conversation)) {
      count++;
      const asked = await ask(server, conversation, timeoutMs);
      if (asked === "found") return { server, linkGone: false, unreachable: false, asked: count };
      if (server.via === "link" && asked !== "unreachable") linkGone = true;
      if (asked === "unreachable") unreachable = true;
    }
    return { server: null, linkGone, unreachable, asked: count };
  };
  /** The last lookup's answer per conversation, for its own calls (a short while, while the server files stay the same). */
  const recent = new Map<string, { at: number; mark: string; found: boolean }>();
  /** Conversations the servers answered they do not have: not asked again before `until` while the server files stay the same. */
  const missing = new Map<string, { until: number; wait: number; mark: string }>();
  const missingNow = (conversation: string): boolean => {
    const entry = missing.get(conversation);
    return !!entry && entry.until > now() && entry.mark === serversMark();
  };
  const lookup = async (conversation: string, timeoutMs: number) => {
    const where = await find(conversation, timeoutMs);
    const mark = serversMark();
    recent.set(conversation, { at: now(), mark, found: !!where.server });
    if (where.server) missing.delete(conversation);
    else if (where.asked > 0 && !where.unreachable && !where.linkGone) {
      // Every server answered (no such conversation, or a token it does not take): back off until the files change.
      const before = missing.get(conversation);
      const wait = before && before.mark === mark ? Math.min(before.wait * 2, MISSING_MAX_MS) : MISSING_FIRST_MS;
      missing.set(conversation, { until: now() + wait, wait, mark });
    }
    return where;
  };

  // ── The sessions it wakes ──
  let swept: Set<string> | null = null;
  const sweptSessions = (): Set<string> =>
    (swept ??= new Set([...store.wakingSessionsOfHost(INBOX_ANTIGRAVITY_HOST), ...store.agentSessionsOfHost(INBOX_ANTIGRAVITY_HOST)].filter(isAntigravityConversationId)));
  const found = new Set<string>();
  const dead = new Set<string>();

  const wakesItem = (item: InboxMessage, session: string): boolean => {
    if (!store.isOwner(item, session)) return item.tags?.some((tag) => tag.session === session && tag.host === INBOX_ANTIGRAVITY_HOST && tag.wakes) ?? false;
    if (item.to) return item.to.host === INBOX_ANTIGRAVITY_HOST;
    const asked = item.reply_to ? store.message(item.reply_to) : null;
    return asked?.author.kind === "agent" && asked.author.host === INBOX_ANTIGRAVITY_HOST && isAntigravityConversationId(asked.author.session);
  };

  // ── Claims: one folder per item and conversation, made before the call ──
  const keyOf = (itemId: string, session: string) => `${itemId}.${session}`;
  const claimDir = (key: string) => join(claimRoot, key);
  const claimed = new Set<string>();
  const inFlight = new Set<string>();
  /** Sent with an outcome not known, and not (yet) found in the transcript: never sent again. */
  const uncertain = new Map<string, InboxAntigravityProduct | null>();
  try {
    for (const name of readdirSync(claimRoot)) {
      const dot = name.indexOf(".");
      if (dot <= 0 || !isAntigravityConversationId(name.slice(dot + 1))) continue;
      claimed.add(name);
      // A claim left by an earlier run never finished its record: it may have gone, so it is read back, never sent again.
      let product: InboxAntigravityProduct | null = null;
      try {
        product = (JSON.parse(readFileSync(join(claimRoot, name, "state.json"), "utf8")) as { product?: InboxAntigravityProduct }).product ?? null;
      } catch {
        // Claimed before the server was known.
      }
      uncertain.set(name, product);
    }
  } catch {
    // No claims yet.
  }
  const dropClaim = (itemId: string, session: string) => {
    const key = keyOf(itemId, session);
    store.handover.giveBack(itemId, session);
    claimed.delete(key);
    uncertain.delete(key);
    rmSync(claimDir(key), { recursive: true, force: true });
  };
  const delivered = (itemId: string, session: string) => {
    try {
      store.recordDelivery(itemId, { host: INBOX_ANTIGRAVITY_HOST, session });
    } catch {
      // Gone, or no longer this session's.
    }
    dropClaim(itemId, session);
  };
  /** Whether the conversation's transcript holds a message naming this item (the wake text's first line names it). */
  const inTranscript = (itemId: string, session: string, product: InboxAntigravityProduct | null): boolean => {
    if (!homeOk()) return false;
    const productsToRead: InboxAntigravityProduct[] = product ? [product] : ["cli", "app", "ide"];
    for (const p of productsToRead) {
      const logs = join(dataDirOf(p), "brain", session, ".system_generated", "logs");
      for (const file of ["transcript_full.jsonl", "transcript.jsonl"]) {
        const text = tailOf(join(logs, file), TRANSCRIPT_TAIL_BYTES);
        if (text?.includes(`(${itemId})`)) return true;
      }
    }
    return false;
  };

  const retryAt = new Map<string, { at: number; wait: number }>();
  const failuresSaid = new Set<string>();
  const sayOnce = (line: string) => {
    if (failuresSaid.has(line)) return;
    failuresSaid.add(line);
    log(line);
  };
  const backOff = (key: string) => {
    const wait = Math.min((retryAt.get(key)?.wait ?? RETRY_FIRST_MS / 2) * 2, RETRY_MAX_MS);
    retryAt.set(key, { at: now() + wait, wait });
  };
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if ((retryAt.size === 0 && missing.size === 0) || stopping.signal.aborted) return;
    const next = Math.min(...[...retryAt.values()].map((retry) => retry.at), ...[...missing.values()].map((entry) => entry.until));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void sweep();
    }, Math.max(0, next - now()) + 10);
    (retryTimer as { unref?: () => void }).unref?.();
  };
  // A hand-over is written by another process and an App launch tells the Inbox nothing: while a reply waits on a
  // server that is not there, the files that name servers are looked at again, and a change sweeps.
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  const watchServers = (mark: string | null) => {
    if (waitTimer) clearTimeout(waitTimer);
    waitTimer = null;
    if (mark === null || stopping.signal.aborted) return;
    waitTimer = setTimeout(() => {
      waitTimer = null;
      if (serversMark() === mark) watchServers(mark);
      else void sweep();
    }, options.waitCheckMs ?? WAIT_CHECK_MS);
    (waitTimer as { unref?: () => void }).unref?.();
  };

  /** One item: claimed, sent once, recorded. Returns whether it waits on a server that is not there. */
  const deliverOne = async (item: InboxMessage, session: string): Promise<boolean> => {
    const id = store.deliveryIdOf(item, session);
    const key = keyOf(id, session);
    const retry = retryAt.get(key);
    if (retry && retry.at > now()) return false;
    // Not there when last asked, and no server file has changed since: it waits (the files are watched meanwhile).
    if (missingNow(session)) return true;
    const where = await lookup(session, options.sendTimeoutMs ?? INBOX_ANTIGRAVITY_SEND_TIMEOUT_MS);
    if (!where.server) {
      if (where.unreachable) {
        backOff(key);
        return false;
      }
      if (where.linkGone) {
        // The agy that handed this conversation over is gone: ended until it hands over again (or calls the Inbox).
        if (!dead.has(session)) log(`Antigravity conversation ${session} is no longer running (its agy has exited); the reply waits in the Inbox.`);
        dead.add(session);
        found.delete(session);
        rmSync(linkPath(session), { force: true });
      }
      return true;
    }
    found.add(session);
    dead.delete(session);
    if (id === item.id && !store.handover.hand(item, session, INBOX_ANTIGRAVITY_HOST)) return false;
    try {
      mkdirSync(claimRoot, { recursive: true, mode: 0o700 });
      mkdirSync(claimDir(key));
    } catch {
      // Claimed already (another sweep, or before a restart).
      claimed.add(key);
      return false;
    }
    claimed.add(key);
    inFlight.add(key);
    try {
      writeFileSync(join(claimDir(key), "state.json"), `${JSON.stringify({ product: where.server.product, at: new Date(now()).toISOString() })}\n`);
    } catch {
      // The claim folder alone still keeps it from a second send.
    }
    const text = codexQueueMessage(options.commandOf(item, session));
    const said = await run(where.server, ["send-message", session, text], options.sendTimeoutMs ?? INBOX_ANTIGRAVITY_SEND_TIMEOUT_MS);
    inFlight.delete(key);
    const answer = answerOf(said.stdout);
    if (said.exitCode === 0 && answer && !answer.error && answer.response && "sendMessage" in answer.response) {
      retryAt.delete(key);
      delivered(id, session);
      return false;
    }
    const words = `${typeof answer?.error === "string" ? answer.error : ""} ${said.stderr}`.split(where.server.token).join("…").trim().slice(0, 300);
    if (!said.timedOut && !stopping.signal.aborted && NOT_SENT.test(words)) {
      // Nothing went: the server is not there or does not take the token now (a new launch). Looked at again later.
      dropClaim(id, session);
      backOff(key);
      sayOnce(`Antigravity did not take a reply for conversation ${session} (${words.replace(/\s+/g, " ")}). Trying again later.`);
      return false;
    }
    if (!said.timedOut && !stopping.signal.aborted && NOT_FOUND.test(words)) {
      dropClaim(id, session);
      dead.add(session);
      found.delete(session);
      log(`Antigravity no longer has conversation ${session}; the reply waits in the Inbox for the next agent.`);
      return false;
    }
    // Sent, and no answer that says what happened: read back, never sent again.
    if (inTranscript(id, session, where.server.product)) {
      delivered(id, session);
      return false;
    }
    uncertain.set(key, where.server.product);
    log(`agentapi send-message for ${item.id} (conversation ${session}) ${said.timedOut ? "ran out of time" : "did not say it went"}; it is not sent again: the agent sees it when it reads the thread.`);
    return false;
  };

  let sweeping: Promise<void> | null = null;
  let again = false;
  /** The conversations whose hand-over was found ended on this pass: ended here too. */
  const endLinks = async (): Promise<string[]> => {
    const ended = await pruneAntigravityLinks(linksDir);
    for (const session of ended) {
      recent.delete(session);
      if (!sweptSessions().has(session)) continue;
      found.delete(session);
    }
    return ended;
  };
  const sweepOnce = async (): Promise<void> => {
    const ended = await endLinks();
    const sessions = sweptSessions();
    if (sessions.size === 0 && claimed.size === 0) return watchServers(null);
    const pending = store.pendingRepliesFor(sessions, { tags: true });
    const pendingKeys = new Set<string>();
    const work: { item: InboxMessage; session: string }[] = [];
    for (const [session, items] of pending) {
      if (!isAntigravityConversationId(session)) continue;
      for (const item of items) {
        if (!wakesItem(item, session) || options.skip?.(item, session)) continue;
        const key = keyOf(store.deliveryIdOf(item, session), session);
        pendingKeys.add(key);
        if (claimed.has(key)) continue;
        work.push({ item, session });
      }
    }
    // A claim whose item no longer waits (delivered, read, deleted) is done with; one in flight is kept.
    for (const key of [...claimed]) {
      if (pendingKeys.has(key) || inFlight.has(key)) continue;
      const dot = key.indexOf(".");
      dropClaim(key.slice(0, dot), key.slice(dot + 1));
    }
    // An uncertain one that has since shown up in its transcript went.
    for (const [key, product] of [...uncertain]) {
      const dot = key.indexOf(".");
      if (inTranscript(key.slice(0, dot), key.slice(dot + 1), product)) delivered(key.slice(0, dot), key.slice(dot + 1));
    }
    for (const key of [...retryAt.keys()]) if (!pendingKeys.has(key)) retryAt.delete(key);
    const waitingSessions = new Set(work.map((one) => one.session));
    for (const session of [...missing.keys()]) if (!waitingSessions.has(session)) missing.delete(session);
    for (const session of ended) {
      if (!sessions.has(session)) continue;
      if (waitingSessions.has(session) && !dead.has(session)) log(`Antigravity conversation ${session} is no longer running (its agy has exited); the reply waits in the Inbox.`);
      dead.add(session);
    }
    let waiting = false;
    for (const { item, session } of work) {
      if (stopping.signal.aborted) return;
      if (await deliverOne(item, session)) waiting = true;
    }
    scheduleRetry();
    watchServers(waiting ? serversMark() : null);
  };
  const sweep = (): Promise<void> => {
    if (stopping.signal.aborted) return Promise.resolve();
    if (sweeping) {
      again = true;
      return sweeping;
    }
    sweeping = (async () => {
      try {
        do {
          again = false;
          await sweepOnce();
        } while (again && !stopping.signal.aborted);
      } catch (error) {
        log(`the Antigravity wake could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  };

  let sweepQueued = false;
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message") return;
    const message = line.record as InboxMessage;
    if (message.author.kind === "agent") {
      if (message.author.host !== INBOX_ANTIGRAVITY_HOST || !isAntigravityConversationId(message.author.session)) return;
      sweptSessions().add(message.author.session);
    } else {
      if (message.to?.host === INBOX_ANTIGRAVITY_HOST) sweptSessions().add(message.to.session);
      for (const tag of message.tags ?? []) if (tag.host === INBOX_ANTIGRAVITY_HOST && tag.wakes) sweptSessions().add(tag.session);
    }
    if (sweptSessions().size === 0 || sweepQueued) return;
    sweepQueued = true;
    setTimeout(() => {
      sweepQueued = false;
      void sweep();
    }, 0);
  });
  void sweep();

  const remember = (session: string, meta: unknown) => {
    const call = antigravityConversationOfCall(meta);
    if (call && call.conversation === session && call.product) products.set(session, call.product);
  };

  return {
    wakes: async (host, session, meta) => {
      if (host !== INBOX_ANTIGRAVITY_HOST || !isAntigravityConversationId(session)) return false;
      // A subagent's call, or a call that names another conversation, is not this conversation's own.
      if (meta !== undefined && antigravityConversationOfCall(meta)?.conversation !== session) return false;
      remember(session, meta);
      // Asked a moment ago (its calls come in runs), or not there and not to be asked yet: that answer.
      const last = recent.get(session);
      if (last && now() - last.at < LOOKUP_FRESH_MS && last.mark === serversMark()) return last.found && !dead.has(session);
      if (missingNow(session)) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
      });
      const looked = lookup(session, options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
      looked.catch(() => {});
      const where = await Promise.race([looked, late]).finally(() => clearTimeout(timer));
      if (!where?.server) return false;
      found.add(session);
      dead.delete(session);
      return true;
    },
    status: (session) => (dead.has(session) ? "dead" : found.has(session) ? "alive" : null),
    noteToolCall: (session, meta) => {
      if (!isAntigravityConversationId(session)) return;
      remember(session, meta);
      sweptSessions().add(session);
      dead.delete(session);
      // It called: a server holds it, so it is asked for again now.
      missing.delete(session);
      for (const key of [...retryAt.keys()]) if (key.endsWith(`.${session}`)) retryAt.delete(key);
      void sweep();
    },
    uncertain: (session, itemId) => uncertain.has(keyOf(itemId, session)),
    uncertainItems: (session) => [...uncertain.keys()].filter((key) => key.endsWith(`.${session}`)).map((key) => key.slice(0, key.indexOf("."))),
    canWake: () => clientFor(null) !== null,
    sweep,
    stop: () => {
      stopping.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (waitTimer) clearTimeout(waitTimer);
      unsubscribe();
    },
  };
}

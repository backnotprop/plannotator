import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { INBOX_QWEN_HOST, isQwenSessionId, qwenSessionOfCall, type InboxMessage, type InboxQwenSessionRecord } from "@plannotator/core/inbox-types";
import { isPidAlive } from "@plannotator/shared/inbox/registry";
import { listQwenSessionRecords } from "@plannotator/shared/inbox/qwen-sessions";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { stripJsonComments } from "./agent-files";
import { codexQueueMessage } from "./inbox-codex-wake";
import type { AgentEnvironment } from "./inbox-agents";
import { checkQwenTrust, qwenTrustHome, qwenWakeToken } from "./inbox-qwen-trust";

export const INBOX_QWEN_SEND_TIMEOUT_MS = 5_000;
export const INBOX_QWEN_RECEIPT_TIMEOUT_MS = 30_000;
export const INBOX_QWEN_COMEBACK_MS = 60_000;

const FROM_NAME = "Plannotator Inbox";
const CLAIM_DIR = "qwen-wake";
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
const REGISTRY_TTL_MS = 2_000;
const LINE_MAX_CHARS = 1024 * 1024;
const LINE_DEADLINE_MS = 30_000;
const MAX_RECEIPT_CONNECTIONS = 64;
const SOCKET_PATH_MAX = 103;
const SOCKET_FOLDER_PREFIX = "plannotator-qwen-";
const TRUST_CHECK_EVERY_MS = 5 * 60_000;

type ClaimState = "sent" | "delivered" | "held" | "denied" | "refused" | "uncertain";

interface Claim {
  itemId: string;
  session: string;
  msgId: string | null;
  at: number;
  state: ClaimState;
  deliveredAt?: number;
  pid?: number;
}

export interface InboxQwenWake {
  canWake(): boolean;
  wakes(host: unknown, session: unknown, meta: unknown): Promise<boolean>;
  status(session: string): "alive" | "dead" | null;
  noteToolCall(session: string): void;
  uncertain(session: string, itemId: string): boolean;
  uncertainItems(session: string): string[];
  sweep(): Promise<void>;
  stop(): void;
}

function dialable(path: string | null): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\u0000");
}

function linuxIdentity(): { bootId: string | null; pidNs: number | null } {
  let bootId: string | null = null;
  let pidNs: number | null = null;
  try {
    bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
  }
  try {
    pidNs = statSync("/proc/self/ns/pid").ino;
  } catch {
  }
  return { bootId, pidNs };
}

function startTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export function qwenRecordLive(record: InboxQwenSessionRecord, identity: { bootId: string | null; pidNs: number | null } = linuxIdentity()): boolean {
  if (record.pidNs !== null && identity.pidNs !== null && record.pidNs !== identity.pidNs) return false;
  if (record.pidNs === null && identity.pidNs !== null && process.platform === "linux") return false;
  if (record.procStart !== null) {
    const colon = record.procStart.lastIndexOf(":");
    if (identity.bootId === null || colon <= 0) return false;
    if (record.procStart.slice(0, colon) !== identity.bootId) return false;
    if (startTicks(record.pid) !== record.procStart.slice(colon + 1)) return false;
  }
  return isPidAlive(record.pid);
}

export type QwenAgentsSettings = { kind: "missing" } | { kind: "unreadable" } | { kind: "file"; messaging: unknown; inbound: unknown };

export function readQwenAgentsSettings(path: string): QwenAgentsSettings {
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return { kind: "unreadable" };
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable" };
  }
  try {
    const parsed = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ""))) as { agents?: { crossSessionMessaging?: unknown; crossSessionInbound?: unknown } } | null;
    const agents = parsed && typeof parsed === "object" ? parsed.agents : undefined;
    if (!agents || typeof agents !== "object") return { kind: "file", messaging: undefined, inbound: undefined };
    return { kind: "file", messaging: agents.crossSessionMessaging, inbound: agents.crossSessionInbound };
  } catch {
    return { kind: "unreadable" };
  }
}

const messagingStrictness = (value: unknown): number => (value === true || value === undefined ? 0 : 1);
const inboundStrictness = (value: unknown): number => (value === "accept" ? 0 : value === undefined ? 1 : value === "refuse" ? 3 : 2);

export function qwenSettingsKeepOut(scopes: { systemDefaults: QwenAgentsSettings; user: QwenAgentsSettings; workspace: QwenAgentsSettings; system: QwenAgentsSettings }): boolean {
  const all = [scopes.systemDefaults, scopes.user, scopes.workspace, scopes.system];
  if (all.some((scope) => scope.kind === "unreadable")) return true;
  const value = (scope: QwenAgentsSettings, field: "messaging" | "inbound"): unknown => (scope.kind === "file" ? scope[field] : undefined);
  const merged = (field: "messaging" | "inbound", strictness: (value: unknown) => number): unknown => {
    const system = value(scopes.system, field);
    if (system !== undefined) return system;
    const user = value(scopes.user, field);
    const base = user !== undefined ? user : value(scopes.systemDefaults, field);
    const workspace = value(scopes.workspace, field);
    return workspace !== undefined && strictness(workspace) > strictness(base) ? workspace : base;
  };
  return messagingStrictness(merged("messaging", messagingStrictness)) >= 1 || inboundStrictness(merged("inbound", inboundStrictness)) >= 2;
}

function qwenSystemSettingsPaths(e: Pick<AgentEnvironment, "env" | "platform">): { system: string; systemDefaults: string } {
  const system =
    e.env.QWEN_CODE_SYSTEM_SETTINGS_PATH ||
    (e.platform === "darwin" ? "/Library/Application Support/QwenCode/settings.json" : e.platform === "win32" ? "C:\\ProgramData\\qwen-code\\settings.json" : "/etc/qwen-code/settings.json");
  return { system, systemDefaults: e.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH || join(dirname(system), "system-defaults.json") };
}

function clearLeftFolders(base: string): void {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    const match = new RegExp(`^${SOCKET_FOLDER_PREFIX}(\\d+)-[A-Za-z0-9]{6}$`).exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isPidAlive(pid)) continue;
    try {
      const stat = lstatSync(join(base, name));
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
      rmSync(join(base, name), { recursive: true, force: true });
    } catch {
    }
  }
}

export function createInboxQwenWake(options: {
  store: InboxStore;
  environment: AgentEnvironment;
  dataDir: string;
  commandOf: (item: InboxMessage, session: string) => InboxReplyCommand;
  skip?: (item: InboxMessage, session: string) => boolean;
  now?: () => number;
  sendTimeoutMs?: number;
  receiptTimeoutMs?: number;
  comebackMs?: number;
  socketParent?: string;
  checkTrust?: () => Promise<"listed" | "gone" | "unknown">;
  log?: (line: string) => void;
}): InboxQwenWake {
  const { store, environment } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => void process.stderr.write(`Inbox: ${line}\n`));
  const dir = join(store.dir, CLAIM_DIR);
  const supported = environment.platform !== "win32";
  let stopped = false;
  const identity = linuxIdentity();

  const home = () => qwenTrustHome(environment);
  let tokenRead: { at: number; token: string | null } | null = null;
  const token = (): string | null => {
    if (!supported) return null;
    if (tokenRead && Date.now() - tokenRead.at < REGISTRY_TTL_MS) return tokenRead.token;
    tokenRead = { at: Date.now(), token: qwenWakeToken(options.dataDir, home()) };
    return tokenRead.token;
  };

  let registry: { at: number; records: InboxQwenSessionRecord[] } | null = null;
  const records = (): InboxQwenSessionRecord[] => {
    if (registry && Date.now() - registry.at < REGISTRY_TTL_MS) return registry.records;
    const live = listQwenSessionRecords(home()).filter((record) => qwenRecordLive(record, identity));
    registry = { at: Date.now(), records: live };
    return live;
  };
  const settingsRead = new Map<string, { at: number; settings: QwenAgentsSettings }>();
  const settingsOf = (path: string): QwenAgentsSettings => {
    const cached = settingsRead.get(path);
    if (cached && Date.now() - cached.at < REGISTRY_TTL_MS) return cached.settings;
    const settings = readQwenAgentsSettings(path);
    if (settingsRead.size > 256) settingsRead.clear();
    settingsRead.set(path, { at: Date.now(), settings });
    return settings;
  };
  const systemPaths = qwenSystemSettingsPaths(environment);
  const keptOut = (cwd: string | null): boolean => {
    const project = cwd !== null && resolve(cwd) !== resolve(environment.homeDir) ? join(cwd, ".qwen", "settings.json") : null;
    return qwenSettingsKeepOut({
      systemDefaults: settingsOf(systemPaths.systemDefaults),
      user: settingsOf(join(home(), "settings.json")),
      workspace: project ? settingsOf(project) : { kind: "missing" },
      system: settingsOf(systemPaths.system),
    });
  };
  const forgetRegistry = () => {
    registry = null;
    tokenRead = null;
    settingsRead.clear();
  };
  const recordOf = (session: string): InboxQwenSessionRecord | null => {
    let best: InboxQwenSessionRecord | null = null;
    for (const record of records()) if (record.sessionId === session && (!best || record.startedAt > best.startedAt)) best = record;
    return best;
  };
  const reachable = (record: InboxQwenSessionRecord): boolean => {
    if (record.shared || record.kind !== "tui" || !dialable(record.ipcPath) || !record.ipcToken) return false;
    return !keptOut(record.cwd);
  };

  const checkTrust = options.checkTrust ?? (() => checkQwenTrust(options.dataDir, environment));
  let trustCheckedAt = -Infinity;
  let trustChecking = false;
  const askTrust = () => {
    if (trustChecking || stopped || Date.now() - trustCheckedAt < TRUST_CHECK_EVERY_MS) return;
    trustChecking = true;
    trustCheckedAt = Date.now();
    void checkTrust()
      .then((answer) => {
        if (answer !== "gone") return;
        tokenRead = null;
        log("Plannotator's trusted-sender grant was removed in Qwen Code, so replies to Qwen Code sessions wait until they read the Inbox.");
      })
      .catch(() => {
      })
      .finally(() => {
        trustChecking = false;
      });
  };

  let known: Set<string> | null = null;
  const knownSessions = (): Set<string> => (known ??= new Set([...store.wakingSessionsOfHost(INBOX_QWEN_HOST)].filter(isQwenSessionId)));
  const ended = new Set<string>();
  const refused = new Set<string>();

  const claims = new Map<string, Claim>();
  const byMsgId = new Map<string, string>();
  const keyOf = (itemId: string, session: string) => `${itemId}.${session}`;
  const claimPath = (key: string) => join(dir, key);
  const persist = (claim: Claim) => {
    try {
      writeFileSync(join(claimPath(keyOf(claim.itemId, claim.session)), "state.json"), `${JSON.stringify({ at: claim.at, msgId: claim.msgId, state: claim.state, ...(claim.deliveredAt ? { deliveredAt: claim.deliveredAt } : {}) })}\n`);
    } catch {
    }
  };
  try {
    for (const name of readdirSync(dir)) {
      const dot = name.indexOf(".");
      if (dot <= 0) continue;
      const itemId = name.slice(0, dot);
      const session = name.slice(dot + 1);
      if (!isQwenSessionId(session)) continue;
      let claim: Claim = { itemId, session, msgId: null, at: 0, state: "uncertain" };
      try {
        const saved = JSON.parse(readFileSync(join(dir, name, "state.json"), "utf8")) as { at?: unknown; state?: unknown; deliveredAt?: unknown };
        const at = typeof saved.at === "number" ? saved.at : 0;
        if (saved.state === "delivered") claim = { itemId, session, msgId: null, at, state: "delivered", deliveredAt: typeof saved.deliveredAt === "number" ? saved.deliveredAt : at };
        else claim = { itemId, session, msgId: null, at, state: saved.state === "refused" ? "refused" : "uncertain" };
      } catch {
      }
      claims.set(name, claim);
    }
  } catch {
  }
  const dropClaim = (key: string) => {
    const claim = claims.get(key);
    if (claim?.msgId) byMsgId.delete(claim.msgId);
    claims.delete(key);
    rmSync(claimPath(key), { recursive: true, force: true });
  };
  const delivered = (key: string) => {
    const claim = claims.get(key);
    if (!claim) return;
    try {
      store.recordDelivery(claim.itemId, { host: INBOX_QWEN_HOST, session: claim.session });
    } catch {
    }
    dropClaim(key);
  };
  const isUncertain = (claim: Claim) => claim.state !== "delivered" && claim.state !== "sent";

  const wakesItem = (item: InboxMessage, session: string): boolean => {
    if (!store.isOwner(item, session)) return item.tags?.some((tag) => tag.session === session && tag.host === INBOX_QWEN_HOST && tag.wakes) ?? false;
    if (item.to) return item.to.host === INBOX_QWEN_HOST;
    const asked = item.reply_to ? store.message(item.reply_to) : null;
    return asked?.author.kind === "agent" && asked.author.host === INBOX_QWEN_HOST && asked.wakes === true;
  };

  const retryAt = new Map<string, { at: number; wait: number }>();
  const receiptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let comebackTimer: ReturnType<typeof setTimeout> | null = null;
  const unref = (timer: ReturnType<typeof setTimeout>) => (timer as { unref?: () => void }).unref?.();
  const scheduleRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (retryAt.size === 0 || stopped) return;
    const next = Math.min(...[...retryAt.values()].map((retry) => retry.at));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void sweep();
    }, Math.max(0, next - now()) + 10);
    unref(retryTimer);
  };
  const scheduleComeback = (wanted: boolean) => {
    if (!wanted || stopped) {
      if (comebackTimer) clearTimeout(comebackTimer);
      comebackTimer = null;
      return;
    }
    if (comebackTimer) return;
    comebackTimer = setTimeout(() => {
      comebackTimer = null;
      void sweep();
    }, options.comebackMs ?? INBOX_QWEN_COMEBACK_MS);
    unref(comebackTimer);
  };
  const retryLater = (key: string) => {
    const wait = Math.min((retryAt.get(key)?.wait ?? RETRY_FIRST_MS / 2) * 2, RETRY_MAX_MS);
    retryAt.set(key, { at: now() + wait, wait });
  };

  const replyToken = randomBytes(32).toString("hex");
  let receipts: { server: Server; path: string; folder: string } | null = null;
  let binding: Promise<string | null> | null = null;
  const connections = new Set<Socket>();
  const replyTokenBytes = Buffer.from(replyToken);
  const tokenMatches = (presented: unknown) => {
    if (typeof presented !== "string" || Buffer.byteLength(presented) !== replyTokenBytes.length) return false;
    return timingSafeEqual(Buffer.from(presented), replyTokenBytes);
  };
  const onReceipt = (frame: Record<string, unknown>) => {
    if (frame.type !== "control" || frame.action !== "delivery_status" || typeof frame.msgV !== "number" || frame.msgV > 1) return;
    const status = frame.status;
    const ids = [frame.origMsgId, ...(status === "dropped" && Array.isArray(frame.droppedMsgIds) ? frame.droppedMsgIds.slice(0, 256) : [])];
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const key = byMsgId.get(id);
      const claim = key ? claims.get(key) : undefined;
      if (!key || !claim) continue;
      applyReceipt(key, claim, status);
    }
  };
  const applyReceipt = (key: string, claim: Claim, status: unknown) => {
    const settle = () => {
      const timer = receiptTimers.get(key);
      if (timer) clearTimeout(timer);
      receiptTimers.delete(key);
    };
    const pending = claim.state === "sent" || claim.state === "uncertain";
    switch (status) {
      case "delivered":
        if (!pending && claim.state !== "held") return;
        settle();
        claim.state = "delivered";
        claim.deliveredAt = now();
        persist(claim);
        return;
      case "held":
        if (!pending) return;
        settle();
        claim.state = "held";
        persist(claim);
        return;
      case "denied":
        if (!pending && claim.state !== "held") return;
        settle();
        claim.state = "denied";
        persist(claim);
        return;
      case "refused":
        if (!pending) return;
        settle();
        claim.state = "refused";
        refused.add(claim.session);
        persist(claim);
        log(`Qwen Code session ${claim.session} refuses messages from other programs; it sees the reply when it reads the thread.`);
        return;
      case "misaddressed":
        settle();
        ended.add(claim.session);
        forgetRegistry();
        dropClaim(key);
        return;
      case "expired": {
        settle();
        if (claim.state === "held" && claim.pid !== undefined && isPidAlive(claim.pid)) {
          claim.state = "uncertain";
          persist(claim);
          return;
        }
        forgetRegistry();
        dropClaim(key);
        retryLater(key);
        scheduleRetry();
        return;
      }
      case "dropped":
        if (!pending) return;
        settle();
        dropClaim(key);
        retryLater(key);
        scheduleRetry();
        return;
      default:
        return;
    }
  };
  const handleConnection = (socket: Socket) => {
    if (connections.size >= MAX_RECEIPT_CONNECTIONS) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let authed = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => socket.destroy(), LINE_DEADLINE_MS);
      unref(deadline);
    };
    arm();
    socket.on("data", (chunk: string) => {
      try {
        buffer += chunk;
        let at = buffer.indexOf("\n");
        while (at >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf("\n");
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          const frame = parsed as Record<string, unknown>;
          if (!authed) {
            if (frame.type !== "auth" || !tokenMatches(frame.token)) {
              socket.destroy();
              return;
            }
            authed = true;
            arm();
            continue;
          }
          arm();
          onReceipt(frame);
        }
        if (buffer.length > LINE_MAX_CHARS) socket.destroy();
      } catch (error) {
        log(`a Qwen Code receipt could not be read: ${error instanceof Error ? error.message : String(error)}`);
        socket.destroy();
      }
    });
    const done = () => {
      if (deadline) clearTimeout(deadline);
      connections.delete(socket);
    };
    socket.on("close", done);
    socket.on("error", done);
  };
  const bindReceipts = (): Promise<string | null> => {
    if (receipts) return Promise.resolve(receipts.path);
    binding ??= new Promise<string | null>((resolveBind) => {
      let folder: string;
      try {
        const parent = options.socketParent ?? tmpdir();
        const prefix = `${SOCKET_FOLDER_PREFIX}${process.pid}-`;
        const base = Buffer.byteLength(join(parent, `${prefix}XXXXXX`, "r.sock")) <= SOCKET_PATH_MAX ? parent : "/tmp";
        for (const folder of new Set([parent, base])) clearLeftFolders(folder);
        folder = mkdtempSync(join(base, prefix));
        chmodSync(folder, 0o700);
      } catch (error) {
        log(`the Qwen Code receipts socket could not be made: ${error instanceof Error ? error.message : String(error)}`);
        resolveBind(null);
        return;
      }
      const path = join(folder, "r.sock");
      const server = createServer(handleConnection);
      server.once("error", (error) => {
        rmSync(folder, { recursive: true, force: true });
        log(`the Qwen Code receipts socket could not be bound: ${error.message}`);
        resolveBind(null);
      });
      server.listen(path, () => {
        try {
          chmodSync(path, 0o600);
        } catch {
        }
        server.unref();
        receipts = { server, path, folder };
        resolveBind(path);
      });
    }).finally(() => {
      binding = null;
    });
    return binding;
  };

  const sendFrame = (path: string, payload: string): Promise<"sent" | "timeout" | "unreachable" | "failed"> =>
    new Promise((resolveSend) => {
      let settled = false;
      let connected = false;
      const socket = createConnection({ path });
      const finish = (result: "sent" | "timeout" | "unreachable" | "failed") => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        socket.destroy();
        resolveSend(result);
      };
      const deadline = setTimeout(() => finish(connected ? "timeout" : "unreachable"), options.sendTimeoutMs ?? INBOX_QWEN_SEND_TIMEOUT_MS);
      socket.on("connect", () => {
        connected = true;
        socket.end(payload);
      });
      socket.on("error", (error: NodeJS.ErrnoException) => finish(!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED") ? "unreachable" : connected ? "timeout" : "failed"));
      socket.on("close", () => finish(connected ? "sent" : "unreachable"));
    });

  const sendOne = async (item: InboxMessage, session: string, record: InboxQwenSessionRecord, controller: string): Promise<void> => {
    const id = store.deliveryIdOf(item, session);
    const key = keyOf(id, session);
    const retry = retryAt.get(key);
    if (retry && retry.at > now()) return;
    const from = await bindReceipts();
    if (!from || stopped) return;
    try {
      mkdirSync(dir, { recursive: true });
      mkdirSync(claimPath(key));
    } catch {
      return;
    }
    const msgId = randomUUID();
    const claim: Claim = { itemId: id, session, msgId, at: now(), state: "sent", pid: record.pid };
    claims.set(key, claim);
    byMsgId.set(msgId, key);
    persist(claim);
    const content = codexQueueMessage(options.commandOf(item, session));
    const frame = {
      msgV: 1,
      msgId,
      type: "user",
      from,
      replyToken,
      fromName: FROM_NAME,
      toSessionId: session,
      priority: "next",
      message: { role: "user", content },
    };
    const payload = `${JSON.stringify({ msgV: 1, type: "auth", token: controller })}\n${JSON.stringify(frame)}\n`;
    const result = await sendFrame(record.ipcPath!, payload);
    if (result === "unreachable" || result === "failed") {
      if (claims.get(key) === claim) dropClaim(key);
      forgetRegistry();
      retryLater(key);
      if (result === "failed") log(`a reply could not be sent to Qwen Code session ${session}; trying again later.`);
      return;
    }
    retryAt.delete(key);
    if (result === "timeout") {
      if (claim.state === "sent") {
        claim.state = "uncertain";
        persist(claim);
      }
      return;
    }
    if (claim.state === "sent") {
      const timer = setTimeout(() => {
        receiptTimers.delete(key);
        if (claims.get(key) !== claim || claim.state !== "sent") return;
        claim.state = "uncertain";
        persist(claim);
        log(`Qwen Code did not confirm a reply to session ${session}; it is not sent again, and the session sees it when it reads the thread.`);
        askTrust();
      }, options.receiptTimeoutMs ?? INBOX_QWEN_RECEIPT_TIMEOUT_MS);
      unref(timer);
      receiptTimers.set(key, timer);
    }
  };

  let sweeping: Promise<void> | null = null;
  let again = false;
  const sweepOnce = async (): Promise<void> => {
    forgetRegistry();
    const sessions = knownSessions();
    if (sessions.size === 0 && claims.size === 0) return;
    const pending = store.pendingRepliesFor(sessions, { tags: true });
    const pendingKeys = new Set<string>();
    const work: { item: InboxMessage; session: string; record: InboxQwenSessionRecord }[] = [];
    let waitsForComeback = false;
    for (const [session, items] of pending) {
      for (const item of items) {
        if (!wakesItem(item, session) || options.skip?.(item, session)) continue;
        const key = keyOf(store.deliveryIdOf(item, session), session);
        pendingKeys.add(key);
        if (claims.has(key) || refused.has(session)) continue;
        const record = ended.has(session) ? null : recordOf(session);
        if (!record) {
          waitsForComeback = true;
          continue;
        }
        if (!reachable(record)) continue;
        work.push({ item, session, record });
      }
    }
    for (const key of [...claims.keys()]) {
      if (pendingKeys.has(key) || receiptTimers.has(key)) continue;
      dropClaim(key);
    }
    for (const key of [...retryAt.keys()]) if (!pendingKeys.has(key)) retryAt.delete(key);
    const controller = token();
    if (work.length > 0 && controller) {
      for (const { item, session, record } of work) {
        if (stopped) return;
        await sendOne(item, session, record, controller);
      }
    }
    scheduleRetry();
    scheduleComeback(waitsForComeback && controller !== null);
  };
  const sweep = (): Promise<void> => {
    if (stopped || !supported) return Promise.resolve();
    if (sweeping) {
      again = true;
      return sweeping;
    }
    sweeping = (async () => {
      try {
        do {
          again = false;
          await sweepOnce();
        } while (again && !stopped);
      } catch (error) {
        log(`the Qwen Code wake could not run: ${error instanceof Error ? error.message : String(error)}`);
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
      if (message.wakes !== true || message.author.host !== INBOX_QWEN_HOST || !isQwenSessionId(message.author.session)) return;
      knownSessions().add(message.author.session);
    } else {
      if (message.to?.host === INBOX_QWEN_HOST && isQwenSessionId(message.to.session)) knownSessions().add(message.to.session);
      for (const tag of message.tags ?? []) if (tag.host === INBOX_QWEN_HOST && tag.wakes && isQwenSessionId(tag.session)) knownSessions().add(tag.session);
    }
    if (knownSessions().size === 0 || sweepQueued) return;
    sweepQueued = true;
    setTimeout(() => {
      sweepQueued = false;
      void sweep();
    }, 0);
  });
  void sweep();

  const status = (session: string): "alive" | "dead" | null => {
    if (!supported || !knownSessions().has(session) || refused.has(session) || token() === null) return null;
    if (ended.has(session)) return "dead";
    const record = recordOf(session);
    if (!record) return "dead";
    return reachable(record) ? "alive" : null;
  };

  return {
    canWake: () => token() !== null,
    wakes: async (host, session, meta) => {
      if (host !== INBOX_QWEN_HOST || !isQwenSessionId(session) || refused.has(session) || ended.has(session)) return false;
      if (qwenSessionOfCall(meta) !== null || token() === null) return false;
      const record = recordOf(session);
      return record !== null && reachable(record);
    },
    status,
    uncertain: (session, itemId) => {
      const claim = claims.get(keyOf(itemId, session));
      return claim ? isUncertain(claim) : false;
    },
    uncertainItems: (session) => [...claims.values()].filter((claim) => claim.session === session && isUncertain(claim)).map((claim) => claim.itemId),
    noteToolCall: (session) => {
      if (!isQwenSessionId(session)) return;
      if (ended.delete(session)) void sweep();
      const at = now();
      for (const [key, claim] of [...claims]) {
        if (claim.session === session && claim.state === "delivered" && (claim.deliveredAt ?? claim.at) <= at) delivered(key);
      }
    },
    sweep,
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (comebackTimer) clearTimeout(comebackTimer);
      for (const timer of receiptTimers.values()) clearTimeout(timer);
      receiptTimers.clear();
      unsubscribe();
      for (const socket of connections) socket.destroy();
      if (receipts) {
        receipts.server.close();
        rmSync(receipts.folder, { recursive: true, force: true });
        receipts = null;
      }
    },
  };
}

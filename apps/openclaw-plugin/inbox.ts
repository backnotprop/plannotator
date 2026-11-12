import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, resolveInboxTool } from "../../packages/shared/config";
import { getPlannotatorDataDir } from "../../packages/shared/data-dir";
import { discoverInboxTools, InboxAgentConnection, InboxWake } from "../../packages/shared/inbox/agent-link";
import { inboxAgentTool, type InboxToolInfo } from "../../packages/shared/inbox/connection";
import {
  inboxSessionOf,
  isOwnerTurn,
  isPluginEventTurn,
  OPENCLAW_INBOX_AGENT_NAME,
  OPENCLAW_INBOX_HOST,
  startTurn,
  type OpenClawDeliveryContext,
  type OpenClawPluginApi,
  type OpenClawSession,
  type OpenClawTool,
  type OpenClawToolContext,
} from "./openclaw";

export const OPENCLAW_KNOWN_SESSIONS_MAX = 100;
export const OPENCLAW_REDISCOVER_MS = 30_000;

export interface OpenClawInboxDeps {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  discover?: (dataDir: string) => Promise<InboxToolInfo[] | null>;
  tickMs?: number;
  version?: string | null;
  now?: () => number;
}

interface KnownSession extends OpenClawSession {
  cwd: string | null;
  route: OpenClawDeliveryContext | null;
  at: number;
}

interface Watched {
  state: { known: KnownSession };
  wake: InboxWake;
}

export function knownSessionsFileOf(dataDir: string): string {
  return join(dataDir, "inbox", "openclaw-sessions.json");
}

function readKnown(file: string): KnownSession[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessions?: unknown };
    if (!Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.filter(
      (entry): entry is KnownSession =>
        !!entry && typeof entry === "object" && typeof (entry as KnownSession).agentId === "string" && typeof (entry as KnownSession).sessionKey === "string",
    );
  } catch {
    return [];
  }
}

function writeKnown(file: string, sessions: KnownSession[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {
    return;
  }
}

export class OpenClawInbox {
  readonly watched = new Map<string, Watched>();
  private readonly runs = new Map<string, Set<string>>();
  connection: InboxAgentConnection | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly dataDir: string;
  private discovering: Promise<void> | null = null;
  private discoveredAt = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly deps: OpenClawInboxDeps = {},
  ) {
    this.env = deps.env ?? process.env;
    this.dataDir = deps.dataDir ?? getPlannotatorDataDir();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private switchOn(): boolean {
    return resolveInboxTool(loadConfig(), this.env, OPENCLAW_INBOX_HOST);
  }

  private say(message: string): void {
    try {
      (this.api.logger.warn ?? this.api.logger.info)?.(`plannotator: ${message}`);
    } catch {
      return;
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.discover();
    if (!this.switchOn()) return;
    for (const known of readKnown(knownSessionsFileOf(this.dataDir))) this.watch(known);
  }

  stop(): void {
    this.stopped = true;
    for (const { wake } of this.watched.values()) wake.dispose();
    this.watched.clear();
  }

  onRun(sessionKey: string, runId: string, running: boolean): void {
    const runs = this.runs.get(sessionKey) ?? new Set<string>();
    if (running) runs.add(runId);
    else runs.delete(runId);
    if (runs.size > 0) this.runs.set(sessionKey, runs);
    else this.runs.delete(sessionKey);
  }

  private discover(): Promise<void> {
    if (this.discovering) return this.discovering;
    this.discoveredAt = this.now();
    this.discovering = (this.deps.discover ?? ((dir) => discoverInboxTools(dir)))(this.dataDir)
      .catch(() => null)
      .then((tools) => {
        if (tools && !this.connection) {
          this.connection = new InboxAgentConnection({ dataDir: this.dataDir, host: OPENCLAW_INBOX_HOST, agentName: OPENCLAW_INBOX_AGENT_NAME, tools });
        }
      })
      .finally(() => {
        this.discovering = null;
      });
    return this.discovering;
  }

  private watch(known: KnownSession): Watched | null {
    const connection = this.connection;
    if (!connection || this.stopped) return null;
    const id = inboxSessionOf(known);
    const existing = this.watched.get(id);
    if (existing) {
      existing.state.known = known;
      return existing;
    }
    const state = { known };
    const wake = new InboxWake(
      connection,
      id,
      {
        isBusy: () => (this.runs.get(state.known.sessionKey)?.size ?? 0) > 0,
        deliver: (text) => startTurn(this.api.runtime.system, state.known, text, state.known.route ?? undefined),
        notify: (message) => this.say(message),
        projectPath: () => state.known.cwd,
        pluginVersion: () => this.deps.version ?? null,
      },
      this.deps.tickMs,
    );
    const entry = { state, wake };
    this.watched.set(id, entry);
    wake.start();
    return entry;
  }

  private remember(ctx: OpenClawToolContext, owner: boolean): Watched | null {
    const session = { agentId: ctx.agentId!, sessionKey: ctx.sessionKey! };
    const id = inboxSessionOf(session);
    const before = this.watched.get(id)?.state.known;
    const known: KnownSession = {
      ...session,
      cwd: ctx.workspaceDir ?? before?.cwd ?? null,
      route: (owner ? ctx.deliveryContext : undefined) ?? before?.route ?? null,
      at: this.now(),
    };
    const entry = this.watch(known);
    if (!entry) return null;
    if (!before || before.cwd !== known.cwd || JSON.stringify(before.route) !== JSON.stringify(known.route)) {
      const file = knownSessionsFileOf(this.dataDir);
      const others = readKnown(file).filter((other) => inboxSessionOf(other) !== id);
      writeKnown(file, [known, ...others].slice(0, OPENCLAW_KNOWN_SESSIONS_MAX));
    }
    return entry;
  }

  private knows(ctx: OpenClawToolContext): boolean {
    if (!ctx.agentId || !ctx.sessionKey) return false;
    const id = inboxSessionOf({ agentId: ctx.agentId, sessionKey: ctx.sessionKey });
    return this.watched.has(id) || readKnown(knownSessionsFileOf(this.dataDir)).some((session) => inboxSessionOf(session) === id);
  }

  toolFor(ctx: OpenClawToolContext): OpenClawTool | null {
    const owner = isOwnerTurn(ctx);
    if (!owner && !(isPluginEventTurn(ctx) && this.knows(ctx))) return null;
    if (!this.switchOn()) return null;
    if (!this.connection) {
      if (this.now() - this.discoveredAt >= OPENCLAW_REDISCOVER_MS) void this.discover();
      return null;
    }
    const spec = inboxAgentTool(this.connection.tools);
    const entry = this.remember(ctx, owner);
    if (!spec || !entry) return null;
    const connection = this.connection;
    return {
      name: spec.name,
      label: "Plannotator Inbox",
      description: spec.description,
      parameters: spec.inputSchema as Record<string, unknown>,
      execute: async (_toolCallId, params) => {
        entry.wake.touch();
        const result = await connection.callTool(params, { sessionId: entry.wake.sessionId, cwd: entry.state.known.cwd ?? process.cwd(), wakes: true });
        if (result.isError) throw new Error(result.text);
        return { content: [{ type: "text", text: result.text }], details: {} };
      },
    };
  }
}

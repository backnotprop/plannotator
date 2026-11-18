/**
 * Plannotator Inbox: Run on a `:::run` block and Save on a `:::secret` block
 * (inbox-run.ts runs, inbox-secrets.ts keeps). Bun only: the Pi server has no
 * Inbox, so the two-runtimes rule has nothing to mirror.
 *
 *   GET  /api/inbox/messages/:id/run     the message's blocks, runs and the project's saved names
 *   POST /api/inbox/messages/:id/run     { key, op: "start" | "stop" | "terminal", command, serverSession }
 *   POST /api/inbox/messages/:id/secret  { name, value | null, serverSession }   null removes it
 *
 * Who may press: the person's own window here (its Origin, this Host and this run's serverSession; over the
 * tailnet the owner's window, the only account the tailnet gate lets in), a paired phone through the device door,
 * and a linked machine for a press in a window there (`door.window`). An agent's MCP connection, its `plannotator
 * inbox` calls and a bare `curl` carry none of these and get `403 window_only`. No route ever answers a secret's
 * value: there is nothing to read.
 *
 * What runs is the stored message's block, never the request's text: the request names the block by key and sends
 * the command the card showed, which must be those exact bytes (`409 run_changed` otherwise). A command or folder
 * with a hidden character is refused (`422 run_hidden_char`), and the card says why.
 *
 * A run gets only the saved secrets it names (`$NAME` in its command, or its `Uses:` line), and the card shows them
 * ("Uses NAME"). The program it runs under comes from the login environment alone (inbox-run-shell.ts).
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getOpenInApp } from "@plannotator/core/open-in-apps";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import {
  inboxRunBlockHidden,
  inboxRunLookalikes,
  inboxRunSecretNames,
  inboxSecretNameRefused,
  inboxSecretRefusedWords,
  INBOX_RUN_KEY_RE,
  INBOX_SECRET_NAME_RE,
  parseInboxRunBlocks,
  parseInboxSecretBlocks,
  type ParsedInboxRun,
} from "@plannotator/core/inbox-run-blocks";
import { inboxRunReportText, inboxSecretSavedText } from "@plannotator/core/inbox-run-guide";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest, isWindowRequest } from "./inbox-cross-site";
import type { InboxOpenInLauncher } from "./inbox-open-in";
import { MACHINE_PLATFORM, type InboxDoorCaller } from "./inbox-devices";
import type { InboxRunEnded, InboxRuns } from "./inbox-run";
import type { InboxRunRecord } from "./inbox-run-journal";
import { inboxRunArgv, inboxRunShellNote, type InboxRunShell } from "./inbox-run-shell";
import { checkSecretValue, loginEnvCredentials, type InboxSecrets } from "./inbox-secrets";
import { INBOX_SECRET_STORE_FROM, INBOX_SECRET_STORE_WORDS, scrubSecret, type InboxSecretVault } from "./inbox-secret-vault";

export const INBOX_RUN_WINDOW_ONLY_BODY = { error: "A command runs, and a secret is saved, only from the person's own Inbox window or phone.", code: "window_only" } as const;

export interface InboxRunRoutesOptions {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  runs: InboxRuns;
  secrets: InboxSecrets;
  vault: InboxSecretVault;
  /** The login shell's environment: `get` waits for it (a cached copy at once), `peek` is the cached copy or null. */
  loginEnv: { get: () => Promise<Record<string, string>>; peek: () => Record<string, string> | null };
  /** The program a command runs under, from the login environment alone (inbox-run-shell.ts). */
  shellFor: (loginEnv: Readonly<Record<string, string>>) => InboxRunShell;
  /** Puts text on this computer's clipboard (Open in terminal's command); false when it could not. */
  copyToClipboard: (text: string) => Promise<boolean>;
  /** Through the device door: who (a phone, or a linked machine and whether a window there pressed). */
  door: (req: Request) => InboxDoorCaller | undefined;
  /** "your Mac", or this computer's name. */
  computer: () => string;
  /** A path as the person reads it (`~/…`). */
  displayFolder: (path: string) => string;
  /** The person's own terminal, opened in a folder; the app's name, or why not. */
  openTerminal: (folder: string) => Promise<{ ok: true; app: string } | { ok: false; error: string }>;
}

/** A run block's folder on this computer: `Folder:` under the project's, `~/…` under home, or as written. */
export function inboxRunFolder(root: string, folder: string | null, home = homedir()): string {
  if (folder === null) return root;
  if (folder === "~" || folder.startsWith("~/")) return join(home, folder.slice(1));
  return resolve(root, folder);
}

/** Terminals in the order the card prefers them: one the person installed over the system's own. */
const TERMINAL_ORDER = ["ghostty", "iterm2", "warp", "terminal", "powershell"];

/**
 * "Open in terminal": the person's terminal app, opened in the run's folder, through Open in's own launcher
 * (packages/server/open-in.ts opens a terminal in a file's folder, so it is handed a name inside that folder).
 */
export async function openRunTerminal(launcher: InboxOpenInLauncher, folder: string): Promise<{ ok: true; app: string } | { ok: false; error: string }> {
  const terminals = launcher.apps().filter((app) => app.kind === "terminal");
  const rank = (id: string) => {
    const at = TERMINAL_ORDER.indexOf(id);
    return at === -1 ? TERMINAL_ORDER.length : at;
  };
  const picked = [...terminals].sort((a, b) => rank(a.id) - rank(b.id))[0];
  const app = picked ? getOpenInApp(picked.id) : undefined;
  if (!app) return { ok: false, error: "No terminal app was found on this computer." };
  const result = await launcher.openWithApp(app, join(folder, "plannotator-run"));
  return result.ok ? { ok: true, app: app.label } : { ok: false, error: result.error ?? `${app.label} did not open.` };
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function createInboxRunRoutes(options: InboxRunRoutesOptions) {
  const { store, json } = options;

  /** A press by the person: their window, their phone, or a window on their linked machine. */
  const pressed = (req: Request, body: Record<string, unknown>): boolean => {
    const door = options.door(req);
    if (door) return door.platform !== MACHINE_PLATFORM || door.window;
    return isWindowRequest(req, body, options.serverSession);
  };

  const agentMessage = (id: string): InboxMessage | null => {
    const message = store.message(id);
    return message && message.author.kind === "agent" ? message : null;
  };
  const rootOf = (message: InboxMessage): string | null => store.project(message.project_id)?.root ?? null;

  /** Every secret name an agent asked for in this thread (`:::secret` blocks). */
  const askedNames = (message: InboxMessage): Set<string> => {
    const names = new Set<string>();
    for (const m of store.thread(message.thread_id)?.messages ?? [message]) {
      if (m.author.kind !== "agent") continue;
      for (const s of parseInboxSecretBlocks(m.body)) if (!s.refused) names.add(s.name);
    }
    return names;
  };

  /**
   * The secrets a block gets: the names it names (`$NAME`, `Uses:`) that are secrets here: saved, asked for in
   * the thread, or on its `Uses:` line. A `$NODE_ENV` that is none of these is the command's own business.
   */
  const secretsOf = (block: ParsedInboxRun, saved: Set<string>, asked: Set<string>): string[] =>
    inboxRunSecretNames(block).filter((name) => saved.has(name) || asked.has(name) || block.uses.includes(name));

  const blockView = (message: InboxMessage, block: ParsedInboxRun, saved: Set<string>, asked: Set<string>, shell: InboxRunShell | null) => {
    const root = rootOf(message);
    const folder = root ? inboxRunFolder(root, block.folder) : null;
    const hidden = inboxRunBlockHidden(block);
    const uses = secretsOf(block, saved, asked);
    return {
      folder: folder ? options.displayFolder(folder) : null,
      folder_missing: folder === null || !isDir(folder),
      hidden: hidden ? { ...hidden.hidden, words: hidden.words, where: hidden.where } : null,
      // The secrets this run gets, and those of them not saved yet (the card shows a field for each).
      uses,
      needs: uses.filter((name) => !saved.has(name)),
      lookalike: inboxRunLookalikes(block.command),
      shell_note: shell ? inboxRunShellNote(block.command, shell, options.computer()) : null,
    };
  };

  const state = (message: InboxMessage) => {
    const saved = options.secrets.list(message.project_id);
    const savedNames = new Set(saved.map((s) => s.name));
    const asked = askedNames(message);
    const login = options.loginEnv.peek();
    // A card is on screen: read the login env now, so a press does not wait for the shell.
    if (!login) void options.loginEnv.get().catch(() => {});
    const shell = login ? options.shellFor(login) : null;
    const blocks: Record<string, ReturnType<typeof blockView>> = {};
    for (const block of parseInboxRunBlocks(message.body)) blocks[block.key] = blockView(message, block, savedNames, asked, shell);
    return {
      computer: options.computer(),
      store: INBOX_SECRET_STORE_WORDS[options.vault.kind],
      shell: shell?.name ?? null,
      blocks,
      runs: options.runs.views(message.id),
      secrets: saved,
    };
  };

  /** The person's note to the agent when a run ends: what ran, where, how it ended, the output's tail. */
  const reportTo = (message: InboxMessage, block: ParsedInboxRun, folder: string) => (ended: InboxRunEnded) => {
    const view = ended.view;
    const text = inboxRunReportText({
      title: block.title,
      command: block.command,
      folder,
      outcome: ended.outcome,
      exit_code: view.exit_code,
      signal: view.signal,
      duration_ms: view.duration_ms,
      tail: view.lines,
      total_lines: view.total_lines,
      waited_for_input: ended.waited_for_input,
      error: view.error,
    });
    note(message, text, "a run's result");
  };
  const note = (message: Pick<InboxMessage, "id">, text: string, what: string) => {
    try {
      store.appendPersonNote(message.id, text);
    } catch (error) {
      process.stderr.write(`Inbox: ${what} was not sent to the agent: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  // A run the last Inbox lost (it died while the run went on): the agent hears it, once.
  options.runs.recover((record: InboxRunRecord) => {
    const text = inboxRunReportText({
      title: record.title,
      command: "",
      folder: record.folder,
      outcome: "inbox_lost",
      exit_code: null,
      signal: null,
      duration_ms: record.view.duration_ms,
      tail: [],
      total_lines: 0,
      waited_for_input: false,
    });
    note({ id: record.message_id }, text, "a lost run's word");
  });
  // A deleted project's secrets leave the vault too.
  void options.secrets.prune((projectId) => store.project(projectId) !== null).catch(() => {});

  const run = async (message: InboxMessage, body: Record<string, unknown>): Promise<Response> => {
    const key = typeof body.key === "string" && INBOX_RUN_KEY_RE.test(body.key) ? body.key : null;
    if (!key) return json({ error: "key: a run block's key.", code: "validation_error" }, 422);
    const op = body.op;
    if (op !== "start" && op !== "stop" && op !== "terminal") return json({ error: 'op: "start", "stop" or "terminal".', code: "validation_error" }, 422);
    if (op === "stop") {
      options.runs.stop(message.id, key);
      return json({ ok: true });
    }
    const block = parseInboxRunBlocks(message.body).find((b) => b.key === key);
    if (!block) return json({ error: "That command is no longer in this message.", code: "run_not_found" }, 404);
    // The bytes the card showed are the bytes that run: anything else is a stale or forged page.
    if (body.command !== block.command) return json({ error: "This command changed since the page showed it. Reload to see it as it is now.", code: "run_changed" }, 409);
    const hidden = inboxRunBlockHidden(block);
    if (hidden) return json({ error: hidden.words, code: "run_hidden_char" }, 422);
    const root = rootOf(message);
    const folder = root ? inboxRunFolder(root, block.folder) : null;
    if (!folder || !isDir(folder)) {
      return json({ error: `That folder isn't on this computer: ${folder ? options.displayFolder(folder) : "the project has no folder"}.`, code: "run_folder_missing" }, 409);
    }
    if (op === "terminal") {
      const opened = await options.openTerminal(folder);
      if (!opened.ok) return json({ error: opened.error, code: "terminal_failed" }, 500);
      // The command goes on this computer's clipboard, where the terminal opened, whichever device pressed.
      const copied = await options.copyToClipboard(block.command).catch(() => false);
      return json({ ok: true, terminal: opened.app, copied });
    }
    const saved = new Set(options.secrets.list(message.project_id).map((s) => s.name));
    const names = secretsOf(block, saved, askedNames(message));
    try {
      // The run exists from here on (a Stop now means it never starts); what it needs is read after.
      options.runs.start({
        message_id: message.id,
        key,
        title: block.title,
        folder: options.displayFolder(folder),
        cwd: folder,
        prepare: async () => {
          const [login, read] = await Promise.all([options.loginEnv.get(), options.secrets.read(message.project_id, names)]);
          if (read.unreadable.length > 0) throw new Error(`Couldn't read ${read.unreadable.join(" or ")} ${INBOX_SECRET_STORE_FROM[options.vault.kind]}. Unlock it if it asks, then run again`);
          // Secrets go into the environment after the shell is chosen, and their names can never be one a program
          // starts from (core/inbox-run-blocks.ts refuses them), so no saved value picks what runs.
          const shell = options.shellFor(login);
          const secretEnv = Object.fromEntries(Object.entries(read.values).filter(([name]) => INBOX_SECRET_NAME_RE.test(name) && !inboxSecretNameRefused(name)));
          return {
            argv: inboxRunArgv(block.command, shell, Object.keys(secretEnv)),
            env: { ...login, ...secretEnv },
            redact: [...Object.values(secretEnv), ...loginEnvCredentials(login)],
          };
        },
        onEnd: reportTo(message, block, options.displayFolder(folder)),
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error), code: "run_running" }, 409);
    }
    return json({ ok: true });
  };

  const secret = async (message: InboxMessage, body: Record<string, unknown>): Promise<Response> => {
    const raw = typeof body.name === "string" ? body.name : "";
    if (INBOX_SECRET_NAME_RE.test(raw) && inboxSecretNameRefused(raw)) return json({ error: inboxSecretRefusedWords(raw), code: "secret_name_refused" }, 422);
    if (!INBOX_SECRET_NAME_RE.test(raw)) return json({ error: "name: a secret's name, like PAYMENTS_TEST_KEY.", code: "validation_error" }, 422);
    const name = raw;
    if (body.value === null) {
      try {
        await options.secrets.remove(message.project_id, name);
      } catch (error) {
        return json({ error: `${name} was not removed. ${error instanceof Error ? error.message : String(error)}`, code: "secret_not_removed" }, 500);
      }
      return json({ ok: true });
    }
    const checked = checkSecretValue(body.value);
    if (!checked.ok) return json({ error: checked.message, code: "validation_error", field: "value" }, 422);
    try {
      const { replaced } = await options.secrets.save(message.project_id, name, checked.value);
      note(message, inboxSecretSavedText(name, replaced), "a saved secret's name");
    } catch (error) {
      const said = scrubSecret(error instanceof Error ? error.message : String(error), checked.value);
      return json({ error: `${name} was not saved. ${said}`, code: "secret_not_saved" }, 500);
    }
    return json({ ok: true });
  };

  const RUN_PATH = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/(run|secret)$/;

  return {
    /** The routes' answer, or null for a path that is not theirs. */
    route: async (req: Request, path: string): Promise<Response | null> => {
      const match = RUN_PATH.exec(path);
      if (!match) return null;
      const message = agentMessage(match[1]!);
      if (req.method === "GET" && match[2] === "run") {
        if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
        if (!message) return json({ error: "No such agent message.", code: "message_not_found" }, 404);
        return json(state(message));
      }
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      if (!pressed(req, body)) return json(INBOX_RUN_WINDOW_ONLY_BODY, 403);
      if (!message) return json({ error: "No such agent message.", code: "message_not_found" }, 404);
      return match[2] === "run" ? run(message, body) : secret(message, body);
    },
    stop: () => options.runs.stopAll(),
  };
}

export type InboxRunRoutes = ReturnType<typeof createInboxRunRoutes>;

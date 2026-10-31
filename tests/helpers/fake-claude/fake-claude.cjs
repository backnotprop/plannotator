/**
 * A fake `claude` (Claude Code 2.1.314) for the launch tests: the CLI
 * contract recorded in .ops/work/bg-test/RESULTS.md and bg-perm-test/RESULTS.md,
 * and the Plannotator mod's bridge poll for the session it "starts". The real
 * Claude Code is never run. Node-safe CommonJS, run by the test runtime's own
 * executable (`process.execPath`) through a `/bin/sh` wrapper on PATH.
 *
 * State lives in the folder the wrapper names (`FAKE_CLAUDE_STATE`):
 *  - config.json  what the test asks for: { version, fault, workMs, hold, waiting, answer, startDelayMs, bgDelayMs, busyDelayMs }
 *  - delivered.log  one line per command a session took (after `delivered` was posted)
 *  - calls.jsonl  one line per call: argv, cwd, env names, and for --bg the
 *                 settings file (content, mode) and whether the thread existed
 *  - agents/<sessionId>.json  each session, as `claude agents --json` lists it
 *  - pids.log     every fake session process, so the test kills only its own
 *
 * Calls:
 *  --version                 "<version> (Claude Code)"
 *  --bg --name N --settings F [--allow-dangerously-skip-permissions] [--permission-mode M]
 *                            no prompt; faults: untrusted (Claude's error, exit 1;
 *                            with `trustCheck`, only in a folder HOME's .claude.json
 *                            does not trust, itself or above, a repository root only
 *                            by its own entry; `respawn` checks it too),
 *                            refuseAuto (commander's refusal of `auto`, exit 1),
 *                            slow (sleeps 40 s); else (after `bgDelayMs`) prints
 *                            "backgrounded · <8 hex> · N (idle — send a prompt to start)"
 *                            and starts the session process.
 *  agents --json [--all] [--cwd D]  without --all, done and stopped sessions are left out
 *  stop <id> / respawn <id> / rm <id> / purge [--dry-run | --yes] <folder> / attach <id>
 *
 * The session process (`__session <sessionId>`) reads the settings file's env
 * (PLANNOTATOR_DATA_DIR), finds the Inbox in <dataDir>/inbox/inbox.json and
 * polls its bridge as the mod does. A command: `delivered`, busy (after
 * `busyDelayMs`, the real mod's gap until its next poll), then after
 * `workMs` (and while `hold` or `waiting` is set) it answers through the
 * Inbox's MCP `send_message` with `reply_to`, and goes idle. `waiting` makes
 * the host list it as waiting on a permission prompt meanwhile.
 *
 * Permission modes, as Claude Code 2.1.314 runs a background session: with no
 * --permission-mode, the flag settings' then the user's `permissions.defaultMode`
 * (else default). Bypass needs the person's own recorded consent
 * (`skipDangerousModePermissionPrompt` in ~/.claude/settings.json, or
 * `bypassPermissionsModeAccepted` in ~/.claude.json; never the --settings file):
 * without it the allow flag is ignored, a bypass start runs in default mode, and
 * a hook's `setMode bypassPermissions` is ignored. In bypass mode a prompt is not
 * asked, except a `safetyCheck` one (dangerous rm): that goes to the
 * settings file's PermissionRequest hook when there is one, is waived only when
 * NO PermissionRequest hook exists at all and
 * CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1, and else waits on the
 * built-in dialog. As in Claude, any PermissionRequest hook counts, the matcher
 * ignored and plugins' included: Plannotator's plugin, enabled in HOME's
 * settings, has one (ExitPlanMode), unless `pluginPermissionHook` is false.
 * A hook's setMode changes the session's mode for later prompts.
 *
 * A `safetyCheck` prompt is for a person only, in any mode (Claude 2.1.314: the
 * ask does not let hooks allow it, and it awaits the hooks before its dialog):
 * no dialog while the hook runs (`localAnswer` does not end it), a hook's deny
 * counts, and an allow is ignored (`ignoredAllow`, no setMode). With no
 * decision, or an ignored allow, the built-in dialog comes up then, and blocks
 * the call on its own `safetyBlockMs` after the hook ended (default 2 minutes;
 * outcome `autoblocked`) unless `localAnswer` answers it first. An `askRule`
 * prompt (the person's own `permissions.ask` rule: "Permission rule …
 * requires confirmation") is person-only the same way, in any mode, but its
 * dialog waits until answered. Nothing in the hook's input marks either.
 *
 * Permission prompts (`prompts`: a list of { tool_name, tool_input,
 * permission_suggestions, safetyCheck }, played in each turn, in order): as Claude Code
 * does, the session lists itself `waiting` on a "permission prompt" and runs
 * the settings file's PermissionRequest command (`/bin/sh -c`, matcher `*`)
 * with the real stdin JSON (bg-perm-test/RESULTS.md) and the settings' env.
 * Allow runs the tool, deny goes on without it; no output leaves it blocked
 * on the built-in dialog until `localAnswer` is set: that is the person
 * answering in `claude attach`, which ends the hook (SIGTERM) and goes on.
 * Each prompt is one line of permissions.jsonl: the tool, the hook's stdout
 * (parsed), its exit code and time, and the outcome (ran, denied, local, autoblocked).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const STATE = process.env.FAKE_CLAUDE_STATE;
if (!STATE) {
  process.stderr.write("fake claude: FAKE_CLAUDE_STATE is not set\n");
  process.exit(2);
}
const agentsDir = path.join(STATE, "agents");
fs.mkdirSync(agentsDir, { recursive: true });

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const config = () => readJson(path.join(STATE, "config.json"), {});
const agentFile = (sessionId) => path.join(agentsDir, `${sessionId}.json`);
const allAgents = () =>
  fs
    .readdirSync(agentsDir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJson(path.join(agentsDir, n), null))
    .filter(Boolean);
const findAgent = (ref) => allAgents().find((a) => a.id === ref || a.sessionId.startsWith(ref)) || null;
const saveAgent = (agent) => {
  const file = agentFile(agent.sessionId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(agent));
  fs.renameSync(`${file}.tmp`, file);
};
const updateAgent = (sessionId, patch) => {
  const current = readJson(agentFile(sessionId), null);
  if (current) saveAgent({ ...current, ...patch });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Claude's folder trust (`trustCheck`), keyed as Claude keys it: HOME's ~/.claude.json accepts the folder or a
 * folder above it, but a git repository's root (a `.git` there) counts only through its own entry: a parent's
 * trust never covers a nested repository (the real-CLI smoke and code.claude.com's workspace-trust docs).
 */
const trusted = (folder) => {
  const projects = (readJson(path.join(process.env.HOME || "", ".claude.json"), {}) || {}).projects || {};
  for (let dir = folder; ; dir = path.dirname(dir)) {
    if (projects[dir] && projects[dir].hasTrustDialogAccepted === true) return true;
    if (fs.existsSync(path.join(dir, ".git"))) return false;
    if (path.dirname(dir) === dir) return false;
  }
};
const untrustedExit = (folder) => {
  process.stdout.write("Starting background service…\n");
  process.stderr.write(`Error: Workspace not trusted. Run \`claude\` in ${folder} once and accept the trust dialog.\n`);
  process.exit(1);
};

const args = process.argv.slice(2);

if (args[0] === "__session") {
  void session(args[1]);
} else {
  main();
}

function record(extra) {
  const line = { argv: args, cwd: process.cwd(), env: Object.keys(process.env).sort(), at: Date.now(), ...extra };
  fs.appendFileSync(path.join(STATE, "calls.jsonl"), `${JSON.stringify(line)}\n`);
}

function flag(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function startSession(sessionId) {
  const child = spawn(process.execPath, [__filename, "__session", sessionId], { detached: true, stdio: "ignore", env: { ...process.env } });
  fs.appendFileSync(path.join(STATE, "pids.log"), `${child.pid}\n`);
  child.unref();
  return child.pid;
}

/** Whether the Inbox wrote the launched thread before calling us: its launch id is in the store. */
function threadWritten(dataDir, launchId) {
  if (!dataDir || !launchId) return false;
  const seen = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "launch" && depth > 0 && seen(p, depth - 1)) return true;
      } else if (/\.(jsonl|json)$/.test(entry.name)) {
        try {
          if (fs.readFileSync(p, "utf8").includes(launchId)) return true;
        } catch {}
      }
    }
    return false;
  };
  return seen(path.join(dataDir, "inbox"), 4);
}

function main() {
  const cfg = config();
  if (args[0] === "--version" || args[0] === "-v") {
    record({});
    process.stdout.write(`${cfg.version || "2.1.314"} (Claude Code)\n`);
    return;
  }
  if (args.includes("--bg")) {
    const settingsPath = flag("--settings");
    let settings = null;
    let mode = null;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      mode = fs.statSync(settingsPath).mode & 0o777;
    } catch {}
    const env = (settings && settings.env) || {};
    record({ settingsPath, settings, settingsMode: mode, threadExisted: threadWritten(env.PLANNOTATOR_DATA_DIR, env.PLANNOTATOR_LAUNCH) });
    if (cfg.fault === "untrusted" || (cfg.trustCheck && !trusted(process.cwd()))) untrustedExit(process.cwd());
    if (cfg.fault === "slow") {
      setTimeout(() => process.exit(1), 40_000);
      return;
    }
    // A CLI without auto mode: commander refuses the flag's value.
    if (cfg.refuseAuto && flag("--permission-mode") === "auto") {
      process.stderr.write("error: option '--permission-mode <mode>' argument 'auto' is invalid. Allowed choices are acceptEdits, bypassPermissions, default, dontAsk, plan.\n");
      process.exit(1);
    }
    // The person's own recorded consent and default mode (never the --settings file's consent).
    const home = process.env.HOME || "";
    const user = readJson(path.join(home, ".claude", "settings.json"), {}) || {};
    const global = readJson(path.join(home, ".claude.json"), {}) || {};
    const consent = user.skipDangerousModePermissionPrompt === true || global.bypassPermissionsModeAccepted === true;
    let permissionMode = flag("--permission-mode") || ((settings && settings.permissions) || {}).defaultMode || (user.permissions || {}).defaultMode || "default";
    const bypassAvailable = consent && (args.includes("--allow-dangerously-skip-permissions") || permissionMode === "bypassPermissions");
    if (permissionMode === "bypassPermissions" && !consent) permissionMode = "default";
    const background = () => {
      const sessionId = crypto.randomUUID();
      const id = sessionId.replace(/-/g, "").slice(0, 8);
      const name = flag("--name") || "session";
      saveAgent({ id, sessionId, cwd: process.cwd(), name, kind: "background", startedAt: Date.now(), status: "idle", state: "running", settingsPath, permissionMode, bypassAvailable });
      startSession(sessionId);
      process.stdout.write(`Starting background service…\nbackgrounded · ${id} · ${name} (idle — send a prompt to start)\n`);
    };
    // A busy supervisor: the session exists only once --bg answers (Delete may land meanwhile).
    if (cfg.bgDelayMs) setTimeout(background, cfg.bgDelayMs);
    else background();
    return;
  }
  record({});
  const [command, ref] = args;
  if (command === "agents") {
    const all = args.includes("--all");
    const cwd = flag("--cwd");
    const waiting = cfg.waiting;
    const list = allAgents()
      .filter((a) => all || (a.state !== "done" && a.state !== "stopped"))
      .filter((a) => !cwd || a.cwd === cwd)
      .map((a) => {
        const out = { pid: a.pid || null, id: a.id, cwd: a.cwd, kind: a.kind, startedAt: a.startedAt, sessionId: a.sessionId, name: a.name, status: a.status, state: a.state };
        if (waiting && a.state === "running" && a.status === "busy") return { ...out, status: "waiting", waitingFor: "permission prompt" };
        // A prompt the session plays lists what it waits for, as Claude Code does ("permission prompt").
        return a.status === "waiting" && a.waitingFor ? { ...out, waitingFor: a.waitingFor } : out;
      });
    process.stdout.write(`${JSON.stringify(list)}\n`);
    return;
  }
  const agent = ref ? findAgent(ref) : null;
  if (command === "stop" || command === "respawn" || command === "rm" || command === "attach") {
    if (!agent) {
      process.stderr.write(`No session ${ref}\n`);
      process.exit(1);
    }
  }
  if (command === "stop") {
    if (agent.pid) {
      try {
        process.kill(agent.pid, "SIGTERM");
      } catch {}
    }
    updateAgent(agent.sessionId, { state: "done", status: null, pid: null });
    process.stdout.write(`stopped ${agent.id}\n`);
    return;
  }
  if (command === "respawn") {
    // Claude checks trust before it restarts a background session too.
    if (cfg.trustCheck && !trusted(agent.cwd)) untrustedExit(agent.cwd);
    updateAgent(agent.sessionId, { state: "running", status: "idle" });
    startSession(agent.sessionId);
    process.stdout.write(`respawned ${agent.id}\n`);
    return;
  }
  if (command === "rm") {
    if (agent.pid) {
      try {
        process.kill(agent.pid, "SIGTERM");
      } catch {}
    }
    fs.rmSync(agentFile(agent.sessionId), { force: true });
    process.stdout.write(`removed ${agent.id}\n`);
    return;
  }
  // purge <folder>: every session of that folder goes (and, in Claude, its transcripts).
  if (command === "purge") {
    // Without -y/--yes Claude asks to confirm: with no terminal, nothing is purged.
    const folder = args.slice(1).filter((a) => !a.startsWith("-")).pop();
    // --dry-run: the plan as 2.1.314 prints it. The entries are the folder's and its git root's: a repository above
    // it maps to that root, and a linked worktree (a `.git` file, `gitdir: <repo>/.git/worktrees/<name>`) to its
    // main repository; a folder that is its own repository maps to itself.
    if (args.includes("--dry-run")) {
      const keys = [folder];
      const own = path.join(folder, ".git");
      let gitRoot = null;
      if (fs.existsSync(own) && !fs.lstatSync(own).isDirectory()) {
        const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(own, "utf8"));
        const main = gitdir && /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(gitdir[1].trim());
        if (main) gitRoot = main[1];
      } else if (!fs.existsSync(own)) {
        for (let dir = path.dirname(folder); dir !== path.dirname(dir); dir = path.dirname(dir)) {
          if (fs.existsSync(path.join(dir, ".git"))) {
            gitRoot = dir;
            break;
          }
        }
      }
      if (gitRoot && gitRoot !== folder) keys.unshift(gitRoot);
      const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "", ".claude");
      const lines = [``, `Purge plan for ${folder}:`, ``, `  dir:    ${path.join(configDir, "projects", folder.replace(/[^A-Za-z0-9]/g, "-"))}`, `           project transcripts (.jsonl) and memory/`];
      for (const key of keys) lines.push(`  config: projects["${key}"]`, `           project entry in ~/.claude.json (trust, history, MCP servers)`);
      lines.push(``, `Dry run: ${keys.length + 1} item(s) would be deleted.`, ``);
      process.stdout.write(lines.join("\n"));
      return;
    }
    if (!args.includes("--yes") && !args.includes("-y")) {
      process.stderr.write("fake claude: purge needs --yes without a terminal\n");
      process.exit(1);
    }
    for (const a of allAgents()) if (a.cwd === folder) fs.rmSync(agentFile(a.sessionId), { force: true });
    process.stdout.write(`purged ${folder}\n`);
    return;
  }
  if (command === "attach") return;
  process.stderr.write(`fake claude: unknown call ${args.join(" ")}\n`);
  process.exit(2);
}

/** The session: the mod's bridge poll, as a launched Claude Code session runs it. */
async function session(sessionId) {
  const agent = readJson(agentFile(sessionId), null);
  if (!agent) return;
  updateAgent(sessionId, { pid: process.pid });
  // A slow start (config `startDelayMs`): the Inbox shows "Starting" until the first poll.
  await sleep(config().startDelayMs || 0);
  const settings = readJson(agent.settingsPath, {});
  const env = settings.env || {};
  const dataDir = env.PLANNOTATOR_DATA_DIR;
  const registry = readJson(path.join(dataDir, "inbox", "inbox.json"), null);
  if (!registry) return;
  // Read again after a failed poll: a restarted Inbox may have a new port and token.
  let base = `http://127.0.0.1:${registry.port}`;
  let headers = { authorization: `Bearer ${registry.token}`, "content-type": "application/json" };
  const reconnect = () => {
    const next = readJson(path.join(dataDir, "inbox", "inbox.json"), null);
    if (!next) return;
    base = `http://127.0.0.1:${next.port}`;
    headers = { authorization: `Bearer ${next.token}`, "content-type": "application/json" };
  };
  /** The session's permission mode now (a hook's setMode changes it). */
  let mode = agent.permissionMode || "default";
  const startedAt = new Date(agent.startedAt).toISOString();
  let busy = false;
  let idleSince = new Date().toISOString();
  let stopped = false;
  /** The permission hook running now: it ends with the session, as Claude Code's own hooks do. */
  let hookChild = null;
  process.on("SIGTERM", () => {
    stopped = true;
    if (hookChild) {
      try {
        hookChild.kill("SIGTERM");
      } catch {}
    }
    process.exit(0);
  });
  const post = (p, body) => fetch(base + p, { method: "POST", headers, body: JSON.stringify({ session: sessionId, host: "claude-code", ...body }) });
  const taken = new Set();

  /** One permission prompt, as Claude Code plays it: the hook, then allow, deny, or blocked until answered locally. */
  const prompt = async (spec) => {
    const entry = (((settings.hooks || {}).PermissionRequest || [])[0] || { hooks: [] }).hooks[0];
    // Bypass mode asks nothing, but a safety check: to the hook when there is one, waived by the export only
    // when no PermissionRequest hook exists anywhere (the plugin's ExitPlanMode one counts, matcher ignored).
    const skipEnv = (env.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS || process.env.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS) === "1";
    const user = readJson(path.join(process.env.HOME || "", ".claude", "settings.json"), {}) || {};
    const pluginHook = config().pluginPermissionHook !== false && Object.entries(user.enabledPlugins || {}).some(([id, on]) => /^plannotator@/.test(id) && on === true);
    const anyHook = Boolean(entry && entry.command) || pluginHook;
    const personOnly = Boolean(spec.safetyCheck || spec.askRule);
    if (mode === "bypassPermissions" && (!personOnly || (!anyHook && skipEnv))) {
      fs.appendFileSync(path.join(STATE, "permissions.jsonl"), `${JSON.stringify({ sessionId, tool: spec.tool_name, input: spec.tool_input || {}, output: null, exitCode: null, outcome: "ran", asked: false, mode, ms: 0 })}\n`);
      return { tool: spec.tool_name, outcome: "ran" };
    }
    const event = {
      session_id: sessionId,
      transcript_path: path.join(STATE, `${sessionId}.jsonl`),
      cwd: agent.cwd,
      prompt_id: crypto.randomUUID(),
      permission_mode: mode,
      effort: { level: "low" },
      hook_event_name: "PermissionRequest",
      tool_name: spec.tool_name,
      tool_input: spec.tool_input || {},
      ...(spec.permission_suggestions ? { permission_suggestions: spec.permission_suggestions } : {}),
    };
    updateAgent(sessionId, { status: "waiting", waitingFor: "permission prompt" });
    const started = Date.now();
    let stdout = "";
    let exitCode = null;
    let local = false;
    if (entry && entry.command) {
      const hookEnv = { ...process.env, ...env, CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: agent.cwd };
      const child = spawn("/bin/sh", ["-c", `exec ${entry.command}`], { cwd: agent.cwd, env: hookEnv, stdio: ["pipe", "pipe", "ignore"] });
      hookChild = child;
      fs.appendFileSync(path.join(STATE, "hookpids.log"), `${child.pid}\n`);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stdin.end(JSON.stringify(event));
      let done = false;
      const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
      void exited.then(() => (done = true));
      while (!done && !stopped) {
        // A safety check's dialog shows only after the hook: nothing to answer in Terminal meanwhile.
        if (config().localAnswer && !personOnly) {
          // Answered in `claude attach`: Claude Code closes the dialog and ends the hook.
          local = true;
          child.kill("SIGTERM");
          break;
        }
        await sleep(100);
      }
      if (stopped) child.kill("SIGTERM");
      exitCode = await exited;
      // The hook's own result, as soon as it exits (permissions.jsonl follows once the prompt is settled).
      fs.appendFileSync(path.join(STATE, "hooks.jsonl"), `${JSON.stringify({ sessionId, tool: spec.tool_name, stdout, exitCode, local, ms: Date.now() - started })}\n`);
      hookChild = null;
    }
    let output = null;
    try {
      output = stdout.trim() ? JSON.parse(stdout) : null;
    } catch {}
    const decision = output && output.hookSpecificOutput && output.hookSpecificOutput.decision;
    // A safety check takes no allow from a hook: the dialog stays for the person (a deny still counts).
    const ignoredAllow = Boolean(personOnly && decision && decision.behavior === "allow");
    let outcome = local ? "local" : decision && !ignoredAllow ? (decision.behavior === "allow" ? "ran" : "denied") : "blocked";
    // A switch of mode: bypass only when it is available (the person's consent and the allow flag), else ignored.
    let modeIgnored = false;
    for (const update of (decision && decision.behavior === "allow" && !ignoredAllow && decision.updatedPermissions) || []) {
      if (!update || update.type !== "setMode") continue;
      if (update.mode === "bypassPermissions" && !agent.bypassAvailable) modeIgnored = true;
      else mode = update.mode;
    }
    // No decision (or an allow it ignored): the built-in dialog stays until someone answers it locally;
    // a safety check's dialog, up only now, blocks the call on its own after a while.
    const blockAt = spec.safetyCheck ? Date.now() + (config().safetyBlockMs ?? 120_000) : Infinity;
    while (outcome === "blocked" && !stopped && !config().localAnswer && Date.now() < blockAt) await sleep(150);
    if (outcome === "blocked") outcome = config().localAnswer ? "local" : "autoblocked";
    fs.appendFileSync(path.join(STATE, "permissions.jsonl"), `${JSON.stringify({ sessionId, tool: spec.tool_name, input: spec.tool_input || {}, output, exitCode, outcome, mode, modeIgnored, ignoredAllow, ms: Date.now() - started })}\n`);
    updateAgent(sessionId, { status: "busy", waitingFor: null });
    return { tool: spec.tool_name, outcome };
  };

  const work = async (command) => {
    await post("/api/inbox/bridge/event", { type: "delivered", id: command.id }).catch(() => {});
    fs.appendFileSync(path.join(STATE, "delivered.log"), `${command.id}\n`);
    await sleep(config().busyDelayMs || 0);
    busy = true;
    updateAgent(sessionId, { status: "busy" });
    await post("/api/inbox/bridge/event", { type: "state", busy: true }).catch(() => {});
    const outcomes = [];
    for (const spec of config().prompts || []) {
      if (stopped) return;
      outcomes.push(await prompt(spec));
    }
    const until = Date.now() + (config().workMs ?? 800);
    while (!stopped && (Date.now() < until || config().hold || config().waiting)) await sleep(150);
    const first = command.body.split("\n")[0].slice(0, 60);
    const tools = outcomes.length > 0 ? ` [${outcomes.map((o) => `${o.tool} ${o.outcome}`).join(", ")}]` : "";
    // `body`: the whole answer, in words (a screenshot's realistic reply); otherwise the line tests read.
    const body = config().body || `${config().answer || "Done"}: ${first} (${env.PLANNOTATOR_LAUNCH || "no launch"})${tools}`;
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "send_message", arguments: { body, reply_to: command.id, project_path: agent.cwd, agent_session: sessionId, agent_host: "claude-code" } },
      }),
    }).catch(() => {});
    busy = false;
    idleSince = new Date().toISOString();
    updateAgent(sessionId, { status: "idle" });
    await post("/api/inbox/bridge/event", { type: "state", busy: false }).catch(() => {});
  };

  let queue = Promise.resolve();
  while (!stopped) {
    const response = await post("/api/inbox/bridge/poll", { waitMs: 1000, project_path: agent.cwd, started_at: startedAt, busy, idle_since: busy ? null : idleSince }).catch(() => null);
    if (!response) {
      reconnect();
      await sleep(300);
      continue;
    }
    let commands = [];
    try {
      const parsed = await response.json();
      commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    } catch {}
    for (const command of commands) {
      if (!command || typeof command.id !== "string" || taken.has(command.id)) continue;
      taken.add(command.id);
      queue = queue.then(() => work(command));
    }
  }
}

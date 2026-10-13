/**
 * Fake agent CLIs for the Inbox's agent connections (packages/server/
 * inbox-agents.ts). A test makes a scratch root with a `home/` and a `bin/`
 * of fakes, and runs everything with HOME, XDG_CONFIG_HOME, CODEX_HOME,
 * CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR and OPENCODE_CONFIG_DIR pointing
 * inside it and PATH = that `bin/` plus /usr/bin:/bin. The real agent CLIs are
 * never run and the real home is never touched.
 *
 * Each fake records its argv (one JSON line per call in `calls.log`) and
 * does what its real CLI's `mcp add` / `mcp remove` does to its config file,
 * so a read after the add finds the entry. `FAKE_AGENT_FAIL=codex,gemini`
 * makes those exit 3 with a message; `FAKE_AGENT_HANG=amp` makes its `mcp`
 * call hang, `FAKE_AGENT_HANG_VERSION=amp` its `--version`;
 * `FAKE_AGENT_GRANDCHILD=codex` leaves a 30 s grandchild holding its output.
 *
 * Every fake process writes its pid under `pids/`. `remove()` proves none is
 * still running: one that is (a hung CLI the code under test left behind) is
 * killed, and `remove()` throws, failing the test. Only pids a fake wrote,
 * whose command line is still this root's fake script, are ever signalled.
 *
 * Node-safe (the Playwright specs run it under node): the fakes run on this
 * process's own runtime (`process.execPath`).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_AGENT_BINS = ["codex", "gemini", "devin", "amp", "cline", "pi", "opencode", "cursor-agent", "kiro-cli"] as const;
export type FakeAgentBin = (typeof FAKE_AGENT_BINS)[number];

export interface FakeAgents {
  root: string;
  home: string;
  bin: string;
  log: string;
  /** The environment every process of the test runs with. */
  env: Record<string, string>;
  /** Put these fakes on PATH (the others are absent: the agent is not installed). */
  install(...bins: FakeAgentBin[]): void;
  /** Every recorded call: `{ name, args }`. */
  calls(): { name: string; args: string[] }[];
  /** The fake processes still running (zombies count as gone): `{ pid, name, args }`. */
  live(): { pid: number; name: string; args: string[] }[];
  /** Kill every fake process still running (only this root's); returns what was running. */
  stopAll(): { pid: number; name: string; args: string[] }[];
  /**
   * Waits briefly for the fakes to end, kills any still running, removes the
   * root, and throws when one had to be killed: nothing may outlive a test.
   */
  remove(): void;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const FAKE = String.raw`
const fs = require("fs");
const path = require("path");
const name = process.argv[2];
const args = process.argv.slice(3);
// Every fake process (and its grandchild) leaves its pid, so the test can prove none outlives it.
if (process.env.FAKE_AGENT_PIDS) fs.writeFileSync(path.join(process.env.FAKE_AGENT_PIDS, String(process.pid)), JSON.stringify({ name, args }) + "\n");
const list = (v) => (v || "").split(",").filter(Boolean);
// The grandchild: a daemon an agent CLI leaves behind, holding the output it inherited.
if (args[0] === "--fake-grandchild") setTimeout(() => {}, 30000);
else start();
function start() {
  // Each real CLI's --version line (FAKE_<NAME>_VERSION overrides it), answered before anything is recorded.
  if (args[0] === "--version") {
    if (list(process.env.FAKE_AGENT_HANG_VERSION).includes(name)) {
      setInterval(() => {}, 1000);
      return;
    }
    const versions = { codex: "codex-cli 0.160.0", gemini: "0.43.0", devin: "devin 2026.7.16 (4723f912)", amp: "0.0.1781669741-g230fdd (released 2026-06-17)", pi: "0.99.1" };
    const override = process.env["FAKE_" + name.toUpperCase().replace(/-/g, "_") + "_VERSION"];
    process.stdout.write((override !== undefined ? override : versions[name] || "1.0.0") + "\n");
    process.exit(0);
  }
  fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ name, args }) + "\n");
  if (list(process.env.FAKE_AGENT_HANG).includes(name)) setInterval(() => {}, 1000);
  else main();
}
function main() {
  // A grandchild that keeps our stdout open after we exit (a daemon an agent CLI leaves behind).
  if (list(process.env.FAKE_AGENT_GRANDCHILD).includes(name)) {
    require("child_process").spawn(process.execPath, [__filename, name, "--fake-grandchild"], { stdio: "inherit" }).unref();
  }
  // FAKE_AGENT_FAIL_FILE: the same list read from a file, so a test can fix the failure between runs.
  const failFile = process.env.FAKE_AGENT_FAIL_FILE;
  const failing = list(process.env.FAKE_AGENT_FAIL).concat(failFile && fs.existsSync(failFile) ? list(fs.readFileSync(failFile, "utf8").trim()) : []);
  if (failing.includes(name)) {
    process.stderr.write("boom: " + name + " could not write its config (permission denied)\n");
    process.exit(3);
  }
  // The fake runs only with HOME set to the test's scratch home (createFakeAgents().env).
  const fakeHome = process.env["HOME"];
  const xdg = process.env.XDG_CONFIG_HOME || path.join(fakeHome, ".config");
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
  const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
  const jsonAgent = (file, key, nameAt, commandAt) => {
    const sub = args[1];
    const config = readJson(file);
    config[key] = config[key] || {};
    if (sub === "add") {
      const server = args[nameAt];
      const words = args.slice(commandAt).filter((w) => w !== "--");
      config[key][server] = { command: words[0], args: words.slice(1) };
      writeJson(file, config);
    } else if (sub === "remove") {
      delete config[key][args[args.length - 1]];
      writeJson(file, config);
    }
  };
  if (args[0] !== "mcp") process.exit(0);
  switch (name) {
    case "codex": {
      const file = path.join(process.env.CODEX_HOME || path.join(fakeHome, ".codex"), "config.toml");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (args[1] === "add") {
        const words = args.slice(args.indexOf("--") + 1);
        const table = "[mcp_servers." + args[2] + "]\ncommand = " + JSON.stringify(words[0]) + "\nargs = " + JSON.stringify(words.slice(1)) + "\n";
        fs.writeFileSync(file, (text && !text.endsWith("\n") ? text + "\n" : text) + (text ? "\n" : "") + table);
      } else if (args[1] === "remove") {
        const lines = text.split("\n");
        const out = [];
        let skipping = false;
        for (const line of lines) {
          if (/^\[/.test(line)) skipping = line.trim() === "[mcp_servers." + args[2] + "]";
          if (!skipping) out.push(line);
        }
        fs.writeFileSync(file, out.join("\n"));
      }
      break;
    }
    case "gemini":
      jsonAgent(path.join(fakeHome, ".gemini", "settings.json"), "mcpServers", 4, 5);
      break;
    case "devin":
      jsonAgent(path.join(xdg, "devin", "config.json"), "mcpServers", 4, 5);
      break;
    case "amp":
      jsonAgent(path.join(xdg, "amp", "settings.json"), "amp.mcpServers", 2, 3);
      break;
    case "pi":
      jsonAgent(path.join(process.env.PI_CODING_AGENT_DIR || path.join(fakeHome, ".pi", "agent"), "mcp.json"), "mcpServers", 2, 3);
      break;
    default:
      break;
  }
}
`;

/** A scratch root with a home and an empty bin of fakes. */
export function createFakeAgents(prefix = "plannotator-agents-"): FakeAgents {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");
  const pids = join(root, "pids");
  mkdirSync(pids, { recursive: true });
  const script = join(root, "fake-agent.js");
  writeFileSync(script, FAKE);
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: tmpdir(),
    FAKE_AGENT_LOG: log,
    FAKE_AGENT_PIDS: pids,
  };
  return {
    root,
    home,
    bin,
    log,
    env,
    install(...bins) {
      for (const name of bins) {
        const file = join(bin, name);
        writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${script}' '${name}' "$@"\n`);
        chmodSync(file, 0o755);
      }
    },
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; args: string[] });
    },
    live() {
      const found: { pid: number; name: string; args: string[] }[] = [];
      if (!existsSync(pids)) return found;
      for (const entry of readdirSync(pids)) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid <= 1) continue;
        const ps = spawnSync("ps", ["-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8" });
        const line = (ps.stdout ?? "").trim();
        if (ps.status !== 0 || !line) continue;
        const [stat = "", ...command] = line.split(/\s+/);
        // A zombie has ended (its parent has not reaped it yet); a reused pid is not ours.
        if (stat.startsWith("Z") || !command.join(" ").includes(script)) continue;
        let call = { name: "?", args: [] as string[] };
        try {
          call = JSON.parse(readFileSync(join(pids, entry), "utf8")) as typeof call;
        } catch {
          // Written as it started; the pid alone is enough.
        }
        found.push({ pid, ...call });
      }
      return found;
    },
    stopAll() {
      const running = this.live();
      for (const { pid } of running) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Ended meanwhile.
        }
      }
      for (let waited = 0; waited < 2000 && this.live().length > 0; waited += 50) sleepSync(50);
      return running;
    },
    remove() {
      // A run the code under test stopped is gone at once; give a SIGKILL in flight a moment.
      for (let waited = 0; waited < 1500 && this.live().length > 0; waited += 50) sleepSync(50);
      const survivors = this.stopAll();
      rmSync(root, { recursive: true, force: true });
      if (survivors.length > 0) {
        const named = survivors.map((s) => `${s.pid} (${s.name} ${s.args.join(" ")})`).join(", ");
        throw new Error(`fake agent processes outlived the test and were killed: ${named}`);
      }
    },
  };
}

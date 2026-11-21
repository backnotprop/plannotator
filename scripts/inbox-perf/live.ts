/**
 * The live baseline: ONE sandboxed Inbox over a copy of a seeded world
 * (scripts/inbox-perf/seed.ts), its routes timed with plain HTTP, cold and
 * warm, then its idle CPU and memory, then its own debug log's `loop_stall`
 * and `slow_req` lines.
 *
 *   bun scripts/inbox-perf/live.ts --root /tmp/inbox-perf/medium --port 47953 [--out results.json] [--warm 20] [--idle 60]
 *
 * The sandbox (scripts/inbox-perf/live-inbox.sh): `env -i` with every variable
 * spelled out, HOME and every agent or config home in a new scratch folder,
 * PATH with only a link to bun and the system folders (checked: no claude,
 * codex, pi, opencode or t3), PLANNOTATOR_TEST_SANDBOX=1, launch and routines
 * off in the copy's config.json, the relay at a dead port. The port is pinned
 * by seeding the copy's inbox/inbox.json with a dead pid and `--port` (the
 * Inbox reuses the port it last had). Before the first request the Inbox's own
 * environment is read back (`ps eww`) and checked; the run stops at once if it
 * is not the sandbox's, or if any output names the real Inbox's port.
 *
 * Live agent sessions: the seed's live sessions (Codex aside, which never
 * polls) long-poll /api/inbox/bridge/poll as the connections do, and say they
 * took what they are handed. The Inbox is stopped by its exact pid at the end.
 */

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { refuseRealDataDir } from "../../tests/helpers/real-data-dir";
import { summarize, type Timing } from "./bench-store";
import type { PerfManifest } from "./seed";

const REAL_PORTS = [59812, 58437, 58455];
const AGENT_CLIS = ["claude", "codex", "pi", "opencode", "t3"];

function flagOf(name: string): string | undefined {
  const list = process.argv.slice(2);
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** `ps` cumulative CPU time ("[[dd-]hh:]mm:ss.ss") in seconds. */
function cpuSeconds(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = rest!.split(":").map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return Number(days) * 86400 + s;
}

function psSample(pid: number): { cpu: number; rssMb: number; cpuTime: number } | null {
  const out = Bun.spawnSync(["/bin/ps", "-o", "%cpu=,rss=,time=", "-p", String(pid)], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString().trim();
  if (!out) return null;
  const [cpu, rss, time] = out.split(/\s+/);
  return { cpu: Number(cpu), rssMb: Math.round(Number(rss) / 102.4) / 10, cpuTime: cpuSeconds(time!) };
}

async function main(): Promise<void> {
  const root = resolve(flagOf("--root") ?? "");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as PerfManifest;
  const port = Number(flagOf("--port") ?? 0);
  const warmRuns = Number(flagOf("--warm") ?? 20);
  const idleSeconds = Number(flagOf("--idle") ?? 60);
  const repo = resolve(import.meta.dir, "..", "..");
  const log = (line: string) => process.stderr.write(`${line}\n`);
  if (!port || port < 1024 || REAL_PORTS.includes(port)) throw new Error(`--port: a free high port, never ${REAL_PORTS.join(", ")}`);
  if (!(await portFree(port))) throw new Error(`port ${port} is taken`);

  // The scratch world: a copy of the seed's data dir, a home, a PATH with only bun.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `inbox-perf-live-${manifest.preset}-`)));
  const dataDir = join(scratch, "data");
  cpSync(manifest.dataDir, dataDir, { recursive: true });
  refuseRealDataDir(dataDir, "scripts/inbox-perf/live.ts");
  for (const dir of ["home", "bin", "gh", "xdg", "codex"]) mkdirSync(join(scratch, dir), { recursive: true });
  symlinkSync(process.execPath, join(scratch, "bin", "bun"));
  for (const dir of [join(scratch, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    for (const cli of AGENT_CLIS) if (existsSync(join(dir, cli))) throw new Error(`${dir}/${cli} is on the sandbox PATH`);
  }
  // Launch off, routines off (and the Inbox's debug log on through the env).
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: false }, inboxScheduledThreads: false }));
  // Pin the port: an entry of a dead Inbox that had it.
  let deadPid = 99_000;
  while (pidAlive(deadPid)) deadPid += 1;
  const version = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  writeFileSync(
    join(dataDir, "inbox", "inbox.json"),
    JSON.stringify({ v: 1, pid: deadPid, port, url: `http://127.0.0.1:${port}`, version, token: randomBytes(32).toString("hex"), serverSession: "seeded-dead-entry", startedAt: new Date(Date.now() - 86_400_000).toISOString() }),
    { mode: 0o600 },
  );

  const stdoutFile = join(scratch, "inbox.stdout.log");
  const stderrFile = join(scratch, "inbox.stderr.log");
  const spawnAt = performance.now();
  const proc = Bun.spawn(["/bin/sh", join(repo, "scripts", "inbox-perf", "live-inbox.sh"), repo, dataDir, scratch], {
    env: { PATH: "/usr/bin:/bin" },
    cwd: scratch,
    stdin: "ignore",
    stdout: Bun.file(stdoutFile),
    stderr: Bun.file(stderrFile),
  });
  const pid = proc.pid;
  const output = () => `${existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf8") : ""}${existsSync(stderrFile) ? readFileSync(stderrFile, "utf8") : ""}`;
  const stop = async (why: string) => {
    if (pidAlive(pid)) process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50 && pidAlive(pid); i++) await Bun.sleep(100);
    if (pidAlive(pid)) process.kill(pid, "SIGKILL");
    log(`stopped the Inbox (pid ${pid}): ${why}`);
  };
  const realPortSeen = () => REAL_PORTS.some((p) => output().includes(`:${p}`));

  // Before any request: the process's own environment must be the sandbox's.
  let envLine = "";
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    envLine = Bun.spawnSync(["/bin/ps", "eww", "-o", "command=", "-p", String(pid)], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString();
    if (envLine.includes("apps/hook/server/index.ts")) break;
  }
  const expected = [`PLANNOTATOR_DATA_DIR=${dataDir}`, `HOME=${scratch}/home`, "PLANNOTATOR_TEST_SANDBOX=1", "PLANNOTATOR_INBOX_CONNECT=0", "PLANNOTATOR_RELAY_URL=http://127.0.0.1:9", `PATH=${scratch}/bin:/usr/bin:/bin:/usr/sbin:/sbin`, "PLANNOTATOR_INBOX_DEBUG=1"];
  const missing = expected.filter((e) => !envLine.includes(e));
  if (!envLine.includes("apps/hook/server/index.ts") || missing.length > 0) {
    await stop("environment check failed");
    throw new Error(`the Inbox's environment is not the sandbox's: missing ${missing.join(", ")}`);
  }
  log(`pid ${pid}: environment checked (${expected.length} variables, the sandbox's)`);

  // Ready: the Inbox rewrote the registry with its own pid (read from the file, no request).
  let entry: { pid: number; port: number; token: string } | null = null;
  for (let i = 0; i < 600; i++) {
    if (realPortSeen()) {
      await stop("the output named the real Inbox's port");
      throw new Error("the sandbox attached to the real Inbox: stopped");
    }
    try {
      const read = JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")) as { pid: number; port: number; token: string };
      if (read.pid === pid) {
        entry = read;
        break;
      }
    } catch {
      // Being rewritten.
    }
    if (!pidAlive(pid)) throw new Error(`the Inbox exited:\n${output()}`);
    await Bun.sleep(50);
  }
  if (!entry) {
    await stop("never became ready");
    throw new Error(`the Inbox did not start:\n${output()}`);
  }
  if (entry.port !== port) {
    await stop("port not pinned");
    throw new Error(`the Inbox took port ${entry.port}, not ${port}`);
  }
  const base = `http://127.0.0.1:${port}`;
  const startup = { registryMs: Math.round(performance.now() - spawnAt), healthMs: 0 };
  for (let i = 0; i < 200; i++) {
    const ok = await fetch(`${base}/api/inbox/health`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await Bun.sleep(50);
  }
  startup.healthMs = Math.round(performance.now() - spawnAt);
  log(`ready: registry at ${startup.registryMs} ms, health at ${startup.healthMs} ms`);
  const memoryAtReady = psSample(pid);

  // Live agent sessions, polling as the connections do.
  const token = entry.token;
  const pollers = manifest.sessions.filter((s) => s.live && s.host !== "codex");
  const control = new AbortController();
  let delivered = 0;
  let polls = 0;
  const pollLoop = async (s: PerfManifest["sessions"][number]) => {
    const startedAt = Date.now() - 3_600_000;
    while (!control.signal.aborted) {
      try {
        const answer = (await fetch(`${base}/api/inbox/bridge/poll`, {
          method: "POST",
          signal: control.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session: s.session, host: s.host, waitMs: 25_000, tags: true, project_path: s.folder, session_folder: s.folder, started_at: startedAt, busy: false, idle_since: startedAt, ...(s.plugin ? { plugin: { ...s.plugin, loaded_at: startedAt } } : {}) }),
        }).then((r) => r.json())) as { commands?: { id?: string }[] };
        polls += 1;
        for (const command of answer.commands ?? []) {
          if (!command.id) continue;
          await fetch(`${base}/api/inbox/bridge/event`, {
            method: "POST",
            signal: control.signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ session: s.session, host: s.host, type: "delivered", id: command.id }),
          });
          delivered += 1;
        }
      } catch {
        if (!control.signal.aborted) await Bun.sleep(500);
      }
    }
  };
  const loops = pollers.map(pollLoop);
  await Bun.sleep(5_000);
  log(`${pollers.length} sessions polling (${polls} polls answered, ${delivered} items taken)`);

  // Routes, as the window asks them.
  const thread = manifest.longThread;
  const sample = manifest.sampleThreads[0]!;
  const routes: [string, string][] = [
    ["thread list", "/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1"],
    ["thread read (400 messages)", `/api/inbox/threads/${thread}`],
    ["thread read (ordinary)", `/api/inbox/threads/${sample}`],
    ["thread sessions", `/api/inbox/threads/${sample}/sessions`],
    ["live sessions", "/api/inbox/sessions"],
    ["agents", "/api/inbox/agents"],
    ["settings", "/api/inbox/settings?store=0"],
    ["projects", "/api/inbox/projects"],
    ["archived", "/api/inbox/threads/archived"],
    ["health", "/api/inbox/health"],
  ];
  const get = async (path: string) => {
    const t0 = performance.now();
    const response = await fetch(`${base}${path}`, { headers: { Accept: "application/json" } });
    const body = await response.arrayBuffer();
    return { ms: performance.now() - t0, status: response.status, bytes: body.byteLength, serverTiming: response.headers.get("server-timing"), body };
  };
  const cold: Record<string, unknown>[] = [];
  for (const [name, path] of routes) {
    const r = await get(path);
    cold.push({ name, path, ms: Math.round(r.ms * 100) / 100, status: r.status, bytes: r.bytes, serverTiming: r.serverTiming });
    log(`  cold ${name.padEnd(28)} ${r.ms.toFixed(1).padStart(8)} ms  ${r.status}  ${r.bytes} B`);
  }
  // Search: the first query starts the index build (it answers `indexing` after 250 ms); the build time is until a query answers.
  const searchPath = "/api/inbox/search?q=retry%20queue";
  const firstSearch = await get(searchPath);
  const buildStart = performance.now();
  let searchReadyMs = 0;
  for (let i = 0; i < 600; i++) {
    const r = await get(searchPath);
    const parsed = JSON.parse(new TextDecoder().decode(r.body)) as { indexing?: boolean };
    if (!parsed.indexing) {
      searchReadyMs = Math.round(performance.now() - buildStart + firstSearch.ms);
      break;
    }
    await Bun.sleep(50);
  }
  cold.push({ name: "search (first query)", path: searchPath, ms: Math.round(firstSearch.ms * 100) / 100, status: firstSearch.status, bytes: firstSearch.bytes, indexReadyMs: searchReadyMs });
  log(`  cold search: first answer ${firstSearch.ms.toFixed(1)} ms, index ready after ${searchReadyMs} ms`);

  const warm: Timing[] = [];
  for (const [name, path] of [...routes, ["search", searchPath] as [string, string], ["search (another query)", "/api/inbox/search?q=deploy%20rollback"] as [string, string]]) {
    const samples: number[] = [];
    let bytes = 0;
    let serverTiming: string | null = null;
    for (let i = 0; i < warmRuns; i++) {
      const r = await get(path);
      samples.push(r.ms);
      bytes = r.bytes;
      serverTiming = r.serverTiming;
    }
    const t = summarize(name, samples, { path, bytes, serverTiming });
    warm.push(t);
    log(`  warm ${name.padEnd(28)} median ${t.median.toFixed(1).padStart(8)} ms  p95 ${t.p95.toFixed(1).padStart(8)} ms`);
  }

  // Idle: no window, sessions still polling. Then idle with one window's event stream open.
  const idle = async (label: string) => {
    const samples: { t: number; cpu: number; rssMb: number }[] = [];
    const first = psSample(pid)!;
    const t0 = performance.now();
    for (let s = 0; s < idleSeconds; s += 2) {
      await Bun.sleep(2_000);
      const sample = psSample(pid);
      if (sample) samples.push({ t: Math.round((performance.now() - t0) / 1000), cpu: sample.cpu, rssMb: sample.rssMb });
    }
    const last = psSample(pid)!;
    const wall = (performance.now() - t0) / 1000;
    const avgCpu = Math.round(((last.cpuTime - first.cpuTime) / wall) * 1000) / 10;
    const result = { label, seconds: Math.round(wall), avgCpuPercent: avgCpu, psCpuMedian: summarize("ps", samples.map((s) => s.cpu)).median, psCpuMax: Math.max(...samples.map((s) => s.cpu)), rssMbStart: first.rssMb, rssMbEnd: last.rssMb, rssMbMax: Math.max(...samples.map((s) => s.rssMb)), samples };
    log(`  idle (${label}): ${avgCpu}% CPU on average over ${Math.round(wall)} s; RSS ${first.rssMb} -> ${last.rssMb} MB`);
    return result;
  };
  const idleNoWindow = await idle("no window");
  const windowStream = new AbortController();
  void fetch(`${base}/api/inbox/events?window=perfharnesswindow01`, { signal: windowStream.signal, headers: { Accept: "text/event-stream" } })
    .then(async (r) => {
      const reader = r.body!.getReader();
      for (;;) if ((await reader.read()).done) break;
    })
    .catch(() => {});
  await Bun.sleep(1_000);
  const idleWindow = await idle("one window's event stream open");
  windowStream.abort();
  const memoryAtEnd = psSample(pid);

  control.abort();
  await Promise.allSettled(loops);
  await stop("done");
  await proc.exited;

  // The Inbox's own debug log.
  const debugLines: Record<string, unknown>[] = [];
  for (const file of ["debug.log.1", "debug.log"]) {
    const path = join(dataDir, "inbox", file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!/loop_stall|slow_req|store_load/.test(line)) continue;
      try {
        debugLines.push(JSON.parse(line));
      } catch {
        debugLines.push({ raw: line.slice(0, 500) });
      }
    }
  }
  const out = output();
  const spawnLines = out.split("\n").filter((line) => /spawn|respawn|resume|launch/i.test(line));
  const result = {
    preset: manifest.preset,
    label: flagOf("--label") ?? "main",
    machine: { platform: process.platform, arch: process.arch, bun: Bun.version, cpus: navigator.hardwareConcurrency, loadavgAtEnd: loadavg() },
    shape: manifest.shape,
    counts: manifest.counts,
    port,
    pid,
    envChecked: expected,
    startup,
    memoryAtReady,
    memoryAtEnd,
    pollers: pollers.length,
    polls,
    delivered,
    cold,
    warm,
    idle: [idleNoWindow, idleWindow],
    debug: debugLines,
    realPortSeen: realPortSeen(),
    spawnOrLaunchOutputLines: spawnLines.slice(0, 40),
    outputTail: out.split("\n").slice(-40),
    scratch,
  };
  const file = flagOf("--out");
  if (file) writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  log(`debug lines: ${debugLines.length}; real port seen: ${result.realPortSeen}; spawn/launch output lines: ${spawnLines.length}`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

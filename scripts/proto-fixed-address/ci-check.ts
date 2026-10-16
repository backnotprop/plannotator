/**
 * PROTOTYPE (proto/inbox-fixed-address): the whole fixed-address flow on a CI
 * runner (ubuntu-latest, windows-latest, macos-latest), everything except a
 * human typing a password: the runner is already admin (passwordless sudo,
 * or an elevated Windows session), so the Inbox runs its privileged step
 * with PLANNOTATOR_PROTO_NAME_ELEVATE=sudo (Linux, macOS) or =direct (Windows).
 *
 *   bun scripts/proto-fixed-address/ci-check.ts <shots dir>
 *
 * Steps, each recorded (a JSON summary on stdout and in $GITHUB_STEP_SUMMARY):
 *   1. start a scratch Inbox (temp data dir, prototype on)
 *   2. click Sure in its window (headless Chromium, ui-flow.ts --click-sure):
 *      portless installed into the data dir, `service install`, alias, verify
 *   3. http://inbox.plannotator.localhost/api/inbox/health answers this
 *      Inbox (by the name; when this runner cannot resolve it, by
 *      127.0.0.1:80 with the name as Host, recorded as a finding); nothing
 *      of portless listens on 443 and no CA was made
 *   4. browsers load it as a secure context with notifications available
 *      (browser-check.ts); no certificate anywhere
 *   5. port change: the Inbox stopped, its old port held, started again on a
 *      new port; the name answers the new Inbox with no privileged step
 *   6. --name off: the alias goes and the name no longer answers this Inbox
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const shots = resolve(process.argv[2] ?? "proto-shots");
mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "pn-fixed-address-"));
const NAME = "http://inbox.plannotator.localhost";
const portlessState = join(homedir(), ".portless");
const env = {
  ...process.env,
  PLANNOTATOR_DATA_DIR: data,
  PLANNOTATOR_INBOX_CONNECT: "0",
  PLANNOTATOR_INBOX_NOTES: "0",
  PLANNOTATOR_UPDATE_CHECK: "0",
  PLANNOTATOR_AUTO_UPDATE: "0",
  PLANNOTATOR_PROTO_FIXED_ADDRESS: "1",
  PLANNOTATOR_PROTO_NAME_ELEVATE: process.platform === "win32" ? "direct" : "sudo",
};

const results: { step: string; ok: boolean; finding?: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
};
/** Something this run exists to find out, expected on this OS: shown, not counted as a failure. */
const finding = (step: string, detail: string) => {
  results.push({ step, ok: true, finding: true, detail });
  console.log(`FINDING ${step}: ${detail}`);
};
const run = (args: string[], options: SpawnSyncOptions = {}) => {
  const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", timeout: 10 * 60_000, ...options });
  return { code: result.status, out: `${result.stdout ?? ""}`, err: `${result.stderr ?? ""}` };
};
/**
 * Playwright under Node: under Bun on Windows, Chromium's launch never
 * finishes (Playwright talks to it over extra stdio pipes; the first CI run
 * timed out at 180 s). Node 24 runs these .ts files by stripping types.
 */
const runNode = (args: string[]) => {
  const result = spawnSync("node", args, { cwd: repo, env, encoding: "utf8", timeout: 10 * 60_000 });
  return { code: result.status, out: `${result.stdout ?? ""}`, err: `${result.stderr ?? ""}` };
};
const registry = () => JSON.parse(readFileSync(join(data, "inbox", "inbox.json"), "utf8")) as { port: number; token: string; serverSession: string; url: string };
const nameState = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/api/inbox/name`)).json()) as { name: Record<string, unknown> }).name;
/** The serverSession the name answers: by the name itself, else through 127.0.0.1:80 with the name as Host. */
const nameSession = async (): Promise<{ session: string; via: "name" | "127.0.0.1:80" }> => {
  const read = async (url: string, headers: Record<string, string>) => {
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return `HTTP ${response.status} ${response.headers.get("location") ?? ""}`.trim();
    return ((await response.json()) as { serverSession?: string }).serverSession ?? "(no serverSession)";
  };
  try {
    return { session: await read(`${NAME}/api/inbox/health`, {}), via: "name" };
  } catch (error) {
    try {
      return { session: await read("http://127.0.0.1:80/api/inbox/health", { host: "inbox.plannotator.localhost" }), via: "127.0.0.1:80" };
    } catch (second) {
      return { session: `error: ${String(error)}; ${String(second)}`, via: "name" };
    }
  }
};
/** Whether portless answers on 127.0.0.1:<port> (its HTTPS proxy accepts plain HTTP on its TLS port and says X-Portless). */
const portlessOn = async (port: number): Promise<boolean> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "inbox.plannotator.localhost" }, redirect: "manual", signal: AbortSignal.timeout(2500) });
    return response.headers.get("x-portless") !== null;
  } catch {
    return false;
  }
};
const startInbox = () => {
  const started = run([join(repo, "apps/hook/server/index.ts"), "inbox", "--background"], { cwd: data });
  if (started.code !== 0) throw new Error(`inbox --background failed: ${started.err}`);
  return started.out.trim();
};
const stopInbox = async () => {
  const { port, token } = registry();
  await fetch(`http://127.0.0.1:${port}/api/inbox/control/stop`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  for (let i = 0; i < 50; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/api/inbox/health`).then(() => true, () => false);
    if (!up) return;
    await Bun.sleep(200);
  }
};

try {
  // 1.
  const url = startInbox();
  const first = registry();
  record("start scratch inbox", true, `${url} (data ${data})`);

  // 2.
  const flow = runNode([join(repo, "scripts/proto-fixed-address/ui-flow.ts"), url, shots, "--click-sure"]);
  console.log(flow.out, flow.err);
  const afterSure = await nameState(first.port);
  record("Sure in the window -> on", afterSure.status === "on", `status ${afterSure.status}; reason ${afterSure.reason}; probe ${afterSure.probe}`);
  console.log("commands run:\n" + ((afterSure.log as string[] | undefined) ?? []).join("\n"));
  const privileged = ((afterSure.log as string[] | undefined) ?? []).filter((line) => /'?service'? '?install'?/.test(line));
  if (afterSure.status === "failed" && /Port 80 is already used by another program/.test(String(afterSure.reason))) {
    // The runner's port 80 is someone else's (Windows images: http.sys, PID 4). What must hold: a plain
    // message, nothing installed, no privileged command. The rest of the flow needs the port.
    finding(`${process.platform}: port 80 is held by another program on this runner; Sure refused before asking`, String(afterSure.reason));
    record("the refusal ran no privileged command and installed nothing", privileged.length === 0 && !existsSync(join(data, "portless")), `${privileged.length} privileged; portless dir ${existsSync(join(data, "portless")) ? "exists" : "absent"}`);
    throw new Error("stop: port 80 is not free here");
  }
  record("exactly one privileged command, plain HTTP", privileged.length === 1 && /--no-tls/.test(privileged[0] ?? ""), privileged.join(" | ").slice(0, 300) || "(none run)");
  const moved = /tab moved to the name: true/.test(flow.out);
  const movedLine = (/tab moved to the name: .*/.exec(flow.out) ?? ["(no line)"])[0];
  record("the tab moved itself to the name", moved, movedLine);

  // 3.
  const named1 = await nameSession();
  record("http name answers this Inbox", named1.session === first.serverSession, `${named1.session} (via ${named1.via})`);
  if (named1.via !== "name") finding(`${process.platform}: this runner's resolver does not map inbox.plannotator.localhost (browsers do it themselves)`, named1.via);
  record("no certificate: portless made no CA", !existsSync(join(portlessState, "ca.pem")), existsSync(join(portlessState, "ca.pem")) ? "ca.pem exists" : "no ca.pem");
  const on443 = await portlessOn(443);
  record("no portless on 443 (no HTTPS proxy)", !on443, on443 ? "portless answers on 127.0.0.1:443" : "not on 443");

  // 4.
  const browsers = runNode([join(repo, "scripts/proto-fixed-address/browser-check.ts"), first.serverSession, NAME]);
  console.log(browsers.out, browsers.err);
  record("a browser loads the name as a secure context with notifications", browsers.code === 0, browsers.out.trim().split("\n").join(" | "));

  // 5.
  const listener = afterSure.listener_port;
  await stopInbox();
  const squatter = Bun.serve({ hostname: "127.0.0.1", port: first.port, fetch: () => new Response("held") });
  try {
    startInbox();
    const second = registry();
    record("restarted on a new port", second.port !== first.port, `${first.port} -> ${second.port}`);
    let state = await nameState(second.port);
    for (let i = 0; i < 60 && state.status === "working"; i++) {
      await Bun.sleep(500);
      state = await nameState(second.port);
    }
    record("name on again after the move, no privileged step", state.status === "on", `status ${state.status}; listener ${state.listener_port} (was ${listener}); ${state.reason ?? ""}`);
    console.log("commands run after the move:\n" + ((state.log as string[] | undefined) ?? []).join("\n"));
    const named2 = await nameSession();
    record("http name answers the restarted Inbox", named2.session === second.serverSession, `${named2.session} (via ${named2.via})`);

    // 6.
    const off = run([join(repo, "apps/hook/server/index.ts"), "inbox", "--name", "off"]);
    // portless reloads routes.json on a file watch, and the listener closes a moment after the answer.
    let session3 = (await nameSession()).session;
    for (let i = 0; i < 30 && session3 === second.serverSession; i++) {
      await Bun.sleep(200);
      session3 = (await nameSession()).session;
    }
    record("--name off: the name no longer answers this Inbox", off.code === 0 && session3 !== second.serverSession, session3);
    await stopInbox();
  } finally {
    squatter.stop(true);
  }
} catch (error) {
  if (!String(error).includes("stop: port 80 is not free here")) record("unexpected", false, String(error));
}

const lines = [`### Fixed address on ${process.platform}`, "", "| | step | detail |", "|---|---|---|", ...results.map((r) => `| ${r.finding ? "⚠️" : r.ok ? "✅" : "❌"} | ${r.step} | ${r.detail.replace(/\|/g, "\\|").slice(0, 400)} |`)];
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
console.log(JSON.stringify({ platform: process.platform, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);

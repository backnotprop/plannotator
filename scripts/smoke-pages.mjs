#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const binary = resolve(arg("binary"));
const replacement = resolve(arg("replacement"));
const digestsFile = resolve(arg("digests"));
const bunArg = arg("bun");
const bun = !bunArg ? null : /[\\/]/.test(bunArg) ? resolve(bunArg) : bunArg;
let port = Number(arg("port-base", "19560"));
const isWindows = process.platform === "win32";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digests = new Map();
for (const line of readFileSync(digestsFile, "utf8").split("\n")) {
  const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
  if (m) digests.set(basename(m[2]), m[1]);
}
for (const name of ["index.html", "review.html", "shape.html"]) {
  if (!digests.has(name)) throw new Error(`no digest for ${name} in ${digestsFile}`);
}

let failures = 0;
const ok = (msg) => console.log(`OK: ${msg}`);
const fail = (msg) => {
  failures++;
  console.error(`FAIL: ${msg}`);
};

const sandbox = mkdtempSync(join(tmpdir(), "plannotator-smoke-pages-"));
const env = {
  ...process.env,
  HOME: join(sandbox, "home"),
  USERPROFILE: join(sandbox, "home"),
  PLANNOTATOR_DATA_DIR: join(sandbox, "data"),
  PLANNOTATOR_UPDATE_CHECK: "0",
  PLANNOTATOR_INBOX_CONNECT: "0",
};
mkdirSync(env.HOME, { recursive: true });

function get(p, path, headers = {}) {
  return new Promise((done, reject) => {
    const req = request({ host: "127.0.0.1", port: p, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout on ${path}`)));
    req.end();
  });
}

async function waitFor(p, path, child, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`exited with ${child.exitCode} before answering ${path}`);
    try {
      const res = await get(p, path);
      if (res.status === 200) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no answer on ${path} within ${seconds} s`);
}

function start(file, argv, extraEnv, cwd) {
  const child = spawn(file, argv, { cwd, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], detached: !isWindows });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  child.log = () => log;
  return child;
}

function stop(child) {
  if (child.exitCode !== null) return;
  if (isWindows) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

function replaceLikeInstaller(target, source) {
  const dir = resolve(target, "..");
  const staged = join(dir, `.plannotator.new.${process.pid}`);
  copyFileSync(source, staged);
  if (isWindows) {
    renameSync(target, `${target}.old`);
    renameSync(staged, target);
  } else {
    chmodSync(staged, 0o755);
    renameSync(staged, target);
  }
  if (sha256(readFileSync(target)) !== sha256(readFileSync(source))) throw new Error("the replacement did not land");
}

function checkPage(label, res, digest, encoding, contentType = "text/html") {
  if (res.status !== 200) return fail(`${label}: status ${res.status}`);
  const type = res.headers["content-type"];
  if (type !== contentType) fail(`${label}: Content-Type ${type}`);
  let body = res.body;
  if (encoding === "identity") {
    if (res.headers["content-encoding"]) fail(`${label}: unexpected Content-Encoding ${res.headers["content-encoding"]}`);
  } else {
    if (res.headers["content-encoding"] !== encoding) return fail(`${label}: Content-Encoding ${res.headers["content-encoding"]}, expected ${encoding}`);
    if (res.headers.vary !== "Accept-Encoding") fail(`${label}: Vary ${res.headers.vary}`);
    if (Number(res.headers["content-length"]) !== body.length) fail(`${label}: Content-Length ${res.headers["content-length"]} for ${body.length} bytes`);
    body = gunzipSync(body);
  }
  if (sha256(body) !== digest) return fail(`${label}: body (${body.length} bytes) is not the built page`);
  ok(`${label}: the built page, ${body.length} bytes, ${encoding}`);
  return body.toString("utf8");
}

async function checkPageAssets(label, p, page, headers, encoding) {
  if (typeof page !== "string") return;
  const paths = [...page.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  if (paths.length === 0) return fail(`${label}: the page loads no /assets/ file`);
  for (const path of paths) {
    const res = await get(p, path, headers);
    const name = basename(path);
    if (res.status !== 200) {
      fail(`${label} ${path}: status ${res.status}`);
      continue;
    }
    if (res.headers["x-content-type-options"] !== "nosniff") fail(`${label} ${path}: no nosniff`);
    const coding = res.headers["content-encoding"];
    if (coding && coding !== encoding) fail(`${label} ${path}: Content-Encoding ${coding}, expected ${encoding}`);
    const body = coding === "gzip" ? gunzipSync(res.body) : res.body;
    if (!digests.has(name)) fail(`${label} ${path}: no digest for ${name}`);
    else if (sha256(body) !== digests.get(name)) fail(`${label} ${path}: not the built ${name}`);
    else ok(`${label} ${path}: as built, ${body.length} bytes`);
  }
}

function scratchRepo() {
  const repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...a) => {
    const r = spawnSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  writeFileSync(join(repo, "file.txt"), "one\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "file.txt"), "one\ntwo smoke change\n");
  writeFileSync(join(repo, "doc.md"), "# Smoke\n\nA page.\n");
  return repo;
}

async function servedPages(repo) {
  {
    const p = port++;
    const child = start(binary, ["review"], { PLANNOTATOR_PORT: String(p) }, repo);
    try {
      const diff = await waitFor(p, "/api/diff", child);
      const page = checkPage("review /", await get(p, "/"), digests.get("review.html"), "identity");
      await checkPageAssets("review", p, page, {}, "identity");
      checkPage("review / again", await get(p, "/"), digests.get("review.html"), "identity");
      const engine = JSON.parse(diff.body.toString("utf8")).diagramEngine;
      if (engine && typeof engine === "object") {
        for (const [key, path] of Object.entries(engine)) {
          if (typeof path !== "string" || !path.startsWith("/assets/diagram-engine/")) continue;
          const name = `${key}.js`;
          const res = await get(p, path);
          if (!digests.has(name)) fail(`no digest for diagram engine ${name}`);
          else if (res.status !== 200 || sha256(res.body) !== digests.get(name)) fail(`review ${path}: not the built ${name} (status ${res.status})`);
          else ok(`review ${path}: the built ${name}`);
        }
      } else fail("review /api/diff advertises no diagram engine");
    } catch (e) {
      fail(`review: ${e.message}\n${child.log()}`);
    } finally {
      stop(child);
    }
  }
  for (const [label, extra, headers, encoding] of [
    ["annotate /", {}, {}, "identity"],
    ["annotate / (remote, gzip)", { PLANNOTATOR_REMOTE: "1" }, { "Accept-Encoding": "gzip" }, "gzip"],
  ]) {
    const p = port++;
    const child = start(binary, ["annotate", "doc.md"], { PLANNOTATOR_PORT: String(p), ...extra }, repo);
    try {
      await waitFor(p, "/api/plan", child);
      const page = checkPage(label, await get(p, "/", headers), digests.get("index.html"), encoding);
      await checkPageAssets(label, p, page, headers, encoding);
    } catch (e) {
      fail(`${label}: ${e.message}\n${child.log()}`);
    } finally {
      stop(child);
    }
  }
}

async function shapePage(repo) {
  const p = port++;
  const shapes = join(env.PLANNOTATOR_DATA_DIR, "shapes");
  mkdirSync(shapes, { recursive: true });
  writeFileSync(join(env.PLANNOTATOR_DATA_DIR, "config.json"), JSON.stringify({ inboxShape: true }));
  writeFileSync(join(shapes, "server.json"), JSON.stringify({ v: 1, pid: 0, port: p, url: `http://127.0.0.1:${p}`, version: "smoke", started: "" }));
  const child = start(binary, ["shape", "serve"], {}, repo);
  try {
    await waitFor(p, "/api/shape-server", child);
    for (const [label, headers, encoding] of [
      ["shape /", {}, "identity"],
      ["shape / (gzip)", { "Accept-Encoding": "gzip, deflate, br" }, "gzip"],
    ]) {
      checkPage(label, await get(p, "/", headers), digests.get("shape.html"), encoding, "text/html; charset=utf-8");
    }
  } catch (e) {
    fail(`shape: ${e.message}\n${child.log()}`);
  } finally {
    stop(child);
  }
}

async function pagesAfterReplacement(repo) {
  const installDir = join(sandbox, "install");
  mkdirSync(installDir, { recursive: true });
  const installed = join(installDir, isWindows ? "plannotator.exe" : "plannotator");
  copyFileSync(binary, installed);
  if (!isWindows) chmodSync(installed, 0o755);
  const p = port++;
  const child = start(installed, ["annotate", "doc.md"], { PLANNOTATOR_PORT: String(p) }, repo);
  try {
    await waitFor(p, "/api/plan", child);
    replaceLikeInstaller(installed, replacement);
    ok(`the running binary was replaced the way ${isWindows ? "install.ps1 and install.cmd do" : "install.sh does"}`);
    const label = "annotate / first fetched after the replacement";
    const page = checkPage(label, await get(p, "/"), digests.get("index.html"), "identity");
    await checkPageAssets(label, p, page, {}, "identity");
    const plan = await get(p, "/api/plan");
    if (plan.status !== 200) fail(`/api/plan after the replacement: ${plan.status}`);
    else ok("annotate /api/plan still answers after the replacement");
  } catch (e) {
    fail(`replacement: ${e.message}\n${child.log()}`);
  } finally {
    stop(child);
  }
}

const PROBE = `
import asset from "./asset.bin" with { type: "file" };
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const sha = (b) => createHash("sha256").update(b).digest("hex");
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PROBE_PORT),
  async fetch(req) {
    if (new URL(req.url).pathname !== "/read") return new Response("ready");
    const viaBun = new Uint8Array(await Bun.file(asset).arrayBuffer());
    const viaFs = readFileSync(asset);
    return Response.json({ bun: sha(viaBun), fs: sha(viaFs) });
  },
});
`;

async function probeFirstReadAfterReplacement() {
  const dir = join(sandbox, "probe");
  const builds = {};
  for (const [name, size, fill] of [["a", 8_000_000, 0x41], ["b", 9_000_123, 0x42]]) {
    const src = join(dir, name);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "probe.ts"), PROBE);
    writeFileSync(join(src, "asset.bin"), Buffer.alloc(size, fill));
    const out = join(dir, `probe-${name}${isWindows ? ".exe" : ""}`);
    const r = spawnSync(bun, ["build", "probe.ts", "--compile", "--no-compile-autoload-bunfig", "--outfile", out], { cwd: src, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`probe build: ${r.stderr}`);
    builds[name] = { out, digest: sha256(Buffer.alloc(size, fill)) };
  }
  const installDir = join(dir, "install");
  mkdirSync(installDir, { recursive: true });
  const installed = join(installDir, isWindows ? "plannotator.exe" : "plannotator");
  copyFileSync(builds.a.out, installed);
  if (!isWindows) chmodSync(installed, 0o755);
  const p = port++;
  const child = start(installed, [], { PROBE_PORT: String(p) }, dir);
  try {
    await waitFor(p, "/", child);
    replaceLikeInstaller(installed, builds.b.out);
    const read = JSON.parse((await get(p, "/read")).body.toString("utf8"));
    if (read.bun === builds.a.digest && read.fs === builds.a.digest) {
      ok("an embedded file first read after the binary was replaced is the running binary's own (Bun.file and node:fs)");
    } else {
      fail(`an embedded file first read after the replacement is not the original: ${JSON.stringify(read)}`);
    }
  } catch (e) {
    fail(`probe: ${e.message}\n${child.log()}`);
  } finally {
    stop(child);
  }
}

const repo = scratchRepo();
await servedPages(repo);
await shapePage(repo);
await pagesAfterReplacement(repo);
if (bun) await probeFirstReadAfterReplacement();
else console.log("SKIP: no --bun, the embedded-file probe did not run");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("ALL OK");

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../tests/helpers/no-browser";

const scriptsDir = import.meta.dir;
const readScript = (name: string) => readFileSync(join(scriptsDir, name), "utf-8").replace(/\r\n?/g, "\n");

const BINARY = Buffer.from(
  "#!/bin/sh\necho plannotator-fixture\nexit 0\n" +
    Array.from({ length: 30_000 }, (_, i) => `# line ${String(i).padStart(6, "0")}\n`).join(""),
);
const BINARY_SHA256 = createHash("sha256").update(BINARY).digest("hex");
const OLD = "#!/bin/sh\necho plannotator-old\n";

type Plan =
  | { kind: "serve" }
  | { kind: "cut"; bytes: number }
  | { kind: "stall"; bytes: number }
  | { kind: "ignore-range" }
  | { kind: "garbage-cut"; bytes: number }
  | { kind: "short-promise" }
  | { kind: "wrong-start" }
  | { kind: "unsized-cut"; bytes: number }
  | { kind: "status"; code: number };

interface SeenRequest {
  path: string;
  range: string | null;
}

interface ReleaseServer {
  origin: string;
  requests: SeenRequest[];
  attempts(): SeenRequest[];
  signed(): SeenRequest[];
  close(): Promise<void>;
}

const servers: ReleaseServer[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function startReleaseServer(plans: Plan[]): Promise<ReleaseServer> {
  const requests: SeenRequest[] = [];
  const sockets = new Set<Socket>();
  const issued = new Set<string>();
  let nextSigned = 0;
  let port = 0;

  const send = (sock: Socket, status: string, headers: Record<string, string | number>, body?: Buffer, end = true) => {
    const head = [`HTTP/1.1 ${status}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "Connection: close", "", ""];
    sock.write(head.join("\r\n"));
    if (body && body.length > 0) sock.write(body);
    if (end) sock.end();
  };

  const serveSigned = (sock: Socket, path: string, start: number | null) => {
    if (!issued.has(path)) {
      send(sock, "403 Forbidden", { "Content-Length": 0 });
      return;
    }
    issued.delete(path);
    const plan = plans.shift() ?? { kind: "serve" };
    const total = BINARY.length;
    const from = start ?? 0;
    if (plan.kind === "status") return send(sock, `${plan.code} Status`, { "Content-Length": 0 });
    if (plan.kind === "ignore-range" || start === null) {
      if (plan.kind === "cut") return send(sock, "200 OK", { "Content-Length": total }, BINARY.subarray(0, plan.bytes));
      if (plan.kind === "stall") return send(sock, "200 OK", { "Content-Length": total }, BINARY.subarray(0, plan.bytes), false);
      if (plan.kind === "garbage-cut") return send(sock, "200 OK", { "Content-Length": total }, Buffer.alloc(plan.bytes, 0x7a));
      if (plan.kind === "short-promise") return send(sock, "200 OK", { "Content-Length": total + 1 }, BINARY);
      if (plan.kind === "unsized-cut") return send(sock, "200 OK", {}, BINARY.subarray(0, plan.bytes));
      return send(sock, "200 OK", { "Content-Length": total }, BINARY);
    }
    if (from >= total) return send(sock, "416 Range Not Satisfiable", { "Content-Range": `bytes */${total}`, "Content-Length": 0 });
    const rest = BINARY.subarray(from);
    const range = { "Content-Range": `bytes ${from}-${total - 1}/${total}`, "Content-Length": rest.length };
    if (plan.kind === "cut") return send(sock, "206 Partial Content", range, rest.subarray(0, plan.bytes));
    if (plan.kind === "stall") return send(sock, "206 Partial Content", range, rest.subarray(0, plan.bytes), false);
    if (plan.kind === "garbage-cut") return send(sock, "206 Partial Content", range, Buffer.alloc(plan.bytes, 0x7a));
    if (plan.kind === "wrong-start") {
      return send(sock, "206 Partial Content", { "Content-Range": `bytes 0-${total - 1}/${total}`, "Content-Length": total }, BINARY);
    }
    return send(sock, "206 Partial Content", range, rest);
  };

  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let head = "";
    sock.on("data", (chunk) => {
      if (head.includes("\r\n\r\n")) return;
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const path = head.split("\r\n")[0]!.split(" ")[1] ?? "";
      const rangeMatch = /^range:\s*bytes=(\d+)-\s*$/im.exec(head);
      requests.push({ path, range: rangeMatch ? `bytes=${rangeMatch[1]}-` : null });
      const start = rangeMatch ? Number(rangeMatch[1]) : null;
      const pathname = path.split("?")[0]!;
      if (pathname.includes("/releases/download/") && pathname.endsWith(".sha256")) {
        const sum = Buffer.from(`${BINARY_SHA256}  plannotator\n`);
        return send(sock, "200 OK", { "Content-Length": sum.length }, sum);
      }
      if (pathname.includes("/releases/download/")) {
        nextSigned++;
        const signed = `/signed/${nextSigned}?sig=${nextSigned}`;
        issued.add(signed);
        return send(sock, "302 Found", { Location: `http://127.0.0.1:${port}${signed}`, "Content-Length": 0 });
      }
      if (pathname.startsWith("/signed/")) return serveSigned(sock, path, start);
      send(sock, "404 Not Found", { "Content-Length": 0 });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  const handle: ReleaseServer = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    attempts: () => requests.filter((r) => r.path.includes("/releases/download/") && !r.path.endsWith(".sha256")),
    signed: () => requests.filter((r) => r.path.startsWith("/signed/")),
    close: async () => {
      for (const sock of sockets) sock.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(handle);
  return handle;
}

const REAL_CURL = Bun.which("curl");
const BASH = Bun.which("bash");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-download-test-"));
  roots.push(root);
  const home = join(root, "home");
  const stub = join(root, "stub-bin");
  const data = join(root, "data");
  for (const dir of [home, stub, data, join(home, "tmp"), join(home, ".local", "bin")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".local", "bin", "plannotator"), OLD, { mode: 0o755 });
  writeFileSync(
    join(stub, "curl"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_CURL_LOG"
args=()
for a in "$@"; do
  case "$a" in
    https://github.com/*) a="$RELEASE_SERVER/\${a#https://github.com/}" ;;
    https://*) echo "curl: (6) the test reached for $a" >&2; exit 6 ;;
  esac
  args+=("$a")
done
exec "$REAL_CURL" "\${args[@]}"
`,
    { mode: 0o755 },
  );
  writeFileSync(join(stub, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(stub, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return { root, home, stub, data };
}

async function runInstallSh(server: ReleaseServer, env: Record<string, string> = {}) {
  const s = sandbox();
  const log = join(s.home, "curl.log");
  const proc = Bun.spawn(
    [BASH!, join(scriptsDir, "install.sh"), "--version", "v99.9.9", "--non-interactive", "--minimal"],
    {
      env: {
        HOME: s.home,
        TMPDIR: join(s.home, "tmp"),
        PATH: `${s.stub}:/usr/bin:/bin`,
        PLANNOTATOR_DATA_DIR: s.data,
        PLANNOTATOR_BROWSER: NO_BROWSER,
        PLANNOTATOR_TEST_SANDBOX: "1",
        PLANNOTATOR_INSTALL_NOTIFY: "0",
        PLANNOTATOR_SKIP_SEM_INSTALL: "1",
        PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL: "1",
        PLANNOTATOR_DOWNLOAD_RETRY_DELAY: "0",
        STUB_CURL_LOG: log,
        RELEASE_SERVER: server.origin,
        REAL_CURL: REAL_CURL!,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const bin = join(s.home, ".local", "bin");
  return {
    code,
    out: out + err,
    installed: readFileSync(join(bin, "plannotator")),
    leftovers: [...readdirSync(join(s.home, "tmp")), ...readdirSync(bin).filter((f) => f !== "plannotator")],
    curlCalls: existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : [],
  };
}

describe.skipIf(process.platform === "win32" || !REAL_CURL || !BASH)("install.sh resumes a broken binary download (real curl, local server)", () => {
  test("a clean download is one request, with no Range, and installs the file", async () => {
    const server = await startReleaseServer([]);
    const r = await runInstallSh(server);
    expect(r.code).toBe(0);
    expect(r.installed.equals(BINARY)).toBe(true);
    expect(server.attempts()).toHaveLength(1);
    expect(server.signed()).toEqual([{ path: "/signed/1?sig=1", range: null }]);
    expect(r.leftovers).toEqual([]);
    expect(r.out).not.toContain("trying again");
  }, 30_000);

  test("a dropped connection continues from where it stopped, through a new signed URL, and the checksum matches", async () => {
    const server = await startReleaseServer([{ kind: "cut", bytes: 100_000 }]);
    const r = await runInstallSh(server);
    expect(r.code).toBe(0);
    expect(r.out).toContain("SHA256 verified");
    expect(r.installed.equals(BINARY)).toBe(true);
    expect(server.attempts()).toHaveLength(2);
    expect(server.signed()).toEqual([
      { path: "/signed/1?sig=1", range: null },
      { path: "/signed/2?sig=2", range: "bytes=100000-" },
    ]);
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("several drops in a row each continue, as long as bytes keep arriving", async () => {
    const server = await startReleaseServer(Array.from({ length: 6 }, () => ({ kind: "cut", bytes: 30_000 }) as Plan));
    const r = await runInstallSh(server);
    expect(r.code).toBe(0);
    expect(r.installed.equals(BINARY)).toBe(true);
    expect(server.signed().map((q) => q.range)).toEqual([null, ...[1, 2, 3, 4, 5, 6].map((n) => `bytes=${n * 30_000}-`)]);
  }, 30_000);

  test("a stall ends the attempt and the next one continues", async () => {
    const server = await startReleaseServer([{ kind: "stall", bytes: 50_000 }]);
    const r = await runInstallSh(server, { PLANNOTATOR_DOWNLOAD_STALL_SECONDS: "1" });
    expect(r.code).toBe(0);
    expect(r.installed.equals(BINARY)).toBe(true);
    expect(server.signed().map((q) => q.range)).toEqual([null, "bytes=50000-"]);
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("a server that answers the Range with the whole file: the file is fetched again from zero", async () => {
    const server = await startReleaseServer([{ kind: "cut", bytes: 100_000 }, { kind: "ignore-range" }]);
    const r = await runInstallSh(server);
    expect(r.code).toBe(0);
    expect(r.installed.equals(BINARY)).toBe(true);
    expect(server.signed().map((q) => q.range)).toEqual([null, "bytes=100000-", null]);
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("every byte arrived but the connection ended badly: the next attempt finds nothing left (416) and installs", async () => {
    const server = await startReleaseServer([{ kind: "short-promise" }]);
    const r = await runInstallSh(server);
    expect(r.code).toBe(0);
    expect(r.installed.equals(BINARY)).toBe(true);
    expect(server.signed().map((q) => q.range)).toEqual([null, `bytes=${BINARY.length}-`]);
  }, 30_000);

  test("a corrupted partial fails the checksum: nothing is replaced and the partial is removed", async () => {
    const server = await startReleaseServer([{ kind: "garbage-cut", bytes: 100_000 }]);
    const r = await runInstallSh(server);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Checksum verification failed!");
    expect(r.installed.toString()).toBe(OLD);
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("four attempts in a row with no new bytes stop with curl's error: nothing installed, nothing left", async () => {
    const server = await startReleaseServer(Array.from({ length: 10 }, () => ({ kind: "cut", bytes: 0 }) as Plan));
    const r = await runInstallSh(server);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Could not download");
    expect(r.out).toContain("curl exit 18");
    expect(r.out).toContain("Nothing was changed");
    expect(server.attempts()).toHaveLength(4);
    expect(r.installed.toString()).toBe(OLD);
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("a missing release asset (404) stops after four attempts", async () => {
    const server = await startReleaseServer(Array.from({ length: 10 }, () => ({ kind: "status", code: 404 }) as Plan));
    const r = await runInstallSh(server);
    expect(r.code).toBe(1);
    expect(r.out).toContain("curl exit 22");
    expect(server.attempts()).toHaveLength(4);
    expect(r.installed.toString()).toBe(OLD);
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("progress that never finishes stops at 30 attempts", async () => {
    const server = await startReleaseServer(Array.from({ length: 40 }, () => ({ kind: "cut", bytes: 1 }) as Plan));
    const r = await runInstallSh(server);
    expect(r.code).toBe(1);
    expect(server.attempts()).toHaveLength(30);
    expect(r.installed.toString()).toBe(OLD);
    expect(r.leftovers).toEqual([]);
  }, 60_000);

  test("curl's own --retry is not used for the binary (it would throw the partial away)", async () => {
    const server = await startReleaseServer([]);
    const r = await runInstallSh(server);
    const binaryCalls = r.curlCalls.filter((c) => c.includes("/releases/download/") && !c.endsWith(".sha256"));
    expect(binaryCalls).toHaveLength(1);
    expect(binaryCalls[0]).not.toContain("--retry");
    expect(binaryCalls[0]).toContain("--speed-limit 1 --speed-time 60");
  }, 30_000);
});

const PS_SHELLS = (process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"])
  .map((name) => Bun.which(name))
  .filter((path): path is string => !!path);
const PS_TIMEOUT_MS = process.platform === "win32" ? 300_000 : 60_000;

function extractPs1DownloadRegion(): string {
  const ps = readScript("install.ps1");
  const start = ps.indexOf("function Invoke-ReleaseDownload {");
  const end = ps.indexOf("if ($verifyAttestationResolved) {", start);
  if (start < 0 || end < 0) throw new Error("could not locate the binary download in install.ps1");
  return ps.slice(start, end);
}

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function runPs1Download(shell: string, server: ReleaseServer, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-ps-download-test-"));
  roots.push(root);
  const out = join(root, "download.tmp");
  writeFileSync(out, "");
  const driver = join(root, "driver.ps1");
  writeFileSync(
    driver,
    [
      `$ErrorActionPreference = "Stop"`,
      `$binaryUrl = ${psQuote(`${server.origin}/backnotprop/plannotator/releases/download/v99.9.9/plannotator-windows-x64.exe`)}`,
      `$checksumUrl = "$binaryUrl.sha256"`,
      `$binaryName = "plannotator-windows-x64.exe"`,
      `$latestTag = "v99.9.9"`,
      `$tmpFile = ${psQuote(out)}`,
      `try {`,
      extractPs1DownloadRegion(),
      `    Write-Host "RESULT=ok"`,
      `} catch {`,
      `    Write-Host ("RESULT=failed: " + $_.Exception.Message)`,
      `}`,
      `exit 0`,
    ].join("\n"),
  );
  const parentEnv: Record<string, string | undefined> = { ...process.env };
  if (/^powershell(\.exe)?$/i.test(shell.split(/[\\/]/).pop() ?? "")) {
    for (const key of Object.keys(parentEnv)) if (key.toLowerCase() === "psmodulepath") delete parentEnv[key];
  }
  const proc = Bun.spawn([shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver], {
    env: {
      ...parentEnv,
      HOME: root,
      USERPROFILE: root,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      PLANNOTATOR_DOWNLOAD_RETRY_DELAY: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const text = stdout + stderr;
  const result = /RESULT=(.*)/.exec(text)?.[1]?.trim() ?? `no result: ${text}`;
  return { result, out: text, file: existsSync(out) ? readFileSync(out) : null };
}

describe.skipIf(PS_SHELLS.length === 0)("install.ps1 resumes a broken binary download (PowerShell, local server)", () => {
  for (const shell of PS_SHELLS) {
    const name = shell.split(/[\\/]/).pop();

    test(`${name}: a clean download is one request, with no Range`, async () => {
      const server = await startReleaseServer([]);
      const r = await runPs1Download(shell, server);
      expect(r.result).toBe("ok");
      expect(r.file?.equals(BINARY)).toBe(true);
      expect(server.signed()).toEqual([{ path: "/signed/1?sig=1", range: null }]);
      expect(r.out).not.toContain("trying again");
    }, PS_TIMEOUT_MS);

    test(`${name}: a dropped connection continues from where it stopped, through a new signed URL`, async () => {
      const server = await startReleaseServer([{ kind: "cut", bytes: 100_000 }, { kind: "cut", bytes: 50_000 }]);
      const r = await runPs1Download(shell, server);
      expect(r.result).toBe("ok");
      expect(r.file?.equals(BINARY)).toBe(true);
      expect(server.attempts()).toHaveLength(3);
      expect(server.signed()).toEqual([
        { path: "/signed/1?sig=1", range: null },
        { path: "/signed/2?sig=2", range: "bytes=100000-" },
        { path: "/signed/3?sig=3", range: "bytes=150000-" },
      ]);
    }, PS_TIMEOUT_MS);

    test(`${name}: a stall ends the attempt and the next one continues`, async () => {
      const server = await startReleaseServer([{ kind: "stall", bytes: 50_000 }]);
      const r = await runPs1Download(shell, server, { PLANNOTATOR_DOWNLOAD_STALL_SECONDS: "1" });
      expect(r.result).toBe("ok");
      expect(r.file?.equals(BINARY)).toBe(true);
      expect(server.signed().map((q) => q.range)).toEqual([null, "bytes=50000-"]);
    }, PS_TIMEOUT_MS);

    test(`${name}: a server that answers the Range with the whole file has it written from the start`, async () => {
      const server = await startReleaseServer([{ kind: "cut", bytes: 100_000 }, { kind: "ignore-range" }]);
      const r = await runPs1Download(shell, server);
      expect(r.result).toBe("ok");
      expect(r.file?.equals(BINARY)).toBe(true);
      expect(server.signed().map((q) => q.range)).toEqual([null, "bytes=100000-"]);
    }, PS_TIMEOUT_MS);

    test(`${name}: a 206 for another part of the file starts the file again`, async () => {
      const server = await startReleaseServer([{ kind: "cut", bytes: 100_000 }, { kind: "wrong-start" }]);
      const r = await runPs1Download(shell, server);
      expect(r.result).toBe("ok");
      expect(r.file?.equals(BINARY)).toBe(true);
      expect(server.signed().map((q) => q.range)).toEqual([null, "bytes=100000-", null]);
    }, PS_TIMEOUT_MS);

    test(`${name}: every byte arrived but the connection ended badly: a 416 ends it`, async () => {
      const server = await startReleaseServer([{ kind: "short-promise" }]);
      const r = await runPs1Download(shell, server);
      expect(r.result).toBe("ok");
      expect(r.file?.equals(BINARY)).toBe(true);
      expect(server.signed().map((q) => q.range)).toEqual([null, `bytes=${BINARY.length}-`]);
    }, PS_TIMEOUT_MS);

    test(`${name}: when the resumable download gives up, the earlier download gets the last word`, async () => {
      const server = await startReleaseServer(Array.from({ length: 4 }, () => ({ kind: "status", code: 404 }) as Plan));
      const r = await runPs1Download(shell, server);
      expect(r.result).toBe("ok");
      expect(r.file?.equals(BINARY)).toBe(true);
      expect(server.attempts()).toHaveLength(5);
    }, PS_TIMEOUT_MS);

    test(`${name}: a fallback download that ends short of the size seen is a failed attempt`, async () => {
      const cut0 = Array.from({ length: 4 }, () => ({ kind: "cut", bytes: 0 }) as Plan);
      const retried = await startReleaseServer([...cut0, { kind: "unsized-cut", bytes: 100_000 }]);
      const ok = await runPs1Download(shell, retried);
      expect(ok.result).toBe("ok");
      expect(ok.file?.equals(BINARY)).toBe(true);
      expect(retried.attempts()).toHaveLength(6);
      const short = await startReleaseServer([...cut0, ...Array.from({ length: 4 }, () => ({ kind: "unsized-cut", bytes: 100_000 }) as Plan)]);
      const failed = await runPs1Download(shell, short);
      expect(failed.result).toStartWith("failed");
      expect(failed.result).toContain("before the end of the file");
      expect(short.attempts()).toHaveLength(8);
      expect(failed.file).toBeNull();
    }, PS_TIMEOUT_MS);

    test(`${name}: when both give up, the error stops the script and the partial file is removed`, async () => {
      const server = await startReleaseServer(Array.from({ length: 20 }, () => ({ kind: "cut", bytes: 0 }) as Plan));
      const r = await runPs1Download(shell, server);
      expect({ result: r.result.slice(0, 6), attempts: server.attempts().length, out: r.result }).toMatchObject({
        result: "failed",
        attempts: 8,
      });
      expect(r.file).toBeNull();
    }, PS_TIMEOUT_MS);
  }
});

function extractCmdDownloadBinary(): string {
  const cmd = readScript("install.cmd");
  const start = cmd.indexOf("\n:DownloadBinary\n");
  const endLabel = cmd.indexOf("\n:DownloadBinaryEnd\n", start);
  const end = cmd.indexOf("\ngoto :eof\n", endLabel);
  if (start < 0 || endLabel < 0 || end < 0) throw new Error("could not locate :DownloadBinary in install.cmd");
  return cmd.slice(start + 1, end + "\ngoto :eof\n".length);
}

async function runCmdDownload(server: ReleaseServer, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-cmd-download-test-"));
  roots.push(root);
  const temp = join(root, "temp");
  mkdirSync(temp);
  const out = join(root, "download.exe");
  const driver = join(root, "driver.cmd");
  const lines = [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    'set "BINARY_URL=%DRV_URL%"',
    'set "TEMP_FILE=%DRV_OUT%"',
    "call :DownloadBinary",
    "echo RESULT=!DL_STATUS!",
    "exit /b 0",
    extractCmdDownloadBinary(),
  ];
  writeFileSync(driver, `${lines.join("\n")}\n`.replace(/\n/g, "\r\n"));
  const proc = Bun.spawn([process.env.ComSpec ?? "cmd.exe", "/d", "/c", driver], {
    env: {
      ...process.env,
      TEMP: temp,
      TMP: temp,
      DRV_URL: `${server.origin}/backnotprop/plannotator/releases/download/v99.9.9/plannotator-windows-x64.exe`,
      DRV_OUT: out,
      PLANNOTATOR_DOWNLOAD_RETRY_DELAY: "0",
      ...env,
    },
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const text = stdout + stderr;
  return {
    status: /RESULT=(\d+)/.exec(text)?.[1] ?? `no result: ${text}`,
    out: text,
    file: existsSync(out) ? readFileSync(out) : null,
    leftovers: readdirSync(temp),
  };
}

describe.skipIf(process.platform !== "win32")("install.cmd resumes a broken binary download (cmd.exe, curl.exe)", () => {
  test("a clean download is one request, with no Range", async () => {
    const server = await startReleaseServer([]);
    const r = await runCmdDownload(server);
    expect(r.status).toBe("0");
    expect(r.file?.equals(BINARY)).toBe(true);
    expect(server.signed()).toEqual([{ path: "/signed/1?sig=1", range: null }]);
    expect(r.leftovers).toEqual([]);
  }, PS_TIMEOUT_MS);

  test("a dropped connection continues from where it stopped, through a new signed URL", async () => {
    const server = await startReleaseServer([{ kind: "cut", bytes: 100_000 }]);
    const r = await runCmdDownload(server);
    expect(r.status).toBe("0");
    expect(r.file?.equals(BINARY)).toBe(true);
    expect(server.signed()).toEqual([
      { path: "/signed/1?sig=1", range: null },
      { path: "/signed/2?sig=2", range: "bytes=100000-" },
    ]);
    expect(r.leftovers).toEqual([]);
  }, PS_TIMEOUT_MS);

  test("a stall ends the attempt and the next one continues", async () => {
    const server = await startReleaseServer([{ kind: "stall", bytes: 50_000 }]);
    const r = await runCmdDownload(server, { PLANNOTATOR_DOWNLOAD_STALL_SECONDS: "1" });
    expect(r.status).toBe("0");
    expect(r.file?.equals(BINARY)).toBe(true);
    expect(server.signed().map((q) => q.range)).toEqual([null, "bytes=50000-"]);
  }, PS_TIMEOUT_MS);

  test("a server that answers the Range with the whole file: the file is fetched again from zero", async () => {
    const server = await startReleaseServer([{ kind: "cut", bytes: 100_000 }, { kind: "ignore-range" }]);
    const r = await runCmdDownload(server);
    expect(r.status).toBe("0");
    expect(r.file?.equals(BINARY)).toBe(true);
    expect(server.signed().map((q) => q.range)).toEqual([null, "bytes=100000-", null]);
  }, PS_TIMEOUT_MS);

  test("four attempts in a row with no new bytes stop with curl's exit code", async () => {
    const server = await startReleaseServer(Array.from({ length: 10 }, () => ({ kind: "cut", bytes: 0 }) as Plan));
    const r = await runCmdDownload(server);
    expect(r.status).toBe("18");
    expect(server.attempts()).toHaveLength(4);
    expect(r.leftovers).toEqual([]);
  }, PS_TIMEOUT_MS);
});

/**
 * `plannotator telemetry` as a process (telemetry-command-entry.ts, the
 * function index.ts dispatches, without the built HTML the full entry
 * imports), under a temp data dir, with a loopback endpoint that counts every
 * request it gets. Nothing here reaches the network: a source run sends only
 * to a loopback PLANNOTATOR_TELEMETRY_URL, and the one "release" run sets the
 * test sandbox so it does too.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildUsageCountsRequest } from "@plannotator/core/usage-counts";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { recordUsageCount, usageCountsDir } from "@plannotator/shared/usage-counts";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "telemetry-command-entry.ts");
/** The feature on in config.json and the counts notice shown. */
const ON = { experimental: { decisionMode: true }, usageCountsNotice: { decisionMode: 1 } } as PlannotatorConfig;
const DAY = 86_400_000;

const requests: string[] = [];
let server: ReturnType<typeof Bun.listen>;
let url = "";
let host = "";

beforeAll(() => {
  const buffers = new Map<unknown, string>();
  server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        const text = (buffers.get(socket) ?? "") + Buffer.from(chunk).toString("latin1");
        buffers.set(socket, text);
        const end = text.indexOf("\r\n\r\n");
        if (end === -1) return;
        const length = Number(/content-length: (\d+)/i.exec(text.slice(0, end))?.[1] ?? 0);
        if (Buffer.byteLength(text.slice(end + 4), "latin1") < length) return;
        requests.push(text);
        socket.write("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
        socket.end();
      },
    },
  });
  url = `http://127.0.0.1:${server.port}`;
  host = `127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A data dir whose config.json says `config`, holding yesterday's and today's counts. */
function world(config: PlannotatorConfig): string {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-telemetry-cli-"));
  dirs.push(dataDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  // Recorded while counts were on, as the feature's code would, by a build that sends (here: to the loopback endpoint).
  const on = { dataDir, env: { PLANNOTATOR_TELEMETRY_URL: url }, version: undefined, random: () => 0, config: () => ON };
  for (const event of ["active_day", "opened", "opened", "decided"] as const) recordUsageCount("decisionMode", event, { ...on, now: Date.now() - DAY });
  recordUsageCount("decisionMode", "opened", { ...on, now: Date.now() });
  return dataDir;
}

async function run(dataDir: string, args: string[], env: Record<string, string> = {}, define?: string) {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["DO_NOT_TRACK", "PLANNOTATOR_TELEMETRY", "PLANNOTATOR_TELEMETRY_URL"].includes(k)) childEnv[k] = v;
  Object.assign(childEnv, { PLANNOTATOR_DATA_DIR: dataDir, NO_BROWSER, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_TELEMETRY_URL: url }, env);
  // Not spawnSync: it would block the endpoint this process answers on.
  const proc = Bun.spawn(["bun", ...(define ? ["--define", define] : []), entry, ...args], { env: childEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}


describe("nothing is sent while counts are off", () => {
  const cases: [string, PlannotatorConfig, Record<string, string>][] = [
    ["counts off in config", { ...ON, usageCounts: false } as PlannotatorConfig, {}],
    ["counts off for the feature", { ...ON, usageCounts: { decisionMode: false } } as PlannotatorConfig, {}],
    ["the feature off", { usageCountsNotice: { decisionMode: 1 } } as PlannotatorConfig, {}],
    ["the notice never shown", { experimental: { decisionMode: true } } as PlannotatorConfig, {}],
    ["an older notice shown", { experimental: { decisionMode: true }, usageCountsNotice: { decisionMode: 0 } } as PlannotatorConfig, {}],
    ["DO_NOT_TRACK=1, even with counts on in config", { ...ON, usageCounts: true } as PlannotatorConfig, { DO_NOT_TRACK: "1" }],
    ["PLANNOTATOR_TELEMETRY=0", ON, { PLANNOTATOR_TELEMETRY: "0" }],
    ["DO_NOT_TRACK=1 beside PLANNOTATOR_TELEMETRY=1", ON, { DO_NOT_TRACK: "1", PLANNOTATOR_TELEMETRY: "1" }],
  ];
  for (const [what, config, env] of cases) {
    test(what, async () => {
      const dataDir = world(config);
      const before = requests.length;
      const sent = await run(dataDir, ["--send"], env);
      expect(sent.code).toBe(0);
      expect(requests.length).toBe(before);
      expect(existsSync(join(usageCountsDir(dataDir), "counts.json"))).toBe(false);
      // And nothing is recorded or sent on a later try either.
      expect((await run(dataDir, ["--send"], env)).code).toBe(0);
      expect(requests.length).toBe(before);
    });
  }
});

describe("with counts on", () => {
  test("--show prints exactly what would be sent and sends nothing", async () => {
    const dataDir = world(ON);
    const before = requests.length;
    const shown = await run(dataDir, ["--show", "--json"]);
    expect(shown.code).toBe(0);
    const report = JSON.parse(shown.stdout);
    expect(report.features[0].counts).toEqual({ on: true, reason: "on" });
    expect(report.features[0].waiting).toHaveLength(1);
    expect(report.features[0].today).toEqual({ opened: 1 });
    const text = await run(dataDir, ["--show"]);
    expect(text.stdout).toContain(report.features[0].waiting[0].body);
    expect(text.stdout).toContain("Host: counts.plannotator.ai");
    expect(requests.length).toBe(before);
  });

  test("--send sends one request per complete day, byte for byte, and only once", async () => {
    const dataDir = world(ON);
    const waiting = JSON.parse((await run(dataDir, ["--show", "--json"])).stdout).features[0].waiting;
    const before = requests.length;
    const sent = await run(dataDir, ["--send", "--json"]);
    expect(JSON.parse(sent.stdout)).toMatchObject({ status: "sent", sent: 1 });
    expect(requests.slice(before)).toEqual([buildUsageCountsRequest(host, waiting[0].body)]);
    expect(requests[before]).toContain('"events":{"active_day":1,"opened":2,"decided":1,"first_day":1,"days_last7":1}');
    expect(JSON.parse((await run(dataDir, ["--send", "--json"])).stdout).status).toBe("nothing");
    expect(requests.length).toBe(before + 1);
  });

  test("a release build ignores the test endpoint outside the test sandbox; inside it, sends there", async () => {
    const dataDir = world(ON);
    const before = requests.length;
    // Under the sandbox (the preload's PLANNOTATOR_TEST_SANDBOX rides in the env), the loopback endpoint applies.
    const sent = await run(dataDir, ["--send", "--json"], {}, '__CLI_VERSION__="9.9.9"');
    expect(JSON.parse(sent.stdout)).toMatchObject({ status: "sent", endpoint: `${url}/v1/counts` });
    expect(requests.length).toBe(before + 1);
    // Without the sandbox a release would go to the real service: --show says
    // so without any request (this test never sends there).
    const shown = await run(dataDir, ["--show", "--json"], { PLANNOTATOR_TEST_SANDBOX: "" }, '__CLI_VERSION__="9.9.9"');
    expect(JSON.parse(shown.stdout).endpoint).toBe("https://counts.plannotator.ai/v1/counts");
  });

  test("a build that is not a release without a test endpoint sends nothing", async () => {
    const dataDir = world(ON);
    const before = requests.length;
    const sent = await run(dataDir, ["--send", "--json"], { PLANNOTATOR_TELEMETRY_URL: "" });
    expect(JSON.parse(sent.stdout).status).toBe("nowhere");
    expect(requests.length).toBe(before);
  });

  test("--off writes config.json and deletes unsent counts; --on puts the default back", async () => {
    const dataDir = world(ON);
    expect((await run(dataDir, ["--off"])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8")).usageCounts).toBe(false);
    expect(existsSync(join(usageCountsDir(dataDir), "counts.json"))).toBe(false);
    const on = await run(dataDir, ["--on"], { DO_NOT_TRACK: "1" });
    expect(on.stdout).toContain("DO_NOT_TRACK is set");
    expect("usageCounts" in JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8"))).toBe(false);
    expect((await run(dataDir, ["--off", "--feature", "decisionMode"])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8")).usageCounts).toEqual({ decisionMode: false });
  });

  test("--off with a config.json it cannot read exits 1, says how to fix it, and leaves the file as it is", async () => {
    const dataDir = world(ON);
    const bytes = '{ "usageCountsNotice": { "decisionMode": 1 }, }\n';
    writeFileSync(join(dataDir, "config.json"), bytes);
    const off = await run(dataDir, ["--off"]);
    expect(off.code).toBe(1);
    expect(off.stderr).toContain("were not turned off");
    expect(off.stderr).toContain("fix or remove it");
    expect(off.stdout).not.toContain("Usage counts are off");
    expect(readFileSync(join(dataDir, "config.json"), "utf-8")).toBe(bytes);
    expect((await run(dataDir, ["--on"])).code).toBe(1);
  });

  test("usage errors exit 2", async () => {
    const dataDir = world(ON);
    expect((await run(dataDir, [])).code).toBe(2);
    expect((await run(dataDir, ["--show", "--off"])).code).toBe(2);
    expect((await run(dataDir, ["--off", "--feature", "nope"])).code).toBe(2);
    expect((await run(dataDir, ["--bogus"])).code).toBe(2);
  });
});

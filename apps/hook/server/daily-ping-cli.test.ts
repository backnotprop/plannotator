import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("plannotator annotate sends the annotate ping, with the favicon config.json sets, once its session starts", async () => {
  const stubs = stubHookDistHtml();
  cleanups.push(() => removeStubbedHtml(stubs));
  const root = mkdtempSync(join(tmpdir(), "plannotator-cli-ping-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dataDir, "ping.json"), JSON.stringify({ firstWeek: "2026-01-05" }));
  writeFileSync(join(root, "doc.md"), "# Doc\n");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ favicon: "glass" }));

  const bodies: string[] = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      bodies.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`);
      return new Response(null, { status: 204 });
    },
  });
  cleanups.push(() => receiver.stop(true));

  const proc = Bun.spawn(["bun", "--define", '__CLI_VERSION__="0.28.46"', entry, "annotate", join(root, "doc.md")], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_TEST_SANDBOX: root,
      PLANNOTATOR_TELEMETRY_URL: `http://127.0.0.1:${receiver.port}`,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER,
      PLANNOTATOR_REMOTE: "0",
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
      PLANNOTATOR_FEEDBACK_URL: "http://127.0.0.1:9/feedback",
      PLANNOTATOR_INSTALL_SCRIPT_URL: "http://127.0.0.1:9/install.sh",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_INBOX_TAILSCALE: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  cleanups.push(async () => {
    proc.kill();
    await proc.exited;
  });

  const sent = () => {
    try {
      return (JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8")).sent ?? []) as string[];
    } catch {
      return [];
    }
  };
  const end = Date.now() + 15_000;
  while (!sent().includes("annotate") && Date.now() < end) await Bun.sleep(50);
  expect(bodies).toEqual(['POST /ping {"version":"0.28.46","age_week":4,"tool":"annotate","first":1,"favicon":"glass"}']);
  expect(sent()).toEqual(["annotate"]);
}, 30_000);

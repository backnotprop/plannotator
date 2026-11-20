/**
 * Custom themes in the Inbox (packages/shared/theme-files.ts): the settings
 * route's palette id check, and the window's `/plannotator-themes.js`. The
 * failures these guard: an id that is neither built in nor added being saved
 * to config.json (the window would draw the default and every page with it),
 * a theme added with `plannotator theme add` refused, and the window's first
 * frame missing the theme's stylesheet.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCustomTheme } from "@plannotator/shared/theme-files";
import { loadConfig } from "./config";
import { startInboxServer, type InboxServer } from "./inbox";

let dataDir: string;
const servers: InboxServer[] = [];
let savedDataDir: string | undefined;

beforeEach(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-custom-theme-")));
  // config.json is read from the data dir env.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

async function start(): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, htmlContent: '<!doctype html><title>Inbox</title><script  src="/plannotator-themes.js"></script>' });
  servers.push(server);
  return server;
}

const post = (server: InboxServer, body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("a palette id is saved only when it is built in or added", async () => {
  const server = await start();
  expect((await post(server, { theme: { dark: "harbor" } })).status).toBe(422);
  expect(loadConfig().theme).toBeUndefined();
  saveCustomTheme(dataDir, { plannotatorTheme: 1, id: "harbor", name: "Harbor", dark: { background: "#0f1419" } });
  expect((await post(server, { theme: { dark: "harbor", light: "nord" } })).status).toBe(200);
  expect(loadConfig().theme).toEqual({ dark: "harbor", light: "nord" });
  expect((await post(server, { theme: { light: "harbor-2" } })).status).toBe(422);
  expect(loadConfig().theme).toEqual({ dark: "harbor", light: "nord" });
});

test("the window's themes script carries an added theme, read fresh on every load", async () => {
  const server = await start();
  const script = async () => fetch(`http://127.0.0.1:${server.port}/plannotator-themes.js`);
  const empty = await script();
  expect(empty.status).toBe(200);
  expect(empty.headers.get("content-type")).toStartWith("text/javascript");
  expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(await empty.text()).not.toContain(".theme-");
  // The window's page: no themes tag with no custom theme; the script written in once there is one (no request).
  const page = async () => (await fetch(`http://127.0.0.1:${server.port}/`)).text();
  expect(await page()).toBe("<!doctype html><title>Inbox</title>");
  saveCustomTheme(dataDir, { plannotatorTheme: 1, id: "harbor", name: "Harbor", dark: { background: "#0f1419" } });
  expect(await page()).toContain(".theme-harbor {");
  const body = await (await script()).text();
  expect(body).toContain(".theme-harbor {");
  expect(body).toContain('"id":"harbor"');
  // A theme's code colours, asked for when code first renders in the window.
  saveCustomTheme(dataDir, { plannotatorTheme: 1, id: "mono", name: "Mono", dark: { background: "#272822", syntax: [{ scope: "keyword", foreground: "#f92672" }] } });
  const syntax = await fetch(`http://127.0.0.1:${server.port}/plannotator-themes.js?syntax=mono`);
  expect(syntax.status).toBe(200);
  expect((await syntax.json()).dark.rules).toEqual([{ scope: "keyword", foreground: "#f92672" }]);
});

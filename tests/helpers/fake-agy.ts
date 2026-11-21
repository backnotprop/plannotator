/**
 * A fake Antigravity agent API for the Antigravity wake (packages/server/
 * inbox-antigravity-wake.ts). A test makes a scratch root with a `home/`;
 * the fake is each product's own client shim, `home/.gemini/<data folder>/
 * bin/agentapi`, as the real products write it, and answers `agentapi
 * get-conversation-metadata <id>` and `agentapi send-message <id> <text>` the
 * way agy 1.5.9 and the App 2.32.1 do (JSON on stdout; send-message answers 0
 * for any id, as the real one does).
 *
 * The servers it plays are in `state.json`: by address, whether it is up, the
 * token it takes, its conversations and its product. A send to a known
 * conversation appends a SYSTEM_MESSAGE step to that conversation's
 * transcript (`brain/<id>/.system_generated/logs/transcript_full.jsonl`), as
 * the real server does. `hang` makes a send sleep past any time limit:
 * `"before"` writing the step, or `"after"` it. Every call is logged in
 * `calls.log` with its argv and whether its token was right, never the token.
 * The real agy and App are never run.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeAgyProduct = "cli" | "app" | "ide";
const DIRS: Record<FakeAgyProduct, string> = { cli: "antigravity-cli", app: "antigravity", ide: "antigravity-ide" };

export interface FakeAgyServer {
  up: boolean;
  token: string;
  product: FakeAgyProduct;
  conversations: string[];
  hang?: "before" | "after";
}

export interface FakeAgy {
  root: string;
  home: string;
  /** Add or change a server (its hub file, for the App or the IDE, is written with `hub`). */
  server(address: string, server: FakeAgyServer): void;
  /** Write the App's or the IDE's hub file for a server (`pid`: a dead pid leaves a stale file). */
  hub(product: "app" | "ide", port: number, token: string, pid?: number): void;
  calls(): { args: string[]; address: string | null; tokenOk: boolean }[];
  sends(): { args: string[]; address: string | null; tokenOk: boolean }[];
  transcript(product: FakeAgyProduct, conversation: string): string;
  remove(): void;
}

const FAKE = String.raw`
const fs = require("fs");
const path = require("path");
const root = process.env.FAKE_AGY_ROOT;
const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
const args = process.argv.slice(2);
const address = process.env.ANTIGRAVITY_LS_ADDRESS || null;
const server = address ? state.servers[address.replace(/^https?:\/\//, "")] : null;
const tokenOk = !!server && process.env.ANTIGRAVITY_CSRF_TOKEN === server.token;
fs.appendFileSync(path.join(root, "calls.log"), JSON.stringify({ args, address, tokenOk }) + "\n");
const out = (o, code) => { process.stdout.write(JSON.stringify(o, null, 2) + "\n"); process.exit(code); };
const sleep = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); };
if (!address) out({ error: "ANTIGRAVITY_LS_ADDRESS is not set" }, 1);
if (!server || !server.up) out({ response: {}, error: "rpc error: code = Unavailable desc = connection error: desc = \"transport: Error while dialing: dial tcp [::1]:" + address.split(":").pop() + ": connect: connection refused\"" }, 1);
if (!process.env.ANTIGRAVITY_CSRF_TOKEN) out({ response: {}, error: "rpc error: code = Unauthenticated desc = unauthenticated: missing CSRF token" }, 1);
if (!tokenOk) out({ response: {}, error: "rpc error: code = Unauthenticated desc = unauthenticated: invalid CSRF token" }, 1);
const [command, id, text] = args;
if (server.hang === "before" && command === "send-message") sleep();
if (command === "get-conversation-metadata") {
  if (!server.conversations.includes(id)) out({ response: {}, error: "rpc error: code = NotFound desc = not_found: trajectory not found: " + id + ": not found (error ID: 0)" }, 1);
  out({ response: { conversationMetadata: { metadata: { rootConversationId: id, workspaces: [] } } } }, 0);
}
if (command === "send-message") {
  if (server.conversations.includes(id)) {
    const logs = path.join(state.home, ".gemini", state.dirs[server.product], "brain", id, ".system_generated", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const content = "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=now sender=system priority=MESSAGE_PRIORITY_HIGH content=" + text + "\n</SYSTEM_MESSAGE>";
    fs.appendFileSync(path.join(logs, "transcript_full.jsonl"), JSON.stringify({ source: "SYSTEM", type: "SYSTEM_MESSAGE", content }) + "\n");
  }
  if (server.hang === "after") sleep();
  out({ response: { sendMessage: { recipientId: id, content: text } } }, 0);
}
out({ error: "unknown command" }, 2);
`;

export function createFakeAgy(prefix = "plannotator-fake-agy-"): FakeAgy {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const state = { home, dirs: DIRS, servers: {} as Record<string, FakeAgyServer> };
  const save = () => writeFileSync(join(root, "state.json"), JSON.stringify(state));
  save();
  writeFileSync(join(root, "fake-agentapi.js"), FAKE);
  for (const product of Object.keys(DIRS) as FakeAgyProduct[]) {
    const bin = join(home, ".gemini", DIRS[product], "bin");
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, "agentapi");
    writeFileSync(shim, `#!/bin/sh\nFAKE_AGY_ROOT=${JSON.stringify(root)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "fake-agentapi.js"))} "$@"\n`);
    chmodSync(shim, 0o755);
  }
  const readCalls = () =>
    existsSync(join(root, "calls.log"))
      ? readFileSync(join(root, "calls.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { args: string[]; address: string | null; tokenOk: boolean })
      : [];
  const hub = (product: "app" | "ide", port: number, token: string, pid = process.pid) => {
    const dir = join(home, ".gemini", DIRS[product], "daemon");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `hub_${port}.json`), JSON.stringify({ pid, httpsPort: port - 1, httpPort: port, lsVersion: "2.32.1", csrfToken: token }), { mode: 0o600 });
  };
  return {
    root,
    home,
    server: (address, server) => {
      state.servers[address] = server;
      save();
    },
    hub,
    calls: readCalls,
    sends: () => readCalls().filter((call) => call.args[0] === "send-message"),
    transcript: (product, conversation) => {
      const path = join(home, ".gemini", DIRS[product], "brain", conversation, ".system_generated", "logs", "transcript_full.jsonl");
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

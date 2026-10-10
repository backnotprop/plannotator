/**
 * `plannotator inbox --help`, the agent guide (inbox-help.ts). What can drift
 * is checked against its source, never against a copy of the prose:
 *
 *   - every tool a real Inbox registers has its section, and every argument
 *     the guide names is in that tool's served input schema;
 *   - the question syntax is QUESTION_AUTHORING_GUIDE, byte for byte;
 *   - every harness of the window's "Connect an agent" is listed, with the
 *     setup command or file harnessPanel gives it for this binary;
 *   - every flag and subcommand the inbox parser accepts is in it;
 *   - the CLI as a process prints it on stdout, exits 0, and starts nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { QUESTION_AUTHORING_GUIDE } from "@plannotator/core/question-block";
import { HARNESSES, harnessPanel, shellLine } from "@plannotator/inbox/harnesses";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { startInboxServer } from "@plannotator/server/inbox";
import { INBOX_FILLED_ARGUMENTS } from "@plannotator/shared/inbox/connection";
import { formatTopLevelHelp } from "./cli";
import { formatInboxHelp, INBOX_HELP_MCP_URL, INBOX_QUESTION_EXAMPLE, TOOL_GUIDE } from "./inbox-help";

const entry = resolve(import.meta.dir, "index.ts");
const distDir = resolve(import.meta.dir, "../dist");
const COMMAND = ["/opt/example bin/plannotator"];
const DATA_DIR = "/home/someone/.plannotator";
const help = formatInboxHelp({ command: COMMAND, dataDir: DATA_DIR, platform: "linux" });

let root = "";
let trapBin = "";
let stubs: string[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-help-")));
  // Nothing here may reach the real tailscale CLI: a trap fails loudly first on PATH.
  trapBin = join(root, "bin");
  mkdirSync(trapBin);
  writeFileSync(join(trapBin, "tailscale"), "#!/bin/sh\necho 'inbox-help.test: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(trapBin, "tailscale"), 0o755);
  // The CLI imports the built HTML; --help never reads it.
  stubs = ["index.html", "review.html", "inbox.html"].map((name) => join(distDir, name)).filter((path) => !existsSync(path));
  mkdirSync(distDir, { recursive: true });
  for (const path of stubs) writeFileSync(path, "<!doctype html><title>test</title>");
});

afterAll(() => {
  for (const path of stubs) rmSync(path, { force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("the guide against what it describes", () => {
  test("every tool a real Inbox registers has a section, and every argument named is in its schema", async () => {
    const savedPath = process.env.PATH;
    const savedTailscale = process.env.PLANNOTATOR_INBOX_TAILSCALE;
    process.env.PATH = `${trapBin}:${savedPath ?? ""}`;
    delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    const server = await startInboxServer({ dataDir: join(root, "served-data") });
    const client = new Client({ name: "inbox-help-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_GUIDE).sort());
      for (const tool of tools) {
        expect(help).toContain(`\n### ${tool.name}\n`);
        const properties = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
        const guide = TOOL_GUIDE[tool.name as keyof typeof TOOL_GUIDE];
        for (const arg of guide.args) {
          expect(properties, `${tool.name} has no argument ${arg}`).toContain(arg);
        }
        // And the reverse: every served argument is named, filled for the agent, or explained in the tool's lines.
        const text = guide.lines.join("\n");
        for (const property of properties) {
          const covered =
            guide.args.includes(property) ||
            (INBOX_FILLED_ARGUMENTS as readonly string[]).includes(property) ||
            text.includes(`\`${property}\``);
          expect(covered, `${tool.name}'s argument ${property} is not in the guide`).toBe(true);
        }
      }
    } finally {
      await client.close();
      server.stop();
      process.env.PATH = savedPath;
      if (savedTailscale === undefined) delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
      else process.env.PLANNOTATOR_INBOX_TAILSCALE = savedTailscale;
    }
  });

  test("carries the question authoring guide byte for byte", () => {
    expect(help).toContain(QUESTION_AUTHORING_GUIDE);
  });

  test("lists every harness, each with the setup harnessPanel gives this binary", () => {
    const ctx = { command: [...COMMAND, "inbox", "mcp"], mcpUrl: INBOX_HELP_MCP_URL, platform: "linux" as const };
    for (const harness of HARNESSES) {
      const line = help.split("\n").find((candidate) => candidate.startsWith(`- **${harness.label}**: `));
      expect(line, harness.label).toBeDefined();
      // A command artefact (or the "Another way" one when the panel leads with a link) appears whole.
      const panel = harnessPanel(harness.id, ctx);
      const command = panel.artefacts.find((artefact) => artefact.kind === "code") ?? panel.another?.body;
      if (command?.kind === "code" && !command.text.includes("\n")) expect(line).toContain(command.text);
    }
    // The stdio entry names this binary, quoted for a shell.
    expect(help).toContain(shellLine([...COMMAND, "inbox", "mcp"]));
  });

  test("names every flag and subcommand the inbox parser accepts", () => {
    const parser = readFileSync(resolve(import.meta.dir, "inbox-command.ts"), "utf-8");
    const flags = [...parser.matchAll(/arg === "(--[a-z][a-z0-9-]*)"/g)].map((m) => m[1]!);
    const subcommands = [...parser.matchAll(/args\[0\] === "([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!);
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) expect(help).toContain(`plannotator inbox ${flag}`);
    for (const sub of subcommands) expect(help).toContain(`plannotator inbox ${sub}`);
  });

  test("names the data dir it was given", () => {
    expect(help).toContain(`\`${join(DATA_DIR, "inbox")}\``);
    expect(help).toContain(`\`${join(DATA_DIR, "config.json")}\``);
  });

  test("its Inbox-only question example reads as Stopped, Holds up and a decision to record", () => {
    expect(help).toContain(`\`\`\`markdown\n${INBOX_QUESTION_EXAMPLE}\n\`\`\``);
    const [question, ...rest] = parseInboxQuestionBlocks(INBOX_QUESTION_EXAMPLE);
    expect(rest).toEqual([]);
    expect(question!.prompt).toBe("Which queue should failed webhook deliveries retry on?");
    expect(question!.stopped).toBe("the retry worker cannot start until this is settled");
    expect(question!.holds_up).toEqual(["webhook-retries", "delivery-dashboard"]);
    expect(question!.decision_on_answer).toBe(true);
    expect(question!.parsed.choices.map((choice) => choice.label)).toEqual(["The existing jobs queue", "A dedicated retries queue"]);
  });

  // Deliberate: the top-level help is where an agent learns this guide exists.
  test("the top-level help points agents at it", () => {
    expect(formatTopLevelHelp()).toContain("plannotator inbox --help");
  });
});

describe("plannotator inbox --help as a process", () => {
  test("prints the guide on stdout, exits 0, and starts no Inbox", async () => {
    const dataDir = join(root, "cli-data");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    for (const argv of [["inbox", "--help"], ["inbox", "mcp", "--help"]]) {
      const proc = Bun.spawn([process.execPath, entry, ...argv], {
        cwd: root,
        env: { PATH: `${trapBin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, TMPDIR: tmpdir(), PLANNOTATOR_DATA_DIR: dataDir },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, stderr).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(QUESTION_AUTHORING_GUIDE);
      expect(stdout).toContain("\n### send_message\n");
      // The stdio entry it names is this CLI: bun plus the entry script, from source.
      expect(stdout).toContain(`${shellLine([entry])} inbox mcp`);
      expect(stdout).toContain(`\`${join(dataDir, "inbox")}\``);
    }
    expect(existsSync(join(dataDir, "inbox"))).toBe(false);
  }, 30_000);
});

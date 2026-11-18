/**
 * The note section of `plannotator inbox --help` (words agents act on): which
 * agents it says the Inbox writes the note for by itself ("don't ask about
 * those") and which need the person's yes. The failure this guards: an agent
 * told not to ask about Cursor where its note is copied by hand (no editor
 * here, nothing written), or told to ask where the Inbox writes it itself. A
 * scratch home with no agent run; no Inbox started.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { formatInboxHelp } from "./inbox-help";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plannotator-help-notes-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const helpFor = () => {
  const agentEnvironment = createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "/nonexistent" } });
  const text = formatInboxHelp({ command: ["/opt/plannotator/bin/plannotator"], dataDir: join(home, ".plannotator"), platform: "linux", agentEnvironment });
  const intro = text.split("\n").find((line) => line.startsWith("Plannotator adds a short note about the Inbox"))!;
  const [auto, ask] = intro.split("For ");
  const cursorLine = text.split("\n").find((line) => line.startsWith("- Cursor (`cursor`)"))!;
  return { auto: auto!, ask: ask!, intro, cursorLine };
};

test("Cursor without its editor: asked about (copied by hand), never in the written-by-itself list", () => {
  const help = helpFor();
  expect(help.auto).not.toContain("Cursor");
  expect(help.ask).toContain("Cursor");
  expect(help.intro).toContain("copied by hand");
  expect(help.cursorLine).toContain("--notes cursor");
});

test("Cursor's editor here: written by itself into its local plugin, and nothing said of a copy by hand", () => {
  mkdirSync(join(home, ".config", "Cursor"), { recursive: true });
  const help = helpFor();
  expect(help.auto).toContain("Cursor");
  expect(help.ask).not.toContain("Cursor");
  expect(help.intro).not.toContain("copied by hand");
  expect(help.cursorLine).toContain("~/.cursor/plugins/local/plannotator-inbox/rules/plannotator-inbox.mdc");
});

test("the agents with a verified global file are written by themselves; Cline is asked about", () => {
  const help = helpFor();
  for (const name of ["Qwen Code", "Kiro", "Windsurf / Devin", "Amp", "Antigravity", "DeepSeek Harness"]) expect(help.auto).toContain(name);
  expect(help.ask).toContain("Cline");
  expect(help.auto).not.toContain("Cline");
});

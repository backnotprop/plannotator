/**
 * `plannotator sessions` over SSH: the person at a terminal gets each
 * session's "From another computer" link with this machine's key under its
 * row; a pipe, an agent's shell and `--json` never get the key.
 */
import { expect, test } from "bun:test";
import type { SessionInfo } from "@plannotator/server/sessions";
import { formatSessionsJson, formatSessionsTable, isPersonAtTerminal } from "./sessions-output";

const KEY = "K".repeat(43);
const base = { pid: 1, port: 19432, url: "http://localhost:19432", mode: "plan", project: "p", startedAt: new Date(0).toISOString(), label: "x" } as const;
const keyed: SessionInfo = { ...base, anotherComputerUrl: "http://10.0.0.1:19432/" };
const unknownAddress: SessionInfo = { ...base, pid: 2, anotherComputerUrl: "" };
const plain: SessionInfo = { ...base, pid: 3 };

test("a session that asks another computer for the key gets its link, with the key, right under its row", () => {
  const lines = formatSessionsTable([keyed, plain], 0, KEY).split("\n");
  const row = lines.findIndex((line) => line.startsWith("  #1 "));
  expect(lines[row + 1]?.trim()).toBe(`From another computer: http://10.0.0.1:19432/?key=${KEY}`);
  // A session that asks for no key gets no line.
  expect(lines.filter((line) => line.includes(KEY))).toHaveLength(1);
  expect(lines[lines.findIndex((line) => line.startsWith("  #2 ")) + 1]).not.toContain("From another computer");
});

test("when the address is not known, the key alone, to add to the address the person uses", () => {
  const table = formatSessionsTable([unknownAddress], 0, KEY);
  expect(table).toContain(`?key=${KEY}`);
  expect(table).toContain("From another computer");
});

test("without the key (a pipe, an agent) the table and --json are as before: no key, no link", () => {
  expect(formatSessionsTable([keyed, unknownAddress])).not.toContain("From another computer");
  expect(formatSessionsTable([keyed, unknownAddress])).toBe(formatSessionsTable([{ ...keyed, anotherComputerUrl: undefined }, { ...unknownAddress, anotherComputerUrl: undefined }]));
  const json = formatSessionsJson([keyed, unknownAddress]);
  expect(json).not.toContain("key=");
  expect(json).not.toContain("anotherComputer");
});

test("only a person at a terminal: both streams a terminal and no agent's mark on the shell", () => {
  expect(isPersonAtTerminal(true, true, {})).toBe(true);
  expect(isPersonAtTerminal(false, true, {})).toBe(false);
  expect(isPersonAtTerminal(true, false, {})).toBe(false);
  expect(isPersonAtTerminal(undefined, undefined, {})).toBe(false);
  for (const marker of ["CLAUDECODE", "CODEX_THREAD_ID", "OPENCODE", "PI_SESSION_ID", "PLANNOTATOR_SESSION_TAG", "GEMINI_CLI", "CURSOR_AGENT"]) {
    expect(isPersonAtTerminal(true, true, { [marker]: "1" })).toBe(false);
  }
});

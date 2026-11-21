/**
 * A stub Pi installed as Windows installs it: `pi.cmd` next to an
 * extensionless `pi`, as npm and Pi's own installer leave them (#2372). It is
 * never a real agent CLI: `pi.cmd` runs a small script with this test
 * runner's own executable, which records the argv and stdin it got. When the
 * stdin holds `HANG`, it also writes its pid and stays alive, so a test can
 * check that Stop ends it and not only the cmd.exe in front of it.
 *
 * Windows-only: the agent-jobs tests that use it skip elsewhere.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakePiCmd {
  /** The folder to put first on PATH. */
  bin: string;
  /** Where the stub writes `{ argv, stdin }`. */
  record: string;
  /** Where a `HANG` run writes its pid. */
  pidFile: string;
}

export function writeFakePiCmd(root: string): FakePiCmd {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const record = join(root, "pi-record.json");
  const pidFile = join(root, "pi-stub.pid");
  writeFileSync(join(bin, "pi-stub.js"), [
    'const fs = require("node:fs");',
    'let stdin = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { stdin += chunk; });',
    'process.stdin.on("end", () => {',
    `  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));`,
    '  if (!stdin.includes("HANG")) return;',
    `  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "  setInterval(() => {}, 1000);",
    "});",
  ].join("\n"));
  // The shape of an npm shim: the runtime, the script beside the shim, then
  // the arguments as cmd.exe passed them.
  writeFileSync(join(bin, "pi.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0pi-stub.js" %*\r\n`);
  writeFileSync(join(bin, "pi"), '#!/bin/sh\necho "the Windows stub runs as pi.cmd" >&2\nexit 1\n');
  return { bin, record, pidFile };
}

/** A PATH that reaches the stub and the Windows tools (cmd, where, taskkill), and no real agent CLI. */
export function fakePiCmdPath(stub: FakePiCmd): string {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  return [stub.bin, system32, process.env.SystemRoot ?? "C:\\Windows"].join(";");
}

/**
 * A Guided Review prompt cmd.exe would misread if it ever saw it: line breaks,
 * quotes, `%VAR%`, `!`, `^`, `&`, `|` and redirections.
 */
export const HOSTILE_PROMPT = [
  "Organize this diff.",
  "",
  '+const s = "100% & | <done> >out.txt"; echo %PATH% !bang! ^caret',
  '"quoted" & calc.exe',
].join("\n");

/**
 * A model id with characters cmd.exe reads outside quotes: if the argument
 * broke out of its quotes, `&` would start another command and `>` would
 * write a file named `broke` in the job's folder.
 */
export const HOSTILE_MODEL = "openai/a&b (c) >broke|x";

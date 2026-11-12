import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakePiCmd {
  bin: string;
  record: string;
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
  writeFileSync(join(bin, "pi.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0pi-stub.js" %*\r\n`);
  writeFileSync(join(bin, "pi"), '#!/bin/sh\necho "the Windows stub runs as pi.cmd" >&2\nexit 1\n');
  return { bin, record, pidFile };
}

export function fakePiCmdPath(stub: FakePiCmd): string {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  return [stub.bin, system32, process.env.SystemRoot ?? "C:\\Windows"].join(";");
}

export const HOSTILE_PROMPT = [
  "Organize this diff.",
  "",
  '+const s = "100% & | <done> >out.txt"; echo %PATH% !bang! ^caret',
  '"quoted" & calc.exe',
].join("\n");

export const HOSTILE_MODEL = "openai/a&b (c) >broke|x";

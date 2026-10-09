import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import * as z from "zod";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { parsePlannotatorToolInput, plannotatorCommandToToolInput } from "@plannotator/shared/plannotator-tool";
import { privateWrite, T3Credentials } from "./auth";
import { callDaemon } from "./daemon";
import { findHookThread } from "./hook-routing";
import { configureT3Hook, hasPlanHookOverlap } from "./install-hook";
import { t3Endpoint, T3Client } from "./t3-client";

const hookEvent = z.object({
  hook_event_name: z.literal("PreToolUse"), tool_name: z.literal("Bash"), tool_use_id: z.string(), session_id: z.string(), cwd: z.string(),
  agent_id: z.string().optional(), tool_input: z.object({ command: z.string() }).passthrough(),
});
const launchSchema = z.object({ v: z.literal(1), endpoint: z.string(), thread: z.string(), input: z.unknown() });
const launchName = /^[0-9a-f-]{36}\.json$/;

function shellWord(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function configuredEndpoints(dataDir: string): URL[] {
  const root = join(dataDir, "t3-code");
  if (!existsSync(root)) return [];
  const endpoints: URL[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
    try {
      const value = z.object({ endpoint: z.string(), tokens: z.object({ access_token: z.string().min(1) }) }).parse(JSON.parse(readFileSync(join(root, entry.name, "oauth.json"), "utf8")) as unknown);
      endpoints.push(t3Endpoint(value.endpoint));
    } catch { /* Only valid, authorized connections participate. */ }
  }
  return endpoints;
}

export async function prepareT3Hook(value: unknown, selfCommand: readonly string[], dataDir: string): Promise<Record<string, unknown>> {
  const parsed = hookEvent.safeParse(value);
  if (!parsed.success || parsed.data.agent_id) return {};
  const event = parsed.data;
  const input = plannotatorCommandToToolInput(event.tool_input.command);
  if (!input) return {};
  const endpoints = configuredEndpoints(dataDir);
  if (!endpoints.length) return {};
  const matches: Array<{ endpoint: URL; thread: string; cwd: string }> = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("T3 automatic connection timed out.")), 6500);
  try {
    for (const endpoint of endpoints) {
      const client = await T3Client.connect(endpoint, new T3Credentials(dataDir, endpoint).token);
      const onAbort = () => { void client.close(); };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        controller.signal.throwIfAborted();
        const match = await findHookThread(client, event.tool_use_id, controller.signal);
        if (match && realpathSync(match.cwd) === realpathSync(event.cwd)) matches.push({ endpoint, ...match });
      } finally { controller.signal.removeEventListener("abort", onAbort); await client.close(); }
    }
    if (!matches.length) return {};
    if (matches.length !== 1) throw new Error("T3 conversation identity is ambiguous; automatic connection was refused.");
    const match = matches[0]!;
    const directory = join(dataDir, "t3-code", "hooks");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${randomUUID()}.json`);
    privateWrite(path, { v: 1, endpoint: match.endpoint.href, thread: match.thread, input });
    const command = [...selfCommand, "t3-hook", "open", path, "--data-dir", dataDir].map(shellWord).join(" ");
    // Permission evaluation still applies to the updated command.
    return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...event.tool_input, command } } };
  } finally { clearTimeout(timer); }
}

export async function runT3Hook(args: readonly string[], selfCommand: readonly string[]): Promise<void> {
  if (args[0] === "install" || args[0] === "remove") {
    const [operation, flag, file, executableFlag, installedExecutable, ...extra] = args;
    const installing = operation === "install";
    const validExecutable = installing ? executableFlag === "--executable" && !!installedExecutable : executableFlag === undefined;
    if (flag !== "--settings" || !file || !validExecutable || extra.length) throw new Error("Invalid T3 hook settings command.");
    const executable = installedExecutable ?? selfCommand[0]!;
    configureT3Hook(resolve(file), executable, getPlannotatorDataDir(), operation === "install");
    console.log(`T3 hook ${operation === "install" ? "installed" : "removed"} in ${resolve(file)}. Restart the Claude provider session to load changed hooks.`);
    return;
  }
  if (args[0] === "plan-hook-present" && args.length === 2) {
    process.exit(hasPlanHookOverlap(resolve(args[1]!)) ? 0 : 1);
  }
  if (!args.length) {
    try {
      const value: unknown = JSON.parse(await Bun.stdin.text());
      console.log(JSON.stringify(await prepareT3Hook(value, selfCommand, getPlannotatorDataDir())));
    } catch (error) {
      console.log(JSON.stringify({ systemMessage: `Plannotator automatic T3 connection unavailable: ${String(error)}` }));
    }
    return;
  }
  const [operation, file, flag, directory, ...extra] = args;
  if (operation !== "open" || !file || flag !== "--data-dir" || !directory || extra.length) throw new Error("Invalid internal T3 hook launch.");
  const dataDir = resolve(directory);
  const root = resolve(dataDir, "t3-code", "hooks");
  const path = resolve(file);
  if (!path.startsWith(root + sep) || !launchName.test(basename(path)) || lstatSync(path).isSymbolicLink()) throw new Error("Invalid T3 hook launch path.");
  const launch = launchSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  const parsed = parsePlannotatorToolInput(launch.input);
  if (!parsed.ok) throw new Error(parsed.error);
  const result = await callDaemon({ endpoint: t3Endpoint(launch.endpoint), dataDir, command: selfCommand, workerCommand: [...selfCommand, "t3"] }, launch.thread, parsed.input);
  if (result.isError) throw new Error(result.text);
  rmSync(path);
  console.log(result.text);
}

import { resolve } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { parsePlannotatorToolInput, type PlannotatorToolInput } from "@plannotator/shared/plannotator-tool";
import { openBrowser } from "@plannotator/server/browser";
import { T3Credentials, loginT3 } from "./auth";
import { callDaemon, daemonStatus, serveDaemon, type AdapterOptions } from "./daemon";
import { t3Endpoint, T3Client, T3Thread } from "./t3-client";
import { T3_CLI_USAGE } from "./usage";

const COMMANDS = ["login", "annotate", "review", "last", "list", "close", "status", "stop", "serve"] as const;
type Command = typeof COMMANDS[number];
interface Invocation { command: Command; endpoint: URL; thread?: string; dataDir?: string; executable?: string; review?: PlannotatorToolInput }

export function parseT3Args(args: readonly string[]): Invocation {
  const [name, ...rest] = args;
  if (!COMMANDS.includes(name as Command)) throw new Error(`Unknown T3 command: ${name ?? "missing command"}. Run 'plannotator t3 --help'.`);
  const command = name as Command;
  const flags = new Map<string, string>();
  const targets: string[] = [];
  let gate = false;
  let markdown = false;
  let positionalOnly = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!positionalOnly && arg === "--") { positionalOnly = true; continue; }
    if (!positionalOnly && (arg === "--gate" || arg === "--markdown")) {
      if (command !== "annotate") throw new Error(`${arg} is only valid with t3 annotate.`);
      if (arg === "--gate") { if (gate) throw new Error("Repeated --gate."); gate = true; }
      else { if (markdown) throw new Error("Repeated --markdown."); markdown = true; }
    } else if (!positionalOnly && arg.startsWith("--")) {
      if (!["--url", "--thread", "--data-dir", "--plannotator", "--base"].includes(arg)) throw new Error(`Unknown T3 option: ${arg}.`);
      const value = rest[++i];
      if (!value || value.startsWith("--") || flags.has(arg)) throw new Error(`Missing value or repeated option: ${arg}.`);
      if (arg === "--base" && command !== "review") throw new Error("--base is only valid with t3 review.");
      flags.set(arg, value);
    } else targets.push(arg);
  }
  const url = flags.get("--url");
  if (!url) throw new Error("--url is required; copy the MCP URL from T3 Settings → Connections.");
  const thread = flags.get("--thread");
  if (command === "login" && thread) throw new Error("Login authorizes an environment; it takes no --thread.");
  if (command !== "login") {
    if (!thread) throw new Error("--thread is required; use the current T3 conversation's explicit ID.");
    new T3Thread({ call: async () => undefined }, thread);
  }
  let review: PlannotatorToolInput | undefined;
  if (["annotate", "review", "last", "list", "close"].includes(command)) {
    if (command !== "annotate" && targets.length > (command === "review" || command === "close" ? 1 : 0)) throw new Error(`Too many targets for t3 ${command}.`);
    const input: Record<string, unknown> = { action: command };
    if (command === "close") input.session = targets[0];
    else if (targets.length) input.target = targets.length === 1 ? targets[0] : targets;
    if (gate) input.gate = true;
    if (markdown || flags.has("--base")) input.options = {
      ...(markdown ? { markdown } : {}),
      ...(flags.has("--base") ? { base: flags.get("--base") } : {}),
    };
    const parsed = parsePlannotatorToolInput(input);
    if (!parsed.ok) throw new Error(parsed.error);
    review = parsed.input;
  } else if (targets.length) throw new Error(`t3 ${command} takes no target.`);
  return { command, endpoint: t3Endpoint(url), thread, dataDir: flags.get("--data-dir"), executable: flags.get("--plannotator"), review };
}

export async function runT3Command(args: readonly string[], selfCommand: readonly string[]): Promise<void> {
  if (!args.length || args.includes("--help") || args.includes("-h") || args[0] === "help") { console.log(T3_CLI_USAGE); return; }
  const input = parseT3Args(args);
  const options: AdapterOptions = { endpoint: input.endpoint, dataDir: input.dataDir ? resolve(input.dataDir) : getPlannotatorDataDir(),
    command: input.executable ? [input.executable] : selfCommand, workerCommand: [...selfCommand, "t3"] };
  if (input.command === "login") {
    const credentials = new T3Credentials(options.dataDir, options.endpoint);
    await loginT3(credentials, async (url) => { console.error(`Authorize Plannotator in T3: ${url.href}`); await openBrowser(url.href); });
    const client = await T3Client.connect(options.endpoint, credentials.token);
    await client.close();
    console.log("Plannotator is authorized with T3. Enable the optional Claude hook with install.sh --with-t3 and restart the provider session to connect ordinary Plannotator commands.");
  } else if (input.command === "serve") await serveDaemon(options, input.thread!);
  else if (input.command === "status" || input.command === "stop") console.log(JSON.stringify(await daemonStatus(options, input.thread!, input.command === "stop")));
  else {
    const answer = await callDaemon(options, input.thread!, input.review!);
    if (answer.isError) throw new Error(answer.text);
    console.log(answer.text);
  }
}

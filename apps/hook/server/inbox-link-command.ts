/**
 * `plannotator inbox link` and `plannotator inbox unlink`: link this
 * computer's Inbox with another machine's (docs/agent-guides/
 * inbox-machines.md). Each asks the running Inbox (started in the background
 * when it is not) over its control routes; the Inbox does the work
 * (packages/server/inbox-machines.ts).
 *
 *   plannotator inbox link --offer [--tailscale]
 *       print a one-time link code (10 minutes) for the other machine
 *   plannotator inbox link <code> [--address <host:port>] [--back <host:port>] [--one-way]
 *       redeem the other machine's code; both ways unless --one-way
 *   plannotator inbox link --list
 *       the linked machines and their state
 *   plannotator inbox unlink <machine name or id>
 *       remove the link on both machines
 */

import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";

type Json = Record<string, any>;

export const INBOX_LINK_USAGE = [
  "  plannotator inbox link --offer [--tailscale]",
  "                                  Print a one-time link code (10 minutes) to paste on",
  "                                  another machine. --tailscale first publishes this",
  "                                  Inbox's door on your tailnet (port 8443, or the next",
  "                                  free one up to 8450), so the code carries its address.",
  "  plannotator inbox link <code> [--address <host:port>] [--back <host:port>] [--one-way]",
  "                                  Link with the machine that printed <code>: each",
  "                                  Inbox then shows both machines' threads. --address",
  "                                  overrides the code's address; --back is how that",
  "                                  machine reaches this one (default: this Inbox's",
  "                                  tailnet door, published now when it is not yet);",
  "                                  --one-way links this side only.",
  "  plannotator inbox link --list   The linked machines and their state.",
  "  plannotator inbox unlink <machine>",
  "                                  Remove the link on both machines (by name or id).",
];

async function control(entry: InboxRegistryEntry, method: "GET" | "POST", path: string, body?: Json): Promise<{ status: number; body: Json }> {
  const response = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/control/machines${path}`, {
    method,
    headers: { Authorization: `Bearer ${entry.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const answer = (await response.json().catch(() => ({}))) as Json;
  if (response.status === 404 && answer.code === "not_found" && path === "") {
    throw new Error("The running Inbox is an older version that cannot link machines; run plannotator inbox restart.");
  }
  return { status: response.status, body: answer };
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function describeMachine(machine: Json): string {
  // This computer's reason: why its door is not published (its port held by another mapping).
  const state = machine.self ? `this computer${machine.reason ? ` (${machine.reason})` : ""}` : machine.state === "offline" ? `offline since ${machine.since}${machine.reason ? ` (${machine.reason})` : ""}` : machine.state;
  const way = machine.self ? "" : machine.both_ways ? ", both ways" : ", one way";
  const waiting = machine.waiting ? `, ${machine.waiting} waiting to send` : "";
  return `${machine.name}  ${machine.id}  ${state}${way}${waiting}${machine.address ? `  ${machine.address}` : ""}`;
}

/** `plannotator inbox link …` and `plannotator inbox unlink …`. Returns the exit code. */
export async function runInboxLinkCommand(args: readonly string[], ensureRunning: () => Promise<InboxRegistryEntry>): Promise<number> {
  const [command, ...rest] = args;
  let offer = false;
  let list = false;
  let tailscale = false;
  let oneWay = false;
  let address: string | undefined;
  let back: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (command === "link" && arg === "--offer") offer = true;
    else if (command === "link" && arg === "--list") list = true;
    else if (command === "link" && arg === "--tailscale") tailscale = true;
    else if (command === "link" && arg === "--one-way") oneWay = true;
    else if (command === "link" && (arg === "--address" || arg === "--back")) {
      const value = rest[++i];
      if (!value) return fail(`${arg} needs a value, like mini.tail1234.ts.net:8443.`);
      if (arg === "--address") address = value;
      else back = value;
    } else if (arg.startsWith("--")) return fail(`Unknown inbox ${command} option: ${arg}\nRun 'plannotator inbox --help' for usage.`);
    else positional.push(arg);
  }
  let entry: InboxRegistryEntry;
  try {
    entry = await ensureRunning();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  try {
    if (command === "unlink") {
      if (positional.length !== 1) return fail("Usage: plannotator inbox unlink <machine name or id>");
      const answer = await control(entry, "POST", "/unlink", { machine: positional[0] });
      if (answer.status !== 200) return fail(answer.body.error ?? `The Inbox answered ${answer.status}.`);
      process.stdout.write(`Unlinked ${answer.body.unlinked.name}.\n`);
      if (!answer.body.told) process.stderr.write(`${answer.body.unlinked.name} could not be reached; it removes its side the next time it reaches this computer. This computer stays reachable on your tailnet for it for up to 7 days, until it hears.\n`);
      return 0;
    }
    if (list) {
      if (offer || positional.length > 0) return fail("--list goes alone.");
      const answer = await control(entry, "GET", "");
      for (const machine of answer.body.machines ?? []) process.stdout.write(`${describeMachine(machine)}\n`);
      return 0;
    }
    if (offer) {
      if (positional.length > 0 || address || back || oneWay) return fail("--offer takes only --tailscale.");
      const answer = await control(entry, "POST", "/offer", { tailscale });
      if (answer.status !== 201) return fail(answer.body.error ?? `The Inbox answered ${answer.status}.`);
      if (answer.body.tailnet_error) process.stderr.write(`${answer.body.tailnet_error}\n`);
      if (!answer.body.tailnet) {
        process.stderr.write(
          tailscale
            ? "This code carries no tailnet address: this Inbox could not publish its door on your tailnet (the reason is above). Fix that and run this again.\n"
            : "This code carries no tailnet address: run this again with --tailscale to publish this Inbox's door on your tailnet.\n",
        );
      }
      process.stderr.write(`On the other machine, within 10 minutes, run:\n  plannotator inbox link '<the code below>'\nSix digits, for typing it in Settings: ${answer.body.code}\n`);
      process.stdout.write(`${answer.body.link}\n`);
      return 0;
    }
    if (positional.length !== 1) return fail("Usage: plannotator inbox link <code>, or plannotator inbox link --offer");
    const answer = await control(entry, "POST", "/link", { link: positional[0], address, back, one_way: oneWay });
    if (answer.status !== 201) return fail(answer.body.error ?? `The Inbox answered ${answer.status}.`);
    const machine = answer.body.machine as Json;
    process.stdout.write(`Linked ${machine.name} (${machine.id})${machine.both_ways ? ", both ways" : ", one way"}.\n`);
    return 0;
  } catch (error) {
    return fail(`Could not reach the running Inbox: ${error instanceof Error ? error.message : String(error)}`);
  }
}

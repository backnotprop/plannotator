/**
 * `plannotator inbox link --offer`: when the code carries no tailnet address,
 * the next step it names is one that can help. After `--tailscale` failed to
 * publish the door, running it again with `--tailscale` changes nothing, so
 * it is never offered then. The Inbox is a stand-in answering the control
 * route, as a running Inbox does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { runInboxLinkCommand } from "./inbox-link-command";

let inbox: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  inbox?.stop(true);
  inbox = null;
});

/** A running Inbox that answers the offer with no tailnet address, and the error it saw (if any). */
function offerWithoutAddress(tailnetError: string | null): () => Promise<InboxRegistryEntry> {
  inbox = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        { link: "plannotator://link?v=1&id=ibx_x&name=Mac&secret=s&code=123456", code: "123456", expires_at: "", machine: {}, tailnet: null, tailnet_error: tailnetError },
        { status: 201 },
      ),
  });
  const port = inbox.port as number;
  return async () => ({ v: 1, pid: process.pid, port, url: "", version: "dev", token: "t".repeat(64), serverSession: "s", startedAt: "" });
}

/** Run the command with stdout and stderr captured; both restored after. */
async function run(args: string[], ensure: () => Promise<InboxRegistryEntry>): Promise<{ code: number; err: string }> {
  let err = "";
  const writeErr = process.stderr.write;
  const writeOut = process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return { code: await runInboxLinkCommand(args, ensure), err };
  } finally {
    process.stderr.write = writeErr;
    process.stdout.write = writeOut;
  }
}

describe("inbox link --offer with no tailnet address", () => {
  test("after --tailscale could not publish the door, it names that failure, and never says to run it with --tailscale again", async () => {
    const reason = "Other tailscale serve mappings already use every port the Inbox can take (8443 to 8450).";
    const { code, err } = await run(["link", "--offer", "--tailscale"], offerWithoutAddress(reason));
    expect(code).toBe(0);
    expect(err).toContain(reason);
    expect(err).toContain("could not publish its door");
    expect(err).not.toContain("--tailscale");
  });

  test("without --tailscale, it says to run it again with --tailscale", async () => {
    const { code, err } = await run(["link", "--offer"], offerWithoutAddress(null));
    expect(code).toBe(0);
    expect(err).toContain("run this again with --tailscale");
  });
});

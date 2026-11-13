import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { braked } from "../src/brake";
import { HELD_COMMANDS_MAX, HELD_COMMAND_BYTES_MAX } from "../src/limits";
import { dumpMailbox, sha256, sleep, startRelay, until, type Json, type Relay } from "./wrangler-relay";

const PHONE = "dev_01K7LIMITSPHONE0000000000A";
const AGENT = "dev_01K7LIMITSAGENT0000000000A";
const BUSY = "dev_01K7LIMITSBUSYPHONE00000AA";
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

describe("how long the relay holds things, under wrangler dev", () => {
  let relay: Relay;
  let mailbox = "";
  const inbox = random();
  const phone = random();
  const agent = random();
  const busy = random();

  const at = (method: string, path: string, bearer: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${relay.url}/v1/mailboxes/${mailbox}${path}`, {
      method,
      headers: { ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const rows = (table: string, device: string): Json[] => ((dumpMailbox(relay, mailbox)[table] as Json[] | undefined) ?? []).filter((row) => row.device_id === device);

  beforeAll(async () => {
    relay = await startRelay("expiry", { HELD_MAX_AGE_SECONDS: "3" });
    const made = await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(inbox) }) });
    mailbox = ((await made.json()) as Json).mailbox_id;
    expect((await at("PUT", `/devices/${PHONE}`, inbox, { secret_sha256: sha256(phone), cursor: 0 })).status).toBe(200);
    expect((await at("PUT", `/devices/${AGENT}`, inbox, { secret_sha256: sha256(agent), cursor: 0, kind: "agent", signal_sha256: sha256(random()) })).status).toBe(200);
    expect((await at("PUT", `/devices/${BUSY}`, inbox, { secret_sha256: sha256(busy), cursor: 0 })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await relay?.stop();
  });

  test("held items, commands and an agent's unread result are deleted once they are older than the relay keeps them", async () => {
    const socket = new WebSocket(`${relay.url.replace(/^http/, "ws")}/v1/mailboxes/${mailbox}/socket`, { headers: { Authorization: `Bearer ${inbox}` } } as unknown as string[]);
    await new Promise((open) => (socket.onopen = open));
    socket.send(JSON.stringify({ type: "item", device_id: PHONE, cursor: 1, ciphertext: "AAAArecordForThePhone" }));
    socket.send(JSON.stringify({ type: "item", device_id: AGENT, cursor: null, ciphertext: "AAAAresultNeverRead" }));
    await until(() => rows("items", PHONE).length + rows("items", AGENT).length, (n) => n === 2, "both items held");
    socket.close();
    await until(async () => ((await (await at("GET", `/devices/${PHONE}/items`, phone)).json()) as Json).inbox_online, (online) => online === false, "the socket gone");
    expect((await at("POST", `/devices/${PHONE}/commands`, phone, { id: "cmd-old", ciphertext: "AAAAoldCommand" })).status).toBe(202);
    expect((await at("POST", `/devices/${AGENT}/commands`, agent, { id: "cmd-agent-old", ciphertext: "AAAAoldAgentCommand" })).status).toBe(202);
    expect(rows("commands", PHONE)).toHaveLength(1);

    await until(() => rows("items", PHONE).length + rows("items", AGENT).length + rows("commands", PHONE).length + rows("commands", AGENT).length, (n) => n === 0, "the expiry sweep", 20_000);
    expect(((await (await at("GET", `/devices/${PHONE}/items?after=0`, phone)).json()) as Json).items).toEqual([]);

    expect((await at("POST", `/devices/${PHONE}/commands`, phone, { id: "cmd-new", ciphertext: "AAAAnewCommand" })).status).toBe(202);
    await sleep(1_000);
    expect(rows("commands", PHONE).map((row) => row.id)).toEqual(["cmd-new"]);
  }, 60_000);

});

describe("how much the relay holds, and who it turns away, under wrangler dev", () => {
  let relay: Relay;
  let mailbox = "";
  const inbox = random();
  const phone = random();
  const agent = random();
  const busy = random();

  const at = (method: string, path: string, bearer: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${relay.url}/v1/mailboxes/${mailbox}${path}`, {
      method,
      headers: { ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const rows = (table: string, device: string): Json[] => ((dumpMailbox(relay, mailbox)[table] as Json[] | undefined) ?? []).filter((row) => row.device_id === device);

  beforeAll(async () => {
    relay = await startRelay("limits", {});
    const made = await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(inbox) }) });
    mailbox = ((await made.json()) as Json).mailbox_id;
    expect((await at("PUT", `/devices/${PHONE}`, inbox, { secret_sha256: sha256(phone), cursor: 0 })).status).toBe(200);
    expect((await at("PUT", `/devices/${AGENT}`, inbox, { secret_sha256: sha256(agent), cursor: 0, kind: "agent", signal_sha256: sha256(random()) })).status).toBe(200);
    expect((await at("PUT", `/devices/${BUSY}`, inbox, { secret_sha256: sha256(busy), cursor: 0 })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await relay?.stop();
  });

  test("one device may hold only so many commands, by count and by size; another device is not held back", async () => {
    for (let i = 0; i < HELD_COMMANDS_MAX; i++) expect((await at("POST", `/devices/${BUSY}/commands`, busy, { id: `cmd-${i}`, ciphertext: "AAAAsmall" })).status).toBe(202);
    const over = await at("POST", `/devices/${BUSY}/commands`, busy, { id: "cmd-over", ciphertext: "AAAAsmall" });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: "too_many_held", held_commands_max: HELD_COMMANDS_MAX });
    expect((await at("POST", `/devices/${BUSY}/commands`, busy, { id: "cmd-0", ciphertext: "AAAAsmall" })).status).toBe(200);
    expect((await at("POST", `/devices/${PHONE}/commands`, phone, { id: "cmd-other", ciphertext: "AAAAsmall" })).status).toBe(202);

    const big = "A".repeat(Math.ceil(HELD_COMMAND_BYTES_MAX / 3) + 1_000_000);
    expect((await at("POST", `/devices/${AGENT}/commands`, agent, { id: "big-1", ciphertext: big })).status).toBe(202);
    expect((await at("POST", `/devices/${AGENT}/commands`, agent, { id: "big-2", ciphertext: big })).status).toBe(202);
    const full = await at("POST", `/devices/${AGENT}/commands`, agent, { id: "big-3", ciphertext: big });
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ code: "too_many_held", held_bytes_max: HELD_COMMAND_BYTES_MAX });
  }, 120_000);

  test("the Worker turns strangers away before a mailbox wakes: no bearer, an unknown route, an oversize body", async () => {
    const never = "mbx_AAAAAAAAAAAAAAAAAAAAAA";
    for (const [method, path] of [
      ["GET", `/devices/${PHONE}/items`],
      ["POST", `/devices/${PHONE}/commands`],
      ["GET", "/socket"],
      ["POST", "/push"],
    ] as const) {
      const answer = await fetch(`${relay.url}/v1/mailboxes/${never}${path}`, { method, body: method === "POST" ? "{}" : undefined });
      expect({ path, status: answer.status, code: ((await answer.json()) as Json).code }).toEqual({ path, status: 401, code: "unauthorized" });
    }
    for (const path of ["/devices/not-a-device/items", "/devices/dev_X/elsewhere", "/signals/short", "/anything"]) {
      expect((await fetch(`${relay.url}/v1/mailboxes/${mailbox}${path}`, { headers: { Authorization: `Bearer ${phone}` } })).status).toBe(404);
    }
    const oversize = await at("POST", `/devices/${PHONE}/ack`, phone, JSON.stringify({ through: 1, pad: "A".repeat(100_000) }));
    expect(oversize.status).toBe(413);
    expect(((await oversize.json()) as Json).code).toBe("body_too_large");
    const create = await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(random()), pad: "A".repeat(100_000) }) });
    expect(create.status).toBe(413);
  }, 30_000);
});

describe("the creation brake", () => {
  const request = (host: string, ip: string | null) => new Request(`https://${host}/v1/mailboxes`, { method: "POST", headers: ip ? { "CF-Connecting-IP": ip } : {} });
  const allow = { limit: async () => ({ success: true }) };
  const full = { limit: async () => ({ success: false }) };
  const broken = {
    limit: async (): Promise<{ success: boolean }> => {
      throw new Error("limiter down");
    },
  };

  test("closed off loopback when it cannot brake: no binding, no client address, or a failing limiter", async () => {
    for (const [limiter, ip] of [
      [undefined, "203.0.113.9"],
      [allow, null],
      [broken, "203.0.113.9"],
    ] as const) {
      const answer = await braked(request("relay.example", ip), limiter, 60);
      expect(answer?.status).toBe(503);
      expect(((await answer!.json()) as Json).code).toBe("brake_unavailable");
    }
    expect(await braked(request("relay.example", "203.0.113.9"), allow, 60)).toBeNull();
    expect((await braked(request("relay.example", "203.0.113.9"), full, 60))?.status).toBe(429);
    expect(await braked(request("127.0.0.1:8787", null), undefined, 60)).toBeNull();
  });
});

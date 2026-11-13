import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { braked, clientKey } from "../src/brake";
import { plainHttp } from "../src/https-only";
import { CREATE_LIMIT, CREATE_WINDOW_MS, HELD_COMMANDS_MAX, HELD_COMMAND_BYTES_MAX, takeCreate, type CreateWindow } from "../src/limits";
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

  test("every creation, a refused body too, counts in the client address's CreateBrake object", async () => {
    const counts = () => {
      const dir = join(relay.persist, "v3", "do", "plannotator-relay-CreateBrake");
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite") : [];
      return files.map((f) => {
        const db = new Database(join(dir, f), { readonly: true });
        try {
          return (db.query("SELECT count FROM brake").get() as { count: number }).count;
        } finally {
          db.close();
        }
      });
    };
    expect(counts()).toEqual([1]);
    for (let i = 0; i < 2; i++) expect((await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: "{}" })).status).toBe(400);
    expect(counts()).toEqual([3]);
  });

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
  // The rate limiting binding in production: approximate and cached per machine, so requests on separate connections pass it.
  const allow = { limit: async () => ({ success: true }) };
  const full = { limit: async () => ({ success: false }) };
  const broken = {
    limit: async (): Promise<{ success: boolean }> => {
      throw new Error("limiter down");
    },
  };
  // A stand-in for the CreateBrake objects: one window per address, the object's own counting, a clock the test moves.
  const objects = (clock: { now: number }) => {
    const windows = new Map<string, CreateWindow>();
    return (ip: string) => ({
      take: async () => {
        const next = takeCreate(windows.get(ip) ?? null, clock.now);
        if (next.allowed) windows.set(ip, next.window);
        return { allowed: next.allowed, retryAfter: next.retryAfter };
      },
    });
  };
  const downObject = () => ({
    take: async (): Promise<{ allowed: boolean; retryAfter: number }> => {
      throw new Error("object unreachable");
    },
  });

  test("the address's count refuses the 21st creation in a minute even when the binding lets every request through", async () => {
    const clock = { now: 1_000_000 };
    const counter = objects(clock);
    for (let i = 0; i < CREATE_LIMIT; i++) expect(await braked(request("relay.example", "203.0.113.9"), allow, counter, 60)).toBeNull();
    clock.now += 15_000;
    const over = await braked(request("relay.example", "203.0.113.9"), allow, counter, 60);
    expect(over?.status).toBe(429);
    expect(over?.headers.get("retry-after")).toBe("45");
    expect(await over!.json()).toEqual({ error: "too many requests", code: "too_many_requests" });
    // Another address has its own count; the first is let in again once its window ends.
    expect(await braked(request("relay.example", "198.51.100.7"), allow, counter, 60)).toBeNull();
    clock.now += CREATE_WINDOW_MS - 15_000;
    expect(await braked(request("relay.example", "203.0.113.9"), allow, counter, 60)).toBeNull();
  });

  test("closed off loopback when it cannot brake: no binding, no object, no client address, or either failing", async () => {
    const counter = objects({ now: 0 });
    for (const [limiter, objectsOf, ip] of [
      [undefined, counter, "203.0.113.9"],
      [allow, undefined, "203.0.113.9"],
      [allow, counter, null],
      [broken, counter, "203.0.113.9"],
      [allow, downObject, "203.0.113.9"],
    ] as const) {
      const answer = await braked(request("relay.example", ip), limiter, objectsOf, 60);
      expect(answer?.status).toBe(503);
      expect(((await answer!.json()) as Json).code).toBe("brake_unavailable");
    }
    const refused = await braked(request("relay.example", "203.0.113.9"), full, counter, 60);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("retry-after")).toBe("60");
    expect(await braked(request("127.0.0.1:8787", null), undefined, undefined, 60)).toBeNull();
  });

  test("one IPv6 host cannot rotate through its /64 past the count", async () => {
    const clock = { now: 1_000_000 };
    const counter = objects(clock);
    for (let i = 0; i < CREATE_LIMIT; i++) expect(await braked(request("relay.example", `2001:db8:1:2::${(i + 1).toString(16)}`), allow, counter, 60)).toBeNull();
    expect((await braked(request("relay.example", "2001:db8:1:2:ffff:ffff:ffff:ffff"), allow, counter, 60))?.status).toBe(429);
    expect(await braked(request("relay.example", "2001:db8:1:3::1"), allow, counter, 60)).toBeNull();
  });

  test("an IPv6 client is keyed by its /64, however the address is written", () => {
    expect(clientKey("2001:0db8:0001:0002:0000:0000:0000:0001")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2::abcd")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
  });
});

describe("https only", () => {
  test("a plain-http request to the relay's host gets a bare 403 on every route; https and loopback pass", async () => {
    for (const path of ["/v1/mailboxes", "/v1/mailboxes/mbx_0000000000000000000000/socket", "/anything?x=1"]) {
      const answer = plainHttp(new Request(`http://relay.plannotator.ai${path}`, { method: "POST" }));
      expect(answer?.status).toBe(403);
      expect(await answer!.text()).toBe("");
    }
    expect(plainHttp(new Request("https://relay.plannotator.ai/v1/mailboxes"))).toBeNull();
    expect(plainHttp(new Request("http://127.0.0.1:8787/v1/mailboxes"))).toBeNull();
  });
});

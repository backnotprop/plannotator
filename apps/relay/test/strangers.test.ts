import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dumpMailbox, sha256, startRelay, until, type Json, type Relay } from "./wrangler-relay";

const PHONE = "dev_01K7STRANGERPHONEA00000000";
const SIBLING = "dev_01K7STRANGERPHONEB00000000";
const AGENT = "dev_01K7STRANGERAGENT000000000";
const NOBODY = "dev_01K7STRANGERNOBODY00000000";

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

describe("a stranger at the relay, under wrangler dev", () => {
  let relay: Relay;
  const a = { id: "", secret: random() };
  const b = { id: "", secret: random() };
  const phone = random();
  const sibling = random();
  const agent = random();
  const signal = random();
  const otherPhone = random();

  const at = (mailbox: string, method: string, path: string, bearer: string | null, body?: unknown) =>
    fetch(`${relay.url}/v1/mailboxes/${mailbox}${path}`, {
      method,
      headers: { ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const make = async (secret: string) => {
    const made = await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(secret) }) });
    expect(made.status).toBe(201);
    return ((await made.json()) as Json).mailbox_id as string;
  };

  const socketAnswer = (mailbox: string, bearer: string | null): Promise<Json | "refused"> =>
    new Promise((done) => {
      const socket = new WebSocket(`${relay.url.replace(/^http/, "ws")}/v1/mailboxes/${mailbox}/socket`, (bearer === null ? {} : { headers: { Authorization: `Bearer ${bearer}` } }) as unknown as string[]);
      const frames: Json[] = [];
      const finish = (value: Json | "refused") => {
        clearTimeout(timer);
        try {
          socket.close();
        } catch {}
        done(value);
      };
      const timer = setTimeout(() => finish(frames.length ? { frames } : "refused"), 5_000);
      socket.onmessage = (event) => {
        frames.push(JSON.parse(String(event.data)));
        if (frames.some((f) => f.type === "command")) finish({ frames });
      };
      socket.onerror = () => finish(frames.length ? { frames } : "refused");
      socket.onclose = () => finish(frames.length ? { frames } : "refused");
    });

  const nobody = () => [null, "not-a-secret", random(), b.secret, sha256(a.secret)];
  const strangers = () => [...nobody(), phone, agent];

  beforeAll(async () => {
    relay = await startRelay("strangers", {});
    a.id = await make(a.secret);
    b.id = await make(b.secret);
    expect(a.id).not.toBe(b.id);
    for (const id of [a.id, b.id]) expect(id).toMatch(/^mbx_[A-Za-z0-9_-]{22}$/);
    expect((await at(a.id, "PUT", `/devices/${PHONE}`, a.secret, { secret_sha256: sha256(phone), cursor: 0 })).status).toBe(200);
    expect((await at(a.id, "PUT", `/devices/${SIBLING}`, a.secret, { secret_sha256: sha256(sibling), cursor: 0 })).status).toBe(200);
    expect((await at(a.id, "PUT", `/devices/${AGENT}`, a.secret, { secret_sha256: sha256(agent), cursor: 0, kind: "agent", signal_sha256: sha256(signal) })).status).toBe(200);
    expect((await at(b.id, "PUT", `/devices/${PHONE}`, b.secret, { secret_sha256: sha256(otherPhone), cursor: 0 })).status).toBe(200);

    const socket = new WebSocket(`${relay.url.replace(/^http/, "ws")}/v1/mailboxes/${a.id}/socket`, { headers: { Authorization: `Bearer ${a.secret}` } } as unknown as string[]);
    await new Promise((open) => (socket.onopen = open));
    socket.send(JSON.stringify({ type: "item", device_id: PHONE, cursor: 1, ciphertext: "AAAAheldForThePhone" }));
    await until(async () => ((await (await at(a.id, "GET", `/devices/${PHONE}/items`, phone)).json()) as Json).items.length, (n) => n === 1, "the phone's item held");
    socket.close();
    expect((await at(a.id, "POST", `/devices/${PHONE}/commands`, phone, { id: "cmd-held", ciphertext: "AAAAheldForTheInbox" })).status).toBe(202);
  }, 90_000);

  afterAll(async () => {
    await relay?.stop();
  });

  test("the Inbox's socket, which hands over every held command, opens for its own mailbox secret alone", async () => {
    for (const bearer of strangers()) expect(await socketAnswer(a.id, bearer)).toBe("refused");
    const own = (await socketAnswer(a.id, a.secret)) as { frames: Json[] };
    expect(own.frames[0]!.type).toBe("hello");
    expect(own.frames.find((f) => f.type === "command")).toMatchObject({ device_id: PHONE, id: "cmd-held", ciphertext: "AAAAheldForTheInbox" });
    const other = (await socketAnswer(b.id, b.secret)) as { frames: Json[] } | "refused";
    if (other !== "refused") expect(other.frames.some((f) => f.type === "command")).toBe(false);
  }, 90_000);

  test("every Inbox route refuses anyone without the mailbox secret, and nothing changes", async () => {
    const before = dumpMailbox(relay, a.id);
    for (const bearer of strangers()) {
      const answers = [
        await at(a.id, "PUT", `/devices/${NOBODY}`, bearer, { secret_sha256: sha256("mine"), cursor: 0 }),
        await at(a.id, "PUT", `/devices/${PHONE}`, bearer, { secret_sha256: sha256("mine"), cursor: 0 }),
        await at(a.id, "PUT", `/devices/${AGENT}`, bearer, { secret_sha256: sha256("mine"), cursor: 0, kind: "agent", signal_sha256: sha256("mine") }),
        await at(a.id, "DELETE", `/devices/${PHONE}`, bearer),
        await at(a.id, "POST", `/devices/${AGENT}/signal`, bearer),
        await at(a.id, "POST", "/push", bearer, { device_id: PHONE, collapse_id: "x", ciphertext: "AAAA" }),
      ];
      expect(answers.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
    }
    expect(dumpMailbox(relay, a.id)).toEqual(before);
  }, 60_000);

  test("every device route opens for that device's own relay secret alone: not a sibling's, not the mailbox's, not the same device id's in another mailbox", async () => {
    const before = dumpMailbox(relay, a.id);
    const others = [...nobody(), sibling, otherPhone, a.secret];
    for (const bearer of [...others, agent]) {
      const answers = [
        await at(a.id, "GET", `/devices/${PHONE}/items?after=0`, bearer),
        await at(a.id, "POST", `/devices/${PHONE}/ack`, bearer, { through: 99 }),
        await at(a.id, "POST", `/devices/${PHONE}/commands`, bearer, { id: "cmd-stranger", ciphertext: "AAAAstranger" }),
        await at(a.id, "PUT", `/devices/${PHONE}/carriage`, bearer, { on: false }),
        await at(a.id, "PUT", `/devices/${PHONE}/apns`, bearer, { token: "ab".repeat(32), environment: "sandbox" }),
        await at(a.id, "PUT", `/devices/${PHONE}/fcm`, bearer, { token: "fcm-stranger" }),
      ];
      expect(answers.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
      for (const answer of answers) expect(((await answer.json()) as Json).items).toBeUndefined();
    }
    for (const bearer of [...others, phone]) {
      const answers = [
        await at(a.id, "GET", `/devices/${AGENT}/items?after=0`, bearer),
        await at(a.id, "POST", `/devices/${AGENT}/ack`, bearer, { item: 1 }),
        await at(a.id, "POST", `/devices/${AGENT}/commands`, bearer, { id: "cmd-stranger", ciphertext: "AAAAstranger" }),
      ];
      expect(answers.map((r) => r.status)).toEqual([401, 401, 401]);
    }
    expect(dumpMailbox(relay, a.id)).toEqual(before);
    const own = (await (await at(a.id, "GET", `/devices/${PHONE}/items?after=0`, phone)).json()) as Json;
    expect(own.items.map((i: Json) => i.ciphertext)).toEqual(["AAAAheldForThePhone"]);
    const sameIdElsewhere = (await (await at(b.id, "GET", `/devices/${PHONE}/items?after=0`, otherPhone)).json()) as Json;
    expect(sameIdElsewhere.items).toEqual([]);
  }, 60_000);

  test("the signal address answers only in its own mailbox", async () => {
    expect((await at(a.id, "GET", `/signals/${signal}`, null)).status).toBe(200);
    expect((await at(b.id, "GET", `/signals/${signal}`, null)).status).toBe(404);
    expect((await at(a.id, "GET", `/signals/${random()}`, null)).status).toBe(404);
  });

  test("a caller without a credential cannot tell a registered device from one that was never registered", async () => {
    const known = await at(a.id, "GET", `/devices/${PHONE}/items?after=0`, "not-a-secret");
    const unknown = await at(a.id, "GET", `/devices/${NOBODY}/items?after=0`, "not-a-secret");
    expect({ status: unknown.status, body: await unknown.json() }).toEqual({ status: known.status, body: await known.json() });
  });
});

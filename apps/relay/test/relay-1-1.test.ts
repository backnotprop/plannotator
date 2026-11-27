/**
 * Relay 1.1, proved under `wrangler dev` with Apple played locally
 * (stand-in-apple.ts); no Inbox runs here: this script is the Inbox's socket
 * and the phone, speaking the wire as the contract writes it
 * (adr/implementation/inbox-mobile.md, section 4, "Relay 1.1").
 *
 *  - the device socket: `{ n }` per item stored for that device and nothing
 *    else; nothing a phone sends on it acts as the Inbox; it never counts as
 *    the Inbox being online; a newer one replaces it; removing the device
 *    closes it;
 *  - Cancel: `DELETE .../commands/:id` before and after the Inbox has it;
 *  - the topic: on the list, off it, and absent (an app from before 1.1, pushed
 *    exactly as 1.0 pushed it);
 *  - the `live` push: counts only, at the Live Activity topic, anything else
 *    refused before Apple is called.
 *
 * Runs from apps/relay (`bun test`) like the rest of the proof; never deploys.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { apnsBody } from "../../../packages/server/inbox-relay-push";
import { RELAY_VERSION } from "../src/topics";
import { standInApple, type ApplePush } from "./stand-in-apple";
import { Database } from "bun:sqlite";
import { dumpMailbox, helloOf, mailboxFiles, sha256, sleep, startRelay, until, type Json, type Relay } from "./wrangler-relay";

const PHONE = "dev_01K7RELAY11PHONE000000000A";
const OTHER = "dev_01K7RELAY11OTHER000000000A";
const THIRD = "dev_01K7RELAY11THIRD000000000A";
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const TOKEN = "b".repeat(64);
const LIVE_TOKEN = "c".repeat(64);

interface Socket {
  ws: WebSocket;
  frames: Json[];
  closed: { code: number } | null;
}

describe("relay 1.1 under wrangler dev", () => {
  let relay: Relay;
  let apple: Awaited<ReturnType<typeof standInApple>>;
  let mailbox = "";
  const inbox = random();
  const phone = random();
  const other = random();
  const third = random();

  const at = (method: string, path: string, bearer: string | null, body?: unknown) =>
    fetch(`${relay.url}/v1/mailboxes/${mailbox}${path}`, {
      method,
      headers: { ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const open = (path: string, bearer: string): Promise<Socket> =>
    new Promise((ready, fail) => {
      const socket: Socket = { ws: new WebSocket(`${relay.url.replace(/^http/, "ws")}/v1/mailboxes/${mailbox}${path}`, { headers: { Authorization: `Bearer ${bearer}` } } as unknown as string[]), frames: [], closed: null };
      socket.ws.onmessage = (event) => socket.frames.push(JSON.parse(String(event.data)));
      socket.ws.onclose = (event) => (socket.closed = { code: event.code });
      socket.ws.onopen = () => ready(socket);
      socket.ws.onerror = () => fail(new Error(`${path} did not open`));
    });
  const commands = (device: string) => ((dumpMailbox(relay, mailbox).commands as Json[] | undefined) ?? []).filter((row) => row.device_id === device).map((row) => row.id);
  const lastPush = (): ApplePush => apple.pushes.at(-1)!;

  beforeAll(async () => {
    apple = await standInApple();
    relay = await startRelay("relay-1-1", { ...apple.vars, APNS_TOPICS: "ai.plannotator.app, ai.plannotator.app.beta" });
    const made = await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(inbox) }) });
    mailbox = ((await made.json()) as Json).mailbox_id;
    expect((await at("PUT", `/devices/${PHONE}`, inbox, { secret_sha256: sha256(phone), cursor: 0 })).status).toBe(200);
    expect((await at("PUT", `/devices/${OTHER}`, inbox, { secret_sha256: sha256(other), cursor: 0 })).status).toBe(200);
    expect((await at("PUT", `/devices/${THIRD}`, inbox, { secret_sha256: sha256(third), cursor: 0 })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await relay?.stop();
    apple?.close();
  });

  test("hello says the relay's version, beside 1.0's fields", async () => {
    const hello = await helloOf(relay.url, mailbox, inbox);
    expect(hello.version).toBe(RELAY_VERSION);
    expect(hello.devices.find((d: Json) => d.device_id === PHONE)).toEqual({ device_id: PHONE, cursor: 0, carriage: true, apns: false, fcm: false, topic: false });
  });

  test("the Inbox hears when a phone starts and stops naming its app's topic, and hello lists it; a token with no topic says nothing", async () => {
    const hub = await open("/socket", inbox);
    await until(() => hub.frames.some((f) => f.type === "hello"), (said) => said, "hello");
    expect((await at("PUT", `/devices/${THIRD}/apns`, third, { token: TOKEN, environment: "sandbox" })).status).toBe(204);
    expect((await at("PUT", `/devices/${THIRD}/apns`, third, { token: TOKEN, environment: "sandbox", topic: "ai.plannotator.app" })).status).toBe(204);
    expect((await at("PUT", `/devices/${THIRD}/apns`, third, { token: TOKEN, environment: "sandbox", topic: "ai.plannotator.app.beta" })).status).toBe(204);
    expect((await at("PUT", `/devices/${THIRD}/apns`, third, { token: null })).status).toBe(204);
    await until(() => hub.frames.filter((f) => f.type === "topic").length, (n) => n >= 2, "two topic frames");
    // One frame per change: a token with no topic, and a topic changed for another, say nothing.
    expect(hub.frames.filter((f) => f.type === "topic")).toEqual([
      { type: "topic", device_id: THIRD, topic: true },
      { type: "topic", device_id: THIRD, topic: false },
    ]);
    hub.ws.close();
    // hello lists it (a new Inbox socket replaces the one above).
    expect((await at("PUT", `/devices/${THIRD}/apns`, third, { token: TOKEN, environment: "sandbox", topic: "ai.plannotator.app" })).status).toBe(204);
    expect((await helloOf(relay.url, mailbox, inbox)).devices.find((d: Json) => d.device_id === THIRD).topic).toBe(true);
    expect((await at("PUT", `/devices/${THIRD}/apns`, third, { token: null })).status).toBe(204);
  }, 30_000);

  test("a device registered again with a new secret starts with no topic, and the Inbox is told; the same registration again says nothing", async () => {
    const FOURTH = "dev_01K7RELAY11FOURTH00000000A";
    const fourth = random();
    expect((await at("PUT", `/devices/${FOURTH}`, inbox, { secret_sha256: sha256(fourth), cursor: 0 })).status).toBe(200);
    const hub = await open("/socket", inbox);
    await until(() => hub.frames.some((f) => f.type === "hello"), (said) => said, "hello");
    expect((await at("PUT", `/devices/${FOURTH}/apns`, fourth, { token: TOKEN, environment: "sandbox", topic: "ai.plannotator.app" })).status).toBe(204);
    expect((await at("PUT", `/devices/${FOURTH}`, inbox, { secret_sha256: sha256(fourth), cursor: 0 })).status).toBe(200);
    expect((await at("PUT", `/devices/${FOURTH}`, inbox, { secret_sha256: sha256(random()), cursor: 0 })).status).toBe(200);
    await until(() => hub.frames.filter((f) => f.type === "topic").length, (n) => n >= 2, "two topic frames");
    expect(hub.frames.filter((f) => f.type === "topic")).toEqual([
      { type: "topic", device_id: FOURTH, topic: true },
      { type: "topic", device_id: FOURTH, topic: false },
    ]);
    hub.ws.close();
    expect((await helloOf(relay.url, mailbox, inbox)).devices.find((d: Json) => d.device_id === FOURTH).topic).toBe(false);
  }, 30_000);

  test("the device socket takes only that device's bearer, and an upgrade", async () => {
    expect((await at("GET", `/devices/${PHONE}/socket`, other)).status).toBe(401);
    expect((await at("GET", `/devices/${PHONE}/socket`, null)).status).toBe(401);
    expect((await at("GET", `/devices/${PHONE}/socket`, phone)).status).toBe(400);
  });

  test("the device socket hears { n } for each item stored for it, and nothing for another device's", async () => {
    const device = await open(`/devices/${PHONE}/socket`, phone);
    const otherDevice = await open(`/devices/${OTHER}/socket`, other);
    // A phone's socket is not the Inbox: the relay still says the computer is away.
    expect(((await (await at("GET", `/devices/${PHONE}/items`, phone)).json()) as Json).inbox_online).toBe(false);
    const hub = await open("/socket", inbox);
    hub.ws.send(JSON.stringify({ type: "item", device_id: PHONE, cursor: 5, ciphertext: "AAAArecord" }));
    hub.ws.send(JSON.stringify({ type: "item", device_id: PHONE, cursor: null, ciphertext: "AAAAresult" }));
    await until(() => device.frames.length, (n) => n === 2, "two notices");
    const items = ((await (await at("GET", `/devices/${PHONE}/items?after=0`, phone)).json()) as Json).items as Json[];
    expect(device.frames).toEqual(items.map((item) => ({ n: item.n })));
    await sleep(300);
    expect(otherDevice.frames).toEqual([]);
    hub.ws.close();
    device.ws.close();
    otherDevice.ws.close();
  }, 30_000);

  test("nothing a phone sends on its socket acts as the Inbox: no item is stored, no command is let go", async () => {
    await until(async () => ((await (await at("GET", `/devices/${OTHER}/items`, other)).json()) as Json).inbox_online, (online) => online === false, "the Inbox's socket gone");
    expect((await at("POST", `/devices/${OTHER}/commands`, other, { id: "cmd-kept", ciphertext: "AAAAcommand" })).status).toBe(202);
    const device = await open(`/devices/${OTHER}/socket`, other);
    device.ws.send(JSON.stringify({ type: "applied", device_id: OTHER, id: "cmd-kept" }));
    device.ws.send(JSON.stringify({ type: "item", device_id: OTHER, cursor: 9, ciphertext: "AAAAforged" }));
    await sleep(500);
    expect(commands(OTHER)).toEqual(["cmd-kept"]);
    expect(((await (await at("GET", `/devices/${OTHER}/items?after=0`, other)).json()) as Json).items).toEqual([]);
    expect(device.frames).toEqual([]);
    device.ws.close();
    // Leave nothing held for the tests after this one.
    const hub = await open("/socket", inbox);
    await until(() => hub.frames.some((f) => f.type === "command"), (seen) => seen, "the held command");
    hub.ws.send(JSON.stringify({ type: "applied", device_id: OTHER, id: "cmd-kept" }));
    await until(() => commands(OTHER).length, (n) => n === 0, "the command applied");
    hub.ws.close();
  }, 30_000);

  // Local workerd takes about 10 s to finish a close the relay starts, so both closes are awaited together.
  test("a newer socket for the device replaces the older (4000); removing the device closes it (4001)", async () => {
    const first = await open(`/devices/${THIRD}/socket`, third);
    const second = await open(`/devices/${THIRD}/socket`, third);
    const removed = await open(`/devices/${OTHER}/socket`, other);
    expect((await at("DELETE", `/devices/${OTHER}`, inbox)).status).toBe(204);
    await Promise.all([
      until(() => first.closed, (closed) => closed !== null, "the older socket closed"),
      until(() => removed.closed, (closed) => closed !== null, "the socket closed on removal"),
    ]);
    expect(first.closed!.code).toBe(4000);
    expect(removed.closed!.code).toBe(4001);
    expect(second.closed).toBeNull();
    second.ws.close();
  }, 30_000);

  test("Cancel takes back a command no Inbox socket has had (204); once one has, 409 already_handed; unknown, 404", async () => {
    await until(async () => ((await (await at("GET", `/devices/${PHONE}/items`, phone)).json()) as Json).inbox_online, (online) => online === false, "the Inbox's socket gone");
    expect((await at("POST", `/devices/${PHONE}/commands`, phone, { id: "key:take-back.1", ciphertext: "AAAAheld" })).status).toBe(202);
    expect((await at("DELETE", `/devices/${PHONE}/commands/${encodeURIComponent("key:take-back.1")}`, other)).status).toBe(401);
    expect((await at("DELETE", `/devices/${PHONE}/commands/${encodeURIComponent("key:take-back.1")}`, phone)).status).toBe(204);
    expect(commands(PHONE)).toEqual([]);
    const gone = await at("DELETE", `/devices/${PHONE}/commands/key:take-back.1`, phone);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: "command_not_found" });

    expect((await at("POST", `/devices/${PHONE}/commands`, phone, { id: "key-handed", ciphertext: "AAAAhanded" })).status).toBe(202);
    const hub = await open("/socket", inbox);
    await until(() => hub.frames.filter((f) => f.type === "command").map((f) => f.id), (ids) => ids.includes("key-handed"), "the command handed over");
    // The command taken back first never reached the Inbox.
    expect(hub.frames.filter((f) => f.type === "command").map((f) => f.id)).toEqual(["key-handed"]);
    const handed = await at("DELETE", `/devices/${PHONE}/commands/key-handed`, phone);
    expect(handed.status).toBe(409);
    expect(await handed.json()).toMatchObject({ code: "already_handed" });
    expect(commands(PHONE)).toEqual(["key-handed"]);

    // Posted while the Inbox is connected: handed at once, so it cannot be taken back.
    expect((await at("POST", `/devices/${PHONE}/commands`, phone, { id: "key-live", ciphertext: "AAAAlive" })).status).toBe(202);
    expect((await at("DELETE", `/devices/${PHONE}/commands/key-live`, phone)).status).toBe(409);
    for (const id of ["key-handed", "key-live"]) hub.ws.send(JSON.stringify({ type: "applied", device_id: PHONE, id }));
    await until(() => commands(PHONE).length, (n) => n === 0, "both applied");
    hub.ws.close();
  }, 30_000);

  test("a phone that names no topic is pushed exactly as relay 1.0 pushed it", async () => {
    expect((await at("PUT", `/devices/${PHONE}/apns`, phone, { token: TOKEN, environment: "sandbox" })).status).toBe(204);
    const sent = await at("POST", "/push", inbox, { device_id: PHONE, collapse_id: "c".repeat(64), ciphertext: "AAAAsealedPush" });
    expect(sent.status).toBe(202);
    const push = lastPush();
    expect(push.jwtValid).toBe(true);
    expect(push.headers).toMatchObject({ ":path": `/3/device/${TOKEN}`, "apns-push-type": "alert", "apns-priority": "10", "apns-topic": "ai.plannotator.app", "apns-collapse-id": "c".repeat(64) });
    expect(push.body).toBe(apnsBody("AAAAsealedPush"));
    expect(push.body).toBe('{"aps":{"alert":{"title":"Plannotator","body":"New in your Inbox"},"mutable-content":1,"sound":"default"},"e":"AAAAsealedPush"}');
  });

  test("a topic on the list is the push's apns-topic; one off it is refused and changes nothing", async () => {
    expect((await at("PUT", `/devices/${PHONE}/apns`, phone, { token: TOKEN, environment: "sandbox", topic: "ai.plannotator.app.beta" })).status).toBe(204);
    expect((await at("POST", "/push", inbox, { device_id: PHONE, collapse_id: "d".repeat(64), ciphertext: "AAAAbeta" })).status).toBe(202);
    expect(lastPush().headers["apns-topic"]).toBe("ai.plannotator.app.beta");

    const refused = await at("PUT", `/devices/${PHONE}/apns`, phone, { token: TOKEN, environment: "production", topic: "com.example.other" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "topic_not_allowed" });
    expect((await at("PUT", `/devices/${PHONE}/apns`, phone, { token: TOKEN, environment: "sandbox", topic: "not a bundle id" })).status).toBe(400);
    expect((await at("POST", "/push", inbox, { device_id: PHONE, collapse_id: "e".repeat(64), ciphertext: "AAAAstill" })).status).toBe(202);
    expect(lastPush().headers["apns-topic"]).toBe("ai.plannotator.app.beta");
  });

  test("a live push reaches Apple with only the counts, at the Live Activity topic; anything more is refused before Apple", async () => {
    const live = { timestamp: 1_790_000_000, event: "update", "content-state": { working: 2, stopped_on_you: 1, ended: false } };
    const none = await at("POST", "/push", inbox, { device_id: PHONE, kind: "live", live });
    expect(await none.json()).toEqual({ sent: false, reason: "no_live_token" });

    expect((await at("PUT", `/devices/${PHONE}/liveactivity`, phone, { token: LIVE_TOKEN })).status).toBe(204);
    const before = apple.pushes.length;
    expect((await at("POST", "/push", inbox, { device_id: PHONE, kind: "live", live })).status).toBe(202);
    expect(apple.pushes.length).toBe(before + 1);
    const push = lastPush();
    // Priority 5: Apple budgets priority-10 Live Activity updates and throttles past the budget.
    expect(push.headers).toMatchObject({ ":path": `/3/device/${LIVE_TOKEN}`, "apns-push-type": "liveactivity", "apns-priority": "5", "apns-topic": "ai.plannotator.app.beta.push-type.liveactivity" });
    expect(push.headers["apns-collapse-id"]).toBeUndefined();
    expect(JSON.parse(push.body)).toEqual({ aps: live });

    for (const wrong of [
      { ...live, "content-state": { ...live["content-state"], title: "Ship it?" } },
      { ...live, "content-state": { ...live["content-state"], working: "2" } },
      { ...live, alert: "Ship it?" },
      { ...live, event: "start" },
    ]) {
      expect((await at("POST", "/push", inbox, { device_id: PHONE, kind: "live", live: wrong })).status).toBe(400);
    }
    expect((await at("POST", "/push", inbox, { device_id: PHONE, kind: "loud", collapse_id: "f".repeat(64), ciphertext: "AAAA" })).status).toBe(400);
    expect(apple.pushes.length).toBe(before + 1);
    // Only the Inbox posts pushes.
    expect((await at("POST", "/push", phone, { device_id: PHONE, kind: "live", live })).status).toBe(401);
  });

  test("Apple's 410 deletes only the token it refused: one the phone registered while the push was on its way stays", async () => {
    const refused = "4101" + "a".repeat(60);
    const fresh = "d".repeat(64);
    expect((await at("PUT", `/devices/${PHONE}/apns`, phone, { token: refused, environment: "sandbox" })).status).toBe(204);
    const push = at("POST", "/push", inbox, { device_id: PHONE, collapse_id: "g".repeat(64), ciphertext: "AAAAgone" });
    await until(() => apple.pushes.some((p) => p.headers[":path"] === `/3/device/${refused}`), (seen) => seen, "the push at Apple");
    expect((await at("PUT", `/devices/${PHONE}/apns`, phone, { token: fresh, environment: "sandbox" })).status).toBe(204);
    expect(await (await push).json()).toEqual({ sent: false, reason: "apns_gone" });
    const row = (dumpMailbox(relay, mailbox).devices as Json[]).find((d) => d.id === PHONE)!;
    expect(row.apns_token).toBe(fresh);
  }, 30_000);

  // Last: it restarts the relay. A command written by code that knows no `handed` (1.0 before the upgrade, or 1.0 again
  // during a rollback) may have been handed over already, so it counts as handed: Cancel never removes what an Inbox
  // may have applied. 1.1 writes `handed = 0` itself.
  test("a command written by 1.0, before the upgrade or during a rollback, cannot be taken back after 1.1 runs again", async () => {
    await until(async () => ((await (await at("GET", `/devices/${PHONE}/items`, phone)).json()) as Json).inbox_online, (online) => online === false, "the Inbox's socket gone");
    expect((await at("POST", `/devices/${PHONE}/commands`, phone, { id: "key-from-1-0", ciphertext: "AAAAold" })).status).toBe(202);
    await relay.stop();
    const file = mailboxFiles(relay).find((f) => {
      const db = new Database(f, { readonly: true });
      try {
        return (db.query("SELECT name FROM __miniflare_do_name").get() as { name: string } | null)?.name === mailbox;
      } finally {
        db.close();
      }
    })!;
    // Before the upgrade: the table as 1.0 made it, with no `handed`.
    const asOneZero = (sql: string) => {
      const db = new Database(file);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    };
    asOneZero("ALTER TABLE commands DROP COLUMN handed");
    const restart = async () => {
      relay = await startRelay("relay-1-1", { ...apple.vars, APNS_TOPICS: "ai.plannotator.app, ai.plannotator.app.beta" }, { keep: true });
    };
    await restart();
    const refused = await at("DELETE", `/devices/${PHONE}/commands/key-from-1-0`, phone);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "already_handed" });
    expect(commands(PHONE)).toEqual(["key-from-1-0"]);

    // 1.1 again: a command it writes itself can be taken back.
    expect((await at("POST", `/devices/${PHONE}/commands`, phone, { id: "key-from-1-1", ciphertext: "AAAAnew" })).status).toBe(202);
    expect((await at("DELETE", `/devices/${PHONE}/commands/key-from-1-1`, phone)).status).toBe(204);

    // A rollback to 1.0: its INSERT names no `handed` (the column stays). Then 1.1 is deployed again.
    await relay.stop();
    asOneZero(`INSERT INTO commands (seq, device_id, id, part, data, held_at) VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM commands), '${PHONE}', 'key-during-rollback', 0, 'AAAArolled', ${Date.now()})`);
    await restart();
    const rolled = await at("DELETE", `/devices/${PHONE}/commands/key-during-rollback`, phone);
    expect(rolled.status).toBe(409);
    expect(await rolled.json()).toMatchObject({ code: "already_handed" });
    expect(commands(PHONE).sort()).toEqual(["key-during-rollback", "key-from-1-0"]);
  }, 120_000);
});

/**
 * Link two computers through a third (inbox-link-through.ts, core inbox-link-through.ts). Three module instances in
 * temp folders stand for Studio (linked to both), Laptop and Mini (not linked to each other). The links between them
 * are played by hand: a request goes straight to the other instance's door handler, a held ask waits in a list until
 * its computer is back, and "linking" with a code is the code's maker checking the secret it made and the computer
 * it made it for, then both sides naming each other as linked. What regresses: the gap not seen, or seen when there
 * is none; an older computer offered; a click that links nothing; an away computer that never links once back; a
 * link code written to the broker's disk; an introduction taken from a computer that is not linked, without a
 * window's press, or a second time; two computers whose clocks disagree refused as late; the introductions seen
 * growing without bound or written per entry; a code made with six digits or not bound to the computer it is for; an
 * address from the broker taken outside a test sandbox; a refused ask that leaves its row idle. The door's side of the
 * binding (a provisional device) is in inbox-link-through-pass.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK_THROUGH_MARK, linkThroughPairs, linkThroughRows, readLinkThroughWire, type LinkThroughPeerFacts, type LinkThroughWire } from "@plannotator/core/inbox-link-through";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { buildLinkOffer, parseLinkOffer } from "./inbox-links";
import { createLinkThrough, LINK_THROUGH_ASK_ROUTE, LINK_THROUGH_INTRODUCE_ROUTE, LINK_THROUGH_OFFER_ROUTE, linkThroughAsks, type InboxLinkThrough } from "./inbox-link-through";
import type { OutboxEntry } from "./inbox-outbox";

const ibx = (last: string) => `ibx_${"0".repeat(25)}${last}`;
const STUDIO = ibx("S");
const LAPTOP = ibx("A");
const MINI = ibx("M");
const OTHER = ibx("X");

interface Node {
  id: string;
  name: string;
  dataDir: string;
  online: boolean;
  older: boolean;
  links: Set<string>;
  /** This node's copy of each link's `link_through`, as its list was last read. */
  read: Map<string, LinkThroughWire | null>;
  held: { via: string; body: Record<string, unknown> }[];
  /** Link codes it made: their secret, the computer each is for and who introduced it, and whether it was redeemed. */
  offers: Map<string, { device: string | null; for: string; by: string }>;
  /** What it was asked to link with (the ordinary link's input). */
  linked: { link: string; address?: string; back?: string }[];
  module: InboxLinkThrough;
}

interface WorldOptions {
  /** Each computer's clock (default: this one's). */
  clocks?: Record<string, () => number>;
  /** Each computer's environment (default: the test sandbox). */
  envs?: Record<string, Record<string, string | undefined>>;
  /** Computers whose door is not on the tailnet (two Inboxes on one computer in a test). */
  unpublished?: string[];
}

/** Three computers and the links between them. */
function world(names: Record<string, string> = { [STUDIO]: "Studio", [LAPTOP]: "Laptop", [MINI]: "Mini" }, options: WorldOptions = {}) {
  const nodes = new Map<string, Node>();
  const sent: { from: string; to: string; route: string; body: Record<string, unknown> }[] = [];
  const node = (id: string) => nodes.get(id)!;
  const wireOf = (id: string): LinkThroughWire | null => (node(id).older ? null : node(id).module.wire());
  const refresh = (viewer: string, ids: string[]) => {
    for (const id of ids) if (node(id).online && node(viewer).links.has(id)) node(viewer).read.set(id, wireOf(id));
  };

  for (const [id, name] of Object.entries(names)) {
    const self: Node = {
      id,
      name,
      dataDir: mkdtempSync(join(tmpdir(), `plannotator-link-through-${name.toLowerCase()}-`)),
      online: true,
      older: false,
      links: new Set(),
      read: new Map(),
      held: [],
      offers: new Map(),
      linked: [],
      module: null as unknown as InboxLinkThrough,
    };
    nodes.set(id, self);
    self.module = createLinkThrough({
      dataDir: self.dataDir,
      selfId: () => id,
      peers: () =>
        [...self.links].map((other) => ({
          id: other,
          name: node(other).name,
          state: node(other).online ? "online" : "offline",
          marks: node(other).older ? [] : [LINK_THROUGH_MARK],
          wire: self.read.get(other) ?? null,
          url: `https://${node(other).name.toLowerCase()}.tail1234.ts.net:8443`,
        })),
      request: async (to, route, body) => {
        if (!node(to).online) throw new Error("offline");
        sent.push({ from: id, to, route, body });
        return door(id, to, route, body, true);
      },
      hold: (via, body) => self.held.push({ via, body }),
      held: () => self.held.map((entry) => ({ via: entry.via, with: String(entry.body.with), why: null })),
      link: async (input) => {
        self.linked.push(input);
        const code = parseLinkOffer(input.link);
        const maker = code?.id ? nodes.get(code.id) : undefined;
        const offer = code?.secret ? maker?.offers.get(code.secret) : undefined;
        if (!maker || !offer || offer.device) throw new InboxError("offer_expired", "This link code is no longer open.");
        offer.device = `dev_${id}`;
        // The code's maker's door takes the link-back only from the computer the code was made for (inbox-devices.ts;
        // the real door is in inbox-link-through-pass.test.ts).
        if (offer.for !== id) throw new InboxError("introduction_mismatch", "This link code was made for another computer.");
        self.links.add(maker.id);
        maker.links.add(id);
        changed();
        return { machine: { id: maker.id } };
      },
      introOffer: (forId, by) => {
        const secret = `secret${Math.random().toString(16).slice(2)}`;
        self.offers.set(secret, { device: null, for: forId, by });
        return { link: buildLinkOffer({ id, name, tailnet: `${name.toLowerCase()}.tail1234.ts.net:8443`, secret, code: null }) };
      },
      ownAddress: () => (options.unpublished?.includes(id) ? null : `${name.toLowerCase()}.tail1234.ts.net:8443`),
      refresh: async (ids) => refresh(id, ids),
      changed: () => changed(),
      now: options.clocks?.[id],
      env: options.envs?.[id] ?? { PLANNOTATOR_TEST_SANDBOX: "1" },
    });
  }

  /** A door route of `to`, from `from`'s token (null when `to` is not linked to `from`). */
  const door = async (from: string, to: string, route: string, body: Record<string, unknown>, window: boolean): Promise<Response> => {
    const target = node(to);
    const caller = target.links.has(from) ? from : null;
    const answer =
      route === LINK_THROUGH_ASK_ROUTE
        ? target.module.asked(caller, window, body)
        : route === LINK_THROUGH_OFFER_ROUTE
          ? await target.module.offerFor(caller, window, body)
          : await target.module.introduce(caller, window, body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
  };

  let dirty = true;
  const changed = () => {
    dirty = true;
  };

  /** Every list read again and every held ask sent, until nothing moves (the `links` events and the outbox). */
  const settle = async () => {
    for (let round = 0; round < 40; round++) {
      dirty = false;
      for (const n of nodes.values()) {
        refresh(n.id, [...n.links]);
        for (const entry of [...n.held]) {
          if (!node(entry.via).online || !n.online) continue;
          n.held.splice(n.held.indexOf(entry), 1);
          await door(n.id, entry.via, LINK_THROUGH_ASK_ROUTE, entry.body, true);
        }
        n.module.tick();
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!dirty) return;
    }
  };

  const link = (x: string, y: string) => {
    node(x).links.add(y);
    node(y).links.add(x);
  };
  return { nodes, node, link, settle, sent, door };
}

/** Studio linked to Laptop and Mini, which are not linked to each other. */
async function chain() {
  const w = world();
  w.link(STUDIO, LAPTOP);
  w.link(STUDIO, MINI);
  await w.settle();
  return w;
}

const facts = (id: string, name: string, links: string[], options: { marks?: string[]; state?: string; through?: boolean } = {}): LinkThroughPeerFacts => ({
  id,
  name,
  state: options.state ?? "online",
  marks: options.marks ?? [LINK_THROUGH_MARK],
  wire: { links: links.map((l) => ({ id: l, name: l === STUDIO ? "Studio" : l === MINI ? "Mini" : "Laptop", through: options.through ?? true, away: false })), pending: [] },
});

describe("detection", () => {
  test("the computer linked to both sees two links that are not linked to each other, and nothing once they are", () => {
    const unlinked = linkThroughPairs([facts(LAPTOP, "Laptop", [STUDIO]), facts(MINI, "Mini", [STUDIO])], []);
    expect(unlinked).toEqual([{ a: { id: LAPTOP, name: "Laptop" }, c: { id: MINI, name: "Mini" }, status: "idle", waiting_for: null, why: null }]);
    // Either side naming the other is enough (a link one side has not read back yet).
    expect(linkThroughPairs([facts(LAPTOP, "Laptop", [STUDIO, MINI]), facts(MINI, "Mini", [STUDIO])], [])).toEqual([]);
  });

  test("one of the two reaches the third through a link, once, and never itself or a computer it is linked to", () => {
    const rows = linkThroughRows(LAPTOP, [facts(STUDIO, "Studio", [LAPTOP, MINI])], []);
    expect(rows).toEqual([{ id: MINI, name: "Mini", via: { id: STUDIO, name: "Studio" }, status: "idle", waiting_for: null, why: null }]);
    expect(linkThroughRows(LAPTOP, [facts(STUDIO, "Studio", [LAPTOP, MINI]), facts(MINI, "Mini", [STUDIO, LAPTOP])], [])).toEqual([]);
  });

  test("an older computer is never offered: no mark, no list, or a third computer its link says is older", () => {
    expect(linkThroughPairs([facts(LAPTOP, "Laptop", [STUDIO]), { ...facts(MINI, "Mini", [STUDIO]), marks: [] }], [])).toEqual([]);
    expect(linkThroughPairs([facts(LAPTOP, "Laptop", [STUDIO]), { ...facts(MINI, "Mini", [STUDIO]), wire: null }], [])).toEqual([]);
    expect(linkThroughRows(LAPTOP, [{ ...facts(STUDIO, "Studio", [LAPTOP, MINI]), marks: [] }], [])).toEqual([]);
    expect(linkThroughRows(LAPTOP, [facts(STUDIO, "Studio", [LAPTOP, MINI], { through: false })], [])).toEqual([]);
  });

  test("a hostile list's `link_through` is read by field: bad ids out, names one line, a job naming one id twice out", () => {
    const wire = readLinkThroughWire({
      links: [{ id: MINI, name: "Mi\u001b[31mni\nthere", through: true }, { id: "../etc", name: "x" }, { id: MINI, name: "again" }],
      pending: [{ a: LAPTOP, c: LAPTOP, state: "waiting" }, { a: LAPTOP, c: MINI, state: "failed", why: "no" }],
    });
    expect(wire).toEqual({ links: [{ id: MINI, name: "Mi [31mni there", through: true, away: false }], pending: [{ a: LAPTOP, c: MINI, state: "failed", why: "no" }] });
    expect(readLinkThroughWire(null)).toBeNull();
    expect(readLinkThroughWire({ pending: [] })).toBeNull();
  });
});

describe("the broker's exchange", () => {
  test("both online, Link on Studio: Laptop and Mini hold a link to each other, and Studio keeps no link code", async () => {
    const w = await chain();
    expect(w.node(STUDIO).module.view().pairs).toHaveLength(1);
    expect(w.node(LAPTOP).module.view().through.map((row) => [row.id, row.via.id])).toEqual([[MINI, STUDIO]]);
    expect(w.node(STUDIO).module.linkHere(LAPTOP, MINI).status).toBe(200);
    await w.settle();
    expect(w.node(LAPTOP).links.has(MINI)).toBe(true);
    expect(w.node(MINI).links.has(LAPTOP)).toBe(true);
    expect(w.node(STUDIO).module.view()).toEqual({ pairs: [], through: [] });
    expect(w.node(LAPTOP).module.view().through).toEqual([]);
    expect(w.node(STUDIO).module.wire().pending).toEqual([]);
    // The code Mini made went through Studio's memory only.
    const code = w.sent.find((s) => s.route === LINK_THROUGH_INTRODUCE_ROUTE)!.body.link as string;
    const kept = join(w.node(STUDIO).dataDir, "inbox", "link-through.json");
    expect(existsSync(kept)).toBe(true);
    expect(readFileSync(kept, "utf8")).not.toContain(parseLinkOffer(code)!.secret!);
  });

  test("both online, Link on Laptop: it asks Studio, which links it with Mini", async () => {
    const w = await chain();
    expect(w.node(LAPTOP).module.askVia(STUDIO, MINI).status).toBe(200);
    expect(w.node(LAPTOP).module.view().through[0]!.status).toBe("linking");
    await w.settle();
    expect(w.node(LAPTOP).links.has(MINI)).toBe(true);
    expect(w.node(MINI).links.has(LAPTOP)).toBe(true);
    expect(w.node(LAPTOP).module.view().through).toEqual([]);
  });

  test("Mini away at the click: Studio says it waits for Mini, and links them once Mini is back", async () => {
    const w = await chain();
    w.node(MINI).online = false;
    w.node(STUDIO).module.linkHere(LAPTOP, MINI);
    await w.settle();
    expect(w.node(LAPTOP).links.has(MINI)).toBe(false);
    expect(w.node(STUDIO).module.view().pairs[0]).toMatchObject({ status: "waiting", waiting_for: "Mini" });
    w.node(MINI).online = true;
    await w.settle();
    expect(w.node(LAPTOP).links.has(MINI)).toBe(true);
    expect(w.node(STUDIO).module.view().pairs).toEqual([]);
  });

  test("Studio away at Laptop's click: the ask waits on Laptop, then Studio links them when it is back", async () => {
    const w = await chain();
    w.node(STUDIO).online = false;
    w.node(LAPTOP).module.askVia(STUDIO, MINI);
    // Laptop's view of Studio (asleep) as its link would say.
    const laptop = w.node(LAPTOP);
    expect(laptop.held).toHaveLength(1);
    expect(laptop.module.view().through[0]).toMatchObject({ id: MINI, status: "waiting", waiting_for: "Studio" });
    // A second click while it waits holds nothing more.
    laptop.module.askVia(STUDIO, MINI);
    expect(laptop.held).toHaveLength(1);
    w.node(STUDIO).online = true;
    await w.settle();
    expect(laptop.links.has(MINI)).toBe(true);
  });

  test("a job that waits is kept on the broker's disk (a restart picks it up), with no link code in it", async () => {
    const w = await chain();
    w.node(MINI).online = false;
    w.node(STUDIO).module.linkHere(LAPTOP, MINI);
    await w.settle();
    const kept = readFileSync(join(w.node(STUDIO).dataDir, "inbox", "link-through.json"), "utf8");
    expect(JSON.parse(kept).jobs).toHaveLength(1);
    expect(JSON.parse(kept).jobs[0]).toMatchObject({ a: LAPTOP, c: MINI, state: "waiting" });
  });

  test("an older computer (no mark) is not offered, and a click for it is refused with the update words", async () => {
    const w = world();
    w.link(STUDIO, LAPTOP);
    w.link(STUDIO, MINI);
    w.node(MINI).older = true;
    await w.settle();
    expect(w.node(STUDIO).module.view().pairs).toEqual([]);
    expect(w.node(LAPTOP).module.view().through).toEqual([]);
    const refused = w.node(STUDIO).module.linkHere(LAPTOP, MINI);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("machine_needs_update");
    expect(w.sent).toEqual([]);
  });

  test("a refusal from one of the two is said on the row, and Link again tries again", async () => {
    const w = await chain();
    // Laptop refuses the code (as an ordinary link would, say, an expired code).
    const laptop = w.node(LAPTOP);
    const original = laptop.module;
    laptop.module = { ...original, introduce: async () => ({ status: 409, body: { error: "This link code is no longer open.", code: "offer_expired" } }) };
    w.node(STUDIO).module.linkHere(LAPTOP, MINI);
    await w.settle();
    expect(w.node(STUDIO).module.view().pairs[0]).toMatchObject({ status: "failed", why: "This link code is no longer open." });
    laptop.module = original;
    w.node(STUDIO).module.linkHere(LAPTOP, MINI);
    await w.settle();
    expect(laptop.links.has(MINI)).toBe(true);
  });
});

describe("what a linked computer can cause", () => {
  test("an introduction or a code request from a computer that is not linked is refused, and nothing is linked", async () => {
    const w = await chain();
    const at = new Date().toISOString();
    const intro = `lt_${"a".repeat(32)}`;
    // OTHER is linked to nobody: Laptop's door has no machine for its token.
    const introduced = await w.node(LAPTOP).module.introduce(null, true, { intro, at, link: "plannotator://link?v=1", with: { id: MINI } });
    expect(introduced.status).toBe(404);
    const offered = await w.node(MINI).module.offerFor(null, true, { intro, at, for: { id: OTHER } });
    expect(offered.status).toBe(404);
    expect(w.node(MINI).offers.size).toBe(0);
    expect(w.node(STUDIO).module.asked(null, true, { with: MINI }).status).toBe(404);
  });

  test("without a window's press there, every route is refused", async () => {
    const w = await chain();
    const at = new Date().toISOString();
    expect(w.node(STUDIO).module.asked(LAPTOP, false, { with: MINI }).status).toBe(403);
    expect((await w.node(MINI).module.offerFor(STUDIO, false, { intro: `lt_${"b".repeat(32)}`, at, for: { id: LAPTOP } })).status).toBe(403);
    expect((await w.node(LAPTOP).module.introduce(STUDIO, false, { intro: `lt_${"c".repeat(32)}`, at, link: "x", with: { id: MINI } })).status).toBe(403);
    expect(w.node(MINI).offers.size).toBe(0);
  });

  test("a linked computer cannot make this one link to a computer it does not itself name as linked", async () => {
    const w = await chain();
    const at = new Date().toISOString();
    const stray = buildLinkOffer({ id: OTHER, name: "Stray", tailnet: "stray.tail1234.ts.net:8443", secret: "s3cret", code: "123456" });
    const refused = await w.node(LAPTOP).module.introduce(STUDIO, true, { intro: `lt_${"d".repeat(32)}`, at, link: stray, with: { id: OTHER } });
    expect(refused).toMatchObject({ status: 409, body: { code: "not_linked_there" } });
    // A code that is not the named computer's own.
    const mismatch = buildLinkOffer({ id: OTHER, name: "Stray", tailnet: "stray.tail1234.ts.net:8443", secret: "s3cret", code: "123456" });
    expect((await w.node(LAPTOP).module.introduce(STUDIO, true, { intro: `lt_${"e".repeat(32)}`, at, link: mismatch, with: { id: MINI } })).status).toBe(422);
    expect(w.node(LAPTOP).links.has(OTHER)).toBe(false);
    // Nor ask this one for a code for a computer it does not name.
    expect(await w.node(MINI).module.offerFor(STUDIO, true, { intro: `lt_${"f".repeat(32)}`, at, for: { id: OTHER } })).toMatchObject({ status: 409, body: { code: "not_linked_there" } });
    expect(w.node(MINI).offers.size).toBe(0);
  });

  test("an introduction is taken once: a replay is refused", async () => {
    const w = await chain();
    w.node(STUDIO).module.linkHere(LAPTOP, MINI);
    await w.settle();
    expect(w.node(LAPTOP).links.has(MINI)).toBe(true);
    const introduced = w.sent.find((s) => s.route === LINK_THROUGH_INTRODUCE_ROUTE)!;
    const offered = w.sent.find((s) => s.route === LINK_THROUGH_OFFER_ROUTE)!;
    // Unlinked again by hand, so a replay would otherwise link them.
    w.node(LAPTOP).links.delete(MINI);
    w.node(MINI).links.delete(LAPTOP);
    await w.settle();
    expect(await w.node(LAPTOP).module.introduce(STUDIO, true, introduced.body)).toMatchObject({ status: 409, body: { code: "introduction_used" } });
    expect(await w.node(MINI).module.offerFor(STUDIO, true, offered.body)).toMatchObject({ status: 409, body: { code: "introduction_used" } });
    expect(w.node(LAPTOP).links.has(MINI)).toBe(false);
  });

  test("computers whose clocks disagree by more than any window still link", async () => {
    const hour = 60 * 60_000;
    const w = world(undefined, { clocks: { [LAPTOP]: () => Date.now() + 3 * hour, [MINI]: () => Date.now() - 5 * hour } });
    w.link(STUDIO, LAPTOP);
    w.link(STUDIO, MINI);
    await w.settle();
    w.node(STUDIO).module.linkHere(LAPTOP, MINI);
    await w.settle();
    expect(w.node(STUDIO).module.view().pairs).toEqual([]);
    expect(w.node(LAPTOP).links.has(MINI)).toBe(true);
  });

  test("the introductions seen are kept per broker, a bounded number, and never written to disk", async () => {
    const w = await chain();
    const laptop = w.node(LAPTOP).module;
    const intro = (i: number) => `lt_${i.toString(16).padStart(32, "0")}`;
    // Many introductions from Studio, each for a code that is not Mini's own (refused after it is seen).
    for (let i = 1; i <= 200; i++) {
      const code = buildLinkOffer({ id: MINI, name: "Mini", tailnet: "mini.tail1234.ts.net:8443", secret: `s${i}`, code: null });
      await laptop.introduce(STUDIO, true, { intro: intro(i), link: code, with: { id: MINI } });
    }
    // The newest are still refused as used; the oldest have left the list.
    expect(await laptop.introduce(STUDIO, true, { intro: intro(200), link: "x", with: { id: MINI } })).toMatchObject({ status: 409, body: { code: "introduction_used" } });
    expect((await laptop.introduce(STUDIO, true, { intro: intro(1), link: "x", with: { id: MINI } })).body.code).not.toBe("introduction_used");
    // Nothing of them on Laptop's disk (it brokers nothing, so it keeps no file).
    expect(existsSync(join(w.node(LAPTOP).dataDir, "inbox", "link-through.json"))).toBe(false);
  });

  test("a code Mini makes is bound to the computer it is for and the broker that asked, and carries no six digits", async () => {
    const w = await chain();
    const offered = await w.node(MINI).module.offerFor(STUDIO, true, { intro: `lt_${"7".repeat(32)}`, for: { id: LAPTOP } });
    expect(offered.status).toBe(200);
    const code = parseLinkOffer(offered.body.link as string)!;
    expect(code.code).toBeNull();
    expect(w.node(MINI).offers.get(code.secret!)).toMatchObject({ for: LAPTOP, by: STUDIO });
  });

  test("outside a test sandbox, the taker never takes an address or a way back from the broker", async () => {
    const tailnetless = buildLinkOffer({ id: MINI, name: "Mini", tailnet: null, secret: "s", code: null });
    const body = { link: tailnetless, with: { id: MINI }, address: "http://127.0.0.1:9", back: "http://127.0.0.1:8" };
    const production = world(undefined, { envs: { [LAPTOP]: {} }, unpublished: [LAPTOP] });
    production.link(STUDIO, LAPTOP);
    production.link(STUDIO, MINI);
    await production.settle();
    await production.node(LAPTOP).module.introduce(STUDIO, true, { ...body, intro: `lt_${"1".repeat(32)}` });
    expect(production.node(LAPTOP).linked).toEqual([{ link: tailnetless }]);
    // Inside one, two Inboxes on one computer reach each other by what the broker says.
    const sandbox = world(undefined, { unpublished: [LAPTOP] });
    sandbox.link(STUDIO, LAPTOP);
    sandbox.link(STUDIO, MINI);
    await sandbox.settle();
    await sandbox.node(LAPTOP).module.introduce(STUDIO, true, { ...body, intro: `lt_${"2".repeat(32)}` });
    expect(sandbox.node(LAPTOP).linked).toEqual([{ link: tailnetless, address: body.address, back: body.back }]);
  });

  test("outside a test sandbox, the broker sends no addresses", async () => {
    const w = world(undefined, { envs: { [STUDIO]: {} } });
    w.link(STUDIO, LAPTOP);
    w.link(STUDIO, MINI);
    await w.settle();
    w.node(STUDIO).module.linkHere(LAPTOP, MINI);
    await w.settle();
    const introduced = w.sent.find((s) => s.route === LINK_THROUGH_INTRODUCE_ROUTE)!;
    expect(introduced.body.address).toBeUndefined();
    expect(introduced.body.back).toBeUndefined();
    expect(w.node(LAPTOP).links.has(MINI)).toBe(true);
  });
});

describe("the computer that asked, when its ask is refused", () => {
  const entry = (n: number, state: OutboxEntry["state"], answer: unknown = null): OutboxEntry => ({
    v: 1,
    key: `link-through:${MINI}:${n}`,
    machine: STUDIO,
    route: LINK_THROUGH_ASK_ROUTE,
    body: { with: MINI },
    n,
    queued_at: "2026-11-24T00:00:00Z",
    state,
    left: state !== "queued",
    errors: 0,
    status: state === "refused" ? 404 : state === "delivered" ? 200 : null,
    answer,
    settled_at: null,
    notice: null,
    dismissed: false,
    auto: true,
  });
  const studio = { id: STUDIO, name: "Studio" };

  test("its row says the refusal's words, and a newer ask (Link again) says it is linking", () => {
    const refused = linkThroughAsks([entry(1, "refused", { error: "That computer is not linked here.", code: "machine_not_linked" })], studio);
    expect(refused).toEqual([{ via: STUDIO, with: MINI, why: "That computer is not linked here." }]);
    expect(linkThroughRows(LAPTOP, [facts(STUDIO, "Studio", [LAPTOP, MINI])], refused)[0]).toMatchObject({ status: "failed", why: "That computer is not linked here." });
    const again = linkThroughAsks([entry(1, "refused", { error: "No." }), entry(2, "queued")], studio);
    expect(linkThroughRows(LAPTOP, [facts(STUDIO, "Studio", [LAPTOP, MINI])], again)[0]).toMatchObject({ status: "linking", why: null });
    // Taken there (the broker's own job tells the rest), and words the broker did not give.
    expect(linkThroughAsks([entry(1, "delivered")], studio)).toEqual([]);
    expect(linkThroughAsks([entry(1, "refused", "not json")], studio)[0]!.why).toBe("Studio answered 404.");
  });

  test("an ask given up on, or whose link went before it left, says so on its row too, never an idle row", () => {
    const facts3 = [facts(STUDIO, "Studio", [LAPTOP, MINI])];
    const parked = linkThroughAsks([{ ...entry(1, "parked"), notice: { kind: "may_have_been_delivered", at: "2026-11-24T00:01:00Z" } }], studio);
    expect(parked).toEqual([{ via: STUDIO, with: MINI, why: "May have been delivered. Check on Studio." }]);
    expect(linkThroughRows(LAPTOP, facts3, parked)[0]).toMatchObject({ status: "failed", why: "May have been delivered. Check on Studio." });
    const dropped = linkThroughAsks([{ ...entry(1, "dropped"), left: false, notice: { kind: "not_delivered", at: "2026-11-24T00:01:00Z" } }], studio);
    expect(linkThroughRows(LAPTOP, facts3, dropped)[0]).toMatchObject({ status: "failed", why: "Studio was unlinked before it went." });
    // Link again: the newer ask is under way.
    expect(linkThroughRows(LAPTOP, facts3, linkThroughAsks([entry(1, "parked"), entry(2, "queued")], studio))[0]).toMatchObject({ status: "linking", why: null });
  });
});

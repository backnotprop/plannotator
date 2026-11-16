/**
 * Tag row colours (approval "inbox-thread-tags", step 3): what a new tag is given, and the one colour and switch every
 * linked machine shows. What this catches: a new tag given a colour another tag already has while one of the twelve is
 * free, or not alternating vivid and calm; a colour stored in a form an older linked Inbox refuses; a quick swatch
 * kept among the person's own colours; two linked machines showing a tag in different colours (each preferring its own); an automatic colour
 * overriding the one the person picked; an older machine's missing switch read as off.
 */
import { describe, expect, test } from "bun:test";
import { inboxMachineTags, type InboxInitiative } from "./inbox-initiatives";
import { INBOX_TAG_AUTO_COLOURS, INBOX_TAG_PRESET_HEX, INBOX_TAG_SWATCHES, inboxNextTagColour, inboxTagColoursOf, inboxTagColoursRead, inboxTagHex, inboxTagLookOf, inboxTagOwnColour, isInboxTagColour, isInboxTagLook, type InboxTagLook } from "./inbox-tag-colours";

const auto = (colour: string, at = "2026-11-12T09:00:00.000Z"): InboxTagLook => ({ colour, by: "auto", at });
const person = (colour: string | null, at: string): InboxTagLook => ({ colour, by: "person", at });
const tag = (id: string, name: string, at: string, look?: InboxTagLook): InboxInitiative & { look?: InboxTagLook } => ({
  id,
  name,
  created_at: at,
  created_by: { kind: "person" },
  updated_at: at,
  deleted_at: null,
  ...(look ? { look } : {}),
});

const SW = (name: string) => INBOX_TAG_SWATCHES.find((s) => s.name === name)!.hex;

describe("inboxNextTagColour", () => {
  test("a new tag walks all twelve swatches, vivid and calm in turn, before any repeats; red late", () => {
    const given: string[] = [];
    for (let i = 0; i < 12; i++) given.push(inboxNextTagColour(given));
    expect(given).toEqual(["Green", "Indigo", "Amber", "Pink", "Blue", "Lime", "Teal", "Orange", "Violet", "Cyan", "Red", "Grey"].map(SW));
    expect(new Set(given).size).toBe(12);
    // Vivid (the first row) and calm (the second) alternate.
    const vivid = new Set(INBOX_TAG_SWATCHES.slice(0, 6).map((s) => s.hex));
    expect(given.map((hex) => vivid.has(hex))).toEqual([true, false, true, false, true, false, true, false, true, false, true, false]);
    // Then round again, from the start.
    expect(inboxNextTagColour(given)).toBe(SW("Green"));
    // A colour freed by a delete (or a None) is the next one again; an own colour takes none.
    expect(inboxNextTagColour([SW("Green"), null, "#ff6a00", SW("Amber")])).toBe(SW("Indigo"));
  });

  test("a stored name counts as its hue's swatch, so an earlier Inbox's tags are not given their hue again", () => {
    expect(inboxNextTagColour(["green"])).toBe(SW("Indigo"));
    expect(inboxNextTagColour(["green", "accent"])).toBe(SW("Amber"));
    expect(inboxNextTagColour(["green", "accent", "amber", "grey"])).toBe(SW("Pink"));
  });
});

describe("colours as stored", () => {
  test("a preset or a lowercase #rrggbb; a typed code in any common form reads as one", () => {
    for (const name of ["accent", "green", "amber", "red", "grey"]) expect(isInboxTagColour(name)).toBe(true);
    expect(isInboxTagColour("#ff6a00")).toBe(true);
    expect(isInboxTagColour("#FF6A00")).toBe(false);
    expect(isInboxTagColour("purple")).toBe(false);
    expect(isInboxTagColour("teal")).toBe(false);
    expect(isInboxTagColour("#0b9488ff")).toBe(false);
    expect(inboxTagHex("#FF6A00")).toBe("#ff6a00");
    expect(inboxTagHex("f60")).toBe("#ff6600");
    expect(inboxTagHex("#12")).toBeNull();
  });

  test("everything this Inbox gives or offers is a lowercase #rrggbb an older Inbox already takes", () => {
    // An older Inbox's check, as it shipped: a preset name or /^#[0-9a-f]{6}$/.
    const older = (v: string) => ["accent", "green", "amber", "red", "grey"].includes(v) || /^#[0-9a-f]{6}$/.test(v);
    for (const hex of [...INBOX_TAG_SWATCHES.map((s) => s.hex), ...INBOX_TAG_AUTO_COLOURS, ...Object.values(INBOX_TAG_PRESET_HEX)]) {
      expect(older(hex)).toBe(true);
      expect(isInboxTagLook({ colour: hex, by: "auto", at: "2026-11-16T00:00:00.000Z" })).toBe(true);
    }
  });

  test("a quick swatch is not one of the person's own colours; any other code is", () => {
    expect(inboxTagOwnColour(SW("Teal"))).toBe(false);
    expect(inboxTagOwnColour("#3a7bd5")).toBe(true);
    expect(inboxTagOwnColour("green")).toBe(false);
    expect(inboxTagOwnColour(null)).toBe(false);
  });
});

describe("one colour per tag across machines", () => {
  test("a colour the person picked beats one given at creation; of two picked, the later", () => {
    const held = [
      { machine: "ibx_a", created_at: "2026-11-01T00:00:00.000Z", look: auto("green") },
      { machine: "ibx_b", created_at: "2026-11-02T00:00:00.000Z", look: person("red", "2026-11-03T00:00:00.000Z") },
      { machine: "ibx_c", created_at: "2026-11-02T00:00:00.000Z", look: person("#ff6a00", "2026-11-04T00:00:00.000Z") },
    ];
    expect(inboxTagLookOf(held)?.colour).toBe("#ff6a00");
    // None the person picked is a pick too.
    expect(inboxTagLookOf([...held, { machine: "ibx_d", created_at: "2026-11-09T00:00:00.000Z", look: person(null, "2026-11-05T00:00:00.000Z") }])?.colour).toBeNull();
  });

  test("of two given at creation, the tag made first keeps its colour; equal times go by machine id", () => {
    expect(inboxTagLookOf([
      { machine: "ibx_b", created_at: "2026-11-02T00:00:00.000Z", look: auto("amber") },
      { machine: "ibx_a", created_at: "2026-11-01T00:00:00.000Z", look: auto("green") },
    ])?.colour).toBe("green");
    expect(inboxTagLookOf([
      { machine: "ibx_b", created_at: "2026-11-01T00:00:00.000Z", look: auto("amber") },
      { machine: "ibx_a", created_at: "2026-11-01T00:00:00.000Z", look: auto("green") },
    ])?.colour).toBe("green");
    // A machine before tag colours brings none.
    expect(inboxTagLookOf([{ machine: "ibx_a", created_at: "2026-11-01T00:00:00.000Z", look: undefined }])).toBeUndefined();
  });

  test("the merged list gives the same colour whichever of two linked machines reads it", () => {
    const macTags = [tag("ini_m_rel", "Release", "2026-11-01T00:00:00.000Z", auto("green")), tag("ini_m_win", "Windows", "2026-11-02T00:00:00.000Z", person("#0b1e4a", "2026-11-05T00:00:00.000Z"))];
    const miniTags = [tag("ini_n_rel", "release", "2026-11-03T00:00:00.000Z", auto("amber")), tag("ini_n_win", "WINDOWS", "2026-11-01T00:00:00.000Z", auto("accent"))];
    const onMac = inboxMachineTags("ibx_mac", macTags, [{ machine: "ibx_mini", tags: miniTags }]).tags;
    const onMini = inboxMachineTags("ibx_mini", miniTags, [{ machine: "ibx_mac", tags: macTags }]).tags;
    const colours = (tags: typeof onMac) => Object.fromEntries(tags.map((t) => [t.name.toLowerCase(), t.look?.colour]));
    expect(colours(onMac)).toEqual({ release: "green", windows: "#0b1e4a" });
    expect(colours(onMini)).toEqual(colours(onMac));
  });

  test("the switch: the latest change on any machine wins, never set is on; own colours newest first across machines", () => {
    const merged = inboxTagColoursOf([
      { show: true, show_at: "2026-11-01T00:00:00.000Z", recent: [{ colour: "#ff6a00", at: "2026-11-01T00:00:00.000Z" }] },
      { show: false, show_at: "2026-11-02T00:00:00.000Z", recent: [{ colour: "#0b1e4a", at: "2026-11-03T00:00:00.000Z" }, { colour: "#ff6a00", at: "2026-11-02T00:00:00.000Z" }] },
      { show: true, show_at: null, recent: [] },
    ]);
    expect(merged.show).toBe(false);
    expect(merged.recent.map((r) => r.colour)).toEqual(["#0b1e4a", "#ff6a00"]);
    expect(inboxTagColoursOf([{ show: true, show_at: null, recent: [] }]).show).toBe(true);
  });

  test("a far machine's malformed tag_colours reads as nothing set", () => {
    expect(inboxTagColoursRead(undefined)).toBeNull();
    expect(inboxTagColoursRead({ show: "no", show_at: null, recent: [] })).toBeNull();
    expect(inboxTagColoursRead({ show: false, show_at: "2026-11-01T00:00:00.000Z", recent: [{ colour: "red", at: "x" }, { colour: "#aabbcc", at: "2026-11-01T00:00:00.000Z" }] })).toEqual({
      show: false,
      show_at: "2026-11-01T00:00:00.000Z",
      recent: [{ colour: "#aabbcc", at: "2026-11-01T00:00:00.000Z" }],
    });
  });
});

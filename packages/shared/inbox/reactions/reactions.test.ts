/**
 * Emoji reactions' decision (approval "inbox-emoji-reactions", items 2–4):
 * the mood gate against the approved contract (fixtures/cases.json, a copy of
 * the design record's amendments/2026-11-03-contrast/tests/cases.json, all 54
 * cases), the picker's
 * proof (praise reaches only happy emoji, an error or a request only calm
 * ones, nothing reaches a grim one), no emoji twice in a row, and the pacing's
 * nevers. What regresses: a sarcastic or frustrated reply getting a cheerful
 * emoji, "Okay, but…" read as a go-ahead, the same emoji twice running, a
 * reaction on code, pasted errors or a long reply.
 */
import { describe, expect, test } from "bun:test";
import CASES from "./fixtures/cases.json" with { type: "json" };
import { mood } from "./gate";
import { decideReaction, type ReactionReply } from "./index";
import { decidePace, paceKind, type PaceEntry } from "./pacing";
import { allowedEmoji, pickEmoji, REACTION_POOL, REACTION_TONE } from "./picker";

interface Case {
  kind: string;
  text: string;
  expect: string | string[];
  not_kind?: string;
  expect_kind?: string;
}

describe("the mood gate: the approved contract", () => {
  for (const c of CASES as Case[]) {
    test(`${c.kind}: ${c.text.slice(0, 60).replace(/\n/g, " ")}`, () => {
      const m = mood(c.text);
      if (Array.isArray(c.expect)) expect(c.expect).toContain(m.mood);
      else expect(m.mood).toBe(c.expect as typeof m.mood);
      if (c.not_kind) expect(m.kind).not.toBe(c.not_kind as typeof m.kind);
      if (c.expect_kind) expect(m.kind).toBe(c.expect_kind as typeof m.kind);
    });
  }

  test('"Okay, but…" is never a go-ahead, and gets no 👍', () => {
    for (const text of ["Okay, but now there's a big empty gap under the header.", "ok but the footer is still wrong", "Sure, but use the other font."]) {
      const m = mood(text);
      expect(m.kind).not.toBe("goahead");
      const pick = pickEmoji({ text, mood: m.mood, kind: m.kind, recent: [], rand: 0 });
      if (pick) expect(allowedEmoji("neutral:goahead")).not.toContain(pick);
    }
    // A plain go-ahead still is one.
    expect(mood("Okay, go ahead and merge it.").kind).toBe("goahead");
  });

  test('"That works, but <problem>" gets no happy emoji; a "but" before the praise keeps it (amendment 2026-11-03-contrast)', () => {
    const happy = new Set([...allowedEmoji("positive"), ...allowedEmoji("positive+joke")]);
    for (const text of ["That works, but the toast is wrong on Safari.", "Looks great, except the header is too tall.", "Nice, though the button still does nothing when I click it."]) {
      const m = mood(text);
      expect(m.mood).not.toBe("positive");
      const pick = pickEmoji({ text, mood: m.mood, kind: m.kind, recent: [], rand: 0.3 });
      if (pick) expect(happy.has(pick)).toBe(false);
    }
    expect(mood("Took a while, but it works now").mood).toBe("positive");
  });
});

describe("the picker", () => {
  test("praise reaches only happy emoji, an error or a request only calm ones, and nothing reaches a grim one", () => {
    for (const key of ["positive", "positive+joke"] as const) for (const e of allowedEmoji(key)) expect(REACTION_TONE[e]).toBe("happy");
    for (const key of ["error", "neutral:goahead", "neutral:looking"] as const) for (const e of allowedEmoji(key)) expect(REACTION_TONE[e]).toBe("calm");
    expect([...new Set(allowedEmoji("error"))].sort()).toEqual(["👀", "🤔"].sort());
    const reachable = new Set((["positive", "positive+joke", "error", "neutral:goahead", "neutral:looking"] as const).flatMap((k) => allowedEmoji(k)));
    for (const e of Object.keys(REACTION_POOL)) if (REACTION_TONE[e] === "grim") expect(reachable.has(e)).toBe(false);
    expect(reachable.has("🙋")).toBe(false);
    // Every pool emoji has a tone, so none slips past the gate untoned.
    for (const e of Object.keys(REACTION_POOL)) expect(REACTION_TONE[e]).toBeDefined();
  });

  test("frustrated and unsure replies get nothing", () => {
    for (const text of ["thanks for nothing, it's still broken", "this is still broken, wtf", "Love the colors, hate the spacing"]) {
      const m = mood(text);
      expect(pickEmoji({ text, mood: m.mood, kind: m.kind, recent: [], rand: 0.5 })).toBeNull();
    }
  });

  test("picks by meaning", () => {
    const text = "thanks, appreciate it";
    const m = mood(text);
    // Thanks lean to 🙏 and friends: whatever the draw, it is from the near-best tier, never a party popper.
    for (let i = 0; i < 20; i++) expect(pickEmoji({ text, mood: m.mood, kind: m.kind, recent: [], rand: i / 20 })).not.toBe("🎉");
    const win = "It works now! Finally.";
    const w = mood(win);
    expect(["🎉", "🙌", "🥳", "🚀", "😎", "💪", "🏆", "✨"]).toContain(pickEmoji({ text: win, mood: w.mood, kind: w.kind, recent: [], rand: 0 })!);
  });

  test("never the same emoji twice in a row, even where only two can be drawn", () => {
    const texts = ["Perfect, that's exactly what I wanted.", "thanks, appreciate it", "It works now! Finally.", "lol that's great", "Okay, go ahead and merge it.", "The save button does nothing when I click it."];
    for (const text of texts) {
      const m = mood(text);
      const recent: string[] = [];
      for (let i = 0; i < 60; i++) {
        const pick = pickEmoji({ text, mood: m.mood, kind: m.kind, recent, rand: ((i * 7919) % 1000) / 1000 })!;
        expect(pick).toBeTruthy();
        if (recent.length > 0) expect(pick).not.toBe(recent[recent.length - 1]!);
        recent.push(pick);
      }
    }
  });
});

describe("the pacing", () => {
  const MIN = 60_000;
  const T0 = Date.parse("2026-11-03T09:00:00Z");

  test("code, pasted errors and long replies never get one, at any level", () => {
    const never = [
      "Use `retry()` here instead.",
      "```\nconst x = 1;\n```",
      "TypeError: Cannot read properties of undefined (reading 'map')\n    at render (app.tsx:12:4)",
      "Thanks! ".repeat(30),
      "Great, thanks.\nOne more thing.\nAnd another.",
    ];
    for (const text of never) {
      expect(paceKind(text, mood(text))).toBe(mood(text).mood === "frustrated" ? "frustrated" : "never");
      for (const level of ["sometimes", "often"] as const)
        for (let i = 0; i < 40; i++) {
          const reply: ReactionReply = { id: `m${i}`, thread: "t", text, at: T0 + i * 30 * MIN };
          expect(decideReaction({ level, reply, history: [], recent: [] })).toBeNull();
        }
    }
  });

  test("thanks or a win that keeps getting nothing is owed: by the fourth, near certain", () => {
    // Many independent days of thanks spread over hours; count how often the 4th deserving reply in a row reacts.
    let hit = 0;
    let tries = 0;
    for (let day = 0; day < 200; day++) {
      const history: PaceEntry[] = [];
      for (let i = 0; i < 3; i++) history.push({ id: `d${day}-${i}`, thread: `t${i}`, at: T0 + i * 40 * MIN, kind: "thanks", reacted: false });
      const d = decidePace(history, { id: `d${day}-3`, thread: "t3", at: T0 + 120 * MIN, kind: "thanks" }, "sometimes");
      tries++;
      if (d.react) hit++;
    }
    expect(hit / tries).toBeGreaterThan(0.9);
  });

  test("a frustrated reply cools its thread: a request right after gets nothing; thanks may", () => {
    const history: PaceEntry[] = [{ id: "f", thread: "t", at: T0, kind: "frustrated", reacted: false }];
    for (let i = 0; i < 50; i++) {
      const d = decidePace(history, { id: `g${i}`, thread: "t", at: T0 + 5 * MIN, kind: "go" }, "often");
      expect(d.react).toBe(false);
    }
    const thanks = Array.from({ length: 50 }, (_, i) => decidePace(history, { id: `h${i}`, thread: "t", at: T0 + 5 * MIN, kind: "thanks" }, "often"));
    expect(thanks.some((d) => d.react)).toBe(true);
  });

  test("Often reacts more than Now and then over the same day", () => {
    const day = (level: "sometimes" | "often") => {
      const history: PaceEntry[] = [];
      const kinds = ["thanks", "go", "ask", "win", "neutral", "joke", "go", "ask"] as const;
      let count = 0;
      for (let i = 0; i < 400; i++) {
        const entry = { id: `x${i}`, thread: `t${i % 5}`, at: T0 + i * 4 * MIN, kind: kinds[i % kinds.length]! };
        const d = decidePace(history, entry, level);
        if (d.react) count++;
        history.push({ ...entry, reacted: d.react });
      }
      return count;
    };
    expect(day("often")).toBeGreaterThan(day("sometimes"));
  });

  test("decided once: the same reply and history give the same reaction, landing 0.8 to 2.5 s after delivery", () => {
    const reply: ReactionReply = { id: "msg_fixed", thread: "t", text: "Perfect, that's exactly what I wanted.", at: T0 };
    const a = decideReaction({ level: "often", reply, history: [], recent: [] });
    const b = decideReaction({ level: "often", reply, history: [], recent: [] });
    expect(a).toEqual(b);
    if (a) {
      const delay = Date.parse(a.at) - T0;
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(2500);
    }
  });
});

/**
 * Decision mode's merged read across linked computers (inbox-decisions-merged.ts), on stand-in lines: no Inbox starts
 * (inbox-decisions-linked.test.ts runs two real ones). What this catches: an older computer (no `decisions` mark)
 * asked, or its threads offering "Decide these N"; a computer away dropping the decisions a dialog on its thread draws
 * (they must stand as it last gave them); a computer that turned decision mode off still offering its threads; a far
 * decision of a thread this Inbox holds, or one listed twice; a malformed far entry passed on to the window.
 */
import { describe, expect, test } from "bun:test";
import type { InboxDecision } from "@plannotator/core/inbox-types";
import { DECISIONS_MARK, createFarDecisions, farDecisionsOf, mergeDecisions, type DecisionsPeer } from "./inbox-decisions-merged";

const STUDIO = "ibx_01JZSTVD10000000000000000S";
const OLDER = "ibx_01JZ0LDER0000000000000000Q";
const id = (n: number) => `msg_01JZ${String(n).padStart(22, "0")}`;

function decision(message: number, thread: number, key = "q1", project = "prj_harbor"): InboxDecision {
  return {
    id: `${id(message)}/${key}`,
    question: { key, message_id: id(message), revision: 1, state: "open" } as unknown as InboxDecision["question"],
    message: { id: id(message), created_at: "2026-11-25T09:00:00.000Z", author: { kind: "agent" } as InboxDecision["message"]["author"], excerpt: null },
    pictures: { inline: [], attachments: [] },
    thread: { id: id(thread), subject: "Ship the harbor search index?", thread_name: null, project: { id: project, name: "harbor" }, section: "needs_you" as InboxDecision["thread"]["section"] },
    session: { key: "s:claude-code\u0000ses_1", host: "claude-code", session: "ses_1", name: "Claude Code", wakes: true },
  };
}

/** A stand-in line: `answer` is what its door gives `GET decisions`; `asked` counts the asks. */
function peer(idOf: string, marks: string[], answer: () => Response | Promise<Response>): DecisionsPeer & { asked: number } {
  const line = {
    id: idOf,
    state: "online",
    list: { marks },
    asked: 0,
    request: async (route: string) => {
      line.asked += 1;
      expect(route).toBe("decisions");
      return answer();
    },
  };
  return line;
}

describe("the merged read", () => {
  test("an older computer is never asked; one away keeps what it last gave; one with decision mode off offers none", async () => {
    let studioOff = false;
    const studio = peer(STUDIO, [DECISIONS_MARK], () => (studioOff ? Response.json({ error: "Not found", code: "not_found" }, { status: 404 }) : Response.json({ decisions: [decision(1, 1), decision(2, 1, "q2")] })));
    const older = peer(OLDER, ["star", "priority"], () => {
      throw new Error("an older computer must not be asked");
    });
    const far = createFarDecisions(() => [studio, older]);
    const first = await far.read();
    expect(first.map((list) => list.map((d) => [d.id, d.machine]))).toEqual([
      [
        [`${id(1)}/q1`, STUDIO],
        [`${id(2)}/q2`, STUDIO],
      ],
    ]);
    expect(older.asked).toBe(0);
    // Studio goes to sleep: a dialog on its thread keeps its cards, as Studio last gave them, and Studio is not asked.
    studio.state = "offline";
    const asleep = await far.read();
    expect(asleep[0]!.map((d) => d.id)).toEqual([`${id(1)}/q1`, `${id(2)}/q2`]);
    expect(studio.asked).toBe(1);
    // Back, it is read again. Then decision mode turned off on Studio: none of its threads offers it, and nothing is kept for when it sleeps.
    studio.state = "online";
    studioOff = true;
    expect(await far.read()).toEqual([[]]);
    studio.state = "offline";
    expect(await far.read()).toEqual([[]]);
  });

  test("a slow or broken door keeps the last answer", async () => {
    let broken = false;
    const studio = peer(STUDIO, [DECISIONS_MARK], () => {
      if (broken) throw new Error("timed out");
      return Response.json({ decisions: [decision(1, 1)] });
    });
    const far = createFarDecisions(() => [studio]);
    await far.read();
    broken = true;
    expect((await far.read())[0]!.map((d) => d.id)).toEqual([`${id(1)}/q1`]);
  });
});

describe("merging", () => {
  test("this Inbox's first, a far one of a thread held here or listed twice passed over, a project filter kept", () => {
    const own = [decision(10, 10)];
    const far = farDecisionsOf(STUDIO, { decisions: [decision(1, 1), decision(10, 10), decision(3, 3, "q1", "prj_fern"), decision(4, 4)] });
    const holds = (thread: string) => thread === id(4);
    expect(mergeDecisions(own, [far], holds, null).map((d) => [d.id, d.machine ?? "here"])).toEqual([
      [`${id(10)}/q1`, "here"],
      [`${id(1)}/q1`, STUDIO],
      [`${id(3)}/q1`, STUDIO],
    ]);
    expect(mergeDecisions(own, [far], holds, "prj_fern").map((d) => d.id)).toEqual([`${id(10)}/q1`, `${id(3)}/q1`]);
  });

  test("a far entry that does not read as a decision is dropped, and an answer of another shape gives none", () => {
    const good = decision(1, 1);
    const entries = [good, { ...good, id: "not-a-decision" }, { ...good, thread: null }, { ...good, pictures: { inline: "x" } }, null, 7];
    expect(farDecisionsOf(STUDIO, { decisions: entries }).map((d) => d.id)).toEqual([good.id]);
    expect(farDecisionsOf(STUDIO, { error: "Not found" })).toEqual([]);
    expect(farDecisionsOf(STUDIO, null)).toEqual([]);
  });
});

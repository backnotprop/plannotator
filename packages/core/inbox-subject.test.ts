import { describe, expect, test } from "bun:test";
import { checkInboxSubject, displayInboxSubject } from "./inbox-types";

const LEAKED =
  'Everything of mine waiting on you or ready to look at, in one place</subject>\n<parameter name="idempotency_key">ws-rollup-2026-10-20-a';
const SHOWN = "Everything of mine waiting on you or ready to look at, in one place";
const NAMESPACED_CLOSE = "<" + "/" + "antml" + ":parameter>";

const refusal = (value: unknown) => {
  const checked = checkInboxSubject(value);
  return checked.ok ? null : checked.message;
};

describe("checkInboxSubject", () => {
  test("refuses leaked tool-call text, saying the call was malformed and to resend the subject alone", () => {
    for (const value of [
      LEAKED,
      "Release notes</subject>",
      "Release notes </SUBJECT >",
      'Release notes<parameter name="thread">release',
      "Release notes</parameter>",
      'Release notes <invoke name="send_message">',
      "Release notes</invoke>",
      "Release notes <function_calls>",
      `Release notes${NAMESPACED_CLOSE}`,
    ]) {
      const message = refusal(value);
      expect(message, value).toContain("contains tool-call text");
      expect(message).toContain("subject alone");
      expect(message).toContain("If you meant to write that text, reword it without the angle brackets.");
    }
  });

  test("refuses a line break in any spelling, control characters and bidi controls", () => {
    for (const value of ["Release\nnotes", "Release\r\nnotes", "Release\rnotes", "Release\u2028notes", "Release\u2029notes"]) {
      expect(refusal(value), JSON.stringify(value)).toContain("must be one line");
    }
    expect(refusal("Release\u0007notes")).toBe("must not contain control characters.");
    expect(refusal("Release\tnotes")).toBe("must not contain control characters.");
    expect(refusal("Release \u202enotes")).toBe("must not contain bidirectional control characters.");
    expect(refusal(42)).toBe("must be a string.");
  });

  test("keeps ordinary prose with < and >, trimmed; empty is no subject", () => {
    for (const value of [
      "Why a < b > c breaks the sort",
      "Vec<T> vs Box<dyn Trait>",
      "Replace <div> with <section> in the footer",
      "The <parameter> element in the schema docs",
      "<subject> line parsing in the mail importer",
      "Is 3 > 2? Then ship →",
    ]) {
      expect(checkInboxSubject(`  ${value} `)).toEqual({ ok: true, subject: value });
    }
    expect(checkInboxSubject("   ")).toEqual({ ok: true, subject: null });
    expect(checkInboxSubject(undefined)).toEqual({ ok: true, subject: null });
    expect(checkInboxSubject(null)).toEqual({ ok: true, subject: null });
  });
});

describe("displayInboxSubject", () => {
  test("the owner's leaked subject shows as the words the agent meant", () => {
    expect(displayInboxSubject(LEAKED)).toBe(SHOWN);
  });

  test("first line, cut where markup starts, controls and bidi out, trimmed", () => {
    expect(displayInboxSubject("Release notes\nsecond line")).toBe("Release notes");
    expect(displayInboxSubject("Release notes\u2028second")).toBe("Release notes");
    expect(displayInboxSubject('Release notes <parameter name="x">y')).toBe("Release notes");
    expect(displayInboxSubject(`Release notes ${NAMESPACED_CLOSE}`)).toBe("Release notes");
    expect(displayInboxSubject("Release\tnotes")).toBe("Release notes");
    expect(displayInboxSubject("Release \u202enotes")).toBe("Release notes");
    expect(displayInboxSubject("</subject>")).toBeNull();
    expect(displayInboxSubject(null)).toBeNull();
    expect(displayInboxSubject(undefined)).toBeNull();
  });

  test("a subject the check accepts is shown unchanged", () => {
    for (const value of ["Vec<T> vs Box<dyn Trait>", "Replace <div> with <section>", "Auth refactor: next steps"]) {
      expect(displayInboxSubject(value)).toBe(value);
    }
  });

  test("a subject that mentions the markup is told how to say it without looping", () => {
    expect(refusal("Fix leaked </subject> in Inbox subjects")).toContain("reword it without the angle brackets");
    expect(checkInboxSubject("Fix leaked /subject in Inbox subjects")).toEqual({ ok: true, subject: "Fix leaked /subject in Inbox subjects" });
  });
});

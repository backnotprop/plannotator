/**
 * A link clicked in a terminal, or pasted from prose, can carry the sentence's punctuation on its id
 * (`#thread=msg_…).`). The guard: that id opens what it names, and a value that is no id of that kind keeps every
 * character, the dots of a pull request's host included.
 */
import { describe, expect, test } from "bun:test";
import { LINK_BASE64URL, LINK_ULID_ID, linkEnd, routeIdWithoutLinkTail, withoutLinkTail } from "./link-tail";

const THREAD = "msg_01M7VKGWJTN05MAA6M48FV0HY0";
const TAILS = [").", ")", ".", ",", ";", ":", "]", ">", '"', "'", ")]."];

describe("withoutLinkTail", () => {
  test("a thread id with the punctuation after its link is that thread", () => {
    for (const tail of TAILS) expect(withoutLinkTail(`${THREAD}${tail}`, LINK_ULID_ID)).toBe(THREAD);
    expect(withoutLinkTail(THREAD, LINK_ULID_ID)).toBe(THREAD);
  });

  test("a value that is no id of that kind keeps every character", () => {
    for (const value of ["notes (v2)", "v1.2.", "the layoffs.", "msg_short).", "prj_01M7VKGWJTN05MAA6M48FV0HY0X)."]) {
      expect(withoutLinkTail(value, LINK_ULID_ID)).toBe(value);
    }
    expect(withoutLinkTail(null, LINK_ULID_ID)).toBeNull();
  });

  test("a share key (base64url) drops the tail; one with other characters is left as it came", () => {
    expect(withoutLinkTail("abc-DEF_123).", LINK_BASE64URL)).toBe("abc-DEF_123");
    expect(withoutLinkTail("abc+DEF/123=.", LINK_BASE64URL)).toBe("abc+DEF/123=.");
  });
});

describe("routeIdWithoutLinkTail", () => {
  test("an Inbox or plan id, or a pull request's key, drops the tail", () => {
    expect(routeIdWithoutLinkTail(`${THREAD}).`)).toBe(THREAD);
    expect(routeIdWithoutLinkTail("pln_01M7VKGWJTN05MAA6M48FV0HY0.")).toBe("pln_01M7VKGWJTN05MAA6M48FV0HY0");
    expect(routeIdWithoutLinkTail("github.com/acme/api#12).")).toBe("github.com/acme/api#12");
    expect(routeIdWithoutLinkTail("gitlab.example.com/acme/web#7:pull).")).toBe("gitlab.example.com/acme/web#7:pull");
  });

  test("a pull request's key keeps the dots of its host, and anything else is left alone", () => {
    expect(routeIdWithoutLinkTail("github.com/acme/api#12")).toBe("github.com/acme/api#12");
    expect(routeIdWithoutLinkTail("git.acme.co.uk/acme/api#3")).toBe("git.acme.co.uk/acme/api#3");
    expect(routeIdWithoutLinkTail("new")).toBe("new");
    expect(routeIdWithoutLinkTail("src/a (copy).ts")).toBe("src/a (copy).ts");
  });
});

describe("linkEnd", () => {
  test("a text that ends with a link gets a space, so the punctuation after it is not taken into the link", () => {
    expect(`Added ${linkEnd("https://git.example.com/acme/api/pull/3")}.`).toBe("Added https://git.example.com/acme/api/pull/3 .");
    expect(`Added ${linkEnd("acme/api#3")}.`).toBe("Added acme/api#3.");
  });
});

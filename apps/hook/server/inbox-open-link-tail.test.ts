/**
 * `plannotator inbox --open <link>` with a link copied from a sentence (`…/#thread=msg_…).`, how an older agent
 * printed it) opens that thread instead of refusing the link; a thread id never ends with that punctuation.
 */
import { expect, test } from "bun:test";
import { inboxThreadRef } from "./inbox-command";

const THREAD = "msg_01M7VKGWJTN05MAA6M48FV0HY0";

test("--open takes a link or an id with the punctuation of its sentence after it", () => {
  for (const tail of [").", ".", ",", ";", ":", "]", ">", '"', "'"]) {
    expect(inboxThreadRef(`http://localhost:19432/#thread=${THREAD}${tail}`)).toBe(THREAD);
    expect(inboxThreadRef(`${THREAD}${tail}`)).toBe(THREAD);
  }
  // Still refused: what is no thread id once the tail is off.
  expect(inboxThreadRef("http://localhost:19432/#thread=the layoffs.")).toBeNull();
});

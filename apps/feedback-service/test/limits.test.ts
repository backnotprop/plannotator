/**
 * The client (packages/core/product-feedback.ts, used by the Inbox and the
 * CLI) checks a person's input before sending, so they see "too long" before
 * the round trip. Its limits must be the Worker's: a client that allows more
 * would send what the Worker refuses, one that allows less would refuse what
 * it accepts.
 */
import { expect, test } from "bun:test";
import * as client from "../../../packages/core/product-feedback";
import * as worker from "../core/validation";

test("the client's limits and choices are the Worker's", () => {
  expect(client.FEEDBACK_MESSAGE_MAX).toBe(worker.FEEDBACK_MESSAGE_MAX);
  expect(client.FEEDBACK_CONTACT_MAX).toBe(worker.FEEDBACK_CONTACT_MAX);
  expect([...client.FEEDBACK_CATEGORIES]).toEqual([...worker.FEEDBACK_CATEGORIES]);
  expect([...client.FEEDBACK_SURFACES]).toEqual([...worker.FEEDBACK_SURFACES]);
});

test("every payload the client builds is one the Worker accepts", () => {
  const payload = client.productFeedbackPayload(
    { message: "  works  ", category: "bug", contact: "  @me  " },
    { version: "0.28.33", os: client.feedbackOsName("darwin"), surface: "cli" },
  );
  expect(worker.normalizeFeedback(payload)).toEqual({ message: "works", category: "bug", contact: "@me", version: "0.28.33", os: "macOS", surface: "cli" });
  // A source run's version and an unknown platform are labels too.
  const dev = client.productFeedbackPayload({ message: "x" }, { version: "dev", os: client.feedbackOsName("sunos"), surface: "inbox" });
  expect(() => worker.normalizeFeedback(dev)).not.toThrow();
  expect(Object.keys(dev).sort()).toEqual(["message", "os", "surface", "version"]);
});

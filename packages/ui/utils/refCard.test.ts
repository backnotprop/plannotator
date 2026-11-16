/**
 * Which links get a hover card. The failure this guards: a Bitbucket link that
 * starts asking for a card in an app whose server cannot read Bitbucket (plan
 * review, annotate, code review, a host app), where it stayed a plain link.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { refCardTarget, setRefCardBitbucket, setRefCardTransport } from "./refCard";

const BB = "https://bitbucket.org/acme/widgets/pull-requests/3";

afterEach(() => {
  setRefCardTransport(null);
  setRefCardBitbucket(false);
});

describe("refCardTarget", () => {
  test("a Bitbucket pull request gets a card only where the host turned Bitbucket on", () => {
    setRefCardTransport(async () => null);
    expect(refCardTarget("https://github.com/acme/widgets/pull/12")).toMatchObject({ platform: "github" });
    expect(refCardTarget(BB)).toBeNull();
    setRefCardBitbucket(true);
    expect(refCardTarget(BB)).toMatchObject({ platform: "bitbucket", owner: "acme", repo: "widgets", number: 3, kind: "pull" });
    // The server reads no Bitbucket issue: no card that could only say so.
    expect(refCardTarget("https://bitbucket.org/acme/widgets/issues/3")).toBeNull();
  });

  test("no transport, no card, Bitbucket on or not", () => {
    setRefCardBitbucket(true);
    expect(refCardTarget(BB)).toBeNull();
  });
});

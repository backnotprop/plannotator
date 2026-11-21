/**
 * Which links get a hover card. The failure this guards: a Bitbucket link that
 * starts asking for a card in an app whose server cannot read Bitbucket (plan
 * review, annotate, code review, a host app), where it stayed a plain link.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { learnForgejoHosts } from "@plannotator/core/forge-refs";
import { refCardTarget, setRefCardBitbucket, setRefCardForgejo, setRefCardTransport } from "./refCard";

const BB = "https://bitbucket.org/acme/widgets/pull-requests/3";

afterEach(() => {
  setRefCardTransport(null);
  setRefCardBitbucket(false);
  setRefCardForgejo(false);
  learnForgejoHosts([]);
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

describe('refCardTarget for Forgejo', () => {
  const PULL = 'https://codeberg.org/acme/widgets/pulls/3';

  test('a Forgejo link gets a card only where the host turned Forgejo on: other apps keep a plain link', () => {
    setRefCardTransport(async () => null);
    expect(refCardTarget(PULL)).toBeNull();
    expect(refCardTarget('https://git.acme.com/acme/widgets/pulls/3')).toBeNull();
    setRefCardForgejo(true);
    expect(refCardTarget(PULL)).toMatchObject({ platform: 'forgejo', host: 'codeberg.org', owner: 'acme', repo: 'widgets', number: 3, kind: 'pull' });
    // A path names the forge on any host: the SERVER decides which hosts it reads.
    expect(refCardTarget('https://git.acme.com/acme/widgets/pulls/3')).toMatchObject({ platform: 'forgejo', host: 'git.acme.com' });
    // An issue link names no forge on a host this page has not been told of.
    expect(refCardTarget('https://git.acme.com/acme/widgets/issues/3')).toBeNull();
    expect(refCardTarget('https://codeberg.org/acme/widgets/issues/3')).toMatchObject({ platform: 'forgejo', kind: 'issue' });
  });

  test('turning Forgejo on changes nothing for GitHub and Bitbucket links', () => {
    setRefCardTransport(async () => null);
    setRefCardForgejo(true);
    expect(refCardTarget('https://github.com/acme/widgets/pull/12')).toMatchObject({ platform: 'github' });
    expect(refCardTarget(BB)).toBeNull();
  });

  test('no transport, no card, Forgejo on or not', () => {
    setRefCardForgejo(true);
    expect(refCardTarget(PULL)).toBeNull();
  });
});

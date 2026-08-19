import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatAnnotateOutcome,
  supportsAnnotateApprovalNotes,
  supportsAnnotateClientLease,
} from "./annotate-output";

describe("annotate stdout", () => {
  test("preserves legacy plaintext output byte-for-byte", () => {
    expect(formatAnnotateOutcome(
      { feedback: "", approved: true },
      { hook: false, json: false },
    )).toBe("The user approved.");
    expect(formatAnnotateOutcome(
      { feedback: "", exit: true },
      { hook: false, json: false },
    )).toBeNull();
    expect(formatAnnotateOutcome(
      { feedback: "Revise this.", approved: false },
      { hook: false, json: false },
    )).toBe("Revise this.");
  });

  test("preserves legacy hook output byte-for-byte", () => {
    expect(formatAnnotateOutcome(
      { feedback: "Keep the retry bounded.", approved: true },
      { hook: true, json: true },
    )).toBeNull();
    expect(formatAnnotateOutcome(
      { feedback: "Revise this." },
      { hook: true, json: false },
    )).toBe('{"decision":"block","reason":"Revise this."}');
  });

  test("includes nonempty feedback only on direct JSON approval", () => {
    expect(formatAnnotateOutcome(
      { feedback: "Keep the retry bounded.", approved: true },
      { hook: false, json: true },
    )).toBe('{"decision":"approved","feedback":"Keep the retry bounded."}');
    expect(formatAnnotateOutcome(
      { feedback: "", approved: true },
      { hook: false, json: true },
    )).toBe('{"decision":"approved"}');
  });

  test("advertises approval notes only for gated direct JSON", () => {
    expect(supportsAnnotateApprovalNotes({ gate: true, json: true, hook: false })).toBe(true);
    expect(supportsAnnotateApprovalNotes({ gate: false, json: true, hook: false })).toBe(false);
    expect(supportsAnnotateApprovalNotes({ gate: true, json: false, hook: false })).toBe(false);
    expect(supportsAnnotateApprovalNotes({ gate: true, json: true, hook: true })).toBe(false);
  });

  test("advertises client-lease only for gated direct JSON, local sessions", () => {
    expect(supportsAnnotateClientLease({ gate: true, json: true, hook: false, isRemote: false })).toBe(true);
    expect(supportsAnnotateClientLease({ gate: false, json: true, hook: false, isRemote: false })).toBe(false);
    expect(supportsAnnotateClientLease({ gate: true, json: false, hook: false, isRemote: false })).toBe(false);
    expect(supportsAnnotateClientLease({ gate: true, json: true, hook: true, isRemote: false })).toBe(false);
    expect(supportsAnnotateClientLease({ gate: true, json: true, hook: false, isRemote: true })).toBe(false);
  });
});

/**
 * index.ts is a top-level CLI dispatcher, not an importable module, so the
 * repo's precedent for pinning a call-site invariant in it is a source scan
 * (see strict-annotate-result.test.ts, "routes every annotate startup failure
 * through the shared helper").
 *
 * The invariant is deliberately "EVERY call site", not "the four that exist
 * today": the OpenCode bridge site shipped without the lease precisely because
 * a per-site check would have missed it, leaving `/plannotator-last --gate`
 * hanging on waitForDecision() forever once its tab was abandoned.
 */
describe("annotate client-lease call sites", () => {
  /** Slice out the option object literal of every startAnnotateServer( call. */
  function annotateServerCallSites(source: string): string[] {
    const sites: string[] = [];
    const call = "startAnnotateServer({";
    for (
      let at = source.indexOf(call);
      at !== -1;
      at = source.indexOf(call, at + call.length)
    ) {
      let depth = 0;
      const open = at + call.length - 1;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            sites.push(source.slice(open, i + 1));
            break;
          }
        }
      }
    }
    return sites;
  }

  test("every startAnnotateServer call site advertises the lease via the shared predicate", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const sites = annotateServerCallSites(source);

    // Sanity: the scan found the call sites at all (import-only sites like the
    // `startAnnotateServer,` import line are not `startAnnotateServer({`).
    expect(sites.length).toBeGreaterThanOrEqual(4);

    for (const site of sites) {
      // Every transport that blocks on waitForDecision() must decide the lease
      // through supportsAnnotateClientLease rather than hardcoding a boolean —
      // that is what keeps hook/plaintext/remote transports opted out.
      expect(site).toContain("clientLeaseSupported: supportsAnnotateClientLease({");
      expect(site).toContain("isRemote: isRemoteSession()");
    }

    // Cross-check the brace scan against a plain occurrence count, so a call
    // site the scanner failed to slice cannot pass by being invisible.
    const predicateUses = source.split("clientLeaseSupported: supportsAnnotateClientLease({").length - 1;
    expect(predicateUses).toBe(sites.length);
  });
});

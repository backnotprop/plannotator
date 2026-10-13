import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatAnnotateOutcome,
  supportsAnnotateApprovalNotes,
  supportsAnnotateClientLease,
} from "./annotate-output";
import { serializeStrictAnnotateResult } from "./strict-annotate-result";

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

  // The OpenCode bridge names the count in its decision heading. Failure
  // caught: the count leaking into plaintext, hook output or the strict record
  // (which scripts compare byte for byte), or missing from the JSON record.
  test("the JSON record carries annotationCount; plaintext, hook and the strict record do not", () => {
    const sent = { feedback: "Revise this.", annotations: [{}, {}] };
    expect(JSON.parse(formatAnnotateOutcome(sent, { hook: false, json: true }) as string))
      .toEqual({ decision: "annotated", feedback: "Revise this.", annotationCount: 2 });
    expect(JSON.parse(formatAnnotateOutcome({ ...sent, approved: true }, { hook: false, json: true }) as string))
      .toEqual({ decision: "approved", feedback: "Revise this.", annotationCount: 2 });
    expect(formatAnnotateOutcome({ feedback: "", exit: true, annotations: [] }, { hook: false, json: true }))
      .toBe('{"decision":"dismissed"}');
    expect(formatAnnotateOutcome(sent, { hook: false, json: false })).toBe("Revise this.");
    expect(formatAnnotateOutcome(sent, { hook: true, json: false })).toBe('{"decision":"block","reason":"Revise this."}');
    expect(serializeStrictAnnotateResult(sent)).not.toContain("annotationCount");
  });

  // #1701: a bare Done gains ONE additive JSON field; plaintext, hook and the
  // strict-gate record keep their bytes.
  test("a Done with nothing to send adds nothingToSend to the JSON record only", () => {
    const done = { feedback: "User reviewed the document and has no feedback.", nothingToSend: true };
    expect(formatAnnotateOutcome(done, { hook: false, json: true }))
      .toBe('{"decision":"annotated","feedback":"User reviewed the document and has no feedback.","nothingToSend":true}');
    expect(formatAnnotateOutcome(done, { hook: false, json: false }))
      .toBe("User reviewed the document and has no feedback.");
    expect(formatAnnotateOutcome(done, { hook: true, json: false }))
      .toBe('{"decision":"block","reason":"User reviewed the document and has no feedback."}');
    expect(serializeStrictAnnotateResult(done))
      .toBe('{"decision":"annotated","feedback":"User reviewed the document and has no feedback."}');
    expect(formatAnnotateOutcome({ feedback: "Revise this." }, { hook: false, json: true }))
      .toBe('{"decision":"annotated","feedback":"Revise this."}');
  });

  // Failure caught: "Approve with a note…" hidden in a gated session whose
  // output delivers the note (plaintext, which the Claude Code mod and the
  // classic skill launch), or shown where it is dropped (--hook, no gate).
  test("advertises approval notes for every gated output except --hook", () => {
    expect(supportsAnnotateApprovalNotes({ gate: true, hook: false })).toBe(true);
    expect(supportsAnnotateApprovalNotes({ gate: false, hook: false })).toBe(false);
    expect(supportsAnnotateApprovalNotes({ gate: true, hook: true })).toBe(false);
  });

  test("plaintext approval with a note prints the configured approved-with-notes prompt", () => {
    const config = { prompts: { annotate: { approvedWithNotes: "APPROVED {{context}} :: {{feedback}}" } } };
    expect(formatAnnotateOutcome(
      { feedback: "Rename the header.", approved: true },
      { hook: false, json: false },
      { runtime: "claude-code", context: "File: /tmp/page.html", config },
    )).toBe("APPROVED File: /tmp/page.html :: Rename the header.");
    // The default prompt still carries the note and the file it is about.
    const framed = formatAnnotateOutcome(
      { feedback: "Rename the header.", approved: true },
      { hook: false, json: false },
      { context: "File: /tmp/page.html", config: {} },
    );
    expect(framed).toContain("Rename the header.");
    expect(framed).toContain("File: /tmp/page.html");
    // Whitespace is no note: the legacy marker, byte for byte.
    expect(formatAnnotateOutcome(
      { feedback: "  \n", approved: true },
      { hook: false, json: false },
      { config: {} },
    )).toBe("The user approved.");
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

    // Every CLI-flag site decides "Approve with a note…" through the shared
    // predicate (a hardcoded or missing advert hides it, or offers it where
    // the note is dropped). The one exception is opencode-annotate-last: its
    // only output is the structured record, so the advert is the gate itself.
    const bridge = "approvalNotesSupported: input.gate === true,";
    const bridgeSites = sites.filter((site) => site.includes(bridge));
    expect(bridgeSites).toHaveLength(1);
    expect(bridgeSites[0]).toContain('mode: "annotate-last"');
    for (const site of sites.filter((site) => !site.includes(bridge))) {
      expect(site).toContain("approvalNotesSupported: supportsAnnotateApprovalNotes({");
    }
    const advertUses = source.split("approvalNotesSupported: supportsAnnotateApprovalNotes({").length - 1;
    expect(advertUses).toBe(sites.length - 1);

    // Cross-check the brace scan against a plain occurrence count, so a call
    // site the scanner failed to slice cannot pass by being invisible.
    const predicateUses = source.split("clientLeaseSupported: supportsAnnotateClientLease({").length - 1;
    expect(predicateUses).toBe(sites.length);
  });
});

import { describe, expect, test } from "bun:test";
import {
  NO_VCS_APPROVAL_NOTE,
  appendNoVcsApprovalNote,
  resolveNoVcsApprovalNote,
} from "./no-vcs-note";

// The note's identifying phrase. Asserted as a substring so the surrounding
// sentence can be reworded without churning these tests (#493).
const MARKER = "No version control detected";

describe("resolveNoVcsApprovalNote", () => {
  // Guards the feature itself: an approval in an untracked directory must warn.
  test("returns the note when an approved plan has no version control", async () => {
    const note = await resolveNoVcsApprovalNote({
      approved: true,
      detectVcsPresent: () => false,
    });
    expect(note).toContain(MARKER);
  });

  // Guards the "approvals in a VCS-managed directory are unchanged" contract:
  // a regression here spams every normal repo with a bogus warning.
  test("stays silent when the approved plan's directory has version control", async () => {
    const note = await resolveNoVcsApprovalNote({
      approved: true,
      detectVcsPresent: () => true,
    });
    expect(note).toBe("");
  });

  // Guards "denials are unchanged", including that detection never runs on the
  // deny path (a denial must not pay for, or be shaped by, a VCS probe).
  test("stays silent on denial without probing for version control", async () => {
    let probed = false;
    const note = await resolveNoVcsApprovalNote({
      approved: false,
      detectVcsPresent: () => {
        probed = true;
        return false;
      },
    });
    expect(note).toBe("");
    expect(probed).toBe(false);
  });

  // Guards the fail-silent rule: a detection failure must never be reported as
  // "you have no version control", and must never escape to the caller.
  test("stays silent when detection throws", async () => {
    const note = await resolveNoVcsApprovalNote({
      approved: true,
      detectVcsPresent: () => {
        throw new Error("git binary missing");
      },
    });
    expect(note).toBe("");
  });

  test("stays silent when async detection rejects", async () => {
    const note = await resolveNoVcsApprovalNote({
      approved: true,
      detectVcsPresent: async () => {
        throw new Error("provider blew up");
      },
    });
    expect(note).toBe("");
  });
});

describe("appendNoVcsApprovalNote", () => {
  // Guards delivery: the note must be added to existing approval text, not
  // replace it — the host approval prompts are the agent's instructions.
  test("keeps the original approval text and separates the note", () => {
    const appended = appendNoVcsApprovalNote("Plan approved!", NO_VCS_APPROVAL_NOTE);
    expect(appended.startsWith("Plan approved!")).toBe(true);
    expect(appended).toContain(MARKER);
  });

  test("leaves the text untouched when there is no note", () => {
    expect(appendNoVcsApprovalNote("Plan approved!", "")).toBe("Plan approved!");
  });

  test("returns the note alone when there is no approval text", () => {
    expect(appendNoVcsApprovalNote("", NO_VCS_APPROVAL_NOTE)).toBe(NO_VCS_APPROVAL_NOTE);
  });
});

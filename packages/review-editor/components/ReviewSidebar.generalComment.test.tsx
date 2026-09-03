/**
 * Sidebar "+ General comment" (DOM_TESTS=1) — spec §3.3 / §8 test 17, the
 * human producer for a durable scope:'general' review-level comment.
 *
 * Regressions each test guards:
 *  - Reachability at totalCount === 0: the all-empty sidebar must carry the
 *    affordance — it is most useful exactly when nothing is annotated yet, and
 *    the empty state is the branch where it is easiest to forget.
 *  - Reachability with only line comments: the General section header must
 *    render (with the button) even when zero general comments exist, or the
 *    affordance is invisible in every session that starts from the diff.
 *  - The composer commits the trimmed text exactly once and closes; an
 *    empty/whitespace note never fires the callback (the action refocuses the
 *    field instead — the decision-composer contract).
 *  - Escape dismisses the popover but keeps the draft, so a half-typed
 *    comment is not thrown away by the Esc ladder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CodeAnnotation } from "@plannotator/ui/types";
import { ReviewSidebar } from "./ReviewSidebar";

const hasDom = typeof document !== "undefined";

const LINE_COMMENT: CodeAnnotation = {
  id: "l1",
  type: "comment",
  filePath: "src/parse.ts",
  lineStart: 3,
  lineEnd: 3,
  side: "new",
  text: "still drops null",
  createdAt: 1,
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let added: string[] = [];

/** First call mounts; later calls re-render the SAME root, so parent state
 *  (the lifted composer draft) survives — exactly the SSE placement-flip
 *  scenario the L2 test drives. */
async function renderSidebar(annotations: CodeAnnotation[]): Promise<void> {
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <ReviewSidebar
        isOpen
        onClose={() => {}}
        activeTab="annotations"
        annotations={annotations}
        files={[]}
        selectedAnnotationId={null}
        onSelectAnnotation={() => {}}
        onNavigateToAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        onAddGeneralComment={(text) => added.push(text)}
      />,
    );
  });
}

function addButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-add-general-comment]");
}

function noteInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(
    "[data-review-general-composer] [data-decision-note-input]",
  );
}

function commitButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-general-comment-add]");
}

async function openComposer(): Promise<void> {
  await act(async () => addButton()!.click());
}

async function typeNote(text: string): Promise<void> {
  const input = noteInput();
  if (!input) throw new Error("composer is not open");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  added = [];
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)("review sidebar + General comment", () => {
  test("reachable at totalCount === 0, and a commit delivers the trimmed text once", async () => {
    await renderSidebar([]);
    expect(addButton()).not.toBeNull();

    await openComposer();
    await typeNote("  Split this into two PRs.  ");
    await act(async () => commitButton()!.click());

    expect(added).toEqual(["Split this into two PRs."]);
    // Committed → the composer closes and the draft is cleared.
    expect(noteInput()).toBeNull();
  });

  test("with only line comments, the General section header still offers the button", async () => {
    await renderSidebar([LINE_COMMENT]);
    const button = addButton();
    expect(button).not.toBeNull();

    await openComposer();
    await typeNote("overall: needs a migration plan");
    // Mod+Enter commits too — same field contract as the decision composers.
    await act(async () => {
      noteInput()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(added).toEqual(["overall: needs a migration plan"]);
  });

  test("an empty note never commits; the composer stays open and refocuses the field", async () => {
    await renderSidebar([]);
    await openComposer();
    await typeNote("   ");
    await act(async () => commitButton()!.click());
    expect(added).toEqual([]);
    expect(noteInput()).not.toBeNull();
    // The decision-composer contract: an empty commit is answered by focus,
    // not a disabled button.
    expect(document.activeElement).toBe(noteInput());
  });

  test("a placement flip mid-draft keeps the composer open with its text", async () => {
    // The SSE scenario: an external annotation lands while the reviewer is
    // typing in the empty-state composer — totalCount 0→1 unmounts that
    // instance and mounts the section-header one. The lifted parent state
    // must carry the draft across; losing it here throws away a half-typed
    // review-level comment through no action of the reviewer's.
    await renderSidebar([]);
    await openComposer();
    await typeNote("the empty-state draft");

    await renderSidebar([LINE_COMMENT]);
    expect(noteInput()).not.toBeNull(); // still open, now in the General header
    expect(noteInput()!.value).toBe("the empty-state draft");
    expect(added).toEqual([]);
  });

  test("Escape dismisses the popover but keeps the draft for the next open", async () => {
    await renderSidebar([]);
    await openComposer();
    await typeNote("half-typed thought");
    await act(async () => {
      noteInput()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(noteInput()).toBeNull();

    await openComposer();
    expect(noteInput()!.value).toBe("half-typed thought");
    expect(added).toEqual([]);
  });
});

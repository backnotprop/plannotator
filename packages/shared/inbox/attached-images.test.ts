/**
 * send_message's advice about pictures sent only as attachments (the owner,
 * 2026-11-02: the pictures of a message's options sat at the bottom as
 * attachments, away from the words about them). The failures this guards:
 * the advice goes missing for an attached picture the body never shows, or
 * nags an agent that did show the picture in place, or that attached a file
 * that is not a picture.
 */
import { describe, expect, test } from "bun:test";
import { attachedImagesNotInBody, attachedImagesNotInBodyText } from "./attached-images";

describe("attachedImagesNotInBody", () => {
  test("an attached picture the body does not show is named, as written", () => {
    const body = "Three looks for the step; B is the team's pick.";
    expect(attachedImagesNotInBody(body, ["/tmp/shots/a.png", "/tmp/shots/b.JPG", "shots/c.webp"], "/work")).toEqual([
      "/tmp/shots/a.png",
      "/tmp/shots/b.JPG",
      "shots/c.webp",
    ]);
    // The advice counts them and names the syntax that shows a picture in place.
    expect(attachedImagesNotInBodyText(3)).toStartWith(" 3 images are attached");
    expect(attachedImagesNotInBodyText(3)).toContain("`![alt](path)`");
  });

  test("a picture the body also shows is not named: by the same path, a relative path to it, or a picture choice", () => {
    const body = [
      "The menu lost its icon: ![menu](shots/menu.png)",
      "",
      ":::question",
      "Which look?",
      "- [ ] A · Light — ![A](/tmp/shots/a.png) light",
      '- [ ] B · Dark — <img src="/work/shots/b.png"> dark',
      ":::",
    ].join("\n");
    expect(attachedImagesNotInBody(body, ["/work/shots/menu.png", "/tmp/shots/a.png", "shots/b.png"], "/work")).toEqual([]);
    // Resolved from different folders, the same file name still counts as shown.
    expect(attachedImagesNotInBody("![menu](../shots/menu.png)", ["/elsewhere/shots/menu.png"], "/work", "/work/sub")).toEqual([]);
    expect(attachedImagesNotInBodyText(0)).toBe("");
  });

  test("a picture written only inside code is not shown, so it is still named", () => {
    expect(attachedImagesNotInBody("Use `![a](/tmp/a.png)` to show it.", ["/tmp/a.png"], "/work")).toEqual(["/tmp/a.png"]);
  });

  test("files that are not pictures are never named", () => {
    const body = "The plan and the mock are attached.";
    expect(attachedImagesNotInBody(body, ["docs/plan.md", "proto/admin.html", "/tmp/demo.mp4", "report.pdf", "shot.png.txt"], "/work")).toEqual([]);
    expect(attachedImagesNotInBody(body, undefined, "/work")).toEqual([]);
    expect(attachedImagesNotInBody(body, [], "/work")).toEqual([]);
  });

  test("one picture reads in the singular", () => {
    expect(attachedImagesNotInBody("Done.", ["/tmp/after.gif", "notes.md"], null)).toEqual(["/tmp/after.gif"]);
    expect(attachedImagesNotInBodyText(1)).toStartWith(" 1 image is attached");
  });
});

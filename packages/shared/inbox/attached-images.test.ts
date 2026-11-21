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
    // A relative path resolves from either base: the attachments' folder and the body's may differ.
    expect(attachedImagesNotInBody("![menu](shots/menu.png)", ["shots/menu.png"], "/work/sub", "/work")).toEqual([]);
    expect(attachedImagesNotInBodyText(0)).toBe("");
  });

  test("a picture the window finds through an encoded, queried or differently cased path counts as shown", () => {
    // macOS names screenshots with spaces; correct CommonMark writes them as %20.
    expect(attachedImagesNotInBody("![x](shots/Screenshot%202026-11-02%20at%2010.34.12.png)", ["shots/Screenshot 2026-11-02 at 10.34.12.png"], "/work")).toEqual([]);
    expect(attachedImagesNotInBody("![x](shots/a.png?v=2)", ["shots/a.png"], "/work")).toEqual([]);
    expect(attachedImagesNotInBody('<img src="shots/a.png#top">', ["/work/shots/a.png"], "/work")).toEqual([]);
    // One file on a file system that ignores case (macOS, Windows); two files where it does not (Linux).
    expect(attachedImagesNotInBody("![x](shots/Shot.PNG)", ["shots/shot.png"], "/work", "/work", "darwin")).toEqual([]);
    expect(attachedImagesNotInBody("![x](shots/Shot.PNG)", ["shots/shot.png"], "/work", "/work", "linux")).toEqual(["shots/shot.png"]);
  });

  test("two attachments with one name in different folders stay apart: only the one the body shows is left out", () => {
    const body = "After: ![after](after/home.png)";
    expect(attachedImagesNotInBody(body, ["before/home.png", "after/home.png"], "/work")).toEqual(["before/home.png"]);
    expect(attachedImagesNotInBody("![after](/shots/after/home.png)", ["/shots/before/home.png"], "/work")).toEqual(["/shots/before/home.png"]);
  });

  test("with no base to resolve a relative side, the file name decides", () => {
    expect(attachedImagesNotInBody("![a](shots/a.png)", ["/anywhere/a.png"], null)).toEqual([]);
    expect(attachedImagesNotInBody("![a](/anywhere/a.png)", ["a.png"], null)).toEqual([]);
  });

  test("every image kind the window shows counts, AVIF, BMP and ICO included", () => {
    expect(attachedImagesNotInBody("No pictures here.", ["a.avif", "b.bmp", "c.ico", "d.apng", "e.svg"], "/work")).toEqual(["a.avif", "b.bmp", "c.ico", "d.apng", "e.svg"]);
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

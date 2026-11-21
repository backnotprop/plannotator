/**
 * A cloud agent's pictures in the body (agent-pictures.ts): the door shows a picture only from a file attached in the
 * same send, matched by name, and `plannotator inbox call` sends the files a body names from the agent's own disk.
 * The failures these guard: a src that names no attached file slipping through (the Inbox would then look for it on
 * the person's disk), two files of one name showing the wrong one, a picture sent twice, a src rewritten inside code.
 */
import { describe, expect, test } from "bun:test";
import { matchAgentBodyPictures, planAgentBodyPictures } from "./agent-pictures";
import { inboxMessageImageRefsInOrder, renameInboxMessageImageSources } from "./message-images";

const shot = { id: "upl_1", name: "shot.png" };
const chart = { id: "upl_2", name: "chart one.svg" };

describe("matchAgentBodyPictures", () => {
  test("a src names the attached file by its name, as written, with ./, by a relative path's file name or percent-encoded", () => {
    for (const src of ["shot.png", "./shot.png", "out/shot.png", "shot.png?v=2"]) {
      const { pictures, unmatched } = matchAgentBodyPictures(`See ![it](${src}).`, [shot]);
      expect([src, unmatched, pictures.get(src)]).toEqual([src, [], shot]);
    }
    // A path from a root is that file on the person's disk, never a file sent under its file name.
    for (const src of ["/Users/x/site/shot.png", "~/site/shot.png", "C:\\site\\shot.png"]) {
      expect([src, matchAgentBodyPictures(`See ![it](${src}).`, [shot]).unmatched]).toEqual([src, [src]]);
    }
    expect(matchAgentBodyPictures("![c](chart%20one.svg)", [shot, chart]).pictures.get("chart%20one.svg")).toEqual(chart);
    expect(matchAgentBodyPictures('<img src="shot.png" alt="x">', [shot]).pictures.get("shot.png")).toEqual(shot);
  });

  test("a src that names no attached file, or two of the same name, is unmatched; code and remote pictures are not pictures to match", () => {
    expect(matchAgentBodyPictures("![a](secret.png)", [shot]).unmatched).toEqual(["secret.png"]);
    expect(matchAgentBodyPictures("![a](secret.png)", []).unmatched).toEqual(["secret.png"]);
    expect(matchAgentBodyPictures("![a](shot.png)", [shot, { id: "upl_3", name: "shot.png" }]).unmatched).toEqual(["shot.png"]);
    const none = matchAgentBodyPictures("`![a](secret.png)`\n\n```\n![b](x.png)\n```\n![c](https://example.com/c.png)", []);
    expect([none.unmatched, none.pictures.size]).toEqual([[], 0]);
  });
});

describe("planAgentBodyPictures", () => {
  const files = new Set(["/w/out/shot.png", "/w/b/shot.png", "/w/chart.svg", "/w/notes.md"]);
  const isFile = (path: string) => files.has(path);

  test("each picture's file on this machine is sent once, under a name no other file of the send has, the src renamed only where needed", () => {
    const plan = planAgentBodyPictures("A ![a](out/shot.png) B ![b](/w/b/shot.png) C ![c](chart.svg) again ![a2](out/shot.png)", [], "/w", isFile);
    expect(plan.files).toEqual([
      { path: "/w/out/shot.png", name: "shot.png" },
      { path: "/w/b/shot.png", name: "shot-2.png" },
      { path: "/w/chart.svg", name: "chart.svg" },
    ]);
    expect(plan.body).toBe("A ![a](out/shot.png) B ![b](shot-2.png) C ![c](chart.svg) again ![a2](out/shot.png)");
    // What the door then matches: every picture to its own file.
    const sent = plan.files.map((file, i) => ({ id: `upl_${i}`, name: file.name }));
    const matched = matchAgentBodyPictures(plan.body, sent);
    expect(matched.unmatched).toEqual([]);
    expect(inboxMessageImageRefsInOrder(plan.body).map((src) => matched.pictures.get(src)!.name)).toEqual(["shot.png", "shot-2.png", "chart.svg"]);
  });

  test("a picture the send already attaches by path is not sent twice; a name an attached file already has is not reused; a src that is no file is left", () => {
    const plan = planAgentBodyPictures("![a](out/shot.png) ![b](b/shot.png) ![m](missing.png)", ["out/shot.png", { name: "chart.svg", data: "" }], "/w", isFile);
    expect(plan.files).toEqual([{ path: "/w/b/shot.png", name: "shot-2.png" }]);
    expect(plan.body).toBe("![a](out/shot.png) ![b](shot-2.png) ![m](missing.png)");
    expect(planAgentBodyPictures("![c](chart.svg)", [{ name: "chart.svg", data: "" }], "/w", isFile).files).toEqual([{ path: "/w/chart.svg", name: "chart-2.svg" }]);
    // A path from a root that is a file here is sent, its src renamed to the name it is sent under (the door matches no root path by its file name).
    expect(planAgentBodyPictures("![c](/w/chart.svg)", [], "/w", isFile)).toEqual({ body: "![c](chart.svg)", files: [{ path: "/w/chart.svg", name: "chart.svg" }] });
  });
});

describe("renameInboxMessageImageSources", () => {
  test("renames markdown and <img> sources outside code, encoding the new name; code and other sources stay as they were", () => {
    const body = "![a](x/one.png) `![b](x/one.png)` <img src='x/one.png'> <img src=x/one.png> ![c](two.png)\n```\n![d](x/one.png)\n```";
    const out = renameInboxMessageImageSources(body, new Map([["x/one.png", "one (1).png"]]));
    expect(out).toBe('![a](one%20%281%29.png) `![b](x/one.png)` <img src="one (1).png"> <img src="one (1).png"> ![c](two.png)\n```\n![d](x/one.png)\n```');
    expect(renameInboxMessageImageSources(body, new Map())).toBe(body);
  });
});

/**
 * DeepSeek Harness Session Reader Tests
 *
 * Run: bun test apps/hook/server/dsh-session.test.ts
 *
 * Uses synthetic fixtures matching DSH's $DSH_HOME/sessions layout:
 *   <project-key>/<encoded-session-id>/session.v4.jsonl.zstd
 * The live file is a run of zstd frames, one per append batch, so the
 * compressed fixtures are two frames concatenated.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decompressDshLog,
  encodeDshSegment,
  findDshSessionLog,
  getRecentDshMessages,
  resolveDshHome,
} from "./dsh-session";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-home-"));
  tempDirs.push(home);
  return home;
}

function sessionDir(home: string, sessionId: string, project = "--Users-test-project--"): string {
  const dir = join(home, "sessions", project, encodeDshSegment(sessionId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const header = JSON.stringify({ type: "session", version: 4, id: "s1", createdAt: 0, cwd: "/Users/test/project", isSeeded: false, delegationDepth: 0 });

function assistantRow(id: string, content: unknown[], time = 1_700_000_000_000): string {
  return JSON.stringify({
    type: "assistant/message",
    seq: 1,
    time,
    data: { turn: 1, step: 1, stream: [], message: { id, role: "assistant", content, source: { kind: "model" } } },
    surfaceOp: "append",
  });
}

const text = (value: string) => ({ type: "text", text: value });

/** Two append batches, as DSH writes them: older messages, then newer ones. */
const firstBatch = [
  header,
  JSON.stringify({ type: "turn/start", data: { turn: 1 } }),
  assistantRow("m1", [text("First answer.")]),
].join("\n") + "\n";
const secondBatch = [
  assistantRow("m2", [{ type: "reasoning", text: "thinking out loud" }, { type: "tool-call", id: "c1", name: "bash", arguments: "{}" }]),
  JSON.stringify({ type: "tool/result", data: { content: [text("tool output that is not a message")] } }),
  assistantRow("m3", [text("Second answer,"), { type: "tool-call", id: "c2", name: "bash", arguments: "{}" }, text("in two parts.")]),
  assistantRow("m4", []),
].join("\n") + "\n";

function writeCompressed(dir: string, name = "session.v4.jsonl.zstd"): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([
    Bun.zstdCompressSync(Buffer.from(firstBatch)),
    Bun.zstdCompressSync(Buffer.from(secondBatch)),
  ]));
  return path;
}

describe("getRecentDshMessages", () => {
  // Catches: reading only the first zstd frame (the newest messages live in
  // later frames), or treating tool/reasoning-only rows as rendered messages.
  test("multi-frame zstd log: newest text messages first, tool-call and reasoning blocks skipped", () => {
    const home = makeDshHome();
    const log = writeCompressed(sessionDir(home, "s1"));

    const messages = getRecentDshMessages(log, 25);

    expect(messages.map((m) => m.messageId)).toEqual(["m3", "m1"]);
    expect(messages[0].text).toBe("Second answer,\nin two parts.");
    expect(messages[1].text).toBe("First answer.");
    expect(messages[0].timestamp).toBe(new Date(1_700_000_000_000).toISOString());
  });

  // Catches: a reader that only understands .zstd (DSH can be configured to
  // write plain JSONL, and older generations exist).
  test("an uncompressed log reads the same way", () => {
    const home = makeDshHome();
    const dir = sessionDir(home, "s1");
    writeFileSync(join(dir, "session.v4.jsonl"), firstBatch + secondBatch);

    const messages = getRecentDshMessages(join(dir, "session.v4.jsonl"), 25);
    expect(messages.map((m) => m.text)).toEqual(["Second answer,\nin two parts.", "First answer."]);
  });

  test("respects the limit", () => {
    const home = makeDshHome();
    const log = writeCompressed(sessionDir(home, "s1"));
    expect(getRecentDshMessages(log, 1).map((m) => m.messageId)).toEqual(["m3"]);
  });

  // Catches: one half-written append frame (a read racing DSH's write) making
  // the whole log unreadable, so `last` finds nothing in a live session.
  test("a truncated last frame keeps the messages before it", () => {
    const home = makeDshHome();
    const dir = sessionDir(home, "s1");
    const log = join(dir, "session.v4.jsonl.zstd");
    const partial = Bun.zstdCompressSync(Buffer.from(assistantRow("m5", [text("Third answer.")]) + "\n"));
    writeFileSync(log, Buffer.concat([
      Bun.zstdCompressSync(Buffer.from(firstBatch)),
      Bun.zstdCompressSync(Buffer.from(secondBatch)),
      partial.subarray(0, Math.floor(partial.length / 2)),
    ]));

    expect(getRecentDshMessages(log, 25).map((m) => m.messageId)).toEqual(["m3", "m1"]);
  });

  // Catches: a tail too short to hold the next frame's magic making the reader
  // drop the newest complete frame and serve an older answer.
  test("a partial magic number after the last frame keeps that frame", () => {
    const home = makeDshHome();
    const dir = sessionDir(home, "s1");
    const log = join(dir, "session.v4.jsonl.zstd");
    writeFileSync(log, Buffer.concat([
      Bun.zstdCompressSync(Buffer.from(firstBatch)),
      Bun.zstdCompressSync(Buffer.from(secondBatch)),
      Buffer.from([0x28, 0xb5]),
    ]));

    expect(getRecentDshMessages(log, 25).map((m) => m.messageId)).toEqual(["m3", "m1"]);
  });

  // Catches: one damaged append frame in the middle of a live log dropping
  // every newer frame, so `last` serves an old answer.
  test("a damaged frame in the middle keeps the frames on both sides", () => {
    const home = makeDshHome();
    const dir = sessionDir(home, "s1");
    const log = join(dir, "session.v4.jsonl.zstd");
    writeFileSync(log, Buffer.concat([
      Bun.zstdCompressSync(Buffer.from(firstBatch)),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x13, 0x37, 0x42]),
      Bun.zstdCompressSync(Buffer.from(secondBatch)),
    ]));

    expect(getRecentDshMessages(log, 25).map((m) => m.messageId)).toEqual(["m3", "m1"]);
  });

  // Catches: the retry decoding a longer prefix once per frame (quadratic: a
  // long live session made `last` take seconds once a frame was damaged).
  test("a damaged frame costs about two decodes per frame, not one per prefix", () => {
    const frames: Buffer[] = [];
    for (let i = 0; i < 400; i++) {
      frames.push(Buffer.from(Bun.zstdCompressSync(Buffer.from(assistantRow(`m${i}`, [text(`answer ${i}`)]) + "\n"))));
    }
    frames[200] = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x13, 0x37, 0x42]);
    let decodes = 0;
    const out = decompressDshLog(Buffer.concat(frames), (bytes) => {
      decodes++;
      return Buffer.from(Bun.zstdDecompressSync(bytes)).toString("utf-8");
    });

    expect(out).toContain('"m0"');
    expect(out).toContain('"m399"');
    expect(out).not.toContain('"m200"');
    expect(decodes).toBeLessThanOrEqual(2 * frames.length + 4);
  });

  // Catches: after a damaged frame, a frame whose compressed data happens to
  // hold a zstd magic number (so it does not decode in pieces) being dropped,
  // with `last` then serving an older answer.
  test("after a damaged frame, the scan resyncs on a frame holding a stray magic number", () => {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    // Incompressible bytes, so zstd stores them verbatim and the magic stays
    // inside the frame's data.
    const noise = Buffer.concat(Array.from({ length: 64 }, (_, i) => createHash("sha256").update(`noise-${i}`).digest()));
    const middle = Buffer.from(Bun.zstdCompressSync(Buffer.concat([
      Buffer.from("MIDDLE\n"), noise.subarray(0, 1000), magic, noise.subarray(1000), Buffer.from("\n"),
    ])));
    expect(middle.indexOf(magic, 1)).toBeGreaterThan(0);

    const out = decompressDshLog(Buffer.concat([
      Buffer.from(Bun.zstdCompressSync(Buffer.from("BEFORE\n"))),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x13, 0x37, 0x42]),
      middle,
      Buffer.from(Bun.zstdCompressSync(Buffer.from("AFTER\n"))),
    ]));

    expect(out.startsWith("BEFORE\n")).toBe(true);
    expect(out).toContain("MIDDLE\n");
    expect(out.endsWith("AFTER\n")).toBe(true);
  });

  // Catches: a corrupt log throwing out of annotate-last instead of reporting
  // that no message was found.
  test("an undecodable log yields no messages", () => {
    const home = makeDshHome();
    const dir = sessionDir(home, "s1");
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), "not zstd");
    expect(getRecentDshMessages(join(dir, "session.v4.jsonl.zstd"), 25)).toEqual([]);
  });
});

describe("findDshSessionLog", () => {
  // Catches: looking the session up under the wrong project key, or by the
  // raw id when DSH encodes it (here `:` and `~` become ~XXXX escapes).
  test("finds the session by its encoded id under any project directory", () => {
    const home = makeDshHome();
    sessionDir(home, "other", "--Users-test-other--");
    const log = writeCompressed(sessionDir(home, "a:b~c", "--Users-test-elsewhere--"));

    expect(encodeDshSegment("a:b~c")).toBe("a~003Ab~007Ec");
    expect(findDshSessionLog("a:b~c", { dshHome: home })).toBe(log);
  });

  // Catches: picking a stale pre-migration generation over the live one.
  test("prefers the newest generation in the session directory", () => {
    const home = makeDshHome();
    const dir = sessionDir(home, "s1");
    const older = join(dir, "session.v3.jsonl.zstd");
    writeFileSync(older, "");
    const live = writeCompressed(dir);
    utimesSync(older, new Date(), new Date(Date.now() + 60_000));

    expect(findDshSessionLog("s1", { dshHome: home })).toBe(live);
  });

  // Catches: annotate-last opening another session's message when the
  // calling session has no log.
  test("returns null for an unknown session or a missing sessions folder", () => {
    const home = makeDshHome();
    writeCompressed(sessionDir(home, "s1"));
    expect(findDshSessionLog("s2", { dshHome: home })).toBeNull();
    expect(findDshSessionLog("s1", { dshHome: join(home, "absent") })).toBeNull();
  });
});

describe("resolveDshHome", () => {
  // Catches: a blank DSH_HOME resolving sessions against the cwd (DSH treats
  // blank as unset).
  test("uses DSH_HOME when set and ignores a blank value", () => {
    expect(resolveDshHome({ DSH_HOME: "/tmp/dsh-home" })).toBe("/tmp/dsh-home");
    expect(resolveDshHome({ DSH_HOME: "  " })).not.toBe("  ");
    expect(resolveDshHome({ DSH_HOME: "  " })).toBe(resolveDshHome({}));
  });
});

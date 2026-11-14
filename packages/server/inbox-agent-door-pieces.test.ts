import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_UPLOAD_MAX_BYTES } from "@plannotator/core/inbox-types";
import { runInboxCallCommand } from "../../apps/hook/server/inbox-call-command";
import { INBOX_CALL_PIECE_BYTES } from "../../apps/hook/server/inbox-call-pieces";
import { createInboxAgentPieces, INBOX_AGENT_PIECES_DIR, INBOX_AGENT_PIECES_KEEP_MS } from "./inbox-agent-pieces";
import { doorCleanups, doorWorld, filesUnder } from "../../tests/helpers/inbox-agent-door-world";

const cleanups = doorCleanups();
afterEach(() => cleanups.run());

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-pieces-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("a cloud agent sends a big file in pieces", () => {
  test("inbox call splits a file past one piece on its own; it arrives byte-identical beside a small one, and no secret is in an answer, a log line or the output", async () => {
    const w = await doorWorld(cleanups);
    const { pairing, string } = await w.pair();
    const cwd = scratch();
    const video = randomBytes(INBOX_CALL_PIECE_BYTES * 2 + 12_345);
    writeFileSync(join(cwd, "demo.mp4"), video);
    writeFileSync(join(cwd, "notes.md"), "# Notes\n");
    let stdout = "";
    let stderr = "";
    const env = { PLANNOTATOR_PAIRING: string, PLANNOTATOR_PAIRING_DOOR: w.base };
    const run = (argv: string[]) => runInboxCallCommand(argv, { cwd, env, ensureRunning: () => Promise.reject(new Error("not used")), out: (text) => void (stdout += text), err: (text) => void (stderr += text) });

    expect(await run(["send_message", JSON.stringify({ body: "The demo.", attachments: ["notes.md", "demo.mp4"] })])).toBe(0);
    const sent = JSON.parse(stdout) as { thread_id: string };
    const attachments = (await w.thread(sent.thread_id)).messages[0]!.attachments!;
    expect(attachments.map((a) => [a.name, a.size])).toEqual([
      ["notes.md", 8],
      ["demo.mp4", video.length],
    ]);
    expect(sha(readFileSync(attachments[1]!.path))).toBe(sha(video));
    expect(filesUnder(join(w.dataDir, "inbox", INBOX_AGENT_PIECES_DIR))).toEqual([]);

    const haystacks = [...w.answers.slice(1), ...w.logs, stdout, stderr];
    for (const secret of [pairing.token, pairing.secret, string]) expect(haystacks.filter((text) => text.includes(secret))).toEqual([]);

    stdout = "";
    writeFileSync(join(cwd, "huge.mov"), "");
    truncateSync(join(cwd, "huge.mov"), INBOX_UPLOAD_MAX_BYTES + 1);
    expect(await run(["send_message", JSON.stringify({ body: "Too big.", attachments: ["huge.mov"] })])).toBe(1);
    expect(stderr).toContain(`attachment_too_large: huge.mov is ${INBOX_UPLOAD_MAX_BYTES + 1} bytes; a file is at most 100 MB. Nothing was sent.`);
    expect(stdout).toBe("");
  });

  test("pieces may arrive out of order or twice; a wrong hash, a missing piece or a size past 100 MB is refused; an upload is its agent's own and a path is still refused", async () => {
    const w = await doorWorld(cleanups);
    const { pairing } = await w.pair();
    const other = await w.pair("other", "Other agent");
    const door = (tool: string, args: Record<string, unknown>) => w.door(pairing.token, tool, args);
    const bytes = randomBytes(3000);
    const [a, b, c] = [bytes.subarray(0, 1000), bytes.subarray(1000, 2000), bytes.subarray(2000)];

    for (const [index, piece] of [
      [2, c],
      [0, a],
      [1, randomBytes(1000)],
      [1, b],
      [0, a],
    ] as const) {
      expect((await door("upload_piece", { upload_id: "clip-0001", index, data: b64(piece) })).error).toBeNull();
    }
    expect((await door("upload_finish", { upload_id: "clip-0001", name: "clip.webm", size: 3000, sha256: sha(bytes) })).result!.structuredContent).toEqual({ upload: "clip-0001", name: "clip.webm", size: 3000 });
    expect((await w.door(other.pairing.token, "send_message", { body: "Not mine.", attachments: [{ upload: "clip-0001" }] })).error).toStartWith("upload_not_found:");
    const posted = await door("send_message", { body: "The clip.", attachments: [{ upload: "clip-0001" }] });
    expect(posted.error).toBeNull();
    const attachment = (await w.thread(posted.result!.structuredContent!.thread_id as string)).messages[0]!.attachments![0]!;
    expect([attachment.name, sha(readFileSync(attachment.path))]).toEqual(["clip.webm", sha(bytes)]);
    expect((await door("send_message", { body: "Again.", attachments: [{ upload: "clip-0001" }] })).error).toStartWith("upload_not_found:");

    await door("upload_piece", { upload_id: "clip-0002", index: 0, data: b64(a) });
    expect((await door("upload_finish", { upload_id: "clip-0002", name: "clip.webm", size: 1000, sha256: sha(b) })).error).toStartWith("upload_mismatch:");
    expect((await door("upload_finish", { upload_id: "clip-0002", name: "clip.webm", size: 1000, sha256: sha(a) })).error).toStartWith("upload_not_found:");

    await door("upload_piece", { upload_id: "clip-0003", index: 0, data: b64(a) });
    await door("upload_piece", { upload_id: "clip-0003", index: 2, data: b64(c) });
    expect((await door("upload_finish", { upload_id: "clip-0003", name: "clip.webm", size: 3000, sha256: sha(bytes) })).error).toBe("upload_incomplete: Piece 1 has not arrived. Send it, then finish again.");
    expect((await door("upload_finish", { upload_id: "clip-0003", name: "clip.webm", size: INBOX_UPLOAD_MAX_BYTES + 1, sha256: sha(bytes) })).error).toStartWith("upload_too_large:");

    expect((await door("upload_piece", { upload_id: "../../../etc", index: 0, data: b64(a) })).error).toStartWith("validation_error:");
    expect((await door("send_message", { body: "Path.", attachments: [{ upload: "../../uploads" }] })).error).toStartWith("validation_error:");
    expect((await door("send_message", { body: "Path.", attachments: [join(w.project, "secret.png")] })).error).toStartWith("attachment_path_refused:");
  });

  test("an upload left unfinished is dropped after a day", () => {
    const dir = scratch();
    let now = Date.now();
    const pieces = createInboxAgentPieces(dir, () => now);
    pieces.piece("cloud.abc", "left-behind", 0, new Uint8Array([1, 2, 3]));
    const place = join(dir, INBOX_AGENT_PIECES_DIR, "cloud.abc", "left-behind");
    now += INBOX_AGENT_PIECES_KEEP_MS / 2;
    pieces.piece("cloud.abc", "fresh-one", 0, new Uint8Array([4]));
    expect(existsSync(place)).toBe(true);
    now = Date.now() + INBOX_AGENT_PIECES_KEEP_MS + 1;
    pieces.sweep();
    expect(existsSync(place)).toBe(false);
  });
});

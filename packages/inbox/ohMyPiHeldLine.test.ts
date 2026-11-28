/**
 * A thread one Oh My Pi session answers (#3443): its sessions are host `pi`, so the row's agent would read "Pi" from the
 * host. The row carries the writer's own name ("Oh My Pi") even with one agent, and the held line says "Oh My Pi
 * replied in …". A plain Pi session's thread keeps the row as it was (no `last_agent` with one agent).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "../shared/inbox/store";
import { arrivalOf } from "./newsWords";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function threadAnsweredBy(name: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-omp-writer-"));
  dirs.push(dir);
  const root = join(dir, "harbor");
  mkdirSync(root);
  const store = InboxStore.open(join(dir, "data"));
  const project = store.ensureProject({ name: "harbor", root });
  const started = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: { host: "pi", session: "ses_1" }, idempotency_key: "k1", thread_name: "Readme" }).message;
  store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "pi", session: "ses_1", name }, body: "Done.", reply_to: started.id });
  return store.listRows().find((row) => row.thread_id === started.thread_id)!;
}

describe("a thread one Oh My Pi session answers", () => {
  test("the row names the writer Oh My Pi, so the held line does", () => {
    const row = threadAnsweredBy("Oh My Pi");
    expect(row.last_agent).toEqual({ host: "pi", name: "Oh My Pi" });
    expect(arrivalOf(row, undefined).agent).toBe("Oh My Pi");
  });

  test("a Pi session's thread is as before", () => {
    expect(threadAnsweredBy("Pi").last_agent).toBeUndefined();
  });
});

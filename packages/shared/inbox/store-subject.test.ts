import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxError } from "./schema";
import { InboxStore } from "./store";
import { LEAKED_SUBJECT, LEAKED_SUBJECT_SHOWN, seedLeakedSubjects } from "../../../tests/helpers/inbox-leaked-subject";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-subject-"));
  roots.push(dir);
  return dir;
}

const agent = { kind: "agent" as const, host: "claude-code", session: "ses_a", name: "Claude Code" };

function refusal(fn: () => unknown): InboxError {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error;
    throw error;
  }
  throw new Error("not refused");
}

function messagesOnDisk(dir: string): string {
  const projects = join(dir, "inbox", "projects");
  return readdirSync(projects)
    .map((key) => {
      try {
        return readFileSync(join(projects, key, "messages.jsonl"), "utf8");
      } catch {
        return "";
      }
    })
    .join("");
}

describe("a subject is one line at send", () => {
  test("leaked tool-call text, a line break, controls and bidi are refused; nothing is written; a corrected retry lands once", () => {
    const dir = scratch();
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "repo", root: "/work/repo" });
    const cursor = store.cursor();
    for (const subject of [LEAKED_SUBJECT, "Roll-up\nsecond line", "Roll-up\u2028second", "Roll-up\u0000", "Roll-up \u202eevil"]) {
      const error = refusal(() =>
        store.sendMessage({ project_id: project.id, author: agent, subject, body: "Here is the roll-up.", idempotency_key: "ws-rollup-2026-10-20-a" }),
      );
      expect(error.code).toBe("validation_error");
      expect(error.message.startsWith("subject: ")).toBe(true);
      expect(error.details).toMatchObject({ field: "subject" });
    }
    expect(refusal(() => store.sendMessage({ project_id: project.id, author: agent, subject: LEAKED_SUBJECT, body: "x" })).message).toContain(
      "contains tool-call text",
    );
    expect(store.cursor()).toBe(cursor);
    expect(store.threadsOf(project.id)).toEqual([]);

    const first = store.sendMessage({ project_id: project.id, author: agent, subject: LEAKED_SUBJECT_SHOWN, body: "Here is the roll-up.", idempotency_key: "ws-rollup-2026-10-20-a" });
    expect(first.replayed).toBe(false);
    expect(first.message.subject).toBe(LEAKED_SUBJECT_SHOWN);
    const again = store.sendMessage({ project_id: project.id, author: agent, subject: LEAKED_SUBJECT_SHOWN, body: "Here is the roll-up.", idempotency_key: "ws-rollup-2026-10-20-a" });
    expect(again).toMatchObject({ replayed: true, message: { id: first.message.id } });
    expect(store.threadsOf(project.id)).toHaveLength(1);
  });

  test("prose with < and > is kept as written, trimmed; an empty subject derives one", () => {
    const store = InboxStore.open(scratch());
    const project = store.ensureProject({ name: "repo", root: "/work/repo" });
    const sent = store.sendMessage({ project_id: project.id, author: agent, subject: "  Vec<T> vs Box<dyn Trait>: is a < b?  ", body: "Body." });
    expect(sent.message.subject).toBe("Vec<T> vs Box<dyn Trait>: is a < b?");
    const derived = store.sendMessage({ project_id: project.id, author: { ...agent, session: "ses_b" }, subject: "  ", body: ":::question\nWhich <Select> variant?\n\n- [ ] A\n- [ ] B\n:::" });
    expect(derived.message.subject).toBe("Which <Select> variant?");
  });

  test("a reply carrying a malformed subject is refused too: the call itself was malformed", () => {
    const store = InboxStore.open(scratch());
    const project = store.ensureProject({ name: "repo", root: "/work/repo" });
    const root = store.sendMessage({ project_id: project.id, author: agent, body: "First." }).message;
    expect(refusal(() => store.sendMessage({ project_id: project.id, author: agent, reply_to: root.id, subject: LEAKED_SUBJECT, body: "Next." })).code).toBe(
      "validation_error",
    );
    expect(store.threadMessageIds(root.id)).toEqual([root.id]);
  });
});

describe("a subject an older Inbox kept is served as shown", () => {
  test("threadSubject, thread(), the root's wire, the summary and the list row show the first line without the markup; the disk keeps the raw line", () => {
    const dir = scratch();
    const [id] = seedLeakedSubjects(dir, [{ name: "workspaces", root: "/work/workspaces" }]);
    const store = InboxStore.open(dir);
    expect(store.threadSubject(id!)).toBe(LEAKED_SUBJECT_SHOWN);
    expect(store.thread(id!)!.subject).toBe(LEAKED_SUBJECT_SHOWN);
    expect(store.thread(id!)!.messages[0]!.subject).toBe(LEAKED_SUBJECT_SHOWN);
    expect(store.messageWire(id!)!.subject).toBe(LEAKED_SUBJECT_SHOWN);
    expect(store.threadSummary(id!)!.subject).toBe(LEAKED_SUBJECT_SHOWN);
    expect(store.listRow(id!)!.subject).toBe(LEAKED_SUBJECT_SHOWN);
    expect(store.message(id!)!.subject).toBe(LEAKED_SUBJECT);
    expect(messagesOnDisk(dir)).toContain(JSON.stringify(LEAKED_SUBJECT));
  });
});

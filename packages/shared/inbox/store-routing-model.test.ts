import { afterEach, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxThreadNameKey } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Op =
  | { op: "send"; project: number; session: string | null; name: string | null }
  | { op: "personStart"; project: number; session: string; name: string | null; auto: boolean }
  | { op: "name"; target: number; name: string }
  | { op: "resolve"; target: number; resolved: boolean }
  | { op: "readdress"; target: number; session: string }
  | { op: "delete"; target: number }
  | { op: "reload" };

const SESSIONS = ["ses_a", "ses_b", "ses_c"];
const NAMES = ["Release notes", "release NOTES", "Board", "Relay"];

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({
      op: fc.constant("send" as const),
      project: fc.nat(1),
      session: fc.constantFrom(...SESSIONS, null),
      name: fc.constantFrom(null, ...NAMES),
    }),
    weight: 5,
  },
  {
    arbitrary: fc.record({
      op: fc.constant("personStart" as const),
      project: fc.nat(1),
      session: fc.constantFrom(...SESSIONS),
      name: fc.constantFrom(null, ...NAMES),
      auto: fc.boolean(),
    }),
    weight: 3,
  },
  { arbitrary: fc.record({ op: fc.constant("name" as const), target: fc.nat(), name: fc.constantFrom(...NAMES) }), weight: 3 },
  fc.record({ op: fc.constant("resolve" as const), target: fc.nat(), resolved: fc.boolean() }),
  fc.record({ op: fc.constant("readdress" as const), target: fc.nat(), session: fc.constantFrom(...SESSIONS) }),
  fc.record({ op: fc.constant("delete" as const), target: fc.nat() }),
  fc.record({ op: fc.constant("reload" as const) }),
);

interface ModelThread {
  id: string;
  project: number;
  person: boolean;
  name: string | null;
  namedBy: "agent" | "person" | "auto" | null;
  resolved: boolean;
  to: string | null;
}

test("an independent model of routing predicts every send; a compose name never pulls another session's send into the person's thread", () => {
  fc.assert(
    fc.property(fc.array(opArb, { maxLength: 45 }), (ops) => {
      const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-routing-model-"));
      roots.push(dir);
      let store = InboxStore.open(dir);
      const projectId = (n: number) => store.ensureProject({ name: `repo${n}`, root: `/work/repo${n}` }).id;
      const threads: ModelThread[] = [];
      const routes: string[] = [];
      let step = 0;
      const key = (name: string) => inboxThreadNameKey(name);
      const byId = (id: string) => threads.find((t) => t.id === id)!;
      const taken = (project: number, name: string, except: string | null) =>
        threads.some((t) => t.project === project && t.name === key(name) && !t.resolved && t.id !== except);
      const pick = (n: number) => (threads.length === 0 ? null : threads[n % threads.length]!);

      for (const op of ops) {
        step += 1;
        if (op.op === "send") {
          const project = op.project;
          let expected: string | null = null;
          if (op.name !== null) {
            const open = routes.map(byId).filter((t) => t.project === project && t.name === key(op.name!) && !t.resolved);
            expected = open.at(-1)?.id ?? null;
          }
          const sent = store.sendMessage({
            project_id: projectId(project),
            author: { kind: "agent", host: "test", session: op.session, name: null },
            body: `send ${step}`,
            thread: op.name,
          }).message;
          if (expected) {
            expect(sent.thread_id).toBe(expected);
          } else {
            expect(sent.thread_id).toBe(sent.id);
            threads.push({ id: sent.id, project, person: false, name: op.name === null ? null : key(op.name), namedBy: op.name === null ? null : "agent", resolved: false, to: null });
            if (op.name !== null) routes.push(sent.id);
          }
          const landed = byId(sent.thread_id);
          if (op.name !== null && landed.person) {
            expect(landed.namedBy).toBe("agent");
            expect(landed.name).toBe(key(op.name));
          }
        } else if (op.op === "personStart") {
          const typedTaken = op.name !== null && !op.auto && taken(op.project, op.name, null);
          let started: string | null = null;
          try {
            started = store.startPersonThread({
              project_id: projectId(op.project),
              body: `idea ${step}`,
              to: { host: "test", session: op.session },
              idempotency_key: `person-${step}`,
              thread_name: op.name,
              thread_name_auto: op.auto,
            }).message.id;
          } catch (error) {
            if (!(error instanceof InboxError)) throw error;
            expect(error.code).toBe("thread_name_taken");
          }
          expect(started === null).toBe(typedTaken);
          if (started) {
            const named = op.name !== null && !(op.auto && taken(op.project, op.name, null));
            threads.push({ id: started, project: op.project, person: true, name: named ? key(op.name!) : null, namedBy: named ? (op.auto ? "auto" : "person") : null, resolved: false, to: op.session });
          }
        } else if (op.op === "name") {
          const target = pick(op.target);
          if (!target) continue;
          const session = target.person ? target.to! : "ses_a";
          const reply = store.sendMessage({
            project_id: projectId(target.project),
            author: { kind: "agent", host: "test", session, name: null },
            body: `reply ${step}`,
            reply_to: target.id,
            thread: op.name,
          });
          expect(reply.message.thread_id).toBe(target.id);
          const nameable = target.person && (target.namedBy === null || target.namedBy === "auto");
          if (!nameable) {
            expect(reply.naming?.status === "named").toBe(false);
          } else if (taken(target.project, op.name, target.id)) {
            expect(reply.naming).toMatchObject({ status: "refused", code: "thread_name_taken" });
          } else {
            expect(reply.naming).toEqual({ status: "named", name: op.name });
            target.name = key(op.name);
            target.namedBy = "agent";
            routes.push(target.id);
          }
        } else if (op.op === "resolve") {
          const target = pick(op.target);
          if (!target) continue;
          store.resolveThread(target.id, op.resolved);
          target.resolved = op.resolved;
        } else if (op.op === "readdress") {
          const target = pick(op.target);
          if (!target || !target.person) continue;
          let done = true;
          try {
            store.readdressMessage(target.id, { host: "test", session: op.session });
          } catch (error) {
            if (!(error instanceof InboxError)) throw error;
            done = false;
            expect(error.code).toBe("thread_resolved");
          }
          expect(done).toBe(!target.resolved);
          if (done) target.to = op.session;
        } else if (op.op === "delete") {
          const target = pick(op.target);
          if (!target) continue;
          store.deleteThread(target.id);
          threads.splice(threads.indexOf(target), 1);
          const at = routes.indexOf(target.id);
          if (at >= 0) routes.splice(at, 1);
        } else {
          store = InboxStore.open(dir);
        }
      }
    }),
    { numRuns: 150 },
  );
});

test("a send with no reply_to and no thread starts a new thread, though the same session has an open one in the project", () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-routing-new-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project_id = store.ensureProject({ name: "repo0", root: "/work/repo0" }).id;
  const author = { kind: "agent" as const, host: "test", session: "ses_long", name: null };
  const old = store.sendMessage({ project_id, author, body: "Weeks-old status." }).message;
  const next = store.sendMessage({ project_id, author, body: "An unrelated update." });
  expect(store.listRow(old.thread_id)!.resolved_at).toBeNull();
  expect(next.message.thread_id).toBe(next.message.id);
  expect(next.message.thread_id).not.toBe(old.thread_id);
  expect(store.sendMessage({ project_id, author, body: "Follow-up.", reply_to: old.id }).message.thread_id).toBe(old.thread_id);
  const named = store.sendMessage({ project_id, author, body: "Docs, part 1.", thread: "docs" }).message;
  expect(store.sendMessage({ project_id, author, body: "Docs, part 2.", thread: "docs" }).message.thread_id).toBe(named.thread_id);
  const again = InboxStore.open(dir).sendMessage({ project_id, author, body: "After a restart." }).message;
  expect(again.thread_id).toBe(again.id);
});

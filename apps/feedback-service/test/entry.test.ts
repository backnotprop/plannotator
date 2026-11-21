/**
 * The deployed entry point itself (targets/cloudflare.ts, wrangler's `main`),
 * not just handleRequest: driven with a fake D1 that records every statement
 * and throws on anything but `prepare(sql).bind(...).run()`. Every request
 * that is not a valid POST /feedback (another method, a query string, another
 * path) never touches the database; a valid one runs exactly one parameterised
 * INSERT. So a read route wired into the entry, wherever its code lives,
 * fails here.
 */
import { describe, expect, test } from "bun:test";
import worker from "../targets/cloudflare";

type Statement = { sql: string; bound: unknown[] | null; ran: boolean };

/** A D1Database stand-in: `prepare(sql).bind(...).run()` and nothing else; any other use throws. */
function fakeD1() {
  const statements: Statement[] = [];
  const refuse = (what: string) => {
    throw new Error(`fake D1: ${what} is not allowed`);
  };
  const strict = <T extends object>(name: string, allowed: T): T =>
    new Proxy(allowed, {
      get(target, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop in target) return (target as Record<string, unknown>)[prop];
        return refuse(`${name}.${prop}`);
      },
    });
  const db = strict("db", {
    prepare(sql: string) {
      const statement: Statement = { sql, bound: null, ran: false };
      statements.push(statement);
      return strict("statement", {
        bind(...values: unknown[]) {
          statement.bound = values;
          return strict("bound", {
            async run() {
              statement.ran = true;
              return { success: true, meta: {} };
            },
          });
        },
      });
    },
  });
  return { db, statements };
}

const BASE = "https://plannotator-feedback.example";

async function call(db: object, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const request = new Request(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body,
  });
  return worker.fetch(request, { FEEDBACK_DB: db as D1Database });
}

describe("the Worker entry with a strict fake D1", () => {
  test("no other method, query, path or origin ever touches the database", async () => {
    const { db, statements } = fakeD1();
    const json = JSON.stringify({ message: "hi" });
    const cases: Array<[string, string, string | undefined, Record<string, string>?]> = [
      ["GET", "/feedback", undefined],
      ["GET", "/feedback?x", undefined],
      ["GET", "/feedback?select=*", undefined],
      ["GET", "/feedback?id=1&format=json", undefined],
      ["HEAD", "/feedback", undefined],
      ["PUT", "/feedback", json],
      ["PATCH", "/feedback", json],
      ["DELETE", "/feedback", undefined],
      ["DELETE", "/feedback?id=1", undefined],
      ["OPTIONS", "/feedback", undefined],
      ["GET", "/", undefined],
      ["GET", "/admin", undefined],
      ["GET", "/feedback/1", undefined],
      ["POST", "/feedback/1", json],
      ["POST", "/admin", json],
      ["POST", "/feedbacks", json],
      // A browser page (any Origin, none allowed by default).
      ["POST", "/feedback", json, { Origin: "http://localhost:3000" }],
      // Bad bodies never reach the insert.
      ["POST", "/feedback", JSON.stringify({ message: "" })],
      ["POST", "/feedback", "{"],
    ];
    for (const [method, path, body, headers] of cases) {
      const res = await call(db, method, path, body, headers);
      // An OPTIONS with no Origin is an empty 204 (no CORS headers); everything else is refused.
      if (method === "OPTIONS") expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      else expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      if (method !== "HEAD") expect((await res.text()).includes("hi"), `${method} ${path} echoed data`).toBe(false);
    }
    expect(statements).toEqual([]);
  });

  test("a valid POST /feedback runs exactly one parameterised INSERT and answers only {ok:true}", async () => {
    const { db, statements } = fakeD1();
    const res = await call(db, "POST", "/feedback", JSON.stringify({ message: "It works", category: "idea", surface: "cli" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql.replace(/\s+/g, " ").trim()).toMatch(/^INSERT INTO feedback \(/);
    expect(statements[0]!.ran).toBe(true);
    expect(statements[0]!.bound).toContain("It works");
  });
});

import { describe, expect, test } from "bun:test";
import { countUnsentDraftComments, handleHostControlRequest, type HostControlRoute } from "./host-control";

const TOKEN = "k".repeat(40);

function route(overrides: Partial<HostControlRoute> = {}): HostControlRoute {
  return {
    token: TOKEN,
    getServerPort: () => 4321,
    control: {
      status: () => ({ kind: "annotate", documents: [], unsentAnnotations: 0, decided: false }),
      close: () => ({ closed: true, unsentAnnotations: 0 }),
    },
    ...overrides,
  };
}

function ask(overrides: Partial<{ method: string; pathname: string; host: string | null; origin: string | null; authorization: string | null }> = {}, r = route()) {
  return handleHostControlRequest(
    { method: "GET", pathname: "/api/host/status", host: "127.0.0.1:4321", origin: null, authorization: `Bearer ${TOKEN}`, ...overrides },
    r,
  );
}

// The failure each guards: a page on another name (DNS rebinding) or another
// local server, a browser page, or a process without the launch token reads
// or closes a review.
describe("host control guards", () => {
  test("only a loopback Host naming this server's port", () => {
    expect(ask()?.status).toBe(200);
    expect(ask({ host: "localhost:4321" })?.status).toBe(200);
    expect(ask({ host: "evil.example:4321" })?.status).toBe(403);
    expect(ask({ host: "127.0.0.1:9999" })?.status).toBe(403);
    expect(ask({}, route({ getServerPort: () => undefined }))?.status).toBe(403);
  });

  test("no Origin, the right bearer token, and nothing without a token configured", () => {
    expect(ask({ origin: "http://localhost:4321" })?.status).toBe(403);
    expect(ask({ authorization: `Bearer ${"x".repeat(40)}` })?.status).toBe(401);
    expect(ask({ authorization: null })?.status).toBe(401);
    // Off answers a coded 404, so a host can tell it from a Plannotator that
    // predates the endpoint (whose process it may TERM) and leave it alone.
    expect(ask({}, route({ token: undefined }))).toMatchObject({ status: 404, body: { code: "host_control_disabled" } });
    expect(ask({ method: "POST", pathname: "/api/host/close" }, route({ token: undefined }))?.body).toMatchObject({ code: "host_control_disabled" });
  });

  test("other paths are not answered; a session without close refuses it", () => {
    expect(ask({ pathname: "/api/plan" })).toBeNull();
    const plan = route({ control: { status: () => ({ kind: "plan", documents: [], unsentAnnotations: 0, decided: false }) } });
    expect(ask({ method: "POST", pathname: "/api/host/close" }, plan)).toMatchObject({ status: 409, body: { code: "not_closable" } });
  });
});

describe("countUnsentDraftComments", () => {
  test("annotations plus code annotations; anything malformed counts nothing", () => {
    expect(countUnsentDraftComments({ annotations: [{}, {}], codeAnnotations: [{}] })).toBe(3);
    expect(countUnsentDraftComments(null)).toBe(0);
    expect(countUnsentDraftComments({ annotations: "x" })).toBe(0);
  });

  // The failure: "N unsent comments" counts a review agent's or linter's
  // findings as the reviewer's, or misses the reviewer's PR-mode notes.
  test("only the reviewer's own comments: source-tagged entries are skipped, PR notes count", () => {
    expect(
      countUnsentDraftComments({
        codeAnnotations: [{ id: "a" }, { id: "b", source: "review-agent" }, { id: "c", source: "browser-agent" }],
        annotations: [{ id: "d", source: "eslint" }, { id: "e" }],
        descriptionAnnotations: [{ id: "f" }],
        commentAnnotations: [{ id: "g" }, { id: "h" }],
      }),
    ).toBe(5);
  });
});

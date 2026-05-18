import { afterEach, describe, expect, test } from "bun:test";
import { normalizeGoalSetupBundle } from "@plannotator/shared/goal-setup";
import {
  startGoalSetupServer,
  createGoalSetupSession,
  type GoalSetupServerResult,
} from "./goal-setup";

let server: GoalSetupServerResult | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

const interviewBundle = () =>
  normalizeGoalSetupBundle({
    stage: "interview",
    title: "Goal setup",
    questions: [{ id: "scope", prompt: "Scope?" }],
  });

const factsBundle = () =>
  normalizeGoalSetupBundle({
    stage: "facts",
    title: "Facts review",
    facts: [{ id: "f1", text: "The app uses Bun.", accepted: false, removed: false, automatedVerification: false }],
  });

function makeRequest(path: string, init?: RequestInit): { req: Request; url: URL } {
  const fullUrl = `http://localhost${path}`;
  return { req: new Request(fullUrl, init), url: new URL(fullUrl) };
}

describe("goal setup standalone server", () => {
  test("serves interview bundle and resolves submitted answers", async () => {
    const bundle = interviewBundle();
    server = await startGoalSetupServer({
      bundle,
      htmlContent: "<html></html>",
      origin: "claude-code",
    });

    const plan = await fetch(`${server.url}/api/goal-setup`).then((res) => res.json());
    expect(plan.mode).toBe("goal-setup");
    expect(plan.goalSetup.questions[0].id).toBe("scope");

    const decision = server.waitForDecision();
    const submitted = await fetch(`${server.url}/api/goal-setup/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answers: [{ questionId: "scope", selectedOptionIds: [], customAnswer: "", answer: "Everything.", completed: true }],
      }),
    }).then((res) => res.json());

    expect(submitted.ok).toBe(true);
    const result = await decision;
    expect(result.result?.stage).toBe("interview");
  });
});

describe("goal setup daemon session", () => {
  test("serves interview bundle via handleRequest", async () => {
    const session = await createGoalSetupSession({ bundle: interviewBundle(), htmlContent: "<html></html>" });

    const { req, url } = makeRequest("/api/goal-setup");
    const response = await session.handleRequest(req, url);
    const data = await response.json();

    expect(data.mode).toBe("goal-setup");
    expect(data.goalSetup.questions[0].id).toBe("scope");
    session.dispose();
  });

  test("resolves submitted interview answers", async () => {
    const session = await createGoalSetupSession({ bundle: interviewBundle(), htmlContent: "<html></html>" });

    const decision = session.waitForDecision();
    const { req, url } = makeRequest("/api/goal-setup/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answers: [{ questionId: "scope", selectedOptionIds: [], customAnswer: "", answer: "Ship it.", completed: true }],
      }),
    });

    const response = await session.handleRequest(req, url);
    expect((await response.json()).ok).toBe(true);

    const result = await decision;
    expect(result.result?.stage).toBe("interview");
    if (result.result?.stage !== "interview") throw new Error("expected interview");
    expect(result.result.answers[0].answer).toBe("Ship it.");
  });

  test("resolves submitted facts", async () => {
    const session = await createGoalSetupSession({ bundle: factsBundle(), htmlContent: "<html></html>" });

    const decision = session.waitForDecision();
    const { req, url } = makeRequest("/api/goal-setup/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        facts: [{ factId: "f1", accepted: true, removed: false, text: "The app uses Bun.", automatedVerification: true }],
      }),
    });

    const response = await session.handleRequest(req, url);
    expect((await response.json()).ok).toBe(true);

    const result = await decision;
    expect(result.result?.stage).toBe("facts");
  });

  test("resolves exit on /api/exit", async () => {
    const session = await createGoalSetupSession({ bundle: interviewBundle(), htmlContent: "<html></html>" });

    const decision = session.waitForDecision();
    const { req, url } = makeRequest("/api/exit", { method: "POST" });
    await session.handleRequest(req, url);

    const result = await decision;
    expect(result.exit).toBe(true);
    expect(result.result).toBeUndefined();
  });

  test("dispose resolves as exit", async () => {
    const session = await createGoalSetupSession({ bundle: interviewBundle(), htmlContent: "<html></html>" });

    const decision = session.waitForDecision();
    session.dispose();

    const result = await decision;
    expect(result.exit).toBe(true);
  });

  test("returns 404 for unknown routes", async () => {
    const session = await createGoalSetupSession({ bundle: interviewBundle(), htmlContent: "<html></html>" });
    const { req, url } = makeRequest("/api/unknown");
    const response = await session.handleRequest(req, url);
    expect(response.status).toBe(404);
    session.dispose();
  });
});

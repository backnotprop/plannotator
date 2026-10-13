/**
 * The annotate "Agent Instructions" payload is a contract an external agent
 * executes literally: it copies the read command, the POST bodies and the
 * PATCH bodies out of the clipboard text and runs them against the session.
 * These tests do exactly that against a real annotate server for every
 * surface, so an instruction that drifts from the server (a renamed payload
 * field, a body the validator refuses, a field POST silently drops) fails
 * here instead of in an agent's hands.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./annotate";
import {
  buildAnnotateAgentInstructions,
  type AnnotateInstructionsSurface,
} from "../ui/utils/annotateAgentInstructions";

const SHELL = "<html><body>Plannotator</body></html>";

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pn-agent-instr-"));
  for (const key of ["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_DATA_DIR"]) saved[key] = process.env[key];
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface CurlCall {
  method: string;
  url: string;
  body?: string;
  /** Fields of a `jq -r .a` or `jq -r '.a // .b'` filter, in fallback order. */
  jqFields?: string[];
}

/** What the agent's `jq -r` filter prints for a response: the first
 *  non-null field of the `//` chain, or "null" like jq itself. */
function jqOutput(call: CurlCall, json: any): string {
  for (const field of call.jqFields ?? []) {
    const value = json?.[field];
    if (value !== null && value !== undefined) return String(value);
  }
  return "null";
}

/** Every `curl` command in the text, parsed the way a shell would see it
 *  (line continuations joined; single-quoted `-d` bodies may span lines). */
function curlCalls(text: string): CurlCall[] {
  const joined = text.replace(/\\\n\s*/g, " ");
  const chunks = joined.split(/(?=\bcurl -s )/).filter((chunk) => chunk.startsWith("curl -s "));
  return chunks.map((chunk) => {
    const method = /-X (\w+)/.exec(chunk)?.[1];
    const url = /(?:^curl -s (?:-X \w+ )?)"?(http[^\s"']+)"?/.exec(chunk)?.[1] ?? "";
    const body = /-d '([\s\S]*?)'/.exec(chunk)?.[1];
    const filter = /\| jq -r (?:'([^']+)'|(\.\w+))/.exec(chunk.split("\n")[0]);
    const jqFields = filter
      ? (filter[1] ?? filter[2]).split("//").map((part) => part.trim().replace(/^\./, ""))
      : undefined;
    return { method: method ?? (body ? "POST" : "GET"), url, body, jqFields };
  });
}

/** ```json blocks are complete POST bodies. */
function jsonBlocks(text: string): string[] {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
}

async function runInstructions(
  url: string,
  surface: AnnotateInstructionsSurface,
  substitutions: Record<string, string> = {},
) {
  const text = buildAnnotateAgentInstructions(url, surface);
  const calls = curlCalls(text);
  let lastId = "";
  const results: { call: CurlCall; status: number; json: any }[] = [];
  const posts = [
    ...calls.filter((c) => c.method === "POST"),
    ...jsonBlocks(text).map((body) => ({ method: "POST", url: `${url}/api/external-annotations`, body })),
  ];
  const rest = calls.filter((c) => c.method !== "POST");
  for (const call of [...posts, ...rest]) {
    let target = call.url.replace("<uuid>", lastId);
    for (const [from, to] of Object.entries(substitutions)) target = target.replace(from, encodeURIComponent(to));
    if (call.method === "DELETE") continue; // cleanup lines; run last by the caller if needed
    const res = await fetch(target, {
      method: call.method,
      headers: call.body ? { "Content-Type": "application/json" } : undefined,
      body: call.body,
    });
    const json = await res.json().catch(() => null);
    if (call.method === "POST" && json?.ids?.[0]) lastId = json.ids[0];
    results.push({ call, status: res.status, json });
  }
  return { text, calls, results };
}

describe("annotate agent instructions, executed against a live annotate server", () => {
  test("markdown: the read field is the document and every example body is accepted", async () => {
    const file = join(dir, "doc.md");
    writeFileSync(file, "# Notes\n\nadoption doubled last year\n");
    const server = await startAnnotateServer({ markdown: "# Notes\n\nadoption doubled last year\n", filePath: file, htmlContent: SHELL });
    try {
      const { results } = await runInstructions(server.url, "markdown");
      const read = results.find((r) => r.call.jqFields);
      expect(jqOutput(read!.call, read!.json)).toContain("adoption doubled last year");
      for (const r of results) expect(r.status).toBeLessThan(300);
      const list = await (await fetch(`${server.url}/api/external-annotations`)).json();
      expect(list.annotations.map((a: any) => a.type).sort()).toEqual(["COMMENT", "GLOBAL_COMMENT"]);
    } finally {
      server.stop();
    }
  });

  test("html: the read field carries the page and the element anchor survives the PATCH", async () => {
    const html = '<html><body><section id="pricing"><h2>Pricing</h2></section></body></html>';
    const file = join(dir, "page.html");
    writeFileSync(file, html);
    const server = await startAnnotateServer({ markdown: "", filePath: file, htmlContent: SHELL, rawHtml: html, renderHtml: true });
    try {
      const { results } = await runInstructions(server.url, "html");
      const read = results.find((r) => r.call.jqFields);
      expect(jqOutput(read!.call, read!.json)).toContain('id="pricing"');
      for (const r of results) expect(r.status).toBeLessThan(300);
      const patch = results.find((r) => r.call.method === "PATCH" && r.call.body?.includes("htmlAnchor"));
      expect(patch?.json.annotation.htmlAnchor).toMatchObject({ selector: "#pricing > h2", tagName: "h2" });
    } finally {
      server.stop();
    }
  });

  test("html: POST alone drops an element anchor, which is why the instructions PATCH it", async () => {
    const server = await startAnnotateServer({ markdown: "", filePath: join(dir, "p.html"), htmlContent: SHELL, rawHtml: "<p>x</p>", renderHtml: true });
    try {
      const res = await fetch(`${server.url}/api/external-annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "t", type: "COMMENT", text: "c", originalText: "x", htmlAnchor: { selector: "p", tagName: "p" } }),
      });
      const { ids } = await res.json();
      const list = await (await fetch(`${server.url}/api/external-annotations`)).json();
      expect(list.annotations.find((a: any) => a.id === ids[0]).htmlAnchor).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("diagram: the diagramAnchor example is accepted and stored", async () => {
    const source = "flowchart TD\n  A[Start] --> B[Run]\n";
    const file = join(dir, "flow.mmd");
    writeFileSync(file, source);
    const server = await startAnnotateServer({ markdown: source, filePath: file, htmlContent: SHELL });
    try {
      const { results } = await runInstructions(server.url, "diagram");
      for (const r of results) expect(r.status).toBeLessThan(300);
      const list = await (await fetch(`${server.url}/api/external-annotations`)).json();
      expect(list.annotations.some((a: any) => a.diagramAnchor?.id === "A")).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("folder: the document read command prints markdown, HTML and data files", async () => {
    const folder = join(dir, "notes");
    mkdirSync(folder);
    writeFileSync(join(folder, "beta.md"), "# Beta\n\nrollout windows\n");
    writeFileSync(join(folder, "page.html"), "<html><body><h1>Embedded pricing page</h1></body></html>");
    writeFileSync(join(folder, "config.yaml"), "retries: 3\n");
    const server = await startAnnotateServer({ markdown: "", filePath: folder, folderPath: folder, mode: "annotate-folder", htmlContent: SHELL });
    try {
      const cases: Array<[string, string]> = [
        ["beta.md", "rollout windows"],
        ["page.html", "Embedded pricing page"],
        ["config.yaml", "retries: 3"],
      ];
      for (const [file, expected] of cases) {
        const { results } = await runInstructions(server.url, "folder", { "<path-relative-to-folder>": file });
        const read = results.find((r) => r.call.url.includes("/api/doc"));
        expect(read?.status).toBe(200);
        expect(jqOutput(read!.call, read!.json)).toContain(expected);
        for (const r of results) expect(r.status).toBeLessThan(300);
      }
    } finally {
      server.stop();
    }
  });
});

/**
 * Lossless JSON member edits (json-edit.ts): only the one member's text
 * changes, in the file's own style, and anything that cannot be placed
 * safely is refused.
 */
import { describe, expect, test } from "bun:test";
import { addJsonMember, removeJsonMember } from "./json-edit";

const V = { command: "/p", args: ["inbox", "mcp"] };

test("pretty: the new member follows the others' indentation and colon spacing; removal gives the file back", () => {
  const before = '{\n    "mcpServers": {\n        "a": { "command": "x" }\n    },\n    "z": 1.50\n}\n';
  const added = addJsonMember(before, ["mcpServers"], "plannotator-inbox", V);
  expect(added).toEqual({
    ok: true,
    changed: true,
    text: '{\n    "mcpServers": {\n        "a": { "command": "x" },\n        "plannotator-inbox": {\n            "command": "/p",\n            "args": [\n                "inbox",\n                "mcp"\n            ]\n        }\n    },\n    "z": 1.50\n}\n',
  });
  const removed = removeJsonMember(added.ok ? added.text : "", ["mcpServers"], "plannotator-inbox");
  expect(removed).toEqual({ ok: true, changed: true, text: before });
});

test("an empty or missing parent object is made in the file's style", () => {
  expect(addJsonMember('{\n  "theme": 1\n}', ["mcpServers"], "k", 1)).toEqual({ ok: true, changed: true, text: '{\n  "theme": 1,\n  "mcpServers": {\n    "k": 1\n  }\n}' });
  expect(addJsonMember("{}", ["mcpServers"], "k", 1)).toEqual({ ok: true, changed: true, text: '{"mcpServers":{"k":1}}' });
  expect(addJsonMember("", ["mcpServers"], "k", 1)).toEqual({ ok: true, changed: true, text: '{\n  "mcpServers": {\n    "k": 1\n  }\n}\n' });
});

test("mixed line endings: every existing byte stays, the new lines take the dominant ending", () => {
  const before = '{\r\n  "a": 1,\n  "b": {\r\n    "c": 2\r\n  }\r\n}\r\n';
  const added = addJsonMember(before, ["b"], "k", { x: 1 });
  expect(added.ok && added.text).toBe('{\r\n  "a": 1,\n  "b": {\r\n    "c": 2,\r\n    "k": {\r\n      "x": 1\r\n    }\r\n  }\r\n}\r\n');
});

test("present already: unchanged; a member removed that is not there: unchanged", () => {
  const text = '{"mcpServers":{"plannotator-inbox":{"command":"other"}}}';
  expect(addJsonMember(text, ["mcpServers"], "plannotator-inbox", V)).toEqual({ ok: true, text, changed: false });
  expect(removeJsonMember('{"mcpServers":{}}', ["mcpServers"], "x")).toEqual({ ok: true, text: '{"mcpServers":{}}', changed: false });
});

test("refused: comments, a non-object on the path, a duplicate key on the path", () => {
  expect(addJsonMember('{ // x\n}', ["m"], "k", 1).ok).toBe(false);
  expect(addJsonMember('{"m":[]}', ["m"], "k", 1)).toEqual({ ok: false, reason: 'its "m" is not an object' });
  expect(addJsonMember('{"m":{},"m":{}}', ["m"], "k", 1)).toEqual({ ok: false, reason: 'it has "m" twice' });
  expect(removeJsonMember('{"m":{"k":1,"k":2}}', ["m"], "k")).toEqual({ ok: false, reason: 'it has "k" twice' });
});

test("removal of the first, a middle and the only member keeps everything else", () => {
  expect(removeJsonMember('{"m":{"k":1,"a":2}}', ["m"], "k")).toEqual({ ok: true, changed: true, text: '{"m":{"a":2}}' });
  expect(removeJsonMember('{"m":{"a":1,"k":2,"b":3}}', ["m"], "k")).toEqual({ ok: true, changed: true, text: '{"m":{"a":1,"b":3}}' });
  expect(removeJsonMember('{"m":{\n  "k": 1\n}}', ["m"], "k")).toEqual({ ok: true, changed: true, text: '{"m":{}}' });
});

describe("JSON with comments (Qwen Code's settings.json)", () => {
  const C = { comments: true };

  test("every comment stays: the comma goes before a comment ending the last member's line, the member after it; removal gives the file back", () => {
    const before = '{\n  // mine\n  "mcpServers": {\n    "a": { "env": { "T": "${T}" } } // keep\n  },\n  /* x */ "z": "http://a//b"\n}\n';
    const added = addJsonMember(before, ["mcpServers"], "k", 1, C);
    expect(added).toEqual({ ok: true, changed: true, text: '{\n  // mine\n  "mcpServers": {\n    "a": { "env": { "T": "${T}" } }, // keep\n    "k": 1\n  },\n  /* x */ "z": "http://a//b"\n}\n' });
    expect(removeJsonMember(added.ok ? added.text : "", ["mcpServers"], "k", C)).toEqual({ ok: true, changed: true, text: before });
    // A comment inside an empty object stays, after the new member.
    expect(addJsonMember('{\n  "m": {\n    // none yet\n  }\n}', ["m"], "k", 1, C)).toEqual({ ok: true, changed: true, text: '{\n  "m": {\n    "k": 1\n    // none yet\n  }\n}' });
  });

  test("a CRLF file keeps CRLF everywhere: a line comment ending the last member's line keeps its line ending", () => {
    const before = '{\r\n  "mcpServers": {\r\n    "a": 1 // keep\r\n  }\r\n}\r\n';
    const added = addJsonMember(before, ["mcpServers"], "k", { c: "x" }, C);
    expect(added).toEqual({ ok: true, changed: true, text: '{\r\n  "mcpServers": {\r\n    "a": 1, // keep\r\n    "k": {\r\n      "c": "x"\r\n    }\r\n  }\r\n}\r\n' });
    expect(removeJsonMember(added.ok ? added.text : "", ["mcpServers"], "k", C)).toEqual({ ok: true, changed: true, text: before });
  });

  test("a one-line file keeps a comment inside an empty object", () => {
    expect(addJsonMember('{"mcpServers":{/* keep me */}}', ["mcpServers"], "k", 1, C)).toEqual({ ok: true, changed: true, text: '{"mcpServers":{"k":1/* keep me */}}' });
    expect(addJsonMember("{/* only */}", ["mcpServers"], "k", 1, C)).toEqual({ ok: true, changed: true, text: '{"mcpServers":{"k":1}/* only */}' });
  });

  test("a removal next to a comment cuts only the member and one comma", () => {
    expect(removeJsonMember('{"m": {\n  // ours\n  "k": 1,\n  "b": 2 // b\n}}', ["m"], "k", C)).toEqual({ ok: true, changed: true, text: '{"m": {\n  // ours\n  "b": 2 // b\n}}' });
    expect(removeJsonMember('{"m": {\n  "a": 1, // a\n  "k": 2 /* k */\n}}', ["m"], "k", C)).toEqual({ ok: true, changed: true, text: '{"m": {\n  "a": 1 // a /* k */\n}}' });
    expect(removeJsonMember('{"m": {\n  /* only */\n  "k": 1\n}}', ["m"], "k", C)).toEqual({ ok: true, changed: true, text: '{"m": {\n  /* only */\n}}' });
  });

  test("refused as Qwen refuses them: a trailing comma, an unterminated comment; and comments stay refused without the option", () => {
    expect(addJsonMember('{"a": 1,}', ["m"], "k", 1, C)).toEqual({ ok: false, reason: "it is not valid JSON" });
    expect(addJsonMember('{"a": 1 /* x', ["m"], "k", 1, C)).toEqual({ ok: false, reason: "it is not valid JSON" });
    expect(addJsonMember("{ // x\n}", ["m"], "k", 1)).toEqual({ ok: false, reason: "it is not plain JSON" });
  });
});

/**
 * Print a Quint ITF trace of spec/update-lifecycle.qnt as plain steps: the
 * action, the time, and only the fields that changed.
 *
 *   quint run ... --out-itf /tmp/trace.itf.json
 *   bun spec/show-trace.ts /tmp/trace.itf.json
 */
import { readFileSync } from "node:fs";

type Json = unknown;

function decode(value: Json): Json {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const o = value as Record<string, Json>;
    if ("#bigint" in o) return Number(o["#bigint"]);
    if ("#map" in o) return Object.fromEntries((o["#map"] as [Json, Json][]).map(([k, v]) => [String(decode(k)), decode(v)]));
    if ("#set" in o) return (o["#set"] as Json[]).map(decode);
    if ("#tup" in o) return (o["#tup"] as Json[]).map(decode);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

const path = process.argv[2];
if (!path) {
  console.error("usage: bun spec/show-trace.ts <trace.itf.json>");
  process.exit(2);
}
const itf = JSON.parse(readFileSync(path, "utf-8")) as { vars: string[]; states: Record<string, Json>[] };
const stateVar = itf.vars.find((v) => v === "s" || v.endsWith("::s")) ?? "s";
const GHOST = new Set(["minCheckGap", "lastAutoCheck", "lastNotesReq", "minNotesGap", "tickAfterPersonEnd", "act", "now"]);
let previous: Record<string, Json> = {};
itf.states.forEach((state, index) => {
  const s = decode(state[stateVar]) as Record<string, Json>;
  const changed = Object.keys(s)
    .filter((k) => !GHOST.has(k) && JSON.stringify(s[k]) !== JSON.stringify(previous[k]))
    .map((k) => `${k}=${JSON.stringify(s[k])}`);
  console.log(`${String(index).padStart(2)}. t=${String(s.now).padStart(5)}m  ${s.act}${index === 0 ? "" : `\n      ${changed.join("\n      ")}`}`);
  previous = s;
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDiagram } from "@plannotator/diagrams";

const ref = { kind: "file", title: "Ledger", path: "src/ledger.ts", start: 4, end: 8 };
const spec = {
  id: "orders", title: "Orders",
  columns: [{ id: "a", title: "Writer", sections: [{ id: "journal", title: "Journal", refs: [ref], content: "Append receipt" }] }, { id: "b", title: "Ledger" }],
  groups: [{id:"storage",label:"Storage",members:["b"]}],
  links: [{ id: "append", from: "a", to: "b" }, { id: "retry", from: "a", to: "b", lane: "bottom" }]
};
test("stable part identities survive renames and parallel connection reordering", async () => {
  const before = await renderDiagram(spec);
  const after = await renderDiagram({...spec, columns: [{...spec.columns[0], title:"Renamed"},spec.columns[1]], links: [...spec.links].reverse()});
  for (const part of before.parts) {
    assert.ok(after.parts.some(p => p.id === part.id && p.kind === part.kind));
    assert.ok(part.x >= 0 && part.y >= 0 && part.x+part.w <= before.width && part.y+part.h <= before.height);
  }
  const section = before.parts.find(p => p.id === "journal");
  const panel = before.parts.find(p => p.id === "a");
  assert.ok(section.x > panel.x && section.y > panel.y);
  assert.deepEqual(section.refs,[ref]);
  assert.ok(before.parts.find(p=>p.id==="retry").points.length > 2);
  assert.deepEqual(before.parts.map(p=>p.kind).sort(),["group","link","link","panel","panel","section"]);
});
test("review metadata names invalid fields and duplicate authored identities", async () => {
  await assert.rejects(renderDiagram({...spec,links:[spec.links[0],spec.links[0]]}), /links\[1\].id: duplicate link id/);
  await assert.rejects(renderDiagram({...spec,columns:[{title:"Start",refs:[{...ref,path:"../ledger.ts"}]}]}), /refs\[0\].path/);
});

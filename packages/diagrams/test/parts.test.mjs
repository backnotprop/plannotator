import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDiagram } from "@plannotator/diagrams";

const ref = { kind: "file", title: "Ledger", path: "src/ledger.ts", start: 4, end: 8 };
const spec = {
  id: "orders", title: "Orders",
  columns: [{ id: "a", title: "Writer", sections: [{ id: "journal", title: "Journal", refs: [ref], content: "Append receipt" }] }, { id: "b", title: "Ledger" }],
  groups: [{id:"storage",label:"Storage",members:["b"]}],
  links: [{ id: "append", from: "a", to: "b", label: "record" }, { id: "retry", from: "a", to: "b", lane: "bottom" }]
};
test("stable part identities survive renames and parallel connection reordering", async () => {
  const before = await renderDiagram(spec);
  const after = await renderDiagram({...spec, columns: [{...spec.columns[0], title:"Renamed"},spec.columns[1]], links: [...spec.links].reverse()});
  for (const part of before.parts) {
    assert.ok(after.parts.some(p => p.id === part.id && p.kind === part.kind));
    assert.ok(part.x >= 0 && part.y >= 0 && part.x+part.w <= before.width && part.y+part.h <= before.height);
  }
  const arrow = before.parts.find(p => p.id === "append");
  assert.ok(arrow.labelBox.y >= arrow.y && arrow.labelBox.y+arrow.labelBox.h <= arrow.y+arrow.h);
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

test("straight arrow targets enclose their tip and both wings in either direction", async () => {
  for (const [x,y,start,end] of [[400,0,"right","left"],[0,300,"bottom","top"]]) {
    const result=await renderDiagram({
      title:"Route", panels:[{id:"a",title:"A",x:0,y:0},{id:"b",title:"B",x,y}],
      links:[{from:"a",to:"b",start,end}]
    });
    const arrow=result.parts.find(p=>p.kind==="link");
    assert.ok(arrow.w>=7 && arrow.h>=7);
    for (const [x,y] of arrow.points) {
      assert.ok(x>=arrow.x-1e-9 && x<=arrow.x+arrow.w+1e-9);
      assert.ok(y>=arrow.y-1e-9 && y<=arrow.y+arrow.h+1e-9);
    }
  }
});

test("legacy blank part names get collision-free review IDs and links use those IDs", async () => {
  const original={title:"",columns:[{title:""},{id:"panel#1",title:"Named"}],
    groups:[{label:"",members:[""]},{label:"Group",id:"group#1",members:["panel#1"]}],
    links:[{from:"",to:"panel#1"}]};
  const {parts}=await renderDiagram(original);
  const panel=parts.find(p=>p.kind==="panel" && p.title==="");
  const group=parts.find(p=>p.kind==="group" && p.title==="");
  assert.equal(panel.id,"panel#2");
  assert.equal(group.id,"group#2");
  assert.equal(parts.find(p=>p.kind==="link").from,panel.id);
  assert.deepEqual(parts,(await renderDiagram(original)).parts);
});

test("a custom link kind preserves default link and planned labels", async () => {
  const result=await renderDiagram({title:"Messages",columns:[{title:"A"},{title:"B"}],
    theme:{link_labels:{async:"Queued delivery"}},links:[
      {from:"A",to:"B"}, {from:"A",to:"B",kind:"planned"}, {from:"A",to:"B",kind:"async"}]});
  assert.deepEqual(result.links.map(l=>l.kind),["flow","planned","async"]);
  assert.match(result.svg,/Queued delivery/);
});

test("a host editing result references leaves the editable spec alone", async () => {
  const {parts}=await renderDiagram(spec);
  const section=parts.find(p=>p.kind==="section");
  section.refs[0].path="changed.ts";
  section.refs.pop();
  assert.equal(spec.columns[0].sections[0].refs[0].path,"src/ledger.ts");
});

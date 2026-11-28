import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDiagram } from "@plannotator/diagrams";
import { prepare } from "../dist/spec.js";

function graphDiagram(at, panel = {}) {
    const graph = { nodes: { a: "A", b: "B" }, at, links: [] };
    const section = { id: "steps", title: "Steps", content: { row: [{ graph }] } };
    return { title: "Process", columns: [[{ title: "Work", ...panel, sections: [section] }]] };
}

test("mini-graph dimensions follow the node span on each axis and name the nested graph", async () => {
    const origin = await renderDiagram(graphDiagram({ a: [0, 0], b: [1, 1] }));
    const translated = await renderDiagram(graphDiagram({ a: [-100, 100], b: [-99, 101] }));
    assert.deepEqual([translated.width, translated.height], [origin.width, origin.height]);
    for (const at of [{ a: [-31, 0], b: [31, 0] }, { a: [0, -71], b: [0, 71] }]) {
        await assert.rejects(renderDiagram(graphDiagram(at)),
            /columns\[0\]\[0\]\.sections\[0\]\.content\.row\[0\]\.graph:.*8192 pixels/);
    }
});

test("mini-graph limits include the final width allocated by a sibling panel", async () => {
    const diagram = graphDiagram({ a: [0, 0], b: [1, 0] });
    diagram.theme = { pad: 0 };
    const sibling = { title: "Summary", width: 8192 };
    diagram.columns[0].push(sibling);
    await renderDiagram(diagram);
    sibling.width += 1;
    await assert.rejects(renderDiagram(diagram), /sections\[0\]\.content\.row\[0\]\.graph:.*8192 pixels/);
});

// Exercise the inclusive count limits in preparation, without routing a large diagram.
test("panels, nested addressable sections, links and groups share the part limit", () => {
    const sections = Array.from({ length: 508 }, (_, i) => ({ id: String(i), title: "Detail", content: "Text" }));
    const diagram = {
        title: "Parts", columns: [{ title: "A", sections: [{ row: sections }] }, { title: "B" }],
        links: [{ from: "A", to: "B" }], groups: [{ label: "Workers", members: ["A"] }]
    };
    prepare(diagram);
    diagram.groups.push({ label: "Queue", members: ["B"] });
    assert.throws(() => prepare(diagram), /groups\[1\]:.*512 addressable parts/);
});

test("nonempty link labels share a limit across panels and mini-graphs", () => {
    const diagram = graphDiagram({ a: [0, 0], b: [1, 0] });
    const graph = diagram.columns[0][0].sections[0].content.row[0].graph;
    graph.links = Array.from({ length: 127 }, () => ["a", "b", "inner"]);
    diagram.links = [{ from: "Work", to: "Work", label: "outer" }, { from: "Work", to: "Work", label: "" }];
    prepare(diagram);
    diagram.links[1].label = "another";
    assert.throws(() => prepare(diagram), /links\[1\]\.label:.*128 labelled links/);

    graph.links.push(["a", "b", "inner"], ["a", "b", "inner"]);
    assert.throws(() => prepare(diagram), /graph\.links\[128\]\[2\]:.*128 labelled links/);
});

test("all mini-graphs share a single node and link budget", () => {
    const diagram = graphDiagram({ a: [0, 0], b: [1, 0] });
    const row = diagram.columns[0][0].sections[0].content.row;
    const graph = row[0].graph;
    graph.links = Array.from({ length: 508 }, () => ["a", "b"]);
    const other = { nodes: { c: "C", d: "D" }, at: { c: [0, 0], d: [1, 0] }, links: [] };
    row.push({ graph: other });
    prepare(diagram);
    other.links.push(["c", "d"]);
    assert.throws(() => prepare(diagram), /row\[1\]\.graph\.links:.*512 mini-graph nodes and links/);
    other.links.pop();
    other.nodes.e = "E";
    other.at.e = [2, 0];
    assert.throws(() => prepare(diagram), /row\[1\]\.graph\.nodes:.*512 mini-graph nodes and links/);
});

test("the diagnostic list retains the first hundred messages and one overflow notice", async () => {
    const { Painter } = await import("../dist/paint.js");
    const painter = new Painter();
    for (let i = 1; i <= 100; ++i) painter.report("Layout problem " + i);
    assert.equal(painter.getProblems().length, 100);
    painter.report("Another problem");
    painter.report("One more problem");
    assert.equal(painter.getProblems().length, 101);
    assert.equal(painter.getProblems()[99], "Layout problem 100");
    assert.match(painter.getProblems()[100], /More layout problems remain/);
});

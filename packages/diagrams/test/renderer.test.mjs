import assert from "node:assert/strict";
import {once} from "node:events";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {Worker} from "node:worker_threads";
import {renderDiagram} from "@plannotator/diagrams";
import {gold, mesh} from "./cases.mjs";

const simple = {title: "A handoff", columns: [{title: "Intake"}, {title: "Ledger"}]};
const flow = {from: "Intake", to: "Ledger", label: "receipt"};
const cloud = JSON.parse(readFileSync(new URL("./fixtures/gke-eks.json", import.meta.url), "utf8"));

test("the cloud diagram embeds both logos and preserves the request path in the SVG", async () => {
    const result = await renderDiagram(cloud);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.links.map(l=>[l.from,l.to]), [["gke","ha-vpn"],["ha-vpn","aws-vpn"],["aws-vpn","eks"]]);
    assert.equal((result.svg.match(/<image /g)??[]).length, 2);
    for (const alt of ["Google Cloud logo", "Amazon Web Services logo"]) {
        assert.ok(result.description.includes(alt));
        assert.ok(result.svg.includes("<title>"+alt+"</title></image>"));
    }
    assert.equal(result.svg, readFileSync(new URL("./fixtures/gke-eks.svg",import.meta.url), "utf8"));
});

test("image sections reserve space, preserve aspect ratio and escape alt text", async () => {
    const src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AH//Z";
    const image={src,alt:"Node <A> & peers",width:400,height:150};
    const spec={title:"Images",columns:[{title:"Cluster",sections:[{image}]}]};
    const result=await renderDiagram(spec);
    assert.deepEqual(result.problems, []);
    assert.match(result.svg, /width="400" height="150" preserveAspectRatio="xMidYMid meet"/);
    assert.ok(result.svg.includes('href="'+src+'"><title>Node &lt;A&gt; &amp; peers</title>'));
    assert.ok(result.description.includes(image.alt));
    image.width+=120;
    image.height+=40;
    const larger=await renderDiagram(spec);
    assert.equal(larger.panels[0].w-result.panels[0].w,120);
    assert.equal(larger.panels[0].h-result.panels[0].h,40);
    for(const change of [{src:"/icon.png"}, {src:"data:image/svg+xml;base64,PHN2Zz4="},
        {src:"data:image/jpeg;base64,iVBORw0KGgo="}, {width:0}, {height:NaN}, {alt:5}]) {
        spec.columns[0].sections=[{image:{...image,...change}}];
        const key=Object.keys(change)[0];
        await assert.rejects(renderDiagram(spec), error=>
            error instanceof TypeError && error.message.startsWith("diagram.columns[0].sections[0].image."+key+":"));
    }
});

test("the package renders every named panel and directed link without changing the source", async () => {
    for (const spec of Object.values(gold)) {
        const before = structuredClone(spec);
        const result = await renderDiagram(spec);
        assert.deepEqual(result.problems, []);
        assert.deepEqual(spec, before);
        const panels = spec.panels ?? spec.columns?.flat() ?? [...spec.ring, ...(spec.center ?? [])];
        assert.deepEqual(result.panels.map(p => p.id), panels.map(p => p.id ?? p.title));
        assert.deepEqual(result.links.map(l => [l.from, l.to, l.kind, l.label]),
            spec.links.map(l => [l.from, l.to, l.kind ?? "flow", l.label ?? ""]));
        assert.equal((result.svg.match(/<g data-panel=/g) ?? []).length, panels.length);
        assert.equal((result.svg.match(/<g data-from=/g) ?? []).length, result.links.length);
        assert.doesNotMatch(result.svg, /<text\b|NaN|Infinity/);
        assert.deepEqual(await renderDiagram(spec), result);
    }
});

test("overrides participate in measurement, and group membership affects the report", async () => {
    const columns = [{id: "source", title: "Publish requested changes", tiles: ["Shard"]}, {title: "Confirm"}];
    const spec = {title: "Index", columns, groups: [{label: "Writers", members: ["source"]}]};
    const original = await renderDiagram(spec);
    const edited = await renderDiagram({...spec, statuses: {"Publish requested changes": "trial", source: "building", Shard: "planned"}});
    assert.match(edited.description, /Publish requested changes \[building\]/);
    assert.match(edited.description, /Shard \(planned\)/);
    assert.ok(edited.panels[0].w > original.panels[0].w);
    assert.deepEqual(edited.problems, []);
    const grouped = await renderDiagram({...spec, groups: [{label: "Writers", members: ["source", "Confirm"]}]});
    assert.match(grouped.description, /Writers contains Publish requested changes, Confirm/);
    assert.notEqual(grouped.svg, original.svg);
});

test("reports layout conflicts with their affected parts, and clears them after repair", async () => {
    const broken = structuredClone(gold.catalogue);
    delete broken.links.at(-1).lane;
    const problems = (await renderDiagram(broken)).problems;
    for (const id of ["review", "journal"])
        assert.ok(problems.some(p => p.includes("line 'desk' -> 'portal' crosses '" + id + "'")));
    assert.ok(problems.some(p => p.includes("'planned preview'") && p.includes("sits on 'review'")));
    broken.links.at(-1).lane = "top";
    assert.deepEqual((await renderDiagram(broken)).problems, []);

    const placed = {title: "Verification", panels: [
        {title: "A", x: 0, y: 0}, {title: "B", x: 10, y: 0}
    ], groups: [{label: "Owners", members: ["A"]}]};
    const overlap = (await renderDiagram(placed)).problems;
    assert.ok(overlap.some(p => p.includes("'A' and 'B' overlap")));
    assert.ok(overlap.some(p => p.includes("group 'Owners' overlaps 'B'")));
    const backward = await renderDiagram({...simple, links: [{...flow, start: "left", end: "right"}]});
    assert.ok(backward.problems.some(p => p.includes("facing away")));
    const narrow = await renderDiagram({...simple, gap: 2});
    assert.ok(narrow.problems.some(p => p.includes("px apart")));
});

test("preserves duplicate edges and draws a labelled self-loop", async () => {
    const again = {from: "Ledger", to: "Ledger", label: "retry"};
    const spec = {...simple, links: [flow, {...flow, kind: "planned"}, again]};
    const result = await renderDiagram(spec);
    assert.equal(result.links.length, 3);
    assert.equal((result.svg.match(/data-from="Intake" data-to="Ledger"/g) ?? []).length, 2);
    assert.match(result.svg, /data-from="Ledger" data-to="Ledger"[^>]*><path d="[^"]*Q/);
    assert.match(result.description, /Ledger -> Ledger labeled "retry"/);
});

test("reports the path for invalid or silently ignored input", async () => {
    const bad = [
        [{...simple, ring: simple.columns}, /exactly one layout/],
        [{title: "Empty", columns: [[]]}, /columns\[0\]/],
        [{...simple, columns: [{title: "A", tiles: [{label: "B", state: "trial"}]}]}, /tiles\[0\].*unknown key state/],
        [{...simple, columns: [{title: "A", label: "Lost section"}]}, /columns\[0\]\[0\].*require tiles/],
        [{...simple, columns: [{title: "A", sections: [{text: undefined}]}]}, /sections\[0\].*missing text/],
        [{...simple, columns: [{title: "A"}, {title: "A"}]}, /duplicate panel id A/],
        [{...simple, links: [{...flow, to: "Removed"}]}, /links\[0\].to.*Removed/],
        [{...simple, links: [{...flow, lane: "top", via_y: 12}]}, /links\[0\].*one lane/],
        [{...simple, statuses: {unknown: "trial"}}, /statuses.unknown/],
        [{...simple, groups: [{label: "G", members: ["Removed"]}]}, /groups\[0\].members/],
        [{...simple, theme: {ink: "red"}}, /theme.ink/],
        [{...simple, title: "bad\ud800"}, /diagram.title/],
        [{...simple, columns: [{title: "A", sections: [{graph: {nodes: {a: "A"}, links: [["a","b"]], at: {a:[0,0]}}}]}]}, /graph.links\[0\].*unknown node b/],
    ];
    for (const [input, expected] of bad) await assert.rejects(renderDiagram(input), expected);
});

test("preserves new labels and edges in the description and paints escaped text", async () => {
    const graph = {nodes: {a:"Draft", b:"Send", c:"Isolated"}, at: {a:[0,0], b:[2,0], c:[1,2]}, links:[["a","b","approve"]]};
    const result = await renderDiagram({title: "Verify <A&B>", columns: [{title: "Review", sections: [
        {row: [{card: {title: "Receipt", intro: "Must acknowledge", rows: [["Owner", "Desk"]]}}, {graph}]}
    ]}]});
    assert.deepEqual(result.problems, []);
    for (const fact of ["Isolated", 'Draft -> Send labeled "approve"', "Must acknowledge", "Owner: Desk"])
        assert.ok(result.description.includes(fact));
    assert.match(result.svg, /<title>Verify &lt;A&amp;B&gt;<\/title>/);
});

test("all four extended faces load, with deterministic output and visible missing-glyph diagnostics", async () => {
    const unicode = {title: "Ω", subtitle: "Ž", columns: [{title: "Ж"}, {title: "Ledger"}],
        links: [{from:"Ж", to:"Ledger", label:"Ł"}]};
    const [first, concurrent] = await Promise.all([renderDiagram(unicode), renderDiagram(unicode)]);
    assert.deepEqual(first, concurrent);
    assert.deepEqual(first.problems, []);
    for (const label of ["Ω", "Ž", "Ж", "Ł"]) assert.ok(first.svg.includes("<title>" + label + "</title>"));
    const missing = await renderDiagram({...unicode, title: "漢"});
    assert.ok(missing.problems.some(p => p.includes("U+6F22")));
    assert.ok(missing.svg.includes("<title>漢</title>"));
    assert.deepEqual(await renderDiagram(unicode), first);
    const sparse = await renderDiagram({title: "", columns: [{title:""}]});
    assert.equal(sparse.minText, null);
});

test("64 panels and 112 links render cleanly in a fresh DOM-free worker", async () => {
    const spec = mesh(8);
    const adapter = new URL("../dist/worker.js", import.meta.url);
    // Bridge Node's message port to the two dedicated-worker globals used by the demo.
    const source = `import {parentPort} from 'node:worker_threads';
        globalThis.self = {postMessage: value => parentPort.postMessage(value)};
        await import(${JSON.stringify(adapter.href)});
        parentPort.on('message', data => self.onmessage({data}));`;
    const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(source)));
    async function request(id, spec) {
        worker.postMessage({id, spec});
        const [response] = await once(worker, "message");
        assert.equal(response.id, id);
        return response;
    }
    try {
        const {result} = await request(1, spec);
        assert.equal(result.panels.length, 64);
        assert.equal(result.links.length, 112);
        assert.deepEqual(result.problems, []);
        assert.deepEqual(result, await renderDiagram(spec));
        assert.match((await request(2, {})).error, /missing title/);
        const corrected = {...simple, title: "Ω ledger"};
        assert.deepEqual((await request(3, corrected)).result, await renderDiagram(corrected));
        assert.deepEqual((await request(4, cloud)).result, await renderDiagram(cloud));
    } finally {
        await worker.terminate();
    }
});

---
name: diagram
description: Create or revise an editable Plannotator diagram (.diagram.json) of an architecture, process, or request path, and render it to SVG. Use when the person invokes /diagram or asks for a Plannotator diagram.
disable-model-invocation: true
---

# Create a Plannotator diagram

Start with the question the drawing should answer. Read the relevant code, files or thread before naming systems or dependencies. Pick a concrete path to follow, label what moves across each connection, and include a failure or alternate path when it matters to the question.

## Write the source

Use the person's requested path. For a new drawing with Plannotator installed, run `plannotator diagram new checkout` with a short name for the subject. It creates a file in the project's Plannotator data folder and prints its path. To start in a specific folder, use `plannotator diagram new ./checkout.diagram.json`. With only the npm renderer, write the UTF-8 JSON file in the working folder. For a revision, edit the existing file and preserve the diagram and part IDs so comments can still find their targets.

For example, a payment capture could begin with this source:

```json
{
  "id": "payment-capture",
  "title": "How a payment is captured",
  "columns": [
    {"id": "checkout", "title": "Checkout", "tiles": ["Confirm order"]},
    {"id": "payments", "title": "Payments", "tiles": ["Capture funds"]}
  ],
  "gap": 120,
  "links": [
    {"id": "capture", "from": "checkout", "to": "payments", "label": "capture"}
  ]
}
```

Use `columns` for a flow. A column can be an array of panels stacked vertically, so parallel branches can have their own panels. Use `ring` for a cycle, or `panels` with numeric `x` and `y` for an explicitly positioned layout. Choose one layout per diagram. Add a boundary with `groups`, for example `{"id":"billing","label":"Billing","members":["payments"]}`. Give each panel, connection and boundary a unique durable ID, including separate IDs for parallel connections between the same endpoints.

When a source will help someone understand a part, add a `refs` array on that panel, connection, boundary or section. A file ref uses `{"kind":"file","title":"Capture handler","path":"src/payments.ts","start":12,"end":24}`. Check the path and lines against the project first. Omit the range when the whole file is relevant. A link ref uses `{"kind":"link","title":"Payment flow","url":"https://example.org/payments"}`. Replace example values with sources you actually inspected. To make a section addressable, use `{"id":"capture-handler","title":"Capture handler","content":{"text":"Captures an authorized payment."}}` inside the panel's `sections`. Keep long explanations and code in the linked material.

## Render and hand it over

Run the renderer on the saved JSON. Substitute the path you wrote or the path the starter printed.

```sh
plannotator diagram render checkout.diagram.json -o checkout.svg
```

With the standalone npm package `@plannotator/diagrams` installed, use its executable instead:

```sh
plannotator-diagrams render checkout.diagram.json -o checkout.svg
```

For a project-local npm install, run `npm exec -- plannotator-diagrams render checkout.diagram.json -o checkout.svg` from that project. If the renderer reports a bad field, fix the named JSON path. For a label or line that crosses another panel, increase the gap or route the connection above or below with `"lane":"top"` or `"lane":"bottom"`. Render again until the command succeeds and check that the SVG answers the original question.

Return the editable `.diagram.json` and its rendered SVG. In a Plannotator Inbox thread, attach the JSON to a reply to the triggering message so the thread displays the reviewable artifact. For a local Plannotator review, run `plannotator annotate <path-to-file.diagram.json>` and act on the returned comments.

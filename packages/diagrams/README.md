# @plannotator/diagrams

Render an editable architecture diagram as SVG in Node, a browser or a module worker. Text is measured from bundled Inter outlines. The renderer returns named layout problems and geometry that a host can use to select parts, open references and anchor comments.

```js
import { renderDiagram } from "@plannotator/diagrams";

const spec = {
  id: "checkout",
  title: "Checkout",
  columns: [
    { id: "checkout-api", title: "Checkout API", tiles: ["Validate order"] },
    { id: "ledger", title: "Ledger", tiles: ["Record payment"] }
  ],
  links: [{ id: "record", from: "checkout-api", to: "ledger", label: "payment" }]
};
const { svg, width, height, description, parts, problems } = await renderDiagram(spec);
```

Save the JSON as `checkout.diagram.json`. With the package installed, run
`plannotator-diagrams render checkout.diagram.json -o checkout.svg`.
The CLI writes the SVG and exits with status 1 when the layout has problems. Invalid input reports the offending field. The optional `@plannotator/diagrams/worker` module handles messages of the form `{id, spec}` and replies with `{id, result}` or `{id, error}`.

## Reviewable parts

A diagram can use columns, a ring or explicitly positioned panels. Supply a persistent diagram `id` and preserve each authored part ID across edits. Panels, links and groups accept `id` and `refs`. Wrap an addressable section as `{id, title, content, refs}`, where `content` is any supported section. Keep IDs unique within each kind. An explicit ID on each parallel connection keeps a comment with its connection after a reorder. Legacy files without IDs still render. Panel and group IDs fall back to titles and labels, and unnamed links use endpoint IDs and an occurrence number. A blank legacy label gets a deterministic review ID that avoids all authored IDs.

Each entry in `parts` includes its kind, ID, title, references and bounds in the outer SVG coordinate system. Links also include their endpoints and sampled route. References contain display metadata. A link reference takes `{kind: "link", title, url}`. A file reference takes `{kind: "file", title, path, start?, end?, url?}`. Use a project-relative path and one-based line numbers. The host resolves references and owns annotations and AI conversations. Rendering performs no network requests for fonts or references.

## Input limits

A diagram supports up to 512 addressable parts in total. Each panel, named section, group and top-level link counts once, including parts whose IDs the renderer supplies. Up to 128 top-level and mini-graph links combined can carry a nonempty label. Across all mini-graphs, each node and each link counts toward a separate total of 512. The renderer returns the first 100 layout problems and adds a reminder to render again when more remain.

Each mini-graph grid can measure up to 8,192 pixels on each axis, including node labels, padding and any extra width its panel or column gives it. Node coordinates are relative, so the spacing between nodes determines the grid extent. A limit error names the part, label or graph field that exceeds the limit.

## Development and credits

Run `npm test` in this directory. `npm pack` builds the package, including type declarations, the module worker and the four faces used for extended glyphs. The checked-in font geometry is the offline build input. To regenerate it, install Python fontTools and run `python3 scripts/generate-fonts.py /path/to/open-diagram` against upstream revision `387b2c09`. This extracts Inter 4.1 glyphs, advances, kerning and the default theme.

The measured layout and typography are ported from Luke Deasy’s [open-diagram](https://github.com/lukendeasy/open-diagram). Single-file applications can bundle the full notices with `import notices from "@plannotator/diagrams/notices"`. Its MIT notice is in [LICENSE](LICENSE). Inter font data is distributed under the [SIL Open Font License](fonts/OFL.txt).

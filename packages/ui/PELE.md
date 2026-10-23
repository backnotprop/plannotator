# Experimental Pele renderer

In Plannotator, open **Settings → Display → Diagram renderer** and choose **Pele (experimental)**. Existing Mermaid fences (for example, ```` ```mermaid ````) use Pele when selected; no new fence language or server setting is required. The selection is a browser cookie preference and returns to Mermaid when unset or invalid. The rendering happens locally in the browser and works offline after the app has loaded.

Pele's appearance and layout can differ from Mermaid. HTML labels are not supported. This selection affects Mermaid-syntax fences only; Graphviz fences continue using Graphviz. Diagram Shadow in Settings applies to Mermaid only and is disabled when Pele is selected.

Pele is pinned to 1.3.0. Flowchart nodes, edges and subgraphs support individual comments; parallel edges with identical endpoints cannot be distinguished safely. Other diagram types support whole-diagram comments only. Existing part comments that cannot be restored remain in the annotation panel as unanchored rather than being discarded.

Pele is experimental. Do not assume syntax or visual parity beyond the diagrams Pele currently supports. See the [Pele API](https://pele.run/api), [theming](https://pele.run/theming), [security](https://pele.run/security), and [compatibility](https://pele.run/compatibility) references for its current renderer behavior.

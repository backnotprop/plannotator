# Pele: a second engine for Mermaid fences (not on)

[Pele](https://pele.run) (MIT, pinned 1.3.0) draws Mermaid syntax without Mermaid. It is in the package but **draws nothing today**: every Mermaid fence is drawn by Mermaid, as before. There is no setting and nothing a person can see.

One constant decides: `DIAGRAM_ENGINE_MODE` in `utils/diagram-engine.ts`.

- `'mermaid'` (shipped): Mermaid draws every fence; Pele is never imported.
- `'pele-where-safe'`: Pele draws a fence unless `diagramEngineFor` keeps it on Mermaid: the fence has a `$$` math label, or it is a type where Plannotator offers comments on single parts under Mermaid and not under Pele (none today: `PELE_CAPABILITIES` gives Pele part comments on every type Mermaid has them). A fence Pele cannot draw (its type is unsupported, or it throws) is drawn by Mermaid.
- `'pele'`: Pele draws every fence; its errors are shown.

What Pele keeps and loses, per type and per feature, is data in `PELE_CAPABILITIES` and `DIAGRAM_FEATURES` (same file), checked through the real `DiagramBlock` in `components/DiagramBlock.engine.test.tsx`. In short: part comments under Pele work on flowchart, sequence, state, class, ER and requirement diagrams, the six types Mermaid has them on (`utils/diagram-anchor-pele.ts`); Pele prints math labels as raw text, keeps no HTML in labels beyond bold, italic and line breaks, ignores an author's `%%{init}%%` theme settings, draws no node shadow (the Diagram Shadow setting does nothing for it) and has 8 series colours. Comments, the popout, the Source pane, export, print and Ask AI work the same with either engine.

Part comments: for the same source, a click on a part makes the same anchor (kind, id or ends, label, source line) under either engine, so a comment made under one restores on the same part under the other. Checked per type against Mermaid svgs captured in Chromium (`test-setup/fixtures/diagrams/2x-*.svg`, each with its `.mmd` source) in `utils/diagramAnchorPele.test.ts`, and through the real `DiagramBlock` in `components/DiagramBlock.engine.test.tsx`. Per type:

- sequence: an actor by name (a stick-figure `actor` too), a message `msg-<n>` with its ends read from where its line starts and stops, a note `note-<n>`, a frame `frame-<n>`, numbered as both engines draw them (a frame nested in another first).
- state: a state or composite state by id (as a node, as Mermaid does), a transition `edge<n>`, a note; no start or end pseudo-state.
- class: a class by name (its label is the name, not an `«interface»` annotation), a relation by its ends; a note is not a part.
- ER: an entity by name, a relationship by its ends.
- requirement: a requirement or element by name (its label is the name, not the `<<Element>>` type line), a relationship by `{a}-{b}`, its label `<<satisfies>>` under both engines.

Two relations with the same ends (`User --> Order` twice) restore by their label. Two that are the same in ends and label cannot be told apart after a reload: Pele offers neither (a click there is a whole-diagram comment), as it does for a repeated flowchart edge. Labels Mermaid loses are not copied: when one message wraps over two lines Mermaid labels every message `''`, and a wrapped note by its first line; Pele keeps the words, and the restore, which goes by the ordinal when a label does not match, finds the same part either way.

Colours: `utils/peleTheme.ts` hands Pele the colours the Mermaid mapping already guards (`buildMermaidThemeVariables`) and re-fits the few pairs Pele draws differently; `utils/peleTheme.test.ts` checks every pair in every palette and mode. Labels wrap at `MERMAID_LABEL_WRAP_WIDTH` and use the app's fonts.

Loading: through `pele/lazy`, so Pele's core and each diagram type are their own chunks, fetched on the first fence Pele draws.

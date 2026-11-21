# Pele: a second engine for Mermaid fences (not on)

[Pele](https://pele.run) (MIT, pinned 1.3.0) draws Mermaid syntax without Mermaid. It is in the package but **draws nothing today**: every Mermaid fence is drawn by Mermaid, as before. There is no setting and nothing a person can see.

One constant decides: `DIAGRAM_ENGINE_MODE` in `utils/diagram-engine.ts`.

- `'mermaid'` (shipped): Mermaid draws every fence; Pele is never imported.
- `'pele-where-safe'`: Pele draws a fence unless `diagramEngineFor` keeps it on Mermaid: the fence has a `$$` math label, or it is a type where Plannotator offers comments on single parts under Mermaid and not under Pele (sequence, state, class, ER, requirement). A fence Pele cannot draw (its type is unsupported, or it throws) is drawn by Mermaid.
- `'pele'`: Pele draws every fence; its errors are shown.

What Pele keeps and loses, per type and per feature, is data in `PELE_CAPABILITIES` and `DIAGRAM_FEATURES` (same file), checked through the real `DiagramBlock` in `components/DiagramBlock.engine.test.tsx`. In short: part comments under Pele work on flowcharts only (`utils/diagram-anchor-pele.ts`; Pele's svg gives the other types' parts stable `data-id`s, so more finders are possible); Pele prints math labels as raw text, keeps no HTML in labels beyond bold, italic and line breaks, ignores an author's `%%{init}%%` theme settings, draws no node shadow (the Diagram Shadow setting does nothing for it) and has 8 series colours. Comments, the popout, the Source pane, export, print and Ask AI work the same with either engine. Comments anchored under Mermaid restore under Pele on flowcharts.

Colours: `utils/peleTheme.ts` hands Pele the colours the Mermaid mapping already guards (`buildMermaidThemeVariables`) and re-fits the few pairs Pele draws differently; `utils/peleTheme.test.ts` checks every pair in every palette and mode. Labels wrap at `MERMAID_LABEL_WRAP_WIDTH` and use the app's fonts.

Loading: through `pele/lazy`, so Pele's core and each diagram type are their own chunks, fetched on the first fence Pele draws.

/**
 * Eager Mermaid registration: imports the runtime statically, initializes it
 * at module evaluation (exactly where the old module-scope
 * `mermaid.initialize` ran) and fills the slot in `./mermaid`.
 *
 * Plannotator does NOT import this module any more. Through @plannotator/ui
 * 0.39.0 `packages/editor/App.tsx` imported it by policy so Mermaid stayed in
 * the plan editor's entry chunk; with Mermaid 12 (ELK layout by default) the
 * runtime is about 1.8 MB larger and the plan editor loads it on the first
 * diagram instead, through the lazy path in `./mermaid`. The module is kept
 * for hosts that want the runtime registered and initialized before the
 * first render (a host that gates first paint on it, or that would rather
 * not have a separate chunk that can fail on its own):
 *
 *   import '@plannotator/ui/utils/mermaid-eager';
 *
 * A host that does not import it gets the lazy path in `./mermaid`.
 *
 * The source tag passed below doubles as a build marker: the literal only
 * reaches a bundle when this module is evaluated in it, which is how
 * tests/entry-assets.test.ts proves on the built HTML that neither of
 * Plannotator's bundles registers the runtime eagerly (the runtime itself is
 * still inlined in a single-file build through the loader's import(), so a
 * Mermaid diagram id cannot prove or disprove registration).
 */
import mermaid from 'mermaid';
import { MERMAID_CONFIG, setMermaidRuntime } from './mermaid';

mermaid.initialize(MERMAID_CONFIG);
setMermaidRuntime(mermaid, 'plannotator-mermaid-eager');

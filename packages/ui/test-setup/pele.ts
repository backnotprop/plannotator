/**
 * Pele in tests. `true` puts Pele's real library and the engine switch in
 * place, as a build with Pele in it has them, whatever the build's own
 * `PELE_IN_BUILD`; `false` gives both back to the build's own state (as
 * shipped, `DIAGRAM_ENGINE_MODE = 'pele-where-safe'`, that is Pele in too; a
 * build under `'mermaid'` leaves Pele out and its loader refuses).
 */
import { __setPeleInBuildForTests } from '../utils/diagram-render';
import { __setPeleRuntimeLoaderForTests, peleRuntimeFrom, type PeleRuntime } from '../utils/pele';

/** Pele's real library, through `pele/lazy` as a build with Pele in it loads it. */
export const loadRealPele = (): Promise<PeleRuntime> => import('pele/lazy').then(peleRuntimeFrom);

/** `true`: the real library and the engine switch, as a build with Pele in it. `false`: the build's own state. */
export function setPeleInBuildForTests(on: boolean): void {
  __setPeleRuntimeLoaderForTests(on ? loadRealPele : undefined);
  __setPeleInBuildForTests(on ? true : undefined);
}

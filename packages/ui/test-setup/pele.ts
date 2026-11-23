/**
 * Pele in tests. The shipped switch (`DIAGRAM_ENGINE_MODE = 'mermaid'`)
 * leaves Pele out of every build (`PELE_IN_BUILD` in `utils/pele.ts`): its
 * loader refuses and Mermaid fences never reach the engine switch. A test
 * that draws with Pele puts both back as a build with Pele in it has them,
 * and restores the shipped state when it is done.
 */
import { __setPeleInBuildForTests } from '../utils/diagram-render';
import { __setPeleRuntimeLoaderForTests, peleRuntimeFrom, type PeleRuntime } from '../utils/pele';

/** Pele's real library, through `pele/lazy` as a build with Pele in it loads it. */
export const loadRealPele = (): Promise<PeleRuntime> => import('pele/lazy').then(peleRuntimeFrom);

/** `true`: the real library and the engine switch, as a build with Pele in it. `false`: the shipped build's state. */
export function setPeleInBuildForTests(on: boolean): void {
  __setPeleRuntimeLoaderForTests(on ? loadRealPele : undefined);
  __setPeleInBuildForTests(on ? true : undefined);
}

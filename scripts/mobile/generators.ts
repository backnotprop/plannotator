/**
 * The contract's generators, in the order each reads the one before.
 * scripts/mobile/check.ts checks each; scripts/mobile/all.ts runs them,
 * then the stream suite's generator (vectors-stream.ts), which reads the
 * window's stream reader and so is never imported from here. Of the window's
 * own code, vectors.ts reads the badge rule (packages/inbox/tabCount.ts, whose
 * module also holds a React hook) and the list's pure rules for the rows suite
 * (held.ts, markRead.ts, pins.ts, priority.ts, rowActions.ts, rowMenu.ts,
 * rowSwipe.ts in packages/inbox). A change there is caught by the contract
 * check on main and in its nightly run, not by a pull request's path filter.
 */
import { generateDoor } from './door';
import { generateLedger } from './ledger';
import type { Output } from './lib';
import { generateSchema } from './schema';
import { generateSurface } from './surface';
import { generateSwift } from './swift';
import { generateTokens } from './tokens';
import { generateVectors } from './vectors';
import { generateWords } from './words';

/** In order: swift reads the schema and door.json as written. */
export const GENERATORS: readonly (readonly [string, () => Output[] | Promise<Output[]>])[] = [
  ['door', generateDoor],
  ['schema', generateSchema],
  ['swift', generateSwift],
  ['tokens', generateTokens],
  ['words', generateWords],
  ['surface', generateSurface],
  ['ledger', generateLedger],
  ['vectors', generateVectors],
];

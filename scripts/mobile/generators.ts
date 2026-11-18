/**
 * The contract's generators that read no window code, in the order each reads
 * the one before. tests/mobile-vectors.test.ts checks each; scripts/mobile/all.ts
 * runs them, then the stream suite's generator (vectors-stream.ts), which
 * reads the window's stream reader and so is never imported from here.
 */
import { generateDoor } from './door';
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
  ['vectors', generateVectors],
];

/**
 * Exit 1 unless the running Bun is at least the release floor. Run it before
 * a `bun build --compile`: the binary carries the running Bun's runtime, root
 * certificates and TLS checks included, so an older Bun ships a binary that
 * still trusts the compromised eMudhra chain (see check-bun-runtime-trust.ts).
 * usage: bun scripts/require-bun.ts
 */
import { MIN_BUN_VERSION } from "./check-bun-runtime-trust.ts";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
  console.error(`Bun ${Bun.version} is too old to compile Plannotator: use Bun >= ${MIN_BUN_VERSION} (bun upgrade).`);
  process.exit(1);
}

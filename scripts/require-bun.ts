import { MIN_BUN_VERSION } from "./check-bun-runtime-trust.ts";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
  console.error(`Bun ${Bun.version} is too old to compile Plannotator: use Bun >= ${MIN_BUN_VERSION} (bun upgrade).`);
  process.exit(1);
}

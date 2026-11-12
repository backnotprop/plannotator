import { join } from "node:path";

const [which, repoArg, numberArg] = process.argv.slice(2);
if (!process.env.FAKE_GH_SCENARIO || !process.env.PATH?.split(":")[0]?.includes("plannotator-fake-gh-")) {
  console.error("gh-account-runtime-probe: refusing to run without the fake gh first on PATH");
  process.exit(2);
}
const root = join(import.meta.dir, "..", "..");
const mod = which === "pi"
  ? await import(join(root, "apps/pi-extension/server/pr.ts"))
  : await import(join(root, "packages/server/pr.ts"));
const [owner, repo] = repoArg.split("/");
const ref = { platform: "github" as const, host: "github.com", owner, repo, number: Number(numberArg) };
const out: Record<string, unknown> = {};
try {
  const access = await mod.checkPRAuth(ref);
  out.notice = access.notice ?? null;
  out.hasChildEnv = !!access.childEnv;
  out.user = await mod.getPRUser(ref);
  out.repo = (await mod.fetchPR(ref)).metadata.repo;
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
}
out.ghTokenInEnv = process.env.GH_TOKEN !== undefined;
console.log(JSON.stringify(out));

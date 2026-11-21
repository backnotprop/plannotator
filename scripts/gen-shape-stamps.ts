#!/usr/bin/env bun
/**
 * Writes packages/shared/shape/stamp-data.ts: the icons, logos and marks that
 * `plannotator shape update` draws in place of `data-icon`, `data-logo` and
 * `data-draw` (packages/shared/shape/stamps.ts). Nothing is fetched here or at
 * view time: it reads local copies only.
 *
 *   bun scripts/gen-shape-stamps.ts <unpacked simple-icons package folder>
 *
 * - Icons: every Lucide icon, from the lucide-react copy in node_modules (ISC).
 * - Logos: the slugs in LOGOS below, from an unpacked Simple Icons npm package
 *   (CC0): `npm pack simple-icons@16.36.0 && tar xzf simple-icons-16.36.0.tgz`,
 *   then pass the `package` folder. A slug it lacks is reported and skipped,
 *   and so is any logo Simple Icons lists under a licence of its own (some are
 *   CC BY, some NonCommercial): only CC0 drawings are bundled.
 * - Marks: the kit's own marks (packages/core/shape-kit.mjs, MARKS and CODEX),
 *   copied so the store needs no JavaScript kit at run time.
 *
 * Licences and the trademark note: packages/shared/shape/THIRD_PARTY_NOTICES.md.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const siDir = process.argv[2];
if (!siDir || !existsSync(join(siDir, "icons"))) {
  console.error("usage: bun scripts/gen-shape-stamps.ts <unpacked simple-icons package folder>");
  process.exit(2);
}

// The logos a board is likely to name: payments, data, queues, hosting, tools, platforms.
const LOGOS = `stripe paypal visa mastercard applepay googlepay shopify
postgresql mysql sqlite mongodb redis supabase firebase neon planetscale turso upstash cockroachlabs clickhouse duckdb snowflake databricks prisma drizzle
elasticsearch algolia meilisearch qdrant
rabbitmq mqtt celery
cloudflare cloudflareworkers cloudflarepages vercel netlify googlecloud flydotio render railway digitalocean hetzner fastly akamai
docker kubernetes terraform ansible pulumi vault nginx linux ubuntu
bitbucket gitea githubactions circleci
react nextdotjs svelte vite tailwindcss nodedotjs bun typescript python go swift kotlin fastify express graphql electron
apple ios macos expo flutter capacitor ionic googleplay appstore xcode androidstudio
google gmail googlechrome safari firefox googledrive googlemaps mapbox
discord whatsapp telegram x youtube zoom mailgun resend
auth0 clerk okta 1password openid jsonwebtokens
anthropic cursor ollama huggingface langchain
figma notion linear jira trello asana zapier n8n dropbox icloud
sentry datadog grafana prometheus newrelic pagerduty posthog mixpanel intercom zendesk hubspot statuspage
vitest jest cypress npm pnpm homebrew minio backblaze cloudinary webrtc socketdotio pusher`.split(/\s+/);

// Lucide: each icon module holds its drawing as `__iconData = { name, node: [[tag, attrs], …] }`.
const lucidePkg = Bun.resolveSync("lucide-react/package.json", join(root, "packages/ui"));
const lucideVersion = JSON.parse(readFileSync(lucidePkg, "utf8")).version as string;
const lucideDir = join(dirname(lucidePkg), "dist/esm");
const icons: Record<string, string> = {};
for (const f of readdirSync(join(lucideDir, "icons")).sort()) {
  if (!f.endsWith(".mjs")) continue;
  const m = readFileSync(join(lucideDir, "icons", f), "utf8").match(/const __iconData = (\{[\s\S]*?\n\});/);
  if (!m) continue;
  const data = new Function(`return ${m[1]}`)() as { name: string; node: [string, Record<string, string>][] };
  icons[data.name] = data.node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${v}"`).join(" ")}/>`)
    .join("");
}
// Lucide's older names (alert-triangle for triangle-alert…), from its dynamic import map.
const aliases: Record<string, string> = {};
const dyn = readFileSync(join(lucideDir, "dynamicIconImports.mjs"), "utf8");
for (const m of dyn.matchAll(/"([a-z0-9-]+)": \(\) => import\('\.\/icons\/([a-z0-9-]+)\.mjs'\)/g)) if (m[1] !== m[2] && icons[m[2]!]) aliases[m[1]!] = m[2]!;

// Simple Icons: the path from icons/<slug>.svg, the title and colour from data/simple-icons.json.
const siVersion = JSON.parse(readFileSync(join(siDir, "package.json"), "utf8")).version as string;
const siJson = JSON.parse(readFileSync(join(siDir, "data/simple-icons.json"), "utf8"));
const bySlug = new Map((Array.isArray(siJson) ? siJson : siJson.icons).map((d: { slug: string }) => [d.slug, d]));
const luminance = (hex: string) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const logos: Record<string, { t: string; d: string; c: string | null }> = {};
const lacking: string[] = [];
const licensed: string[] = [];
for (const slug of LOGOS) {
  const file = join(siDir, "icons", `${slug}.svg`);
  const meta = bySlug.get(slug) as { title: string; hex: string } | undefined;
  if (!existsSync(file) || !meta) {
    lacking.push(slug);
    continue;
  }
  if ((meta as { license?: unknown }).license) {
    licensed.push(slug);
    continue;
  }
  const L = luminance(meta.hex);
  // Too dark or too light to read on one of the two themes: it follows the board's ink instead.
  logos[slug] = { t: meta.title, d: readFileSync(file, "utf8").match(/<path d="([^"]+)"/)![1]!, c: L < 0.03 || L > 0.8 ? null : `#${meta.hex}` };
}

// The kit's marks, as `plannotator shape kit` draws them.
const kit = readFileSync(join(root, "packages/core/shape-kit.mjs"), "utf8");
const marks = JSON.parse(kit.match(/^const MARKS = (\{.*\});$/m)![1]!);
const codex = kit.match(/^const CODEX = "([^"]+)";$/m)![1]!;

const out = `// @generated by scripts/gen-shape-stamps.ts. Do not edit by hand.
// Icons: Lucide ${lucideVersion} (lucide-react), ISC License. Logos: Simple Icons ${siVersion}, CC0 1.0; each mark is its owner's
// trademark, shown only to name the product. Licence texts: ./THIRD_PARTY_NOTICES.md.
/** Lucide icons by name: the inner SVG of a 24 by 24 stroked icon. */
export const STAMP_ICONS: Record<string, string> = ${JSON.stringify(icons)};
/** Product logos by Simple Icons slug: title, path on a 24 by 24 box, colour (null: it follows the board's ink). */
export const STAMP_LOGOS: Record<string, { t: string; d: string; c: string | null }> = ${JSON.stringify(logos)};
/** Lucide's older names for its icons. */
export const STAMP_ICON_ALIASES: Record<string, string> = ${JSON.stringify(aliases)};
/** The kit's own marks (claude, pi, opencode, github, gitlab): viewBox and inner SVG, as \`plannotator shape kit\` draws them. */
export const STAMP_MARKS: Record<string, { box: string; body: string }> = ${JSON.stringify(marks)};
/** Codex's mark, a PNG. */
export const STAMP_CODEX = ${JSON.stringify(codex)};
`;
writeFileSync(join(root, "packages/shared/shape/stamp-data.ts"), out);
console.log(`icons ${Object.keys(icons).length} (aliases ${Object.keys(aliases).length}), logos ${Object.keys(logos).length}, ${out.length} bytes`);
if (lacking.length) console.log(`not in Simple Icons ${siVersion}: ${lacking.join(" ")}`);
if (licensed.length) console.log(`skipped, under a licence of their own (not CC0): ${licensed.join(" ")}`);

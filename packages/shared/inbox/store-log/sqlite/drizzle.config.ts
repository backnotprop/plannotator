/**
 * drizzle-kit's config for the Inbox schema: `bunx drizzle-kit generate --config
 * packages/shared/inbox/store-log/sqlite/drizzle.config.ts` (from the repo root) writes the next migration
 * under `migrations/`. Then list it in `migrations.ts` and add STRICT to each new table by hand.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/shared/inbox/store-log/sqlite/schema.ts",
  out: "./packages/shared/inbox/store-log/sqlite/migrations",
});

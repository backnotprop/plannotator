/** Run from the repo root: `bunx drizzle-kit generate --config packages/shared/inbox/store-log/sqlite/drizzle.config.ts`. */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/shared/inbox/store-log/sqlite/schema.ts",
  out: "./packages/shared/inbox/store-log/sqlite/migrations",
});

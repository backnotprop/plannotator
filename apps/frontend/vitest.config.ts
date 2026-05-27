import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@plannotator/shared": path.resolve(__dirname, "../../packages/shared"),
      "@plannotator/ui": path.resolve(__dirname, "../../packages/ui"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["src/**/*.browser.test.tsx", "src/routeTree.gen.ts"],
  },
});

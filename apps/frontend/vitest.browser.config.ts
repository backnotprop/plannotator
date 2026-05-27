import path from "path";
import { playwright } from "@vitest/browser-playwright";
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
    include: ["src/**/*.browser.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});

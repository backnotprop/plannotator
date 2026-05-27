import fs from "fs";
import os from "os";
import path from "path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

function discoverDaemon(): { baseUrl: string; authToken: string } | undefined {
  try {
    const statePath = path.join(os.homedir(), ".plannotator", "daemon.json");
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    if (raw.baseUrl && raw.authToken) {
      return { baseUrl: raw.baseUrl, authToken: raw.authToken };
    }
  } catch {}
  return undefined;
}

export default defineConfig(({ command }) => {
  const daemon = command === "serve" ? discoverDaemon() : undefined;

  if (command === "serve" && daemon) {
    console.log(`[frontend] Proxying to daemon at ${daemon.baseUrl}`);
  } else if (command === "serve") {
    console.log(
      "[frontend] No daemon found — API calls will fail. Start one with: plannotator daemon start",
    );
  }

  return {
    server: {
      port: 3002,
      host: "0.0.0.0",
      proxy: daemon
        ? {
            "/daemon": {
              target: daemon.baseUrl,
              ws: true,
              headers: { Authorization: `Bearer ${daemon.authToken}` },
            },
            "^/s/[^/]+/api": {
              target: daemon.baseUrl,
            },
          }
        : undefined,
    },
    plugins: [
      tanstackRouter({
        target: "react",
        routesDirectory: "./src/routes",
        generatedRouteTree: "./src/routeTree.gen.ts",
        quoteStyle: "double",
      }),
      react(),
      tailwindcss(),
      viteSingleFile(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@plannotator/code-review/styles": path.resolve(
          __dirname,
          "../../packages/plannotator-code-review/index.css",
        ),
        "@plannotator/code-review": path.resolve(
          __dirname,
          "../../packages/plannotator-code-review",
        ),
        "@plannotator/plan-review/styles": path.resolve(
          __dirname,
          "../../packages/plannotator-plan-review/index.css",
        ),
        "@plannotator/plan-review": path.resolve(
          __dirname,
          "../../packages/plannotator-plan-review",
        ),
        "@plannotator/shared": path.resolve(__dirname, "../../packages/shared"),
        "@plannotator/ui": path.resolve(__dirname, "../../packages/ui"),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(
        JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8")).version,
      ),
    },
    build: {
      target: "esnext",
      assetsInlineLimit: 100000000,
      chunkSizeWarningLimit: 100000000,
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  };
});

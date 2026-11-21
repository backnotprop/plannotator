/**
 * Bun plan and annotate servers: `/api/doc` outside the project (#2291).
 * Scenarios are shared with the Pi mirror
 * (apps/pi-extension/server/doc-any-path.test.ts).
 */
import { defineDocAnyPathScenarios } from "./doc-any-path.scenarios";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";
import { allowServedHostname, resetServedHostnamesForTests } from "./request-host-guard";

defineDocAnyPathScenarios(
  "bun",
  async (kind, { docPath, htmlContent, folderPath, rawHtml }) => {
    if (kind === "plan") return startPlannotatorServer({ plan: "# Plan\n\nSteps", origin: "claude-code", htmlContent });
    if (folderPath) return startAnnotateServer({ markdown: "", filePath: folderPath, folderPath, htmlContent, mode: "annotate-folder" });
    if (rawHtml) return startAnnotateServer({ markdown: "", filePath: docPath, rawHtml, renderHtml: true, htmlContent, mode: "annotate" });
    return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
  },
  {
    allowServedHost: (hostname) => {
      allowServedHostname(hostname);
      return resetServedHostnamesForTests;
    },
  },
);

/**
 * Bun servers: `GET /api/ref` (the issue / PR / MR hover cards). Scenarios are
 * shared with the Pi mirror (apps/pi-extension/server/ref-card-route.test.ts).
 */
import { defineRefCardRouteScenarios } from "./ref-card-route.scenarios";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";
import { startReviewServer } from "./review";
import { allowServedHostname, resetServedHostnamesForTests } from "./request-host-guard";
import { resetSessionTailnetForTests, setSessionTailnetOwner, setSessionTailnetServedUrl } from "./session-tailnet";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

defineRefCardRouteScenarios(
  "bun",
  async (kind, { root, docPath, htmlContent, refRunner, tailnetPublished }) => {
    if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root, refRunner, tailnetPublished });
    if (kind === "plan") return startPlannotatorServer({ plan: "# Plan\n\nSee https://github.com/acme/widgets/pull/12", origin: "claude-code", htmlContent, refRunner });
    return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate", refRunner, tailnetPublished });
  },
  {
    // `--tailscale` exists for review and annotate only (plan review has no such flag).
    tailnet: {
      kinds: ["annotate", "review"],
      // What the CLI records once `tailscale serve` is up (apps/hook/server/index.ts).
      publish(owner, servedUrl) {
        setSessionTailnetOwner(owner || null);
        setSessionTailnetServedUrl(servedUrl);
        allowServedHostname(new URL(servedUrl).hostname);
      },
      reset() {
        resetSessionTailnetForTests();
        resetServedHostnamesForTests();
      },
    },
  },
);

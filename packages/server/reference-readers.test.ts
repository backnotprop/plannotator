import { defineReferenceReaderScenarios } from "./reference-readers.scenarios";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";

defineReferenceReaderScenarios("bun", async (kind, { docPath, htmlContent }) => {
  if (kind === "plan") return startPlannotatorServer({ plan: "# Plan\n\nSteps", origin: "claude-code", htmlContent });
  return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});

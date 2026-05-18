// Keep text imports isolated so protocol-only commands can run from source
// before apps/hook/dist has been built.
// @ts-ignore - Bun import attribute for text
import planHtml from "../dist/index.html" with { type: "text" };

// @ts-ignore - Bun import attribute for text
import reviewHtml from "../dist/review.html" with { type: "text" };

export const planHtmlContent = planHtml as unknown as string;
export const reviewHtmlContent = reviewHtml as unknown as string;

import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApproveDropdown } from "./ApproveDropdown";

describe("ApproveDropdown", () => {
  test("does not show agent-switch label when only extra approval entries are enabled", () => {
    const html = renderToStaticMarkup(
      <ApproveDropdown
        onApprove={() => {}}
        agents={[]}
        extraEntries={[
          {
            id: "approve-bypass-native-clear",
            label: "Approve + Bypass + Clear Context (native)",
            onSelect: () => {},
          },
        ]}
      />,
    );

    expect(html).toContain("Approve");
    expect(html).not.toContain("build");
    expect(html).not.toContain("(?)");
  });
});

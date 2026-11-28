import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {renderDiagram} from "@plannotator/diagrams";
import {gold} from "./cases.mjs";

// SHA-256 of the original Open Diagram web renderer’s complete, deterministic SVG.
// For an intentional change, review the old and new pictures before updating a digest.
const originalArtwork = {
    catalogue: "4979acdaafc6463ffc9216584b3fc3676457068790f49b424788f114e557a560",
    email: "518bff1d8eb772fe5b59998d1992e042b8c6e287d58c44b21cdeeb567bb49170",
    cycle: "392c21f5626abc159f284da230668f74ab115c07d6d86fb11b23400ff9a64d62",
    layers: "b0a3bfc9dfd7a8a908fd7ea69dc439633a3bed26eed8c3f98edae5ea552f03b1",
    systems: "89a3607db49ba1c9261c6f71e7d0890e1618567e2c01b237c1a4dbdeeab3a147",
    cutover: "8b0d1885fe3aeae576c96fc98ec946b256e50f996a05045dde6ee0353c48a063",
};

for (const [name, digest] of Object.entries(originalArtwork)) {
    test(`the ${name} fixture preserves the original SVG`, async () => {
        const {svg} = await renderDiagram(gold[name]);
        assert.equal(createHash("sha256").update(svg).digest("hex"), digest);
    });
}

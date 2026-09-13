import { expect, test } from "vitest";
import { apply } from "./patches";

// Native DOM operations keep this argument-count regression test affordable.
test("applies a sibling batch larger than the JavaScript argument-count limit", () => {
    const count = 150_000;
    const target = document.createElement("div");
    target.id = "large-batch";
    const old = document.createElement("p");
    target.appendChild(old);
    document.body.appendChild(target);
    try {
        // Reuse one node. The spread argument-count limit does not need distinct nodes.
        const node = document.createComment("row");
        const nodes = new Array<Node>(count).fill(node);
        apply({
            patches: [
                {
                    target,
                    targetId: "large-batch",
                    operation: "append",
                    nodes,
                },
            ],
        });

        expect(document.getElementById("large-batch")).toBe(target);
        expect(target.contains(old)).toBe(true);
        expect(target.contains(node)).toBe(true);
        expect(target.lastChild).toBe(node);
    } finally {
        target.remove();
    }
});

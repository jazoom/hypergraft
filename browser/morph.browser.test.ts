import { expect, test } from "vitest";
import { apply, MEDIA_TYPE, OPERATIONS, preflight } from "./patches";

// Native DOM operations keep this argument-count regression test affordable.
test.each(OPERATIONS)("applies a large sibling batch with %s", (operation) => {
    const count = 150_000;
    const content = "<!--row-->".repeat(count);
    const text = `<graft-patch-set version="1"><graft-patch operation="${operation}" target="large-batch"><template>${content}</template></graft-patch></graft-patch-set>`;
    const target = document.createElement("div");
    target.id = "large-batch";
    const old = document.createElement("p");
    target.appendChild(old);
    document.body.appendChild(target);
    try {
        const response = new Response(text, {
            headers: { "content-type": MEDIA_TYPE },
        });
        const prepared = preflight(response, text);
        if (prepared.kind !== "patches")
            throw new Error("Expected a patch batch");

        apply(prepared.batch);

        expect(document.getElementById("large-batch")).toBe(target);
        expect(target.childNodes.length).toBe(
            count + (operation === "append" ? 1 : 0),
        );
        expect(target.contains(old)).toBe(operation === "append");
        expect(target.lastChild?.nodeType).toBe(Node.COMMENT_NODE);
        expect(target.lastChild?.textContent).toBe("row");
    } finally {
        target.remove();
    }
});

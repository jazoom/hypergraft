import { expect, test } from "vitest";
import { apply, preflightLive } from "./patches";

test.each(["<script></script>", '<p id=""></p>'])(
    "form field names cannot hide invalid content from preflight: %s",
    (content) => {
        const host = document.createElement("div");
        host.id = "form-preflight";
        document.body.append(host);
        try {
            const fields = [
                "childNodes",
                "nodeType",
                "localName",
                "getAttributeNS",
            ]
                .map((name) => `<input name="${name}">`)
                .join("");
            expect(() =>
                preflightLive(
                    `<graft-patch-set version="1"><graft-patch operation="children" target="form-preflight"><template><form>${fields}${content}</form></template></graft-patch></graft-patch-set>`,
                ),
            ).toThrowError(
                expect.objectContaining({ reason: "target-content" }),
            );
            expect(host.childNodes).toHaveLength(0);
        } finally {
            host.remove();
        }
    },
);

test("form field names do not replace Hypergraft adapter properties", () => {
    const host = document.createElement("div");
    const names = [
        "id",
        "contains",
        "cloneNode",
        "ownerDocument",
        "appendChild",
    ];
    const fields = (value: string) =>
        names
            .map(
                (name) =>
                    `<input id="field-${name}" name="${name}" value="${value}">`,
            )
            .join("");
    host.innerHTML = `<form id="form-target">${fields("old")}<div id="form-inner"></div></form>`;
    document.body.append(host);
    const form = host.firstElementChild;
    const controls = Array.from(host.querySelectorAll("input"));
    const update = (content: string, operation = "children") =>
        apply(
            preflightLive(
                `<graft-patch-set version="1"><graft-patch operation="${operation}" target="form-target"><template>${content}</template></graft-patch></graft-patch-set>`,
            ),
        );
    try {
        for (const input of controls) input.value = "dirty";
        update(`${fields("new")}<div id="form-inner"></div>`);
        expect(host.firstElementChild).toBe(form);
        expect(Array.from(host.querySelectorAll("input"))).toEqual(controls);
        expect(controls.map((input) => input.value)).toEqual(
            names.map(() => "new"),
        );
        update('<p id="appended">Extra</p>', "append");
        expect(host.querySelector("#appended")?.textContent).toBe("Extra");
        expect(() =>
            preflightLive(
                '<graft-patch-set version="1"><graft-patch operation="children" target="form-target"><template></template></graft-patch><graft-patch operation="children" target="form-inner"><template></template></graft-patch></graft-patch-set>',
            ),
        ).toThrow("overlapping targets");
    } finally {
        host.remove();
    }
});

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

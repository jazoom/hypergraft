import { expect, test } from "vitest";
import { apply } from "./patches";

function patch(target: HTMLElement, html: string) {
    const source = document.createElement("template");
    source.innerHTML = html;
    apply({
        patches: [
            {
                target,
                targetId: target.id,
                operation: "children",
                nodes: Array.from(source.content.childNodes),
            },
        ],
    });
}

test("equal attributes supersede dirty controls and complete select defaults", () => {
    const target = document.createElement("div");
    const html =
        '<input id="value" value="server"><input id="check" type="checkbox" checked><textarea id="text">server</textarea><select id="select"><option>A</option><option>B</option></select>';
    target.innerHTML = html;
    document.body.append(target);
    try {
        const input = target.querySelector("input")!;
        const checkbox = target.querySelectorAll("input")[1];
        const textarea = target.querySelector("textarea")!;
        const select = target.querySelector("select")!;
        input.value = "dirty";
        checkbox.checked = false;
        textarea.value = "dirty";
        select.selectedIndex = 1;
        patch(target, html);
        expect(target.querySelector("input")).toBe(input);
        expect(input.value).toBe("server");
        expect(checkbox.checked).toBe(true);
        expect(textarea.value).toBe("server");
        textarea.value = "dirty again";
        patch(textarea, "fresh");
        expect(textarea.value).toBe("fresh");
        expect(textarea.defaultValue).toBe("fresh");
        expect(select.selectedIndex).toBe(0);
        select.multiple = true;
        patch(select, "<option>A</option><option>B</option>");
        expect(select.selectedIndex).toBe(-1);
    } finally {
        target.remove();
    }
});

test("native template and namespaced attributes retain sibling identity", () => {
    const target = document.createElement("div");
    target.innerHTML =
        '<template id="native"><b id="inside">old</b></template><svg id="svg"><use id="use" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#old"></use></svg>';
    const template = target.querySelector("template")!;
    const inside = template.content.firstChild;
    const use = target.querySelector("use")!;
    patch(
        target,
        '<template id="native"><b id="inside">new</b></template><svg id="svg"><use id="use" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#new"></use></svg>',
    );
    expect(template.content.firstChild).toBe(inside);
    expect(inside!.textContent).toBe("new");
    expect(target.querySelector("use")).toBe(use);
    expect(use.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe(
        "#new",
    );
});

test("authoritative retention clears file state and indeterminate controls", () => {
    const target = document.createElement("div");
    const html =
        '<input id="file" type="file"><input id="mixed" type="checkbox">';
    target.innerHTML = html;
    document.body.append(target);
    try {
        const file = target.querySelector<HTMLInputElement>("#file")!;
        const mixed = target.querySelector<HTMLInputElement>("#mixed")!;
        const transfer = new DataTransfer();
        transfer.items.add(new File(["content"], "sample.txt"));
        file.files = transfer.files;
        mixed.indeterminate = true;
        patch(target, html);
        expect(target.querySelector("#file")).toBe(file);
        expect(file.files).toHaveLength(0);
        expect(mixed.indeterminate).toBe(false);
    } finally {
        target.remove();
    }
});

test("a failed batch leaves no control associations for later application", () => {
    const host = document.createElement("div");
    host.innerHTML = '<div><input id="retry" value="server"></div><div></div>';
    document.body.append(host);
    try {
        const target = host.firstElementChild as HTMLElement;
        const input = target.querySelector("input")!;
        const source = document.createElement("input");
        source.id = "retry";
        source.value = "server";
        const failure = new Error("host failure");
        expect(() =>
            apply(
                {
                    patches: [
                        {
                            target,
                            targetId: "",
                            operation: "children",
                            nodes: [source],
                        },
                    ],
                },
                () => {
                    throw failure;
                },
            ),
        ).toThrow(failure);
        input.id = "survivor";
        input.value = "unpatched";
        apply({
            patches: [
                {
                    target: host.lastElementChild as HTMLElement,
                    targetId: "",
                    operation: "append",
                    nodes: [source],
                },
            ],
        });
        expect(input.value).toBe("unpatched");
        expect(host.lastElementChild!.firstChild).toBe(source);
        expect(source.value).toBe("server");
    } finally {
        host.remove();
    }
});

test("select state follows final options across retention and insertion", () => {
    const target = document.createElement("div");
    target.innerHTML =
        '<select id="choice" multiple><option id="a" selected>A</option><option id="b" selected>B</option></select>';
    document.body.append(target);
    try {
        const select = target.querySelector("select")!;
        const a = select.options[0];
        const b = select.options[1];
        patch(
            target,
            '<select id="choice"><option id="b" disabled>B</option><option id="a">A</option><option id="c">C</option></select>',
        );
        expect(target.firstChild).toBe(select);
        expect(select.options[0]).toBe(b);
        expect(select.options[1]).toBe(a);
        expect(select.selectedIndex).toBe(1);
        expect(
            Array.from(select.options, (option) => option.defaultSelected),
        ).toEqual([false, false, false]);
        patch(
            target,
            '<select id="choice" multiple><option id="a" selected>A</option><option id="new" selected>New</option><option id="b">B</option></select>',
        );
        expect(select.options[0]).toBe(a);
        expect(select.options[2]).toBe(b);
        expect(Array.from(select.options, (option) => option.selected)).toEqual(
            [true, true, false],
        );
        expect(select.value).toBe("A");
    } finally {
        target.remove();
    }
});

test("radio groups resolve across the complete batch in final document order", () => {
    const host = document.createElement("div");
    host.innerHTML = '<div id="radio-first"></div><div id="radio-last"></div>';
    document.body.append(host);
    try {
        const patches = Array.from(host.children)
            .reverse()
            .map((target) => {
                const source = document.createElement("template");
                source.innerHTML = '<input type="radio" name="shared" checked>';
                return {
                    target: target as HTMLElement,
                    targetId: target.id,
                    operation: "children" as const,
                    nodes: Array.from(source.content.childNodes),
                };
            });
        apply({ patches });
        const radios = host.querySelectorAll("input");
        expect(radios[0].checked).toBe(false);
        expect(radios[1].checked).toBe(true);
    } finally {
        host.remove();
    }
});

for (const fallback of [false, true])
    test(`custom-element moves expose platform lifecycle with fallback=${fallback}`, () => {
        let connections = 0;
        let disconnections = 0;
        const name = `graft-move-${fallback ? "fallback" : "native"}`;
        customElements.define(
            name,
            class extends HTMLElement {
                connectedCallback() {
                    connections++;
                }
                disconnectedCallback() {
                    disconnections++;
                }
                connectedMoveCallback() {}
            },
        );
        const target = document.createElement("div");
        const native = typeof target.moveBefore === "function";
        if (fallback)
            Object.defineProperty(target, "moveBefore", { value: undefined });
        target.innerHTML = `<${name} id="move-a"></${name}><${name} id="move-b"></${name}>`;
        document.body.append(target);
        try {
            const old = target.firstChild;
            connections = 0;
            disconnections = 0;
            patch(
                target,
                `<${name} id="move-b"></${name}><${name} id="move-a"></${name}>`,
            );
            expect(target.lastChild).toBe(old);
            expect(connections).toBe(native && !fallback ? 0 : 1);
            expect(disconnections).toBe(native && !fallback ? 0 : 1);
        } finally {
            target.remove();
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

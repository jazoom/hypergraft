import { afterEach, expect, test, vi } from "vitest";
import { apply, preflightLive } from "./patches";

let host: HTMLDivElement;
afterEach(() => {
    host?.remove();
    vi.restoreAllMocks();
});

function mount(content: string) {
    host = document.createElement("div");
    host.innerHTML = `<main id="reconcile-target">${content}</main>`;
    document.body.append(host);
    return host.firstElementChild as HTMLElement;
}

function batch(
    content: string,
    target = "reconcile-target",
    operation = "children",
) {
    return preflightLive(
        `<graft-patch-set version="1"><graft-patch operation="${operation}" target="${target}"><template>${content}</template></graft-patch></graft-patch-set>`,
    );
}

function update(content: string) {
    apply(batch(content));
}

test("retained elements lose every obsolete attribute and update namespaced attributes", () => {
    const target = mount(
        '<div id="item" data-one="1" data-two="2" data-three="3"><svg><use id="use" xlink:href="#old" aria-label="Old"></use></svg></div>',
    );
    const item = target.firstElementChild!;
    const use = target.querySelector("use")!;
    update(
        '<div id="item"><svg><use id="use" xlink:href="#new"></use></svg></div>',
    );
    expect(target.firstElementChild).toBe(item);
    expect(item.getAttributeNames()).toEqual(["id"]);
    expect(target.querySelector("use")).toBe(use);
    expect(use.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe(
        "#new",
    );
    expect(use.hasAttribute("aria-label")).toBe(false);
    update(
        '<div id="item"><svg><use id="use" href="#plain"></use></svg></div>',
    );
    expect(use.hasAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe(
        false,
    );
    expect(use.getAttributeNS(null, "href")).toBe("#plain");
    item.setAttributeNS("urn:fixture", "old:flag", "same");
    const prepared = batch('<div id="item"></div>');
    (prepared.patches[0]!.nodes[0] as Element).setAttributeNS(
        "urn:fixture",
        "new:flag",
        "same",
    );
    apply(prepared);
    expect(item.getAttributeNodeNS("urn:fixture", "flag")?.name).toBe(
        "new:flag",
    );
});

test("retained HTML attributes keep colon names without namespaces despite form-property shadowing", () => {
    const target = mount(
        '<form id="form" xml:lang="en"><input name="setAttribute"><p id="message">Old</p></form>',
    );
    const form = target.querySelector("form")!;
    const message = target.querySelector("p")!;
    expect(form.setAttribute).toBe(target.querySelector("input"));
    update(
        '<form id="form" xml:lang="fr" x-on:click="save"><input name="setAttribute"><p id="message" xmlns="urn:fixture">New</p></form>',
    );
    expect(target.querySelector("form")).toBe(form);
    expect(target.querySelector("p")).toBe(message);
    expect(form.getAttributeNS(null, "xml:lang")).toBe("fr");
    expect(form.getAttributeNS(null, "x-on:click")).toBe("save");
    expect(message.getAttributeNS(null, "xmlns")).toBe("urn:fixture");
    expect(message.textContent).toBe("New");
});

test("namespaces and input types prevent incompatible identity reuse", () => {
    const target = mount(
        '<svg id="diagram"><a id="link"></a></svg><input id="control" type="text">',
    );
    const link = target.querySelector("a")!;
    const control = target.querySelector("input")!;
    apply(batch('<a id="link">HTML</a>', "diagram"));
    expect(target.querySelector("a")).not.toBe(link);
    expect(target.querySelector("a")?.namespaceURI).toBe(
        "http://www.w3.org/1999/xhtml",
    );
    update('<svg id="diagram"></svg><input id="control" type="checkbox">');
    expect(target.querySelector("input")).not.toBe(control);
});

test("retained templates update their separate contents, including nested templates", () => {
    const target = mount(
        '<template id="outer"><p id="p">Old</p><template id="inner"><b>Old</b></template></template>',
    );
    const outer = target.firstElementChild as HTMLTemplateElement;
    const p = outer.content.querySelector("p");
    const inner = outer.content.querySelector("template")!;
    update(
        '<template id="outer"><p id="p">New</p><template id="inner"><b>New</b></template></template>',
    );
    expect(target.firstElementChild).toBe(outer);
    expect(outer.content.querySelector("p")).toBe(p);
    expect(p?.textContent).toBe("New");
    expect(outer.content.querySelector("template")).toBe(inner);
    expect(inner.content.textContent).toBe("New");
    apply(batch("<i>Replacement</i>", "outer"));
    apply(batch("<b>Appended</b>", "outer", "append"));
    expect(outer.content.textContent).toBe("ReplacementAppended");
    expect(outer.childNodes.length).toBe(0);
});

test.each([false, true])(
    "keyed reorders retain listeners and minimise moves (fallback: %s)",
    (fallback) => {
        const target = mount(
            '<button id="a">A</button><button id="b">B</button><button id="c">C</button>',
        );
        const nodes = Array.from(target.children);
        const listener = vi.fn();
        nodes[2]!.addEventListener("click", listener);
        const descriptor = Object.getOwnPropertyDescriptor(
            Element.prototype,
            "moveBefore",
        );
        if (fallback)
            Object.defineProperty(Element.prototype, "moveBefore", {
                configurable: true,
                value: undefined,
            });
        try {
            const insert = vi.spyOn(target, "insertBefore");
            const move =
                typeof target.moveBefore === "function"
                    ? vi.spyOn(target, "moveBefore")
                    : undefined;
            update(
                '<button id="c">C</button><button id="a">A</button><button id="b">B</button>',
            );
            expect(Array.from(target.children)).toEqual([
                nodes[2],
                nodes[0],
                nodes[1],
            ]);
            expect(
                insert.mock.calls.length + (move?.mock.calls.length ?? 0),
            ).toBe(1);
            (target.firstElementChild as HTMLButtonElement).click();
            expect(listener).toHaveBeenCalledOnce();
        } finally {
            if (fallback) {
                if (descriptor)
                    Object.defineProperty(
                        Element.prototype,
                        "moveBefore",
                        descriptor,
                    );
                else Reflect.deleteProperty(Element.prototype, "moveBefore");
            }
        }
    },
);

test("unkeyed hints retain the right control and link, while changed IDs replace nodes", () => {
    const target = mount(
        '<input name="first" value="First"><input name="second" value="Second"><a href="#one">One</a><a href="#two">Two</a><button id="old">Save</button>',
    );
    const [first, second, one, two, button] = Array.from(target.children);
    update(
        '<input name="second" value="New second"><input name="first" value="New first"><a href="#two">New two</a><a href="#one">New one</a><button id="new">Save</button>',
    );
    expect(Array.from(target.children).slice(0, 4)).toEqual([
        second,
        first,
        two,
        one,
    ]);
    expect(button?.isConnected).toBe(false);
    const replacement = target.lastElementChild;
    update('<input name="unrelated"><button>Save</button>');
    expect(replacement?.isConnected).toBe(false);
    expect(first?.isConnected).toBe(false);
    expect(second?.isConnected).toBe(false);
});

test("identity is sibling-local, not shared across parents or batch targets", () => {
    const target = mount(
        '<section id="left"><button id="moving">Move</button></section><section id="right"></section>',
    );
    const first = target.querySelector("button")!;
    update(
        '<section id="left"></section><section id="right"><button id="moving">Move</button></section>',
    );
    const second = target.querySelector("button")!;
    expect(second).not.toBe(first);
    apply(
        preflightLive(
            '<graft-patch-set version="1"><graft-patch operation="children" target="left"><template><button id="moving">Move</button></template></graft-patch><graft-patch operation="children" target="right"><template></template></graft-patch></graft-patch-set>',
        ),
    );
    expect(target.querySelector("button")).not.toBe(second);
    expect(target.querySelector("button")?.parentElement?.id).toBe("left");
});

test.each([false, true])(
    "unchanged subtrees restore dirty controls and report ownership (callback: %s)",
    (callback) => {
        const markup =
            '<section><input value="Original"><input id="check" type="checkbox"><textarea id="text">Original</textarea><select id="select"><option>A</option><option selected>B</option></select><select id="multiple" multiple><option selected>A</option><option>B</option><option selected>C</option></select></section>';
        const target = mount(markup);
        const input = target.querySelector("input")!;
        const check = target.querySelector<HTMLInputElement>("#check")!;
        const textarea = target.querySelector("textarea")!;
        const select = target.querySelector<HTMLSelectElement>("#select")!;
        const multiple = target.querySelector<HTMLSelectElement>("#multiple")!;
        const originals = Array.from(target.querySelectorAll("*"));
        input.value = "Dirty";
        check.checked = true;
        check.indeterminate = true;
        textarea.value = "Dirty";
        select.selectedIndex = 0;
        multiple.options[0]!.selected = false;
        multiple.options[1]!.selected = true;
        const visited = new Map<Element, Element>();
        const mutations = new MutationObserver(() => {});
        mutations.observe(target, {
            childList: true,
            attributes: true,
            characterData: true,
            subtree: true,
        });
        apply(
            batch(markup),
            callback ? (node, source) => visited.set(node, source) : undefined,
        );
        expect(mutations.takeRecords()).toHaveLength(0);
        mutations.disconnect();
        expect(Array.from(target.querySelectorAll("*"))).toEqual(originals);
        expect(input.value).toBe("Original");
        expect(check.checked).toBe(false);
        expect(check.indeterminate).toBe(false);
        expect(textarea.value).toBe("Original");
        expect(select.selectedIndex).toBe(1);
        expect(
            Array.from(multiple.options, (option) => option.selected),
        ).toEqual([true, false, true]);
        if (callback) {
            expect(visited.size).toBe(originals.length);
            expect(visited.has(target)).toBe(false);
            expect(visited.get(check)?.hasAttribute("checked")).toBe(false);
        }
    },
);

test("authoritative control removals, option reorders and file clearing survive retained nodes", () => {
    const target = mount(
        '<input id="text" value="Old"><input id="check" type="checkbox" checked><input id="file" type="file"><select id="select"><option id="a" value="a" selected>A</option><option id="b" value="b">B</option></select>',
    );
    const text = target.querySelector<HTMLInputElement>("#text")!;
    const check = target.querySelector<HTMLInputElement>("#check")!;
    const file = target.querySelector<HTMLInputElement>("#file")!;
    const select = target.querySelector("select")!;
    const a = select.options[0];
    const b = select.options[1];
    text.value = "Dirty";
    const files = new DataTransfer();
    files.items.add(new File(["private"], "private.txt"));
    file.files = files.files;
    expect(file.files.length).toBe(1);
    update(
        '<input id="text"><input id="check" type="checkbox"><input id="file" type="file"><select id="select"><option id="b" value="b" selected>B</option><option id="a" value="a">A</option></select>',
    );
    expect(target.querySelector("#text")).toBe(text);
    expect(text.value).toBe("");
    expect(check.checked).toBe(false);
    expect(check.defaultChecked).toBe(false);
    expect(target.querySelector("#file")).toBe(file);
    expect(file.files?.length).toBe(0);
    expect(Array.from(select.options)).toEqual([b, a]);
    expect(select.value).toBe("b");
    apply(
        batch(
            '<option id="a" value="a">A</option><option id="b" value="b">B</option>',
            "select",
        ),
    );
    expect(select.selectedIndex).toBe(0);
    apply(
        batch(
            '<option id="extra" value="extra">Extra</option>',
            "select",
            "append",
        ),
    );
    expect(select.value).toBe("a");
    update('<textarea id="root-text">Old</textarea>');
    const textarea = target.querySelector("textarea")!;
    textarea.value = "Dirty";
    apply(batch("New", "root-text"));
    expect(textarea.value).toBe("New");
    expect(textarea.defaultValue).toBe("New");
});

test("prepared properties survive select source mutation and radio group changes across a batch", () => {
    const target = mount(
        '<form id="form"><div id="left"><input id="a" type="radio" name="group" checked></div><div id="right"><input id="b" type="radio" name="group"></div><select id="select"><option>A</option><option>B</option></select></form>',
    );
    const a = target.querySelector<HTMLInputElement>("#a")!;
    const b = target.querySelector<HTMLInputElement>("#b")!;
    a.checked = false;
    b.checked = true;
    const prepared = preflightLive(
        '<graft-patch-set version="1"><graft-patch operation="children" target="right"><template><input id="b" type="radio" name="group" checked></template></graft-patch><graft-patch operation="children" target="left"><template><input id="a" type="radio" name="group" checked></template></graft-patch><graft-patch operation="children" target="select"><template><option id="option-a">A</option><option id="option-b">B</option></template></graft-patch></graft-patch-set>',
    );
    apply(prepared);
    expect(target.querySelector("#a")).toBe(a);
    expect(target.querySelector("#b")).toBe(b);
    expect(a.checked).toBe(false);
    expect(b.checked).toBe(true);
    const next = batch(
        '<select id="select"><option>A</option><option>B</option></select>',
    );
    const sourceSelect = next.patches[0]!.nodes[0] as HTMLSelectElement;
    sourceSelect.selectedIndex = -1;
    apply(next);
    expect(target.querySelector("select")?.selectedIndex).toBe(-1);
});

test.each([false, true])(
    "named controls cannot replace native reconciliation members (form target: %s)",
    (formTarget) => {
        const names = [
            "childNodes",
            "nodeType",
            "localName",
            "namespaceURI",
            "id",
            "attributes",
            "getAttributeNS",
            "getAttributeNodeNS",
            "hasAttributeNS",
            "removeAttributeNS",
            "setAttributeNS",
            "cloneNode",
            "ownerDocument",
            "appendChild",
            "insertBefore",
            "removeChild",
            "moveBefore",
            "parentNode",
            "nextSibling",
            "isConnected",
            "isEqualNode",
            "querySelectorAll",
        ];
        const fields = (value: string) =>
            names
                .map(
                    (name) =>
                        `<input id="field-${name}" name="${name}" value="${value}">`,
                )
                .join("");
        const target = mount(
            `<form id="form" data-one="1" data-two="2">${fields("Old")}<i>Remove</i></form>`,
        );
        const form = target.firstElementChild!;
        const controls = Array.from(target.querySelectorAll("input"));
        const content = `${fields("New")}<p>Added</p>`;
        apply(
            batch(
                formTarget ? content : `<form id="form">${content}</form>`,
                formTarget ? "form" : "reconcile-target",
            ),
        );
        expect(target.firstElementChild).toBe(form);
        expect(Array.from(target.querySelectorAll("input"))).toEqual(controls);
        expect(controls.every((control) => control.value === "New")).toBe(true);
        expect(target.querySelector("i")).toBeNull();
        expect(target.querySelector("p")?.textContent).toBe("Added");
        if (!formTarget)
            expect(Element.prototype.getAttributeNames.call(form)).toEqual([
                "id",
            ]);
    },
);

function snapshot(node: Node): unknown {
    if (!(node instanceof Element)) return [node.nodeType, node.nodeValue];
    const control =
        node instanceof HTMLInputElement
            ? [node.value, node.checked, node.indeterminate]
            : node instanceof HTMLTextAreaElement
              ? node.value
              : node instanceof HTMLSelectElement
                ? Array.from(node.options, (option) => option.selected)
                : undefined;
    return [
        node.namespaceURI,
        node.localName,
        Array.from(node.attributes, (attribute) => [
            attribute.namespaceURI,
            attribute.name,
            attribute.value,
        ]).sort(),
        control,
        Array.from(
            node instanceof HTMLTemplateElement
                ? node.content.childNodes
                : node.childNodes,
            snapshot,
        ),
    ];
}

test("seeded patch sequences converge to source state without losing compatible keyed siblings", () => {
    const target = mount("");
    let state = 0x48c2b2;
    const random = (max: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % max;
    };
    const tags = ["article", "input", "textarea", "select", "template", "svg"];
    for (let step = 0; step < 120; step++) {
        const order = Array.from({ length: 12 }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
            const j = random(i + 1);
            [order[i], order[j]] = [order[j]!, order[i]!];
        }
        const markup = order
            .filter(() => random(5) !== 0)
            .map((id) => {
                const tag = tags[random(tags.length)]!;
                const common = `id="node-${id}" ${random(2) ? 'data-one="1" data-two="2"' : ""}`;
                const text = `Value ${random(10)}`;
                if (tag === "input")
                    return `<input ${common} ${random(2) ? 'type="checkbox" checked' : `value="${text}"`}>`;
                if (tag === "select")
                    return `<select ${common}><option>${text}</option><option selected>Selected</option></select>`;
                if (tag === "template")
                    return `<template ${common}><template><b>${text}</b></template></template>`;
                if (tag === "svg")
                    return `<svg ${common}><text>${text}</text></svg>`;
                return `<${tag} ${common}>${text}</${tag}>`;
            })
            .join(" \n<!--separator-->");
        const old = new Map(
            Array.from(target.children, (node) => [node.id, node]),
        );
        for (const input of target.querySelectorAll("input")) {
            input.value = "Dirty";
            input.checked = !input.checked;
        }
        for (const textarea of target.querySelectorAll("textarea"))
            textarea.value = "Dirty";
        for (const select of target.querySelectorAll("select"))
            select.selectedIndex = 0;
        const prepared = batch(markup);
        const expected = prepared.patches[0]!.nodes.map(snapshot);
        const incoming = prepared.patches[0]!.nodes.filter(
            (node): node is Element => node instanceof Element,
        );
        const retained = incoming
            .filter((node) => {
                const previous = old.get(node.id);
                return (
                    previous?.localName === node.localName &&
                    previous.namespaceURI === node.namespaceURI &&
                    (!(node instanceof HTMLInputElement) ||
                        (previous instanceof HTMLInputElement &&
                            previous.type === node.type))
                );
            })
            .map((node) => node.id);
        apply(prepared);
        expect(
            Array.from(target.childNodes, snapshot),
            `seed 0x48c2b2, step ${step}`,
        ).toEqual(expected);
        for (const id of retained)
            expect(
                target.querySelector(`#${id}`),
                `identity ${id}, step ${step}`,
            ).toBe(old.get(id));
    }
});

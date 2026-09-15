import { describe, expect, it } from "vitest";
import { cachedDocumentIds, incomingIds } from "../benchmarks/id-validation";
import { validateDocumentIds } from "./document-ids";
import { HypergraftError } from "./diagnostics";
import { apply, preflightLive, type PreparedPatch } from "./patches";

const accepted = (run: () => void) => {
    try {
        run();
        return true;
    } catch (error) {
        if (!(error instanceof HypergraftError)) throw error;
        expect(error.reason).toBe("target-content");
        return false;
    }
};
const patch = (
    doc: Document,
    html: string,
    operation: "children" | "append" = "children",
): PreparedPatch[] => {
    const template = doc.createElement("template");
    template.innerHTML = html;
    return [
        {
            target: doc.getElementById("target")!,
            targetId: "target",
            operation,
            nodes: [...template.content.childNodes],
        },
    ];
};

describe("document ID strategies", () => {
    it("preserves final-document acceptance, including repair and inert template scope", () => {
        for (const [initial, html, operation, expected] of [
            ["", '<b id="a"></b><i id="a"></i>', "children", false],
            ['<i id=""></i>', "", "children", false],
            ['<i id="outside"></i>', '<b id="outside"></b>', "children", false],
            ["", '<b id="target"></b>', "children", false],
            ['<i id="same"></i><b id="same"></b>', "", "children", false],
            ["", '<b id="bad id"></b>', "children", false],
            ["", '<b id=""></b>', "children", true],
            ["", '<template><i id=""></i></template>', "children", true],
            ["", '<template><i id="bad id"></i></template>', "children", false],
            [
                "",
                '<b id="a"></b><template><i id="a"></i></template>',
                "children",
                false,
            ],
            ["", '<b id="old"></b>', "append", false],
            ["", '<b id="old"></b>', "children", true],
            [
                '<template><i id="old"></i></template>',
                '<b id="old"></b>',
                "children",
                true,
            ],
            [
                '<svg><g id="outside" /></svg>',
                '<b id="outside"></b>',
                "children",
                false,
            ],
            ["", '<template><i id="old"></i></template>', "children", true],
            [
                '<math><mi id="outside">x</mi></math>',
                '<b id="outside"></b>',
                "children",
                false,
            ],
        ] as const) {
            const doc = document.implementation.createHTMLDocument();
            doc.body.innerHTML = `${initial}<section id="target"><i id="old"></i></section>`;
            const candidate = cachedDocumentIds(doc);
            try {
                const patches = patch(doc, html, operation);
                const baseline = () =>
                    validateDocumentIds(doc, patches, incomingIds(patches));
                // Production inspection supplies an independent oracle for incoming ID collection.
                expect(
                    accepted(() =>
                        preflightLive(
                            `<graft-patch-set version="1"><graft-patch operation="${operation}" target="target"><template>${html}</template></graft-patch></graft-patch-set>`,
                            doc,
                        ),
                    ),
                ).toBe(expected);
                expect(accepted(baseline)).toBe(expected);
                expect(accepted(() => candidate.validate(patches))).toBe(
                    expected,
                );
            } finally {
                candidate.dispose();
            }
        }
        const doc = document.implementation.createHTMLDocument();
        doc.body.innerHTML =
            '<section id="target"><i id=""></i><i id="x"></i><b id="x"></b></section>';
        const candidate = cachedDocumentIds(doc);
        const patches = patch(doc, '<b id="x"></b>');
        try {
            expect(
                accepted(() =>
                    validateDocumentIds(doc, patches, incomingIds(patches)),
                ),
            ).toBe(true);
            expect(accepted(() => candidate.validate(patches))).toBe(true);
            expect(candidate.counts.fallbacks).toBe(1);
            expect(accepted(() => candidate.validate([]))).toBe(false);
            expect(
                accepted(() => validateDocumentIds(doc, [], new Set())),
            ).toBe(false);
            doc.getElementById("target")!.replaceChildren(...patches[0]!.nodes);
            candidate.validate([]);
            const scans = candidate.counts.fullScans;
            candidate.validate([]);
            expect(candidate.counts.fullScans).toBe(scans);
        } finally {
            candidate.dispose();
        }
    });

    it("drains same-turn mutations and delivered records without caching hypothetical output", async () => {
        const doc = document.implementation.createHTMLDocument();
        doc.body.innerHTML = '<section id="target"></section><aside></aside>';
        const candidate = cachedDocumentIds(doc);
        const patches = patch(doc, '<b id="incoming"></b>');
        candidate.validate(patches);
        const aside = doc.querySelector("aside")!;
        aside.textContent = "text";
        aside.setAttribute("data-graft-key", "changed");
        candidate.validate(patches);
        expect(candidate.counts.fullScans).toBe(1);
        for (const delivered of [false, true]) {
            aside.id = "incoming";
            if (delivered)
                await new Promise((resolve) => setTimeout(resolve, 0));
            expect(accepted(() => candidate.validate(patches))).toBe(false);
            expect(
                accepted(() =>
                    validateDocumentIds(doc, patches, incomingIds(patches)),
                ),
            ).toBe(false);
            aside.removeAttribute("id");
            candidate.validate(patches);
        }
        aside.innerHTML = '<div><i id=""></i></div>';
        expect(accepted(() => candidate.validate(patches))).toBe(false);
        aside.replaceChildren();
        candidate.validate(patches);
        candidate.dispose();
        expect(() => candidate.validate(patches)).toThrow("disposed");
        const invalidations = candidate.counts.invalidations;
        const nextDocument = document.implementation.createHTMLDocument();
        const next = cachedDocumentIds(nextDocument);
        try {
            next.validate([]);
            aside.id = "";
            nextDocument.body.innerHTML = '<i id=""></i>';
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(candidate.counts.invalidations).toBe(invalidations);
            expect(accepted(() => next.validate([]))).toBe(false);
            expect(
                accepted(() =>
                    validateDocumentIds(nextDocument, [], new Set()),
                ),
            ).toBe(false);
        } finally {
            next.dispose();
        }
    });

    it("excludes all replaced regions and retains the cache for ID-free subtrees", () => {
        const doc = document.implementation.createHTMLDocument();
        doc.body.innerHTML =
            '<section id="target"><i id="old"></i></section><section id="second"><i id="other"></i></section>';
        const candidate = cachedDocumentIds(doc);
        try {
            const patches = patch(doc, '<b id="other"></b>');
            patches.push({
                target: doc.getElementById("second")!,
                targetId: "second",
                operation: "children",
                nodes: [],
            });
            validateDocumentIds(doc, patches, incomingIds(patches));
            candidate.validate(patches);
            const subtree = doc.createElement("div");
            subtree.innerHTML =
                '<i></i><template><b id="inert"></b></template>';
            doc.body.append(subtree);
            subtree.remove();
            candidate.validate(patches);
            expect(candidate.counts.fullScans).toBe(1);
            const root = doc.createElement("div");
            root.id = "";
            doc.body.append(root);
            expect(accepted(() => candidate.validate(patches))).toBe(false);
            root.remove();
            candidate.validate(patches);
            expect(candidate.counts.invalidations).toBe(2);
        } finally {
            candidate.dispose();
        }
    });

    it("retains host callback, custom-element and partial failure mutations", () => {
        const host = document.createElement("div");
        host.innerHTML =
            '<section id="id-test-target"></section><aside id="id-test-outside"></aside>';
        document.body.append(host);
        const candidate = cachedDocumentIds(document);
        try {
            candidate.validate([]);
            const envelope =
                '<graft-patch-set version="1"><graft-patch operation="children" target="id-test-target"><template><b id="id-test-incoming"></b></template></graft-patch></graft-patch-set>';
            expect(() =>
                preflightLive(envelope, document, () => {
                    host.lastElementChild!.id = "id-test-incoming";
                }),
            ).toThrow();
            expect(
                accepted(() =>
                    candidate.validate([
                        {
                            target: host.firstElementChild as HTMLElement,
                            targetId: "id-test-target",
                            operation: "children",
                            nodes: [
                                Object.assign(document.createElement("b"), {
                                    id: "id-test-incoming",
                                }),
                            ],
                        },
                    ]),
                ),
            ).toBe(false);
            host.lastElementChild!.id = "id-test-outside";
            if (!customElements.get("id-test-effect"))
                customElements.define(
                    "id-test-effect",
                    class extends HTMLElement {
                        connectedCallback() {
                            this.id = "id-test-outside";
                        }
                    },
                );
            const batch = preflightLive(
                envelope.replace(
                    '<b id="id-test-incoming"></b>',
                    "<id-test-effect></id-test-effect>",
                ),
            );
            apply(batch);
            expect(accepted(() => candidate.validate([]))).toBe(false);
            host.firstElementChild!.replaceChildren();
            candidate.validate([]);
            const retained = document.createElement("b");
            host.firstElementChild!.append(retained);
            const partial = preflightLive(
                envelope.replace('<b id="id-test-incoming"></b>', "<b></b>"),
            );
            expect(() =>
                apply(partial, () => {
                    retained.id = "id-test-outside";
                    throw new Error("partial");
                }),
            ).toThrow();
            expect(accepted(() => candidate.validate([]))).toBe(false);
            expect(
                accepted(() => validateDocumentIds(document, [], new Set())),
            ).toBe(false);
        } finally {
            candidate.dispose();
            host.remove();
        }
    });
});

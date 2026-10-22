import { afterEach, expect, test, vi } from "vitest";
import { startHypergraft, resetHypergraftForTests } from "./requests";
import { listenForNavigation } from "./events";
import { MEDIA_TYPE } from "./patches";
import type { NavigationScrollOptions } from "./scroll-restoration";

const original = location.href;
afterEach(() => {
    resetHypergraftForTests();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    history.pushState({}, "", original);
});

// Keep this matrix separate from history traversal tests to stay below WebKit's history update rate limit.
const navigationPolicies: (NavigationScrollOptions | undefined)[] = [
    undefined,
    { mode: "reset" },
    { mode: "targeted", pageRoot: "main" },
    { mode: "preserve" },
];

test.for(navigationPolicies)(
    "navigation scroll policy %j respects replacement boundaries with history on or off",
    async (navigationScroll, { onTestFinished }) => {
        const filler = '<div style="width:2000px;height:2000px"></div>';
        const container = (id: string, content = filler) =>
            `<section id="${id}" tabindex="-1" data-graft-scroll style="width:200px;height:200px;overflow:auto">${content}</section>`;
        const editorContent = `<div id="editor-body">${container("nested")}${filler}</div>`;
        const mainContent = `${container("list")}${container("editor", editorContent)}${filler}`;
        let settled = 0;
        onTestFinished(
            listenForNavigation((detail) => {
                if (detail.state === "succeeded") settled++;
            }),
        );
        let envelope = "";
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(envelope, {
                        headers: { "content-type": MEDIA_TYPE },
                    }),
            ),
        );
        const patch = (
            target: string,
            content: string,
            operation = "children",
        ) =>
            `<graft-patch operation="${operation}" target="${target}"><template>${content}</template></graft-patch>`;
        for (const scrollRestoration of [false, true]) {
            document.body.innerHTML = `<a id="next" data-graft href="?policy">Next</a><main id="main" tabindex="-1">${mainContent}</main>${container("outside")}`;
            startHypergraft({ navigationScroll, scrollRestoration });
            for (const [patches, resetIds, resetWindow] of [
                [patch("editor", editorContent), ["editor", "nested"], false],
                [
                    patch("editor-body", container("nested") + filler),
                    ["nested"],
                    false,
                ],
                [patch("editor", "<p>Appended</p>", "append"), [], false],
                [
                    patch("editor", editorContent) + patch("list", filler),
                    ["editor", "nested", "list"],
                    false,
                ],
                [
                    patch("main", mainContent),
                    ["editor", "nested", "list"],
                    true,
                ],
            ] as const) {
                const owners = ["list", "editor", "nested", "outside"].map(
                    (id) => document.getElementById(id)!,
                );
                for (const owner of owners) owner.scrollTo(30, 80);
                window.scrollTo(40, 600);
                envelope = `<graft-patch-set version="1">${patches}</graft-patch-set>`;
                const expectedSettled = settled + 1;
                document.getElementById("next")!.click();
                await expect.poll(() => settled).toBe(expectedSettled);
                const mode = navigationScroll?.mode ?? "reset";
                for (const owner of owners) {
                    expect(document.getElementById(owner.id)).toBe(owner);
                    const reset =
                        mode === "reset" ||
                        (mode === "targeted" &&
                            (resetIds as readonly string[]).includes(owner.id));
                    expect(owner.scrollTop, owner.id).toBeCloseTo(
                        reset ? 0 : 80,
                        0,
                    );
                    expect(owner.scrollLeft, owner.id).toBeCloseTo(
                        reset ? 0 : 30,
                        0,
                    );
                }
                const reset =
                    mode === "reset" || (mode === "targeted" && resetWindow);
                expect(scrollY).toBeCloseTo(reset ? 0 : 600, 0);
                expect(scrollX).toBeCloseTo(reset ? 0 : 40, 0);
            }
        }
    },
);

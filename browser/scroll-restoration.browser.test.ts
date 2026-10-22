import { afterEach, expect, test, vi } from "vitest";
import { startHypergraft, resetHypergraftForTests } from "./requests";
import { listenForNavigation } from "./events";
import { MEDIA_TYPE } from "./patches";
import { defineIslandModules } from "./required-islands";
import type { IslandInitialiser } from "./islands";
import type { NavigationScrollOptions } from "./scroll-restoration";

const original = location.href;
afterEach(() => {
    resetHypergraftForTests();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    // Discard forward history before Vitest reuses the page for another file.
    history.pushState({}, "", original);
});

test("leaving a committed cold page preserves the previous entry's position and restores only after required geometry", async ({
    onTestFinished,
}) => {
    const content = (island = "", height = 400) =>
        `<div id="panel" data-graft-scroll ${island ? `data-island="${island}"` : ""} style="height:200px;overflow:auto"><div style="height:${height}px"></div><p data-graft-scroll-anchor="row">Row</p><div style="height:2000px"></div></div>`;
    document.body.innerHTML = `<a id="next" data-graft href="?slow">Next</a><main id="main" data-graft-workspace tabindex="-1">${content()}</main>`;
    history.pushState({}, "", "?initial");
    let resolve!: (module: { islands: { slow: IslandInitialiser } }) => void;
    const loading = new Promise<{ islands: { slow: IslandInitialiser } }>(
        (yes) => {
            resolve = yes;
        },
    );
    const obsolete = vi.fn();
    let settled = 0;
    onTestFinished(
        listenForNavigation((detail) => {
            if (detail.state === "succeeded") settled++;
        }),
    );
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async (url: URL) =>
                new Response(
                    `<graft-patch-set version="1"><graft-patch operation="children" target="main"><template>${content(url.search === "?slow" ? "slow" : url.search === "?initial" ? "geometry" : "", 100)}</template></graft-patch></graft-patch-set>`,
                    { headers: { "content-type": MEDIA_TYPE } },
                ),
        ),
    );
    startHypergraft({
        scrollRestoration: true,
        islands: defineIslandModules([
            { names: ["slow"], load: () => loading },
            {
                names: ["geometry"],
                load: async () => ({
                    islands: {
                        geometry(root) {
                            (
                                root.firstElementChild as HTMLElement
                            ).style.height = "600px";
                        },
                    },
                }),
            },
        ]),
    });
    const panel = () => document.getElementById("panel")!;
    const offset = () =>
        panel()
            .querySelector<HTMLElement>("[data-graft-scroll-anchor]")!
            .getBoundingClientRect().top - panel().getBoundingClientRect().top;
    panel().scrollTop = 420;
    const saved = offset();
    document.getElementById("next")!.click();
    await expect.poll(() => location.search).toBe("?slow");
    expect(settled).toBe(0);
    panel().scrollTop = 80;
    (document.getElementById("next") as HTMLAnchorElement).href = "?quick";
    document.getElementById("next")!.click();
    await expect.poll(() => settled).toBe(1);
    resolve({ islands: { slow: obsolete } });
    history.go(-2);
    await expect.poll(() => settled).toBe(2);
    expect(location.search).toBe("?initial");
    expect(offset()).toBeCloseTo(saved, 0);
    expect(obsolete).not.toHaveBeenCalled();
});

test.for(["reset", "targeted", "preserve"] as const)(
    "%s navigation leaves fresh history restoration independent",
    async (mode, { onTestFinished }) => {
        const content = (height: number, anchor = true) =>
            `<div style="height:${height}px"></div><p ${anchor ? 'data-graft-scroll-anchor="row"' : ""}>Row</p><div style="height:2000px"></div>`;
        document.body.innerHTML = `<a data-graft href="?next">Next</a><main id="main" tabindex="-1"><div id="panel" data-graft-scroll style="height:200px;overflow:auto">${content(400)}</div>${content(800)}</main>`;
        let changed = false;
        let missing = false;
        let settled = 0;
        onTestFinished(
            listenForNavigation((detail) => {
                if (detail.state === "succeeded") settled++;
            }),
        );
        const fetcher = vi.fn(
            async () =>
                new Response(
                    `<graft-patch-set version="1"><graft-patch operation="children" target="main"><template><div id="panel" data-graft-scroll style="height:200px;overflow:auto">${content(changed ? 600 : 400, !missing)}</div>${content(changed ? 1100 : 800, !missing)}</template></graft-patch></graft-patch-set>`,
                    { headers: { "content-type": MEDIA_TYPE } },
                ),
        );
        vi.stubGlobal("fetch", fetcher);
        // Keep traversal inside test-owned entries, not Vitest's iframe navigation.
        history.pushState({}, "", "?scroll=initial");
        startHypergraft({
            scrollRestoration: true,
            navigationScroll:
                mode === "targeted" ? { mode, pageRoot: "main" } : { mode },
        });
        const panel = () => document.getElementById("panel")!;
        panel().scrollTop = 420;
        window.scrollTo(0, 1050);
        const windowOffset = document
            .querySelector<HTMLElement>("main > [data-graft-scroll-anchor]")!
            .getBoundingClientRect().top;
        const panelOffset =
            panel()
                .querySelector<HTMLElement>("[data-graft-scroll-anchor]")!
                .getBoundingClientRect().top -
            panel().getBoundingClientRect().top;
        document.querySelector<HTMLAnchorElement>("a")!.click();
        await expect.poll(() => settled).toBe(1);
        expect(scrollY).toBeCloseTo(mode === "preserve" ? 1050 : 0, 0);
        expect(panel().scrollTop).toBe(mode === "preserve" ? 420 : 0);
        changed = true;
        history.back();
        await expect.poll(() => settled).toBe(2);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(
            document
                .querySelector<HTMLElement>(
                    "main > [data-graft-scroll-anchor]",
                )!
                .getBoundingClientRect().top,
        ).toBeCloseTo(windowOffset, 0);
        expect(
            panel()
                .querySelector<HTMLElement>("[data-graft-scroll-anchor]")!
                .getBoundingClientRect().top -
                panel().getBoundingClientRect().top,
        ).toBeCloseTo(panelOffset, 0);
        history.forward();
        await expect.poll(() => settled).toBe(3);
        missing = true;
        history.back();
        await expect.poll(() => settled).toBe(4);
        expect(scrollY).toBe(0);
        expect(panel().scrollTop).toBe(0);
    },
);

test("targeted navigation includes progress replacements but waits for a clean stream end", async ({
    onTestFinished,
}) => {
    const filler = '<div style="height:2000px"></div>';
    const panel = `<div id="panel" data-graft-scroll style="height:200px;overflow:auto">${filler}</div>`;
    document.body.innerHTML = `<a id="next" data-graft href="?stream">Next</a><main id="main" tabindex="-1">${panel}${filler}</main><div id="outside" data-graft-scroll style="height:200px;overflow:auto">${filler}</div>`;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(value) {
                            controller = value;
                        },
                    }),
                    {
                        headers: {
                            "content-type": MEDIA_TYPE,
                            "Graft-Transfer": "stream",
                        },
                    },
                ),
        ),
    );
    let settled = false;
    onTestFinished(
        listenForNavigation((detail) => {
            if (detail.state === "succeeded") settled = true;
        }),
    );
    startHypergraft({
        navigationScroll: { mode: "targeted", pageRoot: "main" },
    });
    document.getElementById("panel")!.scrollTop = 100;
    document.getElementById("outside")!.scrollTop = 150;
    window.scrollTo(0, 600);
    document.getElementById("next")!.click();
    await expect.poll(() => controller).toBeDefined();
    const send = (frame: string) => {
        const bytes = new TextEncoder().encode(frame);
        controller.enqueue(new TextEncoder().encode(`${bytes.length}\n`));
        controller.enqueue(bytes);
    };
    send(
        `<graft-patch-set version="1" phase="progress"><graft-patch operation="children" target="main"><template>${panel}${filler}</template></graft-patch></graft-patch-set>`,
    );
    send(
        '<graft-patch-set version="1" phase="final"><graft-patch operation="append" target="outside"><template><p id="finished">Finished</p></template></graft-patch></graft-patch-set>',
    );
    await expect.poll(() => document.getElementById("finished")).not.toBeNull();
    const beforeEnd = {
        settled,
        windowY: scrollY,
        panelY: document.getElementById("panel")!.scrollTop,
    };
    controller.close();
    await expect.poll(() => settled).toBe(true);
    expect(beforeEnd.settled).toBe(false);
    expect(beforeEnd.windowY).toBeCloseTo(600, 0);
    expect(beforeEnd.panelY).toBeCloseTo(100, 0);
    expect(scrollY).toBe(0);
    expect(document.getElementById("panel")!.scrollTop).toBe(0);
    expect(document.getElementById("outside")!.scrollTop).toBeCloseTo(150, 0);
});

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

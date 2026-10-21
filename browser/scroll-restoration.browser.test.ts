import { afterEach, expect, test, vi } from "vitest";
import { startHypergraft, resetHypergraftForTests } from "./requests";
import { listenForNavigation } from "./events";
import { MEDIA_TYPE } from "./patches";
import { defineIslandModules } from "./required-islands";
import type { IslandInitialiser } from "./islands";

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

test("fresh traversal restores anchors after geometry changes and resets missing anchors", async ({
    onTestFinished,
}) => {
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
    startHypergraft({ scrollRestoration: true });
    const panel = () => document.getElementById("panel")!;
    panel().scrollTop = 420;
    window.scrollTo(0, 1050);
    const windowOffset = document
        .querySelector<HTMLElement>("main > [data-graft-scroll-anchor]")!
        .getBoundingClientRect().top;
    const panelOffset =
        panel()
            .querySelector<HTMLElement>("[data-graft-scroll-anchor]")!
            .getBoundingClientRect().top - panel().getBoundingClientRect().top;
    document.querySelector<HTMLAnchorElement>("a")!.click();
    await expect.poll(() => settled).toBe(1);
    expect(scrollY).toBe(0);
    expect(panel().scrollTop).toBe(0);
    changed = true;
    history.back();
    await expect.poll(() => settled).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
        document
            .querySelector<HTMLElement>("main > [data-graft-scroll-anchor]")!
            .getBoundingClientRect().top,
    ).toBeCloseTo(windowOffset, 0);
    expect(
        panel()
            .querySelector<HTMLElement>("[data-graft-scroll-anchor]")!
            .getBoundingClientRect().top - panel().getBoundingClientRect().top,
    ).toBeCloseTo(panelOffset, 0);
    history.forward();
    await expect.poll(() => settled).toBe(3);
    missing = true;
    history.back();
    await expect.poll(() => settled).toBe(4);
    expect(scrollY).toBe(0);
    expect(panel().scrollTop).toBe(0);
});

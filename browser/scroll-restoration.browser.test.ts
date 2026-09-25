import { afterEach, expect, test, vi } from "vitest";
import { startHypergraft, resetHypergraftForTests } from "./requests";
import { listenForNavigation } from "./events";
import { MEDIA_TYPE } from "./patches";

const original = location.href;
afterEach(() => {
    resetHypergraftForTests();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    history.replaceState({}, "", original);
});

test("fresh traversal restores anchors after geometry changes and resets missing anchors", async () => {
    const content = (height: number, anchor = true) =>
        `<div style="height:${height}px"></div><p ${anchor ? 'data-graft-scroll-anchor="row"' : ""}>Row</p><div style="height:2000px"></div>`;
    document.body.innerHTML = `<a data-graft href="?next">Next</a><main id="main" tabindex="-1"><div id="panel" data-graft-scroll style="height:200px;overflow:auto">${content(400)}</div>${content(800)}</main>`;
    let changed = false;
    let missing = false;
    let settled = 0;
    const stopListener = listenForNavigation((detail) => {
        if (detail.state === "succeeded") settled++;
    });
    const fetcher = vi.fn(
        async () =>
            new Response(
                `<graft-patch-set version="1"><graft-patch operation="children" target="main"><template><div id="panel" data-graft-scroll style="height:200px;overflow:auto">${content(changed ? 600 : 400, !missing)}</div>${content(changed ? 1100 : 800, !missing)}</template></graft-patch></graft-patch-set>`,
                { headers: { "content-type": MEDIA_TYPE } },
            ),
    );
    vi.stubGlobal("fetch", fetcher);
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
    stopListener();
});

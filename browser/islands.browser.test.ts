import { expect, test } from "vitest";
import {
    collectIslands,
    lazyIsland,
    observeIslands,
    type IslandInitialiser,
} from "./islands";
import { apply, preflightLive } from "./patches";
import { startHypergraft } from "./requests";

test("lazy imports mount retained and replaced roots against current markup without replaying gestures", async () => {
    const host = document.createElement("main");
    host.id = "lazy-target";
    host.innerHTML =
        '<section id="retained" data-island="heavy"><button>Old action</button></section><section id="replaced" data-island="heavy"><button>Old action</button></section>';
    document.body.append(host);
    const retained = host.firstElementChild!;
    const removed = host.lastElementChild!;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
        release = resolve;
    });
    let loads = 0;
    const mounted: HTMLElement[] = [];
    const registry = collectIslands({
        feature: {
            islands: {
                heavy: lazyIsland(async () => {
                    loads += 1;
                    await ready;
                    const { initialise } =
                        await import("./fixtures/lazy-island");
                    return ((element, context) => {
                        mounted.push(element);
                        return initialise(element, context);
                    }) satisfies IslandInitialiser;
                }),
            },
        },
    });
    const stop = observeIslands(registry);
    try {
        apply(
            preflightLive(
                '<graft-patch-set version="1"><graft-patch operation="children" target="lazy-target"><template><section id="retained" data-island="heavy"><button>Current action</button></section><section id="replacement" data-island="heavy"><button>Current action</button></section></template></graft-patch></graft-patch-set>',
            ),
        );
        expect(host.firstElementChild).toBe(retained);
        expect(removed.isConnected).toBe(false);
        const button = retained.querySelector("button")!;
        expect(button.disabled).toBe(false);
        button.click();
        expect(retained.getAttribute("data-clicks")).toBeNull();
        release();
        await expect.poll(() => mounted.length).toBe(2);
        expect(loads).toBe(1);
        expect(mounted).toEqual([retained, host.lastElementChild]);
        expect(retained.getAttribute("data-clicks")).toBeNull();
        button.click();
        expect(retained.getAttribute("data-clicks")).toBe("1");
        expect(host.lastElementChild!.getAttribute("data-clicks")).toBeNull();
        stop();
        button.click();
        expect(retained.getAttribute("data-clicks")).toBe("1");
        expect(retained.getAttribute("data-cleaned")).toBe("true");
    } finally {
        stop();
        host.remove();
    }
});

test("a runtime error hook identifies the root for an eager retry without replacing its draft or duplicating handlers", async () => {
    const host = document.createElement("main");
    host.innerHTML =
        '<button type="button" data-retry>Retry preview</button><section data-island="preview"><input value="saved"><button type="button">Preview action</button></section>';
    document.body.append(host);
    const root = host.querySelector<HTMLElement>("section")!;
    const input = root.querySelector("input")!;
    input.value = "unsaved draft";
    const mounted: HTMLElement[] = [];
    let attempts = 0;
    let failedRoot: HTMLElement | undefined;
    const accepted: boolean[] = [];
    const owner = new AbortController();
    const stop = startHypergraft({
        islands: {
            preview: lazyIsland(async () => {
                if (++attempts === 1) throw new Error("Expected load failure");
                const { initialise } = await import("./fixtures/lazy-island");
                return (element, context) => {
                    mounted.push(element);
                    return initialise(element, context);
                };
            }),
        },
        onIslandError(_name, _phase, _error, element) {
            failedRoot = element;
        },
    });
    const retry = host.querySelector<HTMLButtonElement>("[data-retry]")!;
    retry.addEventListener(
        "click",
        () => {
            if (failedRoot) accepted.push(stop.retryIsland(failedRoot));
        },
        { signal: owner.signal },
    );
    try {
        await expect.poll(() => failedRoot).toBe(root);
        retry.click();
        retry.click();
        expect(accepted).toEqual([true, false]);
        await expect.poll(() => mounted.length).toBe(1);
        expect(attempts).toBe(2);
        expect(mounted).toEqual([root]);
        expect(root.querySelector("input")).toBe(input);
        expect(input.value).toBe("unsaved draft");
        root.querySelector("button")!.click();
        expect(root.dataset.clicks).toBe("1");
        retry.click();
        expect(accepted).toEqual([true, false, false]);
        stop();
        root.querySelector("button")!.click();
        expect(root.dataset.clicks).toBe("1");
        expect(root.dataset.cleaned).toBe("true");
        expect(stop.retryIsland(root)).toBe(false);
    } finally {
        owner.abort();
        stop();
        host.remove();
    }
});

test("disposal inside a mutation scan skips queued loads and later eager roots", async () => {
    const host = document.createElement("main");
    document.body.append(host);
    let loads = 0;
    let mounts = 0;
    let destroyed = 0;
    const stop = observeIslands({
        heavy: lazyIsland(async () => {
            loads++;
            return () => {
                mounts++;
            };
        }),
        stop: (_root, { signal }) => {
            stop();
            return () => {
                expect(signal.aborted).toBe(true);
                destroyed++;
            };
        },
        later: () => {
            mounts++;
        },
    });
    try {
        host.innerHTML =
            '<section><div data-island="heavy"></div><div data-island="stop"></div><div data-island="later"></div></section>';
        await expect.poll(() => destroyed).toBe(1);
        expect(loads).toBe(0);
        expect(mounts).toBe(0);
    } finally {
        stop();
        host.remove();
    }
});

test("island attribute changes update lifetimes on a retained root", async () => {
    const host = document.createElement("div");
    host.id = "island-target";
    host.innerHTML = '<section id="island-root"><b>Content</b></section>';
    document.body.append(host);
    const root = host.firstElementChild;
    const mounted: HTMLElement[] = [];
    const aborted: boolean[] = [];
    const initialise = (
        element: HTMLElement,
        { signal }: { signal: AbortSignal },
    ) => {
        mounted.push(element);
        return { destroy: () => aborted.push(signal.aborted) };
    };
    const dispose = observeIslands(
        collectIslands({
            first: { islands: { first: initialise } },
            second: { islands: () => ({ second: initialise }) },
        }),
    );
    const update = async (attribute: string) => {
        apply(
            preflightLive(
                `<graft-patch-set version="1"><graft-patch operation="children" target="island-target"><template><section id="island-root"${attribute}><b>Content</b></section></template></graft-patch></graft-patch-set>`,
            ),
        );
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(host.firstElementChild).toBe(root);
    };
    try {
        expect(mounted).toEqual([]);
        await update(' data-island="first"');
        expect(mounted).toEqual([root]);
        await update(' data-island="second"');
        expect(mounted).toEqual([root, root]);
        expect(aborted).toEqual([true]);
        await update("");
        expect(aborted).toEqual([true, true]);
        expect(root!.isConnected).toBe(true);
    } finally {
        dispose();
        host.remove();
    }
});

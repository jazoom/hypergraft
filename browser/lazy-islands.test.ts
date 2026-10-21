// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
    LIVE_PATCH_EVENT,
    LOCATION_CHANGE_EVENT,
    REQUEST_SETTLED_EVENT,
    emitRequestSettled,
} from "./events";
import {
    collectIslands,
    lazyIsland,
    observeIslands,
    type IslandInitialiser,
    type IslandErrorReporter,
    type IslandMountContext,
} from "./islands";
import { resetHypergraftForTests, startHypergraft } from "./requests";
import { MEDIA_TYPE } from "./patches";

const mutations = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const stops: (() => void)[] = [];
beforeEach(() => document.body.replaceChildren());
afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    resetHypergraftForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function deferred() {
    let resolve!: (initialise: IslandInitialiser) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<IslandInitialiser>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function root(name = "heavy") {
    const element = document.createElement("section");
    element.dataset.island = name;
    document.body.append(element);
    return element;
}

test("collection is synchronous and lazy definitions do not load until a root appears", async () => {
    const eager = vi.fn();
    const heavy = vi.fn();
    const load = vi.fn(async () => heavy);
    const services = { notify: vi.fn() };
    const factory = vi.fn((received: typeof services) => {
        expect(received).toBe(services);
        return { eager, heavy: lazyIsland(load) };
    });
    const registry = collectIslands(
        { feature: { islands: factory } },
        services,
    );
    root("eager");
    stops.push(observeIslands(registry));
    expect(eager).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    await mutations();
    expect(load).not.toHaveBeenCalled();
    const element = root();
    await mutations();
    expect(load).toHaveBeenCalledOnce();
    expect(heavy).toHaveBeenCalledWith(
        element,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
});

test("lazy readiness does not gate or replay command submissions, including after load failure", async () => {
    document.body.innerHTML =
        '<section data-island="heavy"><form id="command" method="post" action="/command" data-graft><button>Save</button></form></section><div id="result"></div>';
    const form = document.querySelector("form")!;
    const loading = deferred();
    const fetchMock = vi.fn(
        async () =>
            new Response(
                '<graft-patch-set version="1"><graft-patch operation="children" target="result"><template>Saved</template></graft-patch></graft-patch-set>',
                { headers: { "content-type": MEDIA_TYPE } },
            ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    stops.push(
        startHypergraft({
            islands: { heavy: lazyIsland(() => loading.promise) },
        }),
    );
    form.requestSubmit();
    await mutations();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(document.getElementById("result")!.textContent).toBe("Saved");
    const error = new Error("load failed");
    loading.reject(error);
    await mutations();
    expect(report).toHaveBeenCalledExactlyOnceWith(
        'Island "heavy" failed to mount:',
        error,
    );
    expect(form.querySelector("button")!.disabled).toBe(false);
    form.requestSubmit();
    await mutations();
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

test.each(["eager", "lazy"] as const)(
    "runtime forwards %s lifecycle failures with the affected root instead of logging them",
    async (kind) => {
        const failed = root();
        const mounted = root();
        const mountError = new Error("mount");
        const reconcileError = new Error("reconcile");
        const destroyError = new Error("destroy");
        const report = vi.fn<IslandErrorReporter>();
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        const initialise: IslandInitialiser = (element) => {
            if (element === failed) throw mountError;
            return {
                reconcile() {
                    throw reconcileError;
                },
                destroy() {
                    throw destroyError;
                },
            };
        };
        const stop = startHypergraft({
            islands: {
                heavy:
                    kind === "lazy"
                        ? lazyIsland(async () => initialise)
                        : initialise,
            },
            onIslandError: report,
        });
        stops.push(stop);
        await mutations();
        emitRequestSettled({
            requestKind: "patch",
            form: document.createElement("form"),
            url: location.href,
            outcome: "safe-failure",
        });
        mounted.remove();
        await mutations();
        stop();
        expect(report.mock.calls).toEqual([
            ["heavy", "mount", mountError, failed],
            ["heavy", "reconcile", reconcileError, mounted],
            ["heavy", "destroy", destroyError, mounted],
        ]);
        expect(consoleError).not.toHaveBeenCalled();
    },
);

test("shared load failures report only current roots, including a replacement with the same ID", async () => {
    const current = root();
    const removed = root();
    const renamed = root();
    const unmarked = root();
    const replaced = root();
    replaced.id = "replaced-root";
    const loading = deferred();
    const report = vi.fn<IslandErrorReporter>();
    const load = vi.fn(() => loading.promise);
    stops.push(
        startHypergraft({
            islands: { heavy: lazyIsland(load), other: () => {} },
            onIslandError: report,
        }),
    );
    await mutations();
    removed.remove();
    renamed.dataset.island = "other";
    unmarked.removeAttribute("data-island");
    replaced.remove();
    const replacement = root();
    replacement.id = replaced.id;
    await mutations();
    const error = new Error("shared failure");
    loading.reject(error);
    await mutations();
    expect(load).toHaveBeenCalledOnce();
    expect(report.mock.calls).toEqual([
        ["heavy", "mount", error, current],
        ["heavy", "mount", error, replacement],
    ]);
});

test("ending and restarting the same node's lifetime while loading mounts only the new lifetime", async () => {
    const element = root();
    const loading = deferred();
    const load = vi.fn(() => loading.promise);
    const mount = vi.fn();
    stops.push(observeIslands({ heavy: lazyIsland(load) }));
    element.remove();
    await mutations();
    document.body.append(element);
    await mutations();
    loading.resolve(mount);
    await mutations();
    expect(load).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledOnce();
    expect(mount.mock.calls[0][0]).toBe(element);
});

test("roots share a load and cached code but not state or lifetimes", async () => {
    const loading = deferred();
    const load = vi.fn(() => loading.promise);
    const first = root();
    const second = root();
    const signals: AbortSignal[] = [];
    const destroyed: HTMLElement[] = [];
    const mount = vi.fn(
        (element: HTMLElement, { signal }: IslandMountContext) => {
            signals.push(signal);
            return () => {
                expect(signal.aborted).toBe(true);
                destroyed.push(element);
            };
        },
    );
    stops.push(observeIslands({ heavy: lazyIsland(load) }));
    document.body.prepend(second);
    await mutations();
    expect(load).toHaveBeenCalledOnce();
    loading.resolve(mount);
    await mutations();
    expect(mount.mock.calls.map(([element]) => element)).toEqual([
        first,
        second,
    ]);
    expect(signals[0]).not.toBe(signals[1]);
    first.remove();
    await mutations();
    expect(destroyed).toEqual([first]);
    expect(signals[1].aborted).toBe(false);
    root();
    await mutations();
    expect(mount).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenCalledOnce();
});

test("removed, renamed and unmarked roots cannot receive late mounts", async () => {
    const loading = deferred();
    const gone = root();
    const renamed = root();
    const unmarked = root();
    const heavy = vi.fn();
    const other = vi.fn();
    stops.push(
        observeIslands({ heavy: lazyIsland(() => loading.promise), other }),
    );
    gone.remove();
    renamed.dataset.island = "other";
    unmarked.removeAttribute("data-island");
    loading.resolve(heavy);
    await mutations();
    expect(heavy).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
    renamed.dataset.island = "heavy";
    await mutations();
    expect(heavy).toHaveBeenCalledOnce();
    expect(heavy.mock.calls[0][0]).toBe(renamed);
});

test("pending roots mount from current DOM without replaying earlier lifecycle facts", async () => {
    const loading = deferred();
    const element = root();
    element.id = "target";
    element.dataset.record = "old";
    const reconcile = vi.fn();
    const mount = vi.fn((element: HTMLElement) => {
        expect(element.dataset.record).toBe("new");
        expect(element.textContent).toBe("Current content");
        return { reconcile, destroy() {} };
    });
    stops.push(observeIslands({ heavy: lazyIsland(() => loading.promise) }));
    element.dataset.record = "new";
    element.textContent = "Current content";
    const facts = [
        [
            REQUEST_SETTLED_EVENT,
            { outcome: "applied-patch", targetIds: ["target"] },
        ],
        [LIVE_PATCH_EVENT, { targetIds: ["target"] }],
        [
            LOCATION_CHANGE_EVENT,
            { url: location.href, cause: "link-navigation" },
        ],
    ] as const;
    for (const [event, detail] of facts)
        dispatchEvent(new CustomEvent(event, { detail }));
    loading.resolve(mount);
    await mutations();
    expect(mount).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    for (const [event, detail] of facts)
        dispatchEvent(new CustomEvent(event, { detail }));
    expect(reconcile.mock.calls.map(([context]) => context.cause)).toEqual([
        "patch",
        "live-patch",
        "location",
    ]);
});

test("stopping before the loader starts skips it and its reports", async () => {
    const element = root();
    const load = vi.fn(async () => vi.fn());
    const report = vi.fn();
    const stop = observeIslands({ heavy: lazyIsland(load) }, report);
    stop();
    await mutations();
    expect(load).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(stop.retryIsland(element)).toBe(false);
});

test("replacement during initial eager mounting ends the old scan and queued loads", async () => {
    root();
    root("replace");
    root("later");
    const load = vi.fn(async () => vi.fn());
    const oldLater = vi.fn();
    const destroyed = vi.fn();
    const nextMount = vi.fn();
    const old = startHypergraft({
        islands: {
            heavy: lazyIsland(load),
            replace: (_root, { signal }) => {
                stops.push(
                    startHypergraft({
                        islands: {
                            heavy: nextMount,
                            replace: nextMount,
                            later: nextMount,
                        },
                    }),
                );
                expect(signal.aborted).toBe(true);
                return destroyed;
            },
            later: oldLater,
        },
    });
    stops.push(old);
    expect(destroyed).toHaveBeenCalledOnce();
    expect(nextMount).toHaveBeenCalledTimes(3);
    old();
    root("later");
    await mutations();
    expect(load).not.toHaveBeenCalled();
    expect(oldLater).not.toHaveBeenCalled();
    expect(nextMount).toHaveBeenCalledTimes(4);
});

test("explicit retries share loading, keep the same nodes and leave other failed roots alone", async () => {
    const first = root();
    const second = root();
    const third = root();
    const retry = deferred();
    const mount = vi.fn();
    const load = vi
        .fn<() => Promise<IslandInitialiser>>()
        .mockRejectedValueOnce(new Error("first attempt"))
        .mockReturnValueOnce(retry.promise);
    const report = vi.fn();
    const stop = observeIslands(
        { heavy: lazyIsland(load), eager: vi.fn<IslandInitialiser>() },
        report,
    );
    stops.push(stop);
    expect(stop.retryIsland(first)).toBe(false);
    await mutations();
    expect(report).toHaveBeenCalledTimes(3);
    expect(stop.retryIsland(first)).toBe(true);
    expect(stop.retryIsland(first)).toBe(false);
    expect(stop.retryIsland(second)).toBe(true);
    await mutations();
    expect(load).toHaveBeenCalledTimes(2);
    retry.resolve(mount);
    await mutations();
    expect(mount.mock.calls.map(([element]) => element)).toEqual([
        first,
        second,
    ]);
    expect(stop.retryIsland(first)).toBe(false);
    expect(stop.retryIsland(document.createElement("section"))).toBe(false);
    const eager = root("eager");
    await mutations();
    expect(stop.retryIsland(eager)).toBe(false);
    third.dataset.island = "eager";
    expect(stop.retryIsland(third)).toBe(false);
    third.dataset.island = "heavy";
    third.remove();
    expect(stop.retryIsland(third)).toBe(false);
    stop();
    document.body.append(third);
    expect(stop.retryIsland(third)).toBe(false);
});

test("a runtime retry handle cannot act on its replacement", async () => {
    const element = root();
    const mount = vi.fn();
    const load = vi
        .fn<() => Promise<IslandInitialiser>>()
        .mockRejectedValueOnce(new Error("old runtime"))
        .mockRejectedValueOnce(new Error("new runtime"))
        .mockResolvedValue(mount);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const islands = { heavy: lazyIsland(load) };
    const old = startHypergraft({ islands });
    stops.push(old);
    await mutations();
    const current = startHypergraft({ islands });
    stops.push(current);
    await mutations();
    expect(old.retryIsland(element)).toBe(false);
    expect(current.retryIsland(element)).toBe(true);
    expect(current.retryIsland(element)).toBe(false);
    await mutations();
    expect(load).toHaveBeenCalledTimes(3);
    expect(mount).toHaveBeenCalledOnce();
    current();
    expect(current.retryIsland(element)).toBe(false);
});

test("a retried root can fail again or end before completion without mounting", async () => {
    const element = root();
    const late = deferred();
    const mount = vi.fn();
    const report = vi.fn();
    const load = vi
        .fn<() => Promise<IslandInitialiser>>()
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValueOnce(new Error("second"))
        .mockReturnValueOnce(late.promise);
    const stop = observeIslands({ heavy: lazyIsland(load) }, report);
    stops.push(stop);
    await mutations();
    expect(stop.retryIsland(element)).toBe(true);
    await mutations();
    expect(report).toHaveBeenCalledTimes(2);
    expect(stop.retryIsland(element)).toBe(true);
    await mutations();
    element.remove();
    late.resolve(mount);
    await mutations();
    expect(mount).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(2);
});

test("retrying a mount failure reuses code but supplies a new lifetime", async () => {
    const element = root();
    const signals: AbortSignal[] = [];
    const destroy = vi.fn();
    const mount = vi.fn(
        (_root: HTMLElement, { signal }: IslandMountContext) => {
            signals.push(signal);
            if (signals.length === 1) throw new Error("mount failed");
            return destroy;
        },
    );
    const load = vi.fn(async () => mount);
    const stop = observeIslands({ heavy: lazyIsland(load) }, vi.fn());
    stops.push(stop);
    await mutations();
    expect(signals[0].aborted).toBe(true);
    expect(stop.retryIsland(element)).toBe(true);
    await mutations();
    expect(load).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1].aborted).toBe(false);
    stop();
    expect(signals[1].aborted).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
});

test.each(["resolve", "reject"] as const)(
    "runtime replacement owns a fresh load and ignores old loader %s",
    async (outcome) => {
        root();
        const old = deferred();
        const next = deferred();
        const load = vi
            .fn()
            .mockReturnValueOnce(old.promise)
            .mockReturnValueOnce(next.promise);
        const islands = { heavy: lazyIsland(load) };
        const stale = vi.fn();
        const current = vi.fn();
        const oldReport = vi.fn<IslandErrorReporter>();
        const currentReport = vi.fn<IslandErrorReporter>();
        const stopOld = startHypergraft({ islands, onIslandError: oldReport });
        await mutations();
        const stopNext = startHypergraft({
            islands,
            onIslandError: currentReport,
        });
        stops.push(stopOld, stopNext);
        await mutations();
        if (outcome === "resolve") old.resolve(stale);
        else old.reject(new Error("old runtime failure"));
        next.resolve(current);
        await mutations();
        expect(load).toHaveBeenCalledTimes(2);
        expect(stale).not.toHaveBeenCalled();
        expect(current).toHaveBeenCalledOnce();
        expect(oldReport).not.toHaveBeenCalled();
        expect(currentReport).not.toHaveBeenCalled();
    },
);

test.each(["resolve", "reject"] as const)(
    "disposal suppresses late loader %s",
    async (outcome) => {
        root();
        const loading = deferred();
        const mount = vi.fn();
        const report = vi.fn();
        const stop = startHypergraft({
            islands: { heavy: lazyIsland(() => loading.promise) },
            onIslandError: report,
        });
        await mutations();
        stop();
        if (outcome === "resolve") loading.resolve(mount);
        else loading.reject(new Error("late failure"));
        await mutations();
        expect(mount).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
    },
);

test("a lazy initialiser disposing its observer still aborts and reports destruction failures for its root", async () => {
    const element = root();
    const loading = deferred();
    const error = new Error("destroy after disposal");
    const destroy = vi.fn(() => {
        throw error;
    });
    const report = vi.fn<IslandErrorReporter>();
    const stop = observeIslands(
        { heavy: lazyIsland(() => loading.promise) },
        report,
    );
    loading.resolve((_element, { signal }) => {
        stop();
        expect(signal.aborted).toBe(true);
        return { destroy };
    });
    await mutations();
    expect(destroy).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith(
        "heavy",
        "destroy",
        error,
        element,
    );
});

test.each(["reject", "throw", "invalid"])(
    "loader %s reports per waiting root, with automatic retry only for a new lifetime",
    async (failure) => {
        const first = root();
        const second = root();
        const error = new Error("load failed");
        const mount = vi.fn();
        const load = vi
            .fn<() => Promise<IslandInitialiser>>()
            .mockImplementationOnce(() => {
                if (failure === "throw") throw error;
                if (failure === "invalid")
                    return Promise.resolve({} as IslandInitialiser);
                return Promise.reject(error);
            })
            .mockResolvedValue(mount);
        const report = vi.fn();
        stops.push(observeIslands({ heavy: lazyIsland(load) }, report));
        await mutations();
        expect(report).toHaveBeenCalledTimes(2);
        expect(
            report.mock.calls.every(
                ([name, phase]) => name === "heavy" && phase === "mount",
            ),
        ).toBe(true);
        document.body.append(first);
        dispatchEvent(new CustomEvent(LOCATION_CHANGE_EVENT, { detail: {} }));
        await mutations();
        expect(load).toHaveBeenCalledOnce();
        const fresh = root();
        await mutations();
        expect(load).toHaveBeenCalledTimes(2);
        expect(mount.mock.calls.map(([element]) => element)).toEqual([fresh]);
        first.remove();
        await mutations();
        document.body.append(first);
        await mutations();
        expect(mount.mock.calls.map(([element]) => element)).toEqual([
            fresh,
            first,
        ]);
        expect(mount.mock.calls.some(([element]) => element === second)).toBe(
            false,
        );
    },
);

test("one failed mount does not poison shared code or retry on unrelated scans", async () => {
    const bad = root();
    const good = root();
    const error = new Error("mount failed");
    const report = vi.fn();
    let failedSignal: AbortSignal | undefined;
    const mount = vi.fn(
        (element: HTMLElement, { signal }: IslandMountContext) => {
            if (element === bad) {
                failedSignal = signal;
                throw error;
            }
        },
    );
    const load = vi.fn(async () => mount);
    stops.push(observeIslands({ heavy: lazyIsland(load) }, report));
    await mutations();
    expect(mount.mock.calls.map(([element]) => element)).toEqual([bad, good]);
    expect(failedSignal?.aborted).toBe(true);
    expect(report).toHaveBeenCalledWith("heavy", "mount", error, bad);
    dispatchEvent(new CustomEvent(LOCATION_CHANGE_EVENT, { detail: {} }));
    await mutations();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledOnce();
});

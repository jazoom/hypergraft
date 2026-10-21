// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import {
    defineIslandModules,
    type RequiredIslandModule,
} from "./required-islands";
import {
    startHypergraft,
    resetHypergraftForTests,
    commandBlockReason,
    cancelNavigation,
} from "./requests";
import {
    listenBeforeNavigation,
    listenForNavigation,
    listenForRequestSettled,
    listenForLocationChanges,
    type NavigationDetail,
} from "./events";
import { MEDIA_TYPE } from "./patches";
import type { IslandInitialiser } from "./islands";

const stops: (() => void)[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function page(content = '<div data-island="editor"></div>') {
    history.replaceState({}, "", "/start");
    document.body.innerHTML = `<a href="/next" data-graft id="next">Next</a><form id="shell" method="post" action="/shell" data-graft></form><section data-graft-workspace-feedback><p data-graft-workspace-loading>Loading</p><p data-graft-workspace-failure hidden>Reload</p><a href="">Reload</a></section><main id="main" data-graft-workspace inert aria-busy="true">${content}<form id="save" method="post" action="/save" data-graft><button>Save</button></form></main><button form="save" id="external">Save</button><aside id="result"></aside>`;
}
function reply(content: string, target = "main", status = 200) {
    return new Response(
        `<graft-patch-set version="1"><graft-patch operation="children" target="${target}"><template>${content}</template></graft-patch></graft-patch-set>`,
        { status, headers: { "Content-Type": MEDIA_TYPE } },
    );
}
function start(modules: RequiredIslandModule[], onIslandError = vi.fn()) {
    const stop = startHypergraft({
        islands: defineIslandModules(modules),
        onIslandError,
    });
    stops.push(stop);
    return stop;
}
function submit(id = "save") {
    (document.getElementById(id) as HTMLFormElement).requestSubmit();
}
afterEach(() => {
    stops
        .splice(0)
        .reverse()
        .forEach((stop) => stop());
    resetHypergraftForTests();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
});

test.each([
    ...["command", "query", "navigation"].flatMap((path) =>
        ["ready", "failure"].map((ending) => ({ path, ending })),
    ),
    ...["command-location", "query-location", "stream"].map((path) => ({
        path,
        ending: "ready",
    })),
])(
    "$path waits for reconciliation-created roots before $ending completion",
    async ({ path, ending }) => {
        page(
            '<div id="editor" data-island="editor"></div><section id="updated"></section>',
        );
        const loading = deferred<{ islands: { child: IslandInitialiser } }>();
        const mount = vi.fn();
        const load = vi.fn(() => loading.promise);
        const form = document.getElementById("save") as HTMLFormElement;
        if (
            path === "query" ||
            path === "query-location" ||
            path === "stream"
        ) {
            form.method = "get";
            if (path !== "query-location") form.dataset.graftHistory = "none";
        }
        let html = await reply("Updated", "updated").text();
        if (path === "command-location")
            html = html.replace('version="1"', 'version="1" location="/saved"');
        if (path === "stream")
            html = html.replace('version="1"', 'version="1" phase="final"');
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                path === "stream"
                    ? `${new TextEncoder().encode(html).length}\n${html}`
                    : html,
                {
                    headers: {
                        "Content-Type": MEDIA_TYPE,
                        "Graft-Transfer":
                            path === "stream" ? "stream" : "complete",
                    },
                },
            ),
        );
        const facts: string[] = [];
        stops.push(
            listenForRequestSettled((detail) => facts.push(detail.outcome)),
            listenForLocationChanges(() => facts.push("location")),
            listenForNavigation((detail) => {
                if (detail.state !== "started") facts.push(detail.state);
            }),
        );
        const reconcile = vi.fn((root: HTMLElement) => {
            expect(form.hasAttribute("data-graft-pending")).toBe(false);
            if (!root.firstElementChild)
                root.innerHTML = '<div data-island="child"></div>';
        });
        start([
            {
                names: ["editor"],
                module: {
                    islandLoading: "eager",
                    islands: {
                        editor: (root) => ({
                            destroy() {},
                            reconcile: () => reconcile(root),
                        }),
                    },
                },
            },
            { names: ["child"], load },
        ]);
        if (path === "navigation") document.getElementById("next")!.click();
        else submit();
        await flush();
        expect(load).toHaveBeenCalledOnce();
        expect(mount).not.toHaveBeenCalled();
        expect(facts).toEqual([]);
        expect(document.getElementById("main")!.hasAttribute("inert")).toBe(
            true,
        );
        expect(commandBlockReason()).toBe(
            path.startsWith("command")
                ? "pending-command"
                : path === "navigation"
                  ? "pending-navigation"
                  : undefined,
        );
        if (ending === "failure") loading.reject(new Error("Unavailable"));
        else loading.resolve({ islands: { child: mount } });
        await flush();
        expect(fetch).toHaveBeenCalledOnce();
        expect(mount).toHaveBeenCalledTimes(ending === "ready" ? 1 : 0);
        if (ending === "failure") {
            expect(facts).toEqual([
                path === "navigation"
                    ? "failed"
                    : path === "command"
                      ? "uncertain-unsafe-result"
                      : "safe-failure",
            ]);
            expect(commandBlockReason()).toBe(
                path === "command" ? "uncertain-command" : undefined,
            );
            expect(
                document.querySelector<HTMLElement>(
                    "[data-graft-workspace-failure]",
                )!.hidden,
            ).toBe(false);
        } else {
            expect(facts).toEqual(
                path === "navigation"
                    ? ["location", "succeeded"]
                    : path.endsWith("-location")
                      ? ["location", "applied-patch"]
                      : ["applied-patch"],
            );
            expect(reconcile).toHaveBeenCalledTimes(
                path.endsWith("-location") ? 2 : 1,
            );
            expect(commandBlockReason()).toBeUndefined();
            expect(document.getElementById("main")!.hasAttribute("inert")).toBe(
                false,
            );
        }
    },
);

test.each(["query", "navigation"])(
    "retiring a %s during reconciliation ends its new-root wait",
    async (path) => {
        page(
            '<div data-island="editor"></div><section id="updated"></section>',
        );
        const loading = deferred<{ islands: { child: IslandInitialiser } }>();
        const mount = vi.fn();
        const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(reply("Updated", "updated"));
        const settlements = vi.fn();
        const navigations: NavigationDetail[] = [];
        stops.push(
            listenForRequestSettled(settlements),
            listenForNavigation((detail) => navigations.push(detail)),
        );
        start([
            {
                names: ["editor"],
                module: {
                    islandLoading: "eager",
                    islands: {
                        editor: (root) => ({
                            destroy() {},
                            reconcile() {
                                if (!root.firstElementChild)
                                    root.innerHTML =
                                        '<div data-island="child"></div>';
                            },
                        }),
                    },
                },
            },
            { names: ["child"], load: () => loading.promise },
        ]);
        if (path === "navigation") document.getElementById("next")!.click();
        else {
            const form = document.getElementById("save") as HTMLFormElement;
            form.method = "get";
            form.dataset.graftHistory = "none";
            submit();
        }
        await flush();
        if (path === "navigation")
            expect(cancelNavigation(navigations[0]!.requestId)).toBe(true);
        else {
            fetch.mockResolvedValue(reply("Left"));
            document.getElementById("next")!.click();
            await flush();
            expect(navigations.at(-1)?.state).toBe("succeeded");
        }
        loading.resolve({ islands: { child: mount } });
        await flush();
        expect(mount).not.toHaveBeenCalled();
        expect(settlements).not.toHaveBeenCalled();
        expect(commandBlockReason()).toBeUndefined();
        expect(document.getElementById("main")!.hasAttribute("inert")).toBe(
            path === "navigation",
        );
        if (path === "navigation")
            expect(navigations.at(-1)?.state).toBe("cancelled");
    },
);

test("required loads share work, mount parents first, and guard external and programmatic submissions without replay", async () => {
    page(
        '<section id="parent" data-island="parent"><div id="child" data-island="editor"></div></section>',
    );
    const parent = deferred<{ islands: { parent: IslandInitialiser } }>();
    const child = deferred<{ islands: { editor: IslandInitialiser } }>();
    const order: string[] = [];
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(reply("Saved", "result"));
    const loadChild = vi.fn(() => child.promise);
    start([
        { names: ["parent"], load: () => parent.promise },
        { names: ["editor"], load: loadChild },
    ]);
    submit();
    document.getElementById("external")!.click();
    expect(fetch).not.toHaveBeenCalled();
    child.resolve({
        islands: {
            editor: () => {
                order.push("child");
            },
        },
    });
    await flush();
    expect(order).toEqual([]);
    parent.resolve({
        islands: {
            parent: () => {
                order.push("parent");
            },
        },
    });
    await flush();
    expect(order).toEqual(["parent", "child"]);
    expect(loadChild).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    submit();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
});

test("eager shell mounts and commands stay independent of a failed workspace module", async () => {
    page();
    document.getElementById("shell")!.dataset.island = "safety";
    const shell = vi.fn();
    const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(reply("Saved", "result"));
    start([
        {
            names: ["safety"],
            module: { islandLoading: "eager", islands: { safety: shell } },
        },
        { names: ["editor"], load: () => loading.promise },
    ]);
    expect(shell).toHaveBeenCalledOnce();
    submit("shell");
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    loading.reject(new Error("private exception"));
    await flush();
    submit();
    expect(fetch).toHaveBeenCalledOnce();
    expect(
        document.querySelector("[data-graft-workspace-feedback]")!.textContent,
    ).not.toContain("private exception");
});

test.each(["remove", "rename"] as const)(
    "a retained required root ends its old lifetime on marker %s before another load",
    async (change) => {
        page('<div id="editor" data-island="editor"></div>');
        const loading = deferred<{ islands: { other: IslandInitialiser } }>();
        let signal: AbortSignal | undefined;
        const destroy = vi.fn();
        const other = vi.fn();
        start([
            {
                names: ["editor"],
                load: async () => ({
                    islands: {
                        editor(_root, context) {
                            signal = context.signal;
                            return destroy;
                        },
                    },
                }),
            },
            { names: ["other"], load: () => loading.promise },
        ]);
        await flush();
        const root = document.getElementById("editor")!;
        if (change === "remove") root.removeAttribute("data-island");
        else root.setAttribute("data-island", "other");
        await flush();
        expect(signal?.aborted).toBe(true);
        expect(destroy).toHaveBeenCalledOnce();
        expect(other).not.toHaveBeenCalled();
        loading.resolve({ islands: { other } });
        await flush();
        expect(other).toHaveBeenCalledTimes(change === "rename" ? 1 : 0);
        expect(destroy).toHaveBeenCalledOnce();
    },
);

test("new eager roots mount during workspace loading and after failure", async () => {
    page();
    const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
    const load = vi.fn(() => loading.promise);
    const safety = vi.fn();
    start([
        { names: ["editor"], load },
        {
            names: ["safety"],
            module: { islandLoading: "eager", islands: { safety } },
        },
    ]);
    document.getElementById("shell")!.setAttribute("data-island", "safety");
    await flush();
    expect(safety).toHaveBeenCalledOnce();
    expect(document.getElementById("main")!.hasAttribute("inert")).toBe(true);
    loading.reject(new Error("workspace unavailable"));
    await flush();
    document.getElementById("result")!.innerHTML =
        '<button data-island="safety">Safety</button>';
    await flush();
    expect(safety).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledOnce();
    expect(document.getElementById("main")!.hasAttribute("inert")).toBe(true);
});

test.each(
    ["manual", "required"].flatMap((mode) =>
        [
            "command",
            "command-location",
            "query",
            "query-location",
            "navigation",
        ].map((path) => ({ mode, path })),
    ),
)(
    "$mode reconciliation cannot settle a retired $path",
    async ({ mode, path }) => {
        page();
        const events: string[] = [];
        stops.push(
            listenForRequestSettled(() => events.push("settled")),
            listenForLocationChanges(() => events.push("location")),
            listenForNavigation((detail) => {
                if (detail.state === "succeeded") events.push("success");
            }),
        );
        const reload = vi
            .spyOn(location, "reload")
            .mockImplementation(() => {});
        const content = await reply("Saved", "result").text();
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                path === "command-location"
                    ? content.replace(
                          'version="1"',
                          'version="1" location="/saved"',
                      )
                    : content,
                { headers: { "Content-Type": MEDIA_TYPE } },
            ),
        );
        const reconcile = vi.fn(() => {
            stops.push(startHypergraft());
        });
        const islands = {
            editor: () => ({ destroy() {}, reconcile }),
        };
        stops.push(
            startHypergraft({
                islands:
                    mode === "manual"
                        ? islands
                        : defineIslandModules([
                              {
                                  names: ["editor"],
                                  module: { islands, islandLoading: "eager" },
                              },
                          ]),
            }),
        );
        if (path === "navigation") document.getElementById("next")!.click();
        else {
            const form = document.getElementById("save") as HTMLFormElement;
            if (path.startsWith("query")) form.method = "get";
            if (path === "query")
                form.setAttribute("data-graft-history", "none");
            submit();
        }
        await flush();
        expect(reconcile, path).toHaveBeenCalledOnce();
        expect(events, path).toEqual([]);
        if (path.startsWith("command")) {
            expect(commandBlockReason()).toBe("uncertain-command");
            expect(reload).toHaveBeenCalledOnce();
        }
    },
);

test.each(["mount", "reconcile"])(
    "a required %s failure aborts the root and never releases readiness",
    async (phase) => {
        page();
        let signal: AbortSignal | undefined;
        const destroyed = vi.fn();
        const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(reply("Saved", "result"));
        start([
            {
                names: ["editor"],
                load: async () => ({
                    islands: {
                        editor: (_root, context) => {
                            signal = context.signal;
                            if (phase === "mount")
                                throw new Error("mount failed");
                            return {
                                destroy: destroyed,
                                reconcile() {
                                    throw new Error("reconcile failed");
                                },
                            };
                        },
                    },
                }),
            },
        ]);
        await flush();
        submit();
        await flush();
        expect(signal?.aborted).toBe(true);
        if (phase === "mount") expect(fetch).not.toHaveBeenCalled();
        else {
            expect(commandBlockReason()).toBe("uncertain-command");
            expect(destroyed).toHaveBeenCalledOnce();
        }
        submit();
        expect(fetch).toHaveBeenCalledTimes(phase === "mount" ? 0 : 1);
    },
);

test("navigation commits content and history before imports, but reconciles before public completion", async () => {
    page('<input id="draft" value="keep">');
    const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
    const order: string[] = [];
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
            reply(
                '<div data-island="editor">New page</div><form id="save" data-graft method="post" action="/save"></form>',
            ),
        );
    const length = history.length;
    stops.push(
        listenForLocationChanges(() => {
            order.push("location");
            expect(document.getElementById("main")!.hasAttribute("inert")).toBe(
                false,
            );
        }),
        listenForNavigation((detail) => {
            if (detail.state === "succeeded") order.push("success");
        }),
    );
    start([{ names: ["editor"], load: () => loading.promise }]);
    document.getElementById("next")!.click();
    await flush();
    expect(document.getElementById("draft")).toBeNull();
    expect(document.getElementById("main")!.textContent).toBe("New page");
    expect(location.pathname).toBe("/next");
    expect(history.length).toBe(length + 1);
    expect(order).toEqual([]);
    submit();
    document.getElementById("external")!.click();
    expect(fetch).toHaveBeenCalledOnce();
    loading.resolve({
        islands: {
            editor: () => {
                order.push("mount");
                return {
                    destroy() {},
                    reconcile() {
                        order.push("reconcile");
                    },
                };
            },
        },
    });
    await flush();
    expect(order).toEqual(["mount", "reconcile", "location", "success"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(history.length).toBe(length + 1);
});

test.each(["resolve", "reject"])(
    "cancellation after commitment retires the wait and ignores late %s without rollback",
    async (ending) => {
        page('<input id="draft" value="keep">');
        const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
        const events: NavigationDetail[] = [];
        stops.push(listenForNavigation((event) => events.push(event)));
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            reply('<div data-island="editor"></div>'),
        );
        const mounted = vi.fn();
        const reload = vi
            .spyOn(location, "reload")
            .mockImplementation(() => {});
        const assign = vi
            .spyOn(location, "assign")
            .mockImplementation(() => {});
        start([{ names: ["editor"], load: () => loading.promise }]);
        document.getElementById("next")!.click();
        await flush();
        expect(cancelNavigation(events[0]!.requestId)).toBe(true);
        expect(commandBlockReason()).toBeUndefined();
        if (ending === "resolve")
            loading.resolve({ islands: { editor: mounted } });
        else loading.reject(new Error("late failure"));
        await flush();
        expect(events.map((event) => event.state)).toEqual([
            "started",
            "cancelled",
        ]);
        expect(document.getElementById("draft")).toBeNull();
        expect(location.pathname).toBe("/next");
        expect(
            document.querySelector<HTMLElement>(
                "[data-graft-workspace-failure]",
            )!.hidden,
        ).toBe(false);
        expect(mounted).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(assign).not.toHaveBeenCalled();
    },
);

test.each(
    ["link", "history"].flatMap((mode) =>
        ["load", "mount", "reconcile", "unknown"].map((failure) => ({
            mode,
            failure,
        })),
    ),
)(
    "$failure failure keeps the new $mode document and offers recovery without automatic reload",
    async ({ mode, failure }) => {
        page("");
        const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
        const events: NavigationDetail[] = [];
        const reload = vi
            .spyOn(location, "reload")
            .mockImplementation(() => {});
        const assign = vi
            .spyOn(location, "assign")
            .mockImplementation(() => {});
        const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(
                reply(
                    '<div data-island="editor">New page</div><form id="save" data-graft method="post" action="/save"></form>',
                ),
            );
        stops.push(listenForNavigation((detail) => events.push(detail)));
        start([
            {
                names: [failure === "unknown" ? "other" : "editor"],
                load: () => loading.promise,
            },
        ]);
        const length = history.length;
        if (mode === "history") {
            history.replaceState({ hypergraft: true }, "", "/next");
            dispatchEvent(
                new PopStateEvent("popstate", { state: history.state }),
            );
        } else document.getElementById("next")!.click();
        await flush();
        if (failure === "load")
            loading.reject(new Error("private module failure"));
        else
            loading.resolve({
                islands: {
                    editor() {
                        if (failure === "mount")
                            throw new Error("mount failed");
                        return {
                            destroy() {},
                            reconcile() {
                                throw new Error("reconcile failed");
                            },
                        };
                    },
                },
            });
        await flush();
        expect(location.pathname).toBe("/next");
        expect(history.length).toBe(length + (mode === "link" ? 1 : 0));
        expect(document.getElementById("main")!.textContent).toBe("New page");
        expect(events.map((detail) => detail.state)).toEqual([
            "started",
            "failed",
        ]);
        expect(events.at(-1)).toMatchObject({ recovery: "document" });
        submit();
        expect(fetch).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
        expect(assign).not.toHaveBeenCalled();
        expect(
            document.querySelector<HTMLElement>(
                "[data-graft-workspace-failure]",
            )!.hidden,
        ).toBe(false);
    },
);

test.each(["supersede", "replace"])(
    "%s after visible commitment cannot finish the retired navigation",
    async (ending) => {
        page("");
        const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
        const old = vi.fn();
        const current = vi.fn();
        const events: NavigationDetail[] = [];
        const reload = vi
            .spyOn(location, "reload")
            .mockImplementation(() => {});
        const assign = vi
            .spyOn(location, "assign")
            .mockImplementation(() => {});
        const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(
                reply('<div data-island="editor">First page</div>'),
            );
        stops.push(listenForNavigation((detail) => events.push(detail)));
        start([{ names: ["editor"], load: () => loading.promise }]);
        document.getElementById("next")!.click();
        await flush();
        if (ending === "replace") {
            start([
                {
                    names: ["editor"],
                    load: async () => ({ islands: { editor: current } }),
                },
            ]);
        } else {
            fetch.mockResolvedValue(reply("Second page"));
            (document.getElementById("next") as HTMLAnchorElement).href =
                "/other";
            document.getElementById("next")!.click();
        }
        await flush();
        loading.resolve({ islands: { editor: old } });
        await flush();
        expect(old).not.toHaveBeenCalled();
        expect(current).toHaveBeenCalledTimes(ending === "replace" ? 1 : 0);
        expect(document.getElementById("main")!.textContent).toBe(
            ending === "replace" ? "First page" : "Second page",
        );
        expect(location.pathname).toBe(
            ending === "replace" ? "/next" : "/other",
        );
        expect(events.map((detail) => detail.state)).toEqual(
            ending === "replace"
                ? ["started", "disposed"]
                : ["started", "cancelled", "started", "succeeded"],
        );
        expect(commandBlockReason()).toBeUndefined();
        expect(reload).not.toHaveBeenCalled();
        expect(assign).not.toHaveBeenCalled();
    },
);

test("replacement from an eager navigation mount retires the old operation before it starts required imports", async () => {
    page("");
    const oldLoad = vi.fn();
    const current = vi.fn();
    const reload = vi.spyOn(location, "reload").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
        reply(
            '<div data-island="shell"></div><div data-island="editor"></div>',
        ),
    );
    start([
        { names: ["editor"], load: oldLoad },
        {
            names: ["shell"],
            module: {
                islandLoading: "eager",
                islands: {
                    shell() {
                        start([
                            {
                                names: ["shell"],
                                module: {
                                    islandLoading: "eager",
                                    islands: { shell() {} },
                                },
                            },
                            {
                                names: ["editor"],
                                load: async () => ({
                                    islands: { editor: current },
                                }),
                            },
                        ]);
                    },
                },
            },
        },
    ]);
    document.getElementById("next")!.click();
    await flush();
    expect(location.pathname).toBe("/next");
    expect(oldLoad).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
});

test("a departure veto runs before visible commitment and does not start destination imports", async () => {
    page('<input id="draft" value="keep">');
    const load = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
        reply('<div data-island="editor"></div>'),
    );
    stops.push(listenBeforeNavigation((event) => event.preventDefault()));
    start([{ names: ["editor"], load }]);
    const length = history.length;
    document.getElementById("next")!.click();
    await flush();
    expect(location.pathname).toBe("/start");
    expect(history.length).toBe(length);
    expect(document.getElementById("draft")).not.toBeNull();
    expect(load).not.toHaveBeenCalled();
});

test.each(["target", "collision"])(
    "post-wait %s changes reject stale prepared content without repeating validation",
    async (change) => {
        page(
            '<form id="query" method="get" action="/query" data-graft data-graft-history="none"></form>',
        );
        const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
        const validateContent = vi.fn();
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            reply('<div id="inserted" data-island="editor"></div>', "result"),
        );
        const outcomes: string[] = [];
        stops.push(
            listenForRequestSettled((detail) => outcomes.push(detail.outcome)),
        );
        stops.push(
            startHypergraft({
                validateContent,
                islands: defineIslandModules([
                    { names: ["editor"], load: () => loading.promise },
                ]),
            }),
        );
        submit("query");
        await flush();
        if (change === "target")
            document.getElementById("result")!.outerHTML =
                '<aside id="result">New target</aside>';
        else {
            const collision = document.createElement("div");
            collision.id = "inserted";
            document.body.append(collision);
        }
        loading.resolve({ islands: { editor: vi.fn() } });
        await flush();
        expect(outcomes).toEqual(["safe-failure"]);
        expect(validateContent).toHaveBeenCalledOnce();
        expect(
            document.getElementById("result")!.querySelector("[data-island]"),
        ).toBeNull();
    },
);

test("client insertion cannot submit in the same turn before mutation observation", async () => {
    page("");
    const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
    const fetch = vi.spyOn(globalThis, "fetch");
    start([{ names: ["editor"], load: () => loading.promise }]);
    const root = document.createElement("div");
    root.dataset.island = "editor";
    document.getElementById("main")!.append(root);
    submit();
    expect(fetch).not.toHaveBeenCalled();
    root.remove();
    await flush();
    loading.reject(new Error("removed root"));
    await flush();
    expect(
        document.querySelector<HTMLElement>("[data-graft-workspace-feedback]")!
            .hidden,
    ).toBe(true);
});

test("a same-turn submission is discarded even when newly inserted behaviour is already cached", async () => {
    page();
    start([
        { names: ["editor"], load: async () => ({ islands: { editor() {} } }) },
    ]);
    await flush();
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(reply("Saved", "result"));
    const root = document.createElement("div");
    root.dataset.island = "editor";
    document.getElementById("main")!.append(root);
    submit();
    expect(fetch).not.toHaveBeenCalled();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    submit();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
});

test("replacement ends loading and initialisation reads the current retained controls", async () => {
    page();
    const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
    const old = vi.fn();
    start([{ names: ["editor"], load: () => loading.promise }]);
    await flush();
    const current = vi.fn();
    start([
        {
            names: ["editor"],
            load: async () => ({ islands: { editor: current } }),
        },
    ]);
    loading.resolve({ islands: { editor: old } });
    await flush();
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
});

test.each([
    "unknown",
    "invalid export",
    "missing workspace",
    "duplicate workspace",
])("%s fails closed", async (failure) => {
    page();
    if (failure === "missing workspace")
        document
            .getElementById("main")!
            .removeAttribute("data-graft-workspace");
    if (failure === "duplicate workspace")
        document
            .getElementById("result")!
            .setAttribute("data-graft-workspace", "");
    const fetch = vi.spyOn(globalThis, "fetch");
    start([
        {
            names: [failure === "unknown" ? "other" : "editor"],
            load: async () => ({
                islands:
                    failure === "invalid export"
                        ? Object.create(null)
                        : { editor: vi.fn() },
            }),
        },
    ]);
    await flush();
    submit();
    expect(fetch).not.toHaveBeenCalled();
});

test("authoritative pending cleanup and required reconciliation precede a listener's next command", async () => {
    page('<div data-island="editor"></div>');
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
            reply('<button id="next-save">Save</button>', "save"),
        );
    const observations: boolean[] = [];
    start([
        {
            names: ["editor"],
            load: async () => ({
                islands: {
                    editor: () => ({
                        destroy() {},
                        reconcile(context) {
                            if (context.cause === "patch")
                                observations.push(
                                    document
                                        .getElementById("save")!
                                        .hasAttribute("data-graft-pending"),
                                );
                        },
                    }),
                },
            }),
        },
    ]);
    await flush();
    stops.push(
        listenForRequestSettled(() => {
            expect(observations.at(-1)).toBe(false);
            if (fetch.mock.calls.length === 1) submit();
        }),
    );
    submit();
    await flush();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(observations).toEqual([false, false]);
});

test("a failed POST dependency keeps the old content, reports uncertainty and never resubmits", async () => {
    page('<input id="draft" value="Local draft">');
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(reply('<div data-island="editor">New state</div>'));
    const settlements: string[] = [];
    stops.push(
        listenForRequestSettled((detail) => settlements.push(detail.outcome)),
    );
    start([
        {
            names: ["editor"],
            load: async () => {
                throw new Error("unavailable");
            },
        },
    ]);
    submit();
    await flush();
    expect(document.getElementById("draft")).not.toBeNull();
    expect(settlements).toEqual(["uncertain-unsafe-result"]);
    expect(commandBlockReason()).toBe("uncertain-command");
    submit();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
});

test("named controls cannot replace required-root traversal or readiness checks", async () => {
    page(
        '<form id="island-form" data-island="editor"><input name="querySelectorAll"><input name="contains"><input name="getAttribute"><input name="isConnected"></form>',
    );
    const mount = vi.fn();
    start([
        {
            names: ["editor"],
            load: async () => ({ islands: { editor: mount } }),
        },
    ]);
    await flush();
    expect(mount).toHaveBeenCalledOnce();
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(reply("Saved", "result"));
    submit();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(commandBlockReason()).toBeUndefined();
});

test("explicit shell navigation can leave a failed initial workspace without retrying its module", async () => {
    page();
    const load = vi.fn(async () => {
        throw new Error("unavailable");
    });
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
            reply(
                '<form id="replacement" method="post" action="/save" data-graft></form>',
            ),
        );
    start([{ names: ["editor"], load }]);
    await flush();
    document.getElementById("next")!.click();
    await flush();
    expect(
        document.querySelector<HTMLElement>("[data-graft-workspace-feedback]")!
            .hidden,
    ).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    fetch.mockResolvedValue(reply("Saved", "result"));
    submit("replacement");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
});

test.each(["complete", "interrupted"])(
    "stream dependencies pause application and retain the gate until %s settlement",
    async (ending) => {
        page(
            '<form id="query" method="get" action="/query" data-graft data-graft-history="none"></form><div id="progress"></div>',
        );
        const loading = deferred<{ islands: { editor: IslandInitialiser } }>();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>(
            {
                start(controller) {
                    stream = controller;
                },
            },
            { highWaterMark: 0 },
        );
        const frame = (phase: string, text: string) => {
            const html = `<graft-patch-set version="1" phase="${phase}"><graft-patch operation="children" target="progress"><template><div data-island="editor">${text}</div></template></graft-patch></graft-patch-set>`;
            stream.enqueue(
                new TextEncoder().encode(
                    `${new TextEncoder().encode(html).length}\n${html}`,
                ),
            );
        };
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(body, {
                headers: {
                    "Content-Type": MEDIA_TYPE,
                    "Graft-Transfer": "stream",
                },
            }),
        );
        const reconciled = vi.fn();
        start([{ names: ["editor"], load: () => loading.promise }]);
        submit("query");
        frame("progress", "Progress");
        await flush();
        expect(document.getElementById("progress")!.textContent).toBe("");
        loading.resolve({
            islands: {
                editor: () => ({ destroy() {}, reconcile: reconciled }),
            },
        });
        await flush();
        expect(document.getElementById("progress")!.textContent).toBe(
            "Progress",
        );
        submit();
        expect(fetch).toHaveBeenCalledOnce();
        expect(reconciled).not.toHaveBeenCalled();
        if (ending === "complete") {
            frame("final", "Final");
            stream.close();
        } else stream.error(new Error("stream lost"));
        await flush();
        expect(document.getElementById("progress")!.textContent).toBe(
            ending === "complete" ? "Final" : "Progress",
        );
        expect(
            document.querySelector<HTMLElement>(
                "[data-graft-workspace-feedback]",
            )!.hidden,
        ).toBe(ending === "complete");
    },
);

test("native template contents do not load until activation, and moved roots keep their lifetime", async () => {
    page('<template id="template"><div data-island="editor"></div></template>');
    const mount = vi.fn(() => ({ destroy: vi.fn() }));
    const load = vi.fn(async () => ({ islands: { editor: mount } }));
    start([{ names: ["editor"], load }]);
    expect(load).not.toHaveBeenCalled();
    const node = (document.getElementById("template") as HTMLTemplateElement)
        .content.firstElementChild!;
    document.getElementById("main")!.append(node);
    await flush();
    await flush();
    expect(mount).toHaveBeenCalledOnce();
    document.getElementById("result")!.append(node);
    await flush();
    expect(mount).toHaveBeenCalledOnce();
});

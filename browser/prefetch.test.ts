// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fixture from "../protocol-v1.json";
import { listenForDiagnostics } from "./diagnostics";
import {
    listenBeforeNavigation,
    listenForNavigation,
    type NavigationDetail,
} from "./events";
import { MEDIA_TYPE } from "./patches";
import {
    DEFAULT_PREFETCH_MAX_AGE_MS,
    GRAFT_PREFETCH,
    PREFETCH_INTENT,
    PREFETCH_MAX_AGE_LIMIT_MS,
    PREFETCH_MAX_BYTES,
    PREFETCH_MAX_REQUESTS,
    PREFETCH_WINDOW_MS,
    type PrefetchOptions,
} from "./prefetch";
import {
    cancelNavigation,
    commandBlockReason,
    invalidatePrefetch,
    resetHypergraftForTests,
    startHypergraft,
} from "./requests";

const cleanup: (() => void)[] = [];
const automaticPolicies: PrefetchOptions[] = [
    { routes: ["/next"] },
    { links: "all" },
];
const agePolicies: { prefetch: true | PrefetchOptions; age: number }[] = [
    { prefetch: true, age: 10_000 },
    { prefetch: {}, age: 10_000 },
    { prefetch: { routes: ["/next"] }, age: 10_000 },
    { prefetch: { links: "all" }, age: 10_000 },
    { prefetch: { maxAgeMs: 1 }, age: 1 },
    { prefetch: { links: "marked", maxAgeMs: 250 }, age: 250 },
    { prefetch: { routes: ["/next"], maxAgeMs: 20_000 }, age: 20_000 },
    { prefetch: { links: "all", maxAgeMs: 30_000 }, age: 30_000 },
    { prefetch: { maxAgeMs: 2_147_483_647 }, age: 2_147_483_647 },
];
let link: HTMLAnchorElement;
let events: NavigationDetail[];
let pointerX = 0;
const settle = () => vi.advanceTimersByTimeAsync(0);
function envelope(text = "New page", target = "main") {
    return `<graft-patch-set version="1"><graft-patch operation="children" target="${target}"><template>${text}</template></graft-patch></graft-patch-set>`;
}
function reply(text = "New page", headers: Record<string, string> = {}) {
    return new Response(envelope(text), {
        headers: {
            "content-type": MEDIA_TYPE,
            "cache-control": "no-store",
            [GRAFT_PREFETCH]: PREFETCH_INTENT,
            ...headers,
        },
    });
}
function pending() {
    let resolve!: (response: Response) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Response>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    vi.mocked(fetch).mockReturnValueOnce(promise);
    return { resolve, reject };
}
function intent(element = link) {
    element.dispatchEvent(
        new PointerEvent("pointerover", {
            bubbles: true,
            pointerType: "mouse",
            clientX: ++pointerX,
        }),
    );
}
function signal(index = 0): AbortSignal {
    return vi.mocked(fetch).mock.calls[index]![1]!.signal!;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    history.replaceState({}, "", "/start");
    document.body.innerHTML = `<main id="main" tabindex="-1">Old page</main>
        <a href="/next?q=one" data-graft data-graft-prefetch>Next</a>
        <form method="get" action="/query" data-graft><button>Query</button></form>
        <form method="post" action="/command" data-graft><button>Command</button></form>`;
    link = document.querySelector("a")!;
    vi.stubGlobal("fetch", vi.fn());
    events = [];
    cleanup.push(
        listenForNavigation((detail) => events.push(detail)),
        startHypergraft({ prefetch: true }),
    );
});
afterEach(() => {
    resetHypergraftForTests();
    for (const stop of cleanup.splice(0).reverse()) stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

test("prefetch policy stays in lock-step with the server fixture", () => {
    expect({
        header: GRAFT_PREFETCH,
        value: PREFETCH_INTENT,
        age: {
            default: DEFAULT_PREFETCH_MAX_AGE_MS,
            minimum: 1,
            maximum: PREFETCH_MAX_AGE_LIMIT_MS,
            integerOnly: true,
            invalid: "RangeError",
        },
        bytes: PREFETCH_MAX_BYTES,
        starts: PREFETCH_MAX_REQUESTS,
        window: PREFETCH_WINDOW_MS,
    }).toEqual({
        header: fixture.prefetch.responseHeader,
        value: fixture.prefetch.responseValue,
        age: fixture.prefetch.maxAgeMs,
        bytes: fixture.prefetch.maxResponseBytes,
        starts: fixture.prefetch.maxRequestsPerWindow,
        window: fixture.prefetch.windowMs,
    });
});

test.each(["active", "complete"])(
    "immediate intent shares a %s request without navigation side effects",
    async (state) => {
        const request = pending();
        const validate = vi.fn();
        const mount = vi.fn();
        cleanup.push(
            startHypergraft({
                prefetch: true,
                validateContent: validate,
                islands: { test: mount },
            }),
        );
        const length = history.length;
        intent();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(
            new URL(link.href),
            expect.objectContaining({
                method: "GET",
                credentials: "same-origin",
                cache: "no-store",
                redirect: "manual",
                headers: { "Graft-Request": "navigation", Accept: MEDIA_TYPE },
            }),
        );
        link.focus();
        if (state === "complete")
            request.resolve(reply('<div data-island="test">New page</div>'));
        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(events).toEqual([]);
        expect(validate).not.toHaveBeenCalled();
        expect(mount).not.toHaveBeenCalled();
        expect(commandBlockReason()).toBeUndefined();
        expect(document.getElementById("main")!.textContent).toBe("Old page");
        expect(location.pathname).toBe("/start");
        expect(history.length).toBe(length);
        link.click();
        if (state === "active")
            request.resolve(reply('<div data-island="test">New page</div>'));
        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(events.map((event) => event.state)).toEqual([
            "started",
            "succeeded",
        ]);
        expect(validate).toHaveBeenCalled();
        expect(mount).toHaveBeenCalledTimes(1);
        expect(document.getElementById("main")!.textContent).toBe("New page");
        expect(location.search).toBe("?q=one");
        expect(history.length).toBe(length + 1);
        vi.mocked(fetch).mockResolvedValueOnce(reply("Fresh navigation"));
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(document.getElementById("main")!.textContent).toBe(
            "Fresh navigation",
        );
    },
);

test.each([
    "runtime",
    "link",
    "download",
    "external",
    "target",
    "fragment",
    "origin",
    "credentials",
    "malformed",
    "save-data",
    "retry",
    "modified",
])("%s exclusion leaves speculation off", (kind) => {
    if (kind === "runtime") cleanup.push(startHypergraft());
    else if (kind !== "link")
        cleanup.push(startHypergraft({ prefetch: { links: "all" } }));
    if (kind === "link") link.removeAttribute("data-graft-prefetch");
    if (kind === "download") link.setAttribute("download", "");
    if (kind === "external") link.rel = "external";
    if (kind === "target") link.target = "_blank";
    if (kind === "fragment") link.hash = "section";
    if (kind === "origin") link.href = "https://elsewhere.test/next";
    if (kind === "credentials")
        link.href = "http://user:password@localhost:3000/next";
    if (kind === "malformed") link.href = "http://[invalid";
    if (kind === "save-data")
        Object.defineProperty(navigator, "connection", {
            configurable: true,
            value: { saveData: true },
        });
    if (kind === "retry") link.setAttribute("data-graft-navigation-retry", "");
    link.dispatchEvent(
        new PointerEvent("pointerover", {
            bubbles: true,
            pointerType: "mouse",
            ctrlKey: kind === "modified",
        }),
    );
    expect(fetch).not.toHaveBeenCalled();
    if (kind === "save-data") Reflect.deleteProperty(navigator, "connection");
});

test.each(automaticPolicies)(
    "configured eligibility adopts unmarked links without query aliasing (%j)",
    async (prefetch) => {
        cleanup.push(startHypergraft({ prefetch }));
        link.removeAttribute("data-graft-prefetch");
        vi.mocked(fetch).mockImplementation(async (url) =>
            reply(new URL(String(url)).search),
        );
        for (const query of ["one", "two"]) {
            // A newly rendered link must receive the same policy without another binder.
            const next = link.cloneNode(true) as HTMLAnchorElement;
            next.href = `/next?q=${query}`;
            link.replaceWith(next);
            link = next;
            intent();
            link.focus();
            await settle();
            expect(events.at(-1)?.state).not.toBe("started");
            link.click();
            await settle();
            expect(location.search).toBe(`?q=${query}`);
            expect(document.getElementById("main")!.textContent).toBe(
                `?q=${query}`,
            );
        }
        link.href = "/next?q=three";
        intent();
        await settle();
        link.href = "/next?q=four";
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(4);
        expect(document.getElementById("main")!.textContent).toBe("?q=four");
    },
);

test("route eligibility is exact and cannot expand through attributes or configuration mutation", () => {
    const routes = ["/", "/next"];
    cleanup.push(startHypergraft({ prefetch: { routes } }));
    routes.push("/outside");
    for (const path of [
        "/next/edit",
        "/next/",
        "/outside",
        "/other",
        "/next?q=one",
    ]) {
        link.href = path;
        if (path === "/next?q=one") link.removeAttribute("data-graft");
        intent();
    }
    document
        .querySelector("form")!
        .dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(fetch).not.toHaveBeenCalled();
    cleanup.push(startHypergraft({ prefetch: { routes: [] } }));
    link.setAttribute("data-graft", "");
    intent();
    expect(fetch).not.toHaveBeenCalled();
});

test("all-links mode does not speculate native links or GET forms", () => {
    cleanup.push(startHypergraft({ prefetch: { links: "all" } }));
    link.removeAttribute("data-graft");
    intent();
    document
        .querySelector("form")!
        .dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(fetch).not.toHaveBeenCalled();
});

test.each([true, ...automaticPolicies])(
    "link opt-out prevents startup and invalidates adoption (%j)",
    async (prefetch) => {
        cleanup.push(startHypergraft({ prefetch }));
        for (const value of ["false", "invalid"]) {
            link.setAttribute("data-graft-prefetch", value);
            intent();
            link.focus();
        }
        expect(fetch).not.toHaveBeenCalled();
        link.setAttribute("data-graft-prefetch", "true");
        vi.mocked(fetch).mockResolvedValueOnce(reply("Speculative"));
        intent();
        await settle();
        link.setAttribute("data-graft-prefetch", "false");
        vi.mocked(fetch).mockResolvedValueOnce(reply("Fresh"));
        link.click();
        await settle();
        expect(signal().aborted).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(document.getElementById("main")!.textContent).toBe("Fresh");
    },
);

test.each(automaticPolicies)(
    "configuration does not replace server approval (%j)",
    async (prefetch) => {
        cleanup.push(startHypergraft({ prefetch }));
        link.removeAttribute("data-graft-prefetch");
        vi.mocked(fetch).mockResolvedValueOnce(
            reply("Unapproved", { [GRAFT_PREFETCH]: "" }),
        );
        intent();
        await settle();
        vi.mocked(fetch).mockResolvedValueOnce(reply("Fresh"));
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(document.getElementById("main")!.textContent).toBe("Fresh");
    },
);

test("false disables even explicit link opt-in", () => {
    cleanup.push(startHypergraft({ prefetch: false }));
    intent();
    expect(fetch).not.toHaveBeenCalled();
});

test.each([0, -1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648, null, "10000"])(
    "invalid maximum age %s preserves the active runtime and its speculation",
    async (maxAgeMs) => {
        const request = pending();
        intent();
        expect(() =>
            startHypergraft({ prefetch: { maxAgeMs: maxAgeMs as number } }),
        ).toThrow(RangeError);
        expect(signal().aborted).toBe(false);
        request.resolve(reply());
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(events.at(-1)?.state).toBe("succeeded");
        expect(document.getElementById("main")!.textContent).toBe("New page");
    },
);

test.each(["pending-command", "uncertain-command"])(
    "an invalid prefetch replacement preserves %s interception",
    async (state) => {
        const request = pending();
        const form =
            document.querySelector<HTMLFormElement>("form[method=post]")!;
        form.requestSubmit();
        if (state === "uncertain-command") {
            request.reject(new TypeError("offline"));
            await settle();
        }
        expect(commandBlockReason()).toBe(state);
        expect(() => startHypergraft({ prefetch: { maxAgeMs: 0 } })).toThrow(
            RangeError,
        );
        const submit = new SubmitEvent("submit", {
            bubbles: true,
            cancelable: true,
        });
        form.dispatchEvent(submit);
        expect(submit.defaultPrevented).toBe(true);
        expect(commandBlockReason()).toBe(state);
        expect(fetch).toHaveBeenCalledTimes(1);
        if (state === "pending-command") {
            request.resolve(reply());
            await settle();
            expect(commandBlockReason()).toBeUndefined();
            expect(document.getElementById("main")!.textContent).toBe(
                "New page",
            );
        }
    },
);

test.each([{}, { maxAgeMs: 500 }, { links: "marked" as const, maxAgeMs: 500 }])(
    "age-only and marked policies never expand link eligibility (%j)",
    (prefetch) => {
        cleanup.push(startHypergraft({ prefetch }));
        link.removeAttribute("data-graft-prefetch");
        intent();
        expect(fetch).not.toHaveBeenCalled();
    },
);

test.each(agePolicies)(
    "completed retention uses request-start age despite delayed timers (%j)",
    async ({ prefetch, age }) => {
        cleanup.push(startHypergraft({ prefetch }));
        const request = pending();
        intent();
        await vi.advanceTimersByTimeAsync(age - 1);
        request.resolve(reply("Expired"));
        await settle();
        expect(signal().aborted).toBe(false);
        vi.setSystemTime(Date.now() + 1);
        vi.mocked(fetch).mockResolvedValueOnce(reply("Fresh"));
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(document.getElementById("main")!.textContent).toBe("Fresh");
    },
);

test.each(agePolicies)(
    "completed results remain single-use until the selected deadline (%j)",
    async ({ prefetch, age }) => {
        cleanup.push(startHypergraft({ prefetch }));
        vi.mocked(fetch).mockResolvedValueOnce(reply("Retained"));
        intent();
        await vi.advanceTimersByTimeAsync(age - 1);
        intent();
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(document.getElementById("main")!.textContent).toBe("Retained");
        vi.mocked(fetch).mockResolvedValueOnce(reply("Fresh"));
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(document.getElementById("main")!.textContent).toBe("Fresh");
    },
);

test.each(agePolicies)(
    "adoption removes the selected deadline but retains navigation cancellation (%j)",
    async ({ prefetch, age }) => {
        cleanup.push(startHypergraft({ prefetch }));
        const request = pending();
        intent();
        await vi.advanceTimersByTimeAsync(age - 1);
        link.click();
        await vi.advanceTimersByTimeAsync(age + 1);
        expect(signal().aborted).toBe(false);
        request.resolve(reply());
        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(events.at(-1)?.state).toBe("succeeded");
        history.replaceState({}, "", "/start");
        const later = pending();
        intent();
        link.click();
        const navigation = events.at(-1)!;
        expect(cancelNavigation(navigation.requestId)).toBe(true);
        expect(signal(1).aborted).toBe(true);
        later.resolve(reply("Cancelled"));
        await settle();
        expect(document.getElementById("main")!.textContent).toBe("New page");
    },
);

test.each(["active", "complete"])(
    "the selected expiry timer discards %s work without new intent",
    async (state) => {
        const prefetch = { routes: ["/next"], maxAgeMs: 500 };
        cleanup.push(startHypergraft({ prefetch }));
        const request = pending();
        intent();
        prefetch.maxAgeMs = 30_000;
        if (state === "complete") request.resolve(reply("Expired"));
        await vi.advanceTimersByTimeAsync(499);
        expect(signal().aborted).toBe(false);
        intent();
        await vi.advanceTimersByTimeAsync(1);
        expect(signal().aborted).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        vi.mocked(fetch).mockResolvedValueOnce(reply("Fresh"));
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(document.getElementById("main")!.textContent).toBe("Fresh");
    },
);

test("replacement owns the only entry and rejects obsolete redirects and failures", async () => {
    const first = pending();
    intent();
    const second = pending();
    link.href = "/latest";
    intent();
    expect(signal().aborted).toBe(true);
    first.resolve(
        new Response(null, { status: 302, headers: { location: "/login" } }),
    );
    await settle();
    second.resolve(reply("Latest"));
    await settle();
    link.click();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(location.pathname).toBe("/latest");
    expect(document.getElementById("main")!.textContent).toBe("Latest");
});

test("traffic admission survives replacement and explicit navigation bypasses an exhausted budget", async () => {
    cleanup.push(
        startHypergraft({ prefetch: { links: "all", maxAgeMs: 250 } }),
    );
    for (let index = 0; index < PREFETCH_MAX_REQUESTS + 2; index++) {
        vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}));
        link.href = `/target-${index}`;
        intent();
    }
    expect(fetch).toHaveBeenCalledTimes(PREFETCH_MAX_REQUESTS);
    for (let index = 0; index < PREFETCH_MAX_REQUESTS; index++)
        expect(signal(index).aborted).toBe(true);
    vi.mocked(fetch).mockReset().mockResolvedValue(reply("Explicit"));
    link.click();
    expect(fetch).toHaveBeenCalledTimes(1);
    await settle();
    expect(document.getElementById("main")!.textContent).toBe("Explicit");
    link.href = "/after-window";
    intent();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PREFETCH_WINDOW_MS);
    intent();
    expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([
    "header",
    "cache",
    "stream",
    "redirect",
    "unauthorised",
    "transport",
])(
    "unusable %s speculation is silent and activation requests fresh content",
    async (kind) => {
        const diagnostic = vi.fn();
        cleanup.push(listenForDiagnostics(diagnostic));
        const request = pending();
        intent();
        if (kind === "transport") request.reject(new TypeError("offline"));
        else if (kind === "redirect")
            request.resolve(
                new Response(null, {
                    status: 302,
                    headers: { location: "/login" },
                }),
            );
        else if (kind === "unauthorised")
            request.resolve(new Response(null, { status: 401 }));
        else
            request.resolve(
                reply(
                    "Unused",
                    kind === "header"
                        ? { [GRAFT_PREFETCH]: "" }
                        : kind === "cache"
                          ? { "cache-control": "public, max-age=30" }
                          : { "Graft-Transfer": "stream" },
                ),
            );
        await settle();
        expect(events).toEqual([]);
        expect(diagnostic).not.toHaveBeenCalled();
        vi.mocked(fetch).mockResolvedValueOnce(reply("Fresh"));
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(document.getElementById("main")!.textContent).toBe("Fresh");
    },
);

test("an adopted transport failure offers recovery without an automatic repeat", async () => {
    const request = pending();
    intent();
    link.click();
    request.reject(new TypeError("offline"));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ state: "failed", recovery: "retry" });
    expect(document.getElementById("main")!.textContent).toBe("Old page");
});

test.each(["declared", "chunks", "utf8"])(
    "%s body rejection stays silent and cannot supply activation",
    async (kind) => {
        const cancel = vi.fn();
        const request = pending();
        intent();
        request.resolve(
            new Response(
                new ReadableStream({
                    start(controller) {
                        if (kind === "chunks")
                            controller.enqueue(
                                new Uint8Array(PREFETCH_MAX_BYTES + 1),
                            );
                        if (kind === "utf8")
                            controller.enqueue(new Uint8Array([0xc3, 0x28]));
                    },
                    cancel,
                }),
                {
                    headers: {
                        "content-type": MEDIA_TYPE,
                        "cache-control": "no-store",
                        [GRAFT_PREFETCH]: PREFETCH_INTENT,
                        ...(kind === "declared"
                            ? {
                                  "content-length": String(
                                      PREFETCH_MAX_BYTES + 1,
                                  ),
                              }
                            : {}),
                    },
                },
            ),
        );
        await settle();
        expect(cancel).toHaveBeenCalledTimes(1);
        vi.mocked(fetch).mockResolvedValueOnce(reply("Fresh"));
        link.click();
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(document.getElementById("main")!.textContent).toBe("Fresh");
    },
);

test.each([false, true])(
    "an adopted request uses the ordinary byte bound (%s)",
    async (adopted) => {
        const extra = adopted ? 1 : 0;
        const padding =
            PREFETCH_MAX_BYTES -
            new TextEncoder().encode(envelope("é")).length +
            extra;
        const content = "é" + "x".repeat(padding);
        const request = pending();
        intent();
        if (adopted) link.click();
        request.resolve(reply(content));
        await settle();
        if (!adopted) {
            expect(document.getElementById("main")!.textContent).toBe(
                "Old page",
            );
            link.click();
            await settle();
        }
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(document.getElementById("main")!.textContent!.length).toBe(
            content.length,
        );
        expect(events.at(-1)?.state).toBe("succeeded");
    },
);

test("admission uses a rolling window rather than a boundary burst", async () => {
    cleanup.push(
        startHypergraft({ prefetch: { links: "all", maxAgeMs: 30_000 } }),
    );
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    intent();
    await vi.advanceTimersByTimeAsync(9000);
    for (let index = 0; index < 3; index++) {
        link.href = `/near-boundary-${index}`;
        intent();
    }
    await vi.advanceTimersByTimeAsync(1000);
    for (let index = 0; index < 2; index++) {
        link.href = `/after-boundary-${index}`;
        intent();
    }
    expect(fetch).toHaveBeenCalledTimes(5);
});

test.each([false, true])(
    "activation uses current targets and a rejected guard prevents mutation (%s)",
    async (reject) => {
        const request = pending();
        const validate = vi.fn();
        cleanup.push(
            startHypergraft({ prefetch: true, validateContent: validate }),
        );
        intent();
        request.resolve(reply());
        await settle();
        const old = document.getElementById("main")!;
        old.replaceWith(old.cloneNode(true));
        if (reject)
            cleanup.push(
                listenBeforeNavigation((event) => event.preventDefault()),
            );
        link.click();
        await settle();
        expect(validate).toHaveBeenCalledTimes(1);
        expect(events.at(-1)).toMatchObject({
            state: reject ? "cancelled" : "succeeded",
        });
        expect(document.getElementById("main")!.textContent).toBe(
            reject ? "Old page" : "New page",
        );
        expect(old.textContent).toBe("Old page");
    },
);

test.each([
    "host",
    "query",
    "command",
    "cancel",
    "hidden",
    "pagehide",
    "replacement",
    "expiry",
])(
    "%s invalidation cancels a speculative body before obsolete adoption",
    async (cause) => {
        const request = pending();
        intent();
        const cancel = vi.fn();
        request.resolve(
            new Response(new ReadableStream({ cancel }), {
                headers: {
                    "content-type": MEDIA_TYPE,
                    "cache-control": "no-store",
                    [GRAFT_PREFETCH]: PREFETCH_INTENT,
                },
            }),
        );
        await settle();
        if (cause === "host") invalidatePrefetch();
        if (cause === "query" || cause === "command") {
            vi.mocked(fetch).mockImplementationOnce(async () => {
                expect(signal().aborted).toBe(true);
                return reply("Form result");
            });
            document
                .querySelector<HTMLFormElement>(
                    `form[method=${cause === "query" ? "get" : "post"}]`,
                )!
                .requestSubmit();
        }
        if (cause === "cancel")
            link.dispatchEvent(
                new PointerEvent("pointercancel", {
                    bubbles: true,
                    pointerType: "touch",
                }),
            );
        if (cause === "hidden") {
            vi.spyOn(document, "hidden", "get").mockReturnValue(true);
            document.dispatchEvent(new Event("visibilitychange"));
        }
        if (cause === "pagehide") window.dispatchEvent(new Event("pagehide"));
        if (cause === "replacement")
            cleanup.push(startHypergraft({ prefetch: true }));
        if (cause === "expiry")
            await vi.advanceTimersByTimeAsync(DEFAULT_PREFETCH_MAX_AGE_MS);
        await settle();
        expect(signal().aborted).toBe(true);
        expect(cancel).toHaveBeenCalledTimes(1);
        vi.mocked(fetch).mockResolvedValueOnce(reply("Fresh"));
        link.click();
        await settle();
        expect(document.getElementById("main")!.textContent).toBe("Fresh");
    },
);

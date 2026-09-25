// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listenForDiagnostics } from "./diagnostics";
import {
    emitNavigation,
    listenForNavigation,
    listenForRequestSettled,
    type NavigationDetail,
} from "./events";
import { bindReadFeedback } from "./feedback";
import { MEDIA_TYPE } from "./patches";
import {
    commandBlockReason,
    resetHypergraftForTests,
    startHypergraft,
} from "./requests";

const cleanup: (() => void)[] = [];
let events: NavigationDetail[];
let indicator: HTMLElement;
let status: HTMLElement;
let link: HTMLAnchorElement;
let stopRuntime: () => void;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function reply(content = "New page") {
    return new Response(
        `<graft-patch-set version="1"><graft-patch operation="children" target="main"><template>${content}</template></graft-patch></graft-patch-set>`,
        {
            headers: { "content-type": MEDIA_TYPE },
        },
    );
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

beforeEach(() => {
    history.replaceState({}, "", "/start");
    document.body.innerHTML = `<main id="main" tabindex="-1">Old page</main>
        <a data-graft href="/next">Next page</a>
        <div data-graft-read-indicator hidden>Please wait for the next page.</div>
        <p data-graft-read-status role="status" aria-atomic="true"></p>`;
    link = document.querySelector("a")!;
    indicator = document.querySelector("[data-graft-read-indicator]")!;
    status = document.querySelector("[data-graft-read-status]")!;
    events = [];
    vi.stubGlobal("fetch", vi.fn());
    cleanup.push(listenForNavigation((detail) => events.push(detail)));
    cleanup.push(bindReadFeedback(document));
    stopRuntime = startHypergraft();
    cleanup.push(stopRuntime);
});

afterEach(() => {
    resetHypergraftForTests();
    for (const stop of cleanup.splice(0).reverse()) stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test("navigation announces startup before transport and success only after authoritative content", async () => {
    const request = pending();
    const settled = vi.fn();
    cleanup.push(listenForRequestSettled(settled));
    cleanup.push(
        listenForNavigation((detail) => {
            if (detail.state === "started") {
                expect(fetch).not.toHaveBeenCalled();
                expect(commandBlockReason()).toBe("pending-navigation");
            } else if (detail.state === "succeeded") {
                expect(document.getElementById("main")!.textContent).toBe(
                    "New page",
                );
                expect(location.pathname).toBe("/next");
                expect(commandBlockReason()).toBeUndefined();
            }
        }),
    );
    link.click();
    const started = events[0]!;
    expect(started).toEqual({
        state: "started",
        requestId: expect.any(Number),
        url: link.href,
        cause: "link-navigation",
        link,
    });
    expect(location.pathname).toBe("/start");
    expect(document.getElementById("main")!.textContent).toBe("Old page");
    request.resolve(reply());
    await flush();
    expect(events).toEqual([started, { ...started, state: "succeeded" }]);
    expect(settled).not.toHaveBeenCalled();
});

test("fast requests remain silent and slow requests clear accessible status after success", async () => {
    vi.useFakeTimers();
    const fast = pending();
    link.click();
    fast.resolve(reply());
    await vi.advanceTimersByTimeAsync(199);
    expect(indicator.hidden).toBe(true);
    expect(status.textContent).toBe("");
    const slow = pending();
    link.click();
    await vi.advanceTimersByTimeAsync(199);
    expect(status.textContent).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(indicator.hidden).toBe(false);
    expect(status.textContent).toBe("Please wait for the next page.");
    slow.resolve(reply());
    await vi.advanceTimersByTimeAsync(0);
    expect(indicator.hidden).toBe(true);
    expect(status.textContent).toBe("");
});

test.each([
    "transport",
    "protocol",
    "redirect",
    "envelope",
    "abort",
    "dispose",
] as const)(
    "%s clears slow feedback without false success or form settlement",
    async (path) => {
        vi.useFakeTimers();
        const request = pending();
        const settled = vi.fn();
        const diagnostic = vi.fn();
        cleanup.push(
            listenForRequestSettled(settled),
            listenForDiagnostics(diagnostic),
        );
        const assign = vi.spyOn(location, "assign").mockImplementation(() => {
            expect(status.textContent).toBe("");
            expect(indicator.hidden).toBe(true);
            expect(events.at(-1)?.state).toBe("handed-off");
        });
        link.click();
        await vi.advanceTimersByTimeAsync(200);
        expect(status.textContent).not.toBe("");
        switch (path) {
            case "transport":
                request.reject(new Error("private error"));
                break;
            case "protocol":
                request.resolve(new Response("private response"));
                break;
            case "redirect":
                request.resolve(
                    new Response(null, {
                        status: 302,
                        headers: { location: "/login" },
                    }),
                );
                break;
            case "envelope":
                request.resolve(
                    new Response(
                        '<graft-patch-set version="1" navigate="/login"></graft-patch-set>',
                        { headers: { "content-type": MEDIA_TYPE } },
                    ),
                );
                break;
            case "abort":
                request.reject(new DOMException("Aborted", "AbortError"));
                break;
            case "dispose":
                stopRuntime();
                request.resolve(reply("Obsolete"));
                break;
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(status.textContent).toBe("");
        expect(indicator.hidden).toBe(true);
        expect(events.some((event) => event.state === "succeeded")).toBe(false);
        expect(settled).not.toHaveBeenCalled();
        expect(JSON.stringify(events)).not.toContain("private");
        expect(document.getElementById("main")!.textContent).toBe("Old page");
        if (path === "abort" || path === "dispose") {
            expect(commandBlockReason()).toBeUndefined();
            expect(assign).not.toHaveBeenCalled();
            expect(diagnostic).not.toHaveBeenCalled();
            expect(events.map((event) => event.state)).toEqual([
                "started",
                path === "abort" ? "cancelled" : "disposed",
            ]);
        } else if (path === "transport") {
            expect(commandBlockReason()).toBeUndefined();
            expect(assign).not.toHaveBeenCalled();
            expect(events.at(-1)).toMatchObject({
                state: "failed",
                recovery: "retry",
            });
        } else {
            expect(commandBlockReason()).toBe("pending-navigation");
            expect(assign).toHaveBeenCalledOnce();
            expect(events.map((event) => event.state)).toEqual(
                path === "protocol"
                    ? ["started", "failed", "handed-off"]
                    : ["started", "handed-off"],
            );
        }
    },
);

test("history supersession rejects late results and old lifecycle facts cannot clear the new status", async () => {
    vi.useFakeTimers();
    const old = pending();
    const current = pending();
    link.click();
    const first = events[0]!;
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    link.click();
    expect(fetch).toHaveBeenCalledTimes(1);
    history.replaceState({ hypergraft: true }, "", "/history");
    dispatchEvent(
        new PopStateEvent("popstate", { state: { hypergraft: true } }),
    );
    const second = events.at(-1)!;
    expect(second).toMatchObject({
        state: "started",
        cause: "history-traversal",
        url: location.href,
    });
    expect(second.requestId).not.toBe(first.requestId);
    expect(signal.aborted).toBe(true);
    expect(events[1]).toEqual({
        ...first,
        state: "cancelled",
        reason: "superseded",
    });
    await vi.advanceTimersByTimeAsync(200);
    old.resolve(reply("Obsolete"));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(3);
    emitNavigation({ ...first, state: "disposed" });
    expect(status.textContent).not.toBe("");
    expect(document.getElementById("main")!.textContent).toBe("Old page");
    current.resolve(reply("History page"));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toEqual({ ...second, state: "succeeded" });
    expect(status.textContent).toBe("");
    expect(location.pathname).toBe("/history");
});

test("replacement retires the old identity synchronously and a late response cannot affect new feedback", async () => {
    vi.useFakeTimers();
    const old = pending();
    link.click();
    const first = events[0]!;
    cleanup.push(startHypergraft());
    expect(events[1]).toEqual({ ...first, state: "disposed" });
    const current = pending();
    link.click();
    expect(events[2]!.requestId).not.toBe(first.requestId);
    await vi.advanceTimersByTimeAsync(200);
    old.resolve(reply("Obsolete"));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(3);
    expect(status.textContent).not.toBe("");
    current.resolve(reply());
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toBe("");
});

test.each(["before", "after"])(
    "a startup observer registered %s feedback can dispose the runtime without a delayed announcement",
    async (order) => {
        vi.useFakeTimers();
        if (order === "before") cleanup[1]!();
        cleanup.push(
            listenForNavigation((detail) => {
                if (detail.state === "started") stopRuntime();
            }),
        );
        if (order === "before") cleanup.push(bindReadFeedback(document));
        link.click();
        expect(events.map((event) => event.state)).toEqual([
            "started",
            "disposed",
        ]);
        expect(fetch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(250);
        expect(status.textContent).toBe("");
        expect(indicator.hidden).toBe(true);
    },
);

test.each(["superseded", "handoff"])(
    "a %s observer cannot send a command before departure",
    async (path) => {
        const command = document.createElement("form");
        command.method = "post";
        command.action = "/command";
        command.dataset.graft = "";
        document.body.append(command);
        const first = pending();
        const second = pending();
        const assign = vi
            .spyOn(location, "assign")
            .mockImplementation(() => {});
        let attempts = 0;
        const submitCommand = () => {
            attempts += 1;
            command.dispatchEvent(
                new SubmitEvent("submit", {
                    bubbles: true,
                    cancelable: true,
                }),
            );
        };
        cleanup.push(
            listenForNavigation((detail) => {
                if (
                    detail.state !== "cancelled" &&
                    detail.state !== "handed-off"
                )
                    return;
                submitCommand();
                if (detail.state === "handed-off")
                    queueMicrotask(submitCommand);
            }),
        );
        link.click();
        if (path === "superseded") {
            dispatchEvent(
                new PopStateEvent("popstate", { state: { hypergraft: true } }),
            );
            second.resolve(reply());
            first.resolve(reply("Obsolete"));
        } else
            first.resolve(
                new Response(null, {
                    status: 302,
                    headers: { location: "/login" },
                }),
            );
        await flush();
        expect(attempts).toBe(path === "handoff" ? 2 : 1);
        expect(
            vi.mocked(fetch).mock.calls.map(([, options]) => options?.method),
        ).toEqual(path === "superseded" ? ["GET", "GET"] : ["GET"]);
        expect(assign).toHaveBeenCalledTimes(path === "handoff" ? 1 : 0);
    },
);

test("teardown between a GET form redirect and its caller prevents obsolete document navigation", async () => {
    const form = document.createElement("form");
    form.method = "get";
    form.action = "/query";
    form.dataset.graft = "";
    document.body.append(form);
    const request = pending();
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    form.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    request.resolve(
        new Response(null, { status: 302, headers: { location: "/obsolete" } }),
    );
    queueMicrotask(stopRuntime);
    await flush();
    expect(assign).not.toHaveBeenCalled();
    expect(events).toEqual([]);
});

test("feedback destruction removes a pending announcement without interference with request ownership", async () => {
    vi.useFakeTimers();
    const request = pending();
    const stopFeedback = cleanup[1]!;
    link.click();
    stopFeedback();
    await vi.advanceTimersByTimeAsync(250);
    expect(status.textContent).toBe("");
    expect(commandBlockReason()).toBe("pending-navigation");
    request.resolve(reply());
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)?.state).toBe("succeeded");
    cleanup.push(bindReadFeedback(document));
    const next = pending();
    link.click();
    await vi.advanceTimersByTimeAsync(200);
    stopFeedback();
    expect(status.textContent).not.toBe("");
    next.resolve(reply());
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toBe("");
});

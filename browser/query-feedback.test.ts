// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
    listenForNavigation,
    listenForQueryPending,
    listenForRequestSettled,
    type QueryPendingDetail,
} from "./events";
import { bindReadFeedback } from "./feedback";
import { MEDIA_TYPE } from "./patches";
import {
    commandBlockReason,
    resetHypergraftForTests,
    startHypergraft,
} from "./requests";

const cleanup: (() => void)[] = [];
let events: QueryPendingDetail[];
let status: HTMLElement;
let form: HTMLFormElement;
let stopRuntime: () => void;
const flush = () => vi.advanceTimersByTimeAsync(0);

function makeForm(action = "/query") {
    const element = document.createElement("form");
    element.method = "get";
    element.action = action;
    element.dataset.graft = "";
    element.innerHTML =
        '<input name="q" value="private query"><button type="submit">Filter</button>';
    document.body.append(element);
    return element;
}
function submit(element = form) {
    element.dispatchEvent(
        new SubmitEvent("submit", {
            bubbles: true,
            cancelable: true,
            submitter: element.querySelector("button"),
        }),
    );
}
function pending() {
    let resolve!: (value: Response) => void;
    let reject!: (reason: unknown) => void;
    vi.mocked(fetch).mockReturnValueOnce(
        new Promise<Response>((yes, no) => {
            resolve = yes;
            reject = no;
        }),
    );
    return { resolve, reject };
}
function envelope(text = "Current results", phase = "") {
    return `<graft-patch-set version="1"${phase ? ` phase="${phase}"` : ""}><graft-patch operation="children" target="results"><template>${text}</template></graft-patch></graft-patch-set>`;
}
function reply(text?: string) {
    return new Response(envelope(text), {
        headers: { "content-type": MEDIA_TYPE },
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    history.replaceState({}, "", "/start");
    document.body.innerHTML =
        '<main id="results">Previous results</main><progress data-graft-read-indicator hidden>Loading content</progress><p data-graft-read-status role="status"></p><a data-graft href="/next">Next</a>';
    form = makeForm();
    status = document.querySelector("[data-graft-read-status]")!;
    events = [];
    cleanup.push(
        listenForQueryPending((detail) => events.push(detail)),
        bindReadFeedback(document),
    );
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

test("queries expose pending ownership without values or navigation and fast results stay silent", async () => {
    const navigation = vi.fn();
    cleanup.push(
        listenForNavigation(navigation),
        listenForQueryPending((detail) => {
            if (detail.pending) expect(fetch).not.toHaveBeenCalled();
            else expect(form.hasAttribute("data-graft-pending")).toBe(false);
        }),
    );
    const request = pending();
    submit();
    const started = events[0]!;
    expect(started).toEqual({
        requestId: expect.any(Number),
        form,
        pending: true,
    });
    expect(form.querySelector("button")!.disabled).toBe(true);
    request.resolve(reply());
    await vi.advanceTimersByTimeAsync(250);
    expect(events).toEqual([started, { ...started, pending: false }]);
    expect(status.textContent).toBe("");
    expect(form.querySelector("button")!.disabled).toBe(false);
    expect(navigation).not.toHaveBeenCalled();
});

test.each([
    "success",
    "failure",
    "abort",
    "redirect",
    "envelope",
    "teardown",
] as const)(
    "%s ends delayed query feedback and restores the submitter",
    async (outcome) => {
        const request = pending();
        const settled = vi.fn();
        cleanup.push(listenForRequestSettled(settled));
        vi.spyOn(location, "assign").mockImplementation(() => {});
        submit();
        await vi.advanceTimersByTimeAsync(199);
        expect(status.textContent).toBe("");
        await vi.advanceTimersByTimeAsync(1);
        expect(status.textContent).toBe("Loading content");
        expect(document.getElementById("results")!.textContent).toBe(
            "Previous results",
        );
        if (outcome === "success") request.resolve(reply());
        else if (outcome === "failure")
            request.reject(new Error("private failure"));
        else if (outcome === "abort")
            request.reject(new DOMException("Aborted", "AbortError"));
        else if (outcome === "redirect")
            request.resolve(
                new Response(null, {
                    status: 302,
                    headers: { location: "/login" },
                }),
            );
        else if (outcome === "envelope")
            request.resolve(
                new Response(
                    '<graft-patch-set version="1" navigate="/login"></graft-patch-set>',
                    { headers: { "content-type": MEDIA_TYPE } },
                ),
            );
        else {
            stopRuntime();
            request.resolve(reply("Obsolete"));
        }
        await flush();
        expect(status.textContent).toBe("");
        expect(events.map((detail) => detail.pending)).toEqual([true, false]);
        expect(form.querySelector("button")!.disabled).toBe(false);
        expect(form.hasAttribute("aria-busy")).toBe(false);
        expect(settled).toHaveBeenCalledTimes(
            outcome === "success" || outcome === "failure" ? 1 : 0,
        );
        if (outcome === "redirect" || outcome === "envelope")
            expect(commandBlockReason()).toBe("pending-navigation");
    },
);

test.each(["first", "second"])(
    "completion of the %s query cannot hide another slow query",
    async (order) => {
        const first = pending();
        const second = pending();
        const other = makeForm("/other");
        submit();
        submit(other);
        await vi.advanceTimersByTimeAsync(200);
        (order === "first" ? first : second).resolve(reply());
        await flush();
        expect(status.textContent).toBe("Loading content");
        (order === "first" ? second : first).resolve(reply());
        await flush();
        expect(status.textContent).toBe("");
    },
);

test("a new query gets its own delay rather than the age of an older query", async () => {
    const first = pending();
    const second = pending();
    submit();
    await vi.advanceTimersByTimeAsync(180);
    submit(makeForm("/other"));
    first.resolve(reply());
    await vi.advanceTimersByTimeAsync(30);
    expect(status.textContent).toBe("");
    second.resolve(reply());
    await vi.advanceTimersByTimeAsync(250);
    expect(status.textContent).toBe("");
});

test("supersession and late responses cannot clear the replacement query's feedback", async () => {
    const first = pending();
    const second = pending();
    submit();
    submit();
    expect(events.map((detail) => detail.pending)).toEqual([true, false, true]);
    expect(events[2]!.requestId).not.toBe(events[0]!.requestId);
    await vi.advanceTimersByTimeAsync(200);
    first.resolve(reply("Obsolete"));
    await flush();
    expect(events).toHaveLength(3);
    expect(status.textContent).toBe("Loading content");
    second.resolve(reply());
    await flush();
    expect(status.textContent).toBe("");
});

test("form removal does not end query feedback before transport ends", async () => {
    const request = pending();
    submit();
    form.remove();
    await vi.advanceTimersByTimeAsync(200);
    expect(status.textContent).toBe("Loading content");
    request.resolve(reply());
    await flush();
    expect(status.textContent).toBe("");
    expect(events.map((detail) => detail.pending)).toEqual([true, false]);
});

test("feedback destruction cancels all query timers without cancelling their requests", async () => {
    const first = pending();
    const second = pending();
    submit();
    submit(makeForm("/other"));
    cleanup[1]!();
    await vi.advanceTimersByTimeAsync(250);
    expect(status.textContent).toBe("");
    expect(events.map((detail) => detail.pending)).toEqual([true, true]);
    first.resolve(reply());
    second.resolve(reply());
    await flush();
    expect(status.textContent).toBe("");
    expect(events.map((detail) => detail.pending)).toEqual([
        true,
        true,
        false,
        false,
    ]);
});

test("navigation cancels query feedback without a late query response hiding the navigation bar", async () => {
    const query = pending();
    const navigation = pending();
    submit();
    await vi.advanceTimersByTimeAsync(200);
    document.querySelector("a")!.click();
    await vi.advanceTimersByTimeAsync(200);
    query.resolve(reply("Obsolete"));
    await flush();
    expect(status.textContent).toBe("Loading content");
    expect(events.map((detail) => detail.pending)).toEqual([true, false]);
    navigation.resolve(reply());
    await flush();
    expect(status.textContent).toBe("");
});

test("runtime replacement disposes query ownership before a late response", async () => {
    const old = pending();
    submit();
    cleanup.push(startHypergraft());
    const current = pending();
    submit();
    await vi.advanceTimersByTimeAsync(200);
    old.resolve(reply("Obsolete"));
    await flush();
    expect(status.textContent).toBe("Loading content");
    expect(events.map((detail) => detail.pending)).toEqual([true, false, true]);
    current.resolve(reply());
    await flush();
    expect(status.textContent).toBe("");
});

test("query observers cannot duplicate a command during query cancellation", async () => {
    const query = pending();
    const command = pending();
    const first = makeForm("/first-command");
    const second = makeForm("/second-command");
    first.method = second.method = "post";
    cleanup.push(
        listenForQueryPending((detail) => {
            if (!detail.pending) submit(second);
        }),
    );
    submit();
    submit(first);
    expect(
        vi
            .mocked(fetch)
            .mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/query", "/first-command"]);
    expect(commandBlockReason()).toBe("pending-command");
    query.resolve(reply("Obsolete"));
    command.resolve(reply());
    await vi.advanceTimersByTimeAsync(250);
    expect(status.textContent).toBe("");
    expect(events.map((detail) => detail.pending)).toEqual([true, false]);
});

test("a query-end observer can supersede the next query without an obsolete request or lost cleanup", async () => {
    const first = pending();
    const latest = pending();
    let replaced = false;
    cleanup.push(
        listenForQueryPending((detail) => {
            if (!detail.pending && !replaced) {
                replaced = true;
                submit();
            }
        }),
    );
    submit();
    submit();
    expect(fetch).toHaveBeenCalledTimes(2);
    first.resolve(reply("Obsolete"));
    await vi.advanceTimersByTimeAsync(200);
    expect(status.textContent).toBe("Loading content");
    latest.resolve(reply());
    await flush();
    expect(status.textContent).toBe("");
});

test.each(["before", "after"])(
    "a startup observer registered %s feedback cannot leave a query or delayed announcement after teardown",
    async (order) => {
        if (order === "before") cleanup[1]!();
        cleanup.push(
            listenForQueryPending((detail) => {
                if (detail.pending) stopRuntime();
            }),
        );
        if (order === "before") cleanup.push(bindReadFeedback(document));
        submit();
        await vi.advanceTimersByTimeAsync(250);
        expect(fetch).not.toHaveBeenCalled();
        expect(events.map((detail) => detail.pending)).toEqual([true, false]);
        expect(status.textContent).toBe("");
        expect(
            document.querySelector<HTMLElement>("[data-graft-read-indicator]")!
                .hidden,
        ).toBe(true);
    },
);

test.each(["get", "post"])(
    "feedback follows the submitter's effective %s method",
    async (method) => {
        form.method = method === "get" ? "post" : "get";
        form.querySelector("button")!.formMethod = method;
        const request = pending();
        submit();
        await vi.advanceTimersByTimeAsync(200);
        expect(status.textContent).toBe(
            method === "get" ? "Loading content" : "",
        );
        request.resolve(reply());
        await flush();
        expect(events.map((detail) => detail.pending)).toEqual(
            method === "get" ? [true, false] : [],
        );
    },
);

test("a final stream frame does not clear feedback before the clean body end", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.mocked(fetch).mockResolvedValue(
        new Response(
            new ReadableStream({
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
    );
    submit();
    await vi.advanceTimersByTimeAsync(200);
    const frame = new TextEncoder().encode(envelope("Final content", "final"));
    controller.enqueue(new TextEncoder().encode(`${frame.byteLength}\n`));
    controller.enqueue(frame);
    await flush();
    expect(document.getElementById("results")!.textContent).toBe(
        "Final content",
    );
    expect(status.textContent).toBe("Loading content");
    controller.close();
    await flush();
    expect(status.textContent).toBe("");
});

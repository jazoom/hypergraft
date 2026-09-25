// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
    listenBeforeNavigation,
    listenForNavigation,
    type NavigationDetail,
} from "./events";
import { bindNavigationRecovery } from "./navigation-feedback";
import { MEDIA_TYPE } from "./patches";
import {
    cancelNavigation,
    commandBlockReason,
    resetHypergraftForTests,
    startHypergraft,
} from "./requests";

const live = vi.hoisted(() => ({
    reconcile: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    retireForm: vi.fn(),
    restoreForm: vi.fn(),
}));
vi.mock("./live", () => ({
    DEFAULT_LIVE_ENDPOINT: "/_hypergraft/live",
    createLiveController: () => live,
}));
const cleanup: (() => void)[] = [];
let events: NavigationDetail[];
let first: HTMLAnchorElement;
let second: HTMLAnchorElement;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const main = () => document.getElementById("main")!;
const failure = () =>
    document.querySelector<HTMLElement>("[data-graft-navigation-failure]")!;
const retry = () =>
    document.querySelector<HTMLAnchorElement>("[data-graft-navigation-retry]")!;
const navigationStatus = () =>
    document.querySelector<HTMLElement>("[data-graft-navigation-status]")!;
function patch(text = "Destination", phase = "") {
    return `<graft-patch-set version="1"${phase}><graft-patch operation="children" target="main"><template>${text}</template></graft-patch></graft-patch-set>`;
}
function reply(text = "Destination") {
    return new Response(patch(text), {
        headers: { "content-type": MEDIA_TYPE },
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
beforeEach(() => {
    history.replaceState({}, "", "/current");
    document.body.innerHTML = `<main id="main" tabindex="-1"><input value="Initial"></main>
        <a id="first" data-graft href="/patients">Patients</a><a id="second" data-graft href="/diary">Diary</a>
        <p data-graft-navigation-status role="status" aria-atomic="true"></p>
        <aside data-graft-navigation-failure hidden><p data-graft-navigation-message>Connection failed</p><a data-graft data-graft-navigation-retry>Retry</a><button data-graft-navigation-dismiss>Dismiss</button></aside>
        <form method="post" action="/command" data-graft><button>Save</button></form>`;
    first = document.querySelector("#first")!;
    second = document.querySelector("#second")!;
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(location, "assign").mockImplementation(() => {});
    vi.spyOn(location, "replace").mockImplementation(() => {});
    vi.spyOn(location, "reload").mockImplementation(() => {});
    vi.clearAllMocks();
    events = [];
    cleanup.push(
        listenForNavigation((detail) => events.push(detail)),
        bindNavigationRecovery(document),
        startHypergraft(),
    );
});
afterEach(() => {
    resetHypergraftForTests();
    for (const stop of cleanup.splice(0).reverse()) stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test.each(["patch", "redirect", "failure"])(
    "a late %s cannot overwrite the latest destination or history",
    async (late) => {
        const old = pending();
        const current = pending();
        const push = vi.spyOn(history, "pushState");
        first.click();
        const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
        second.click();
        second.click();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(signal.aborted).toBe(true);
        expect(events[1]).toMatchObject({
            state: "cancelled",
            reason: "superseded",
        });
        current.resolve(reply("Diary"));
        await flush();
        if (late === "failure") old.reject(new Error("offline"));
        else
            old.resolve(
                late === "patch"
                    ? reply("Patients")
                    : new Response(null, {
                          status: 302,
                          headers: { location: "/login" },
                      }),
            );
        await flush();
        expect(main().textContent).toBe("Diary");
        expect(location.pathname).toBe("/diary");
        expect(push).toHaveBeenCalledTimes(1);
        expect(location.assign).not.toHaveBeenCalled();
        expect(events).toHaveLength(4);
    },
);

test.each(["fetch", "body"])(
    "a %s failure retains input and explicit retry adds only the successful history entry",
    async (stage) => {
        const request = pending();
        const input = main().querySelector("input")!;
        input.value = "Local draft";
        input.focus();
        input.setSelectionRange(2, 5);
        const push = vi.spyOn(history, "pushState");
        expect(navigationStatus().textContent).toBe("");
        first.click();
        if (stage === "fetch") request.reject(new TypeError("offline"));
        else
            request.resolve(
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.error(new Error("lost body"));
                        },
                    }),
                    { headers: { "content-type": MEDIA_TYPE } },
                ),
            );
        await flush();
        expect(main().querySelector("input")).toBe(input);
        expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(
            ["Local draft", 2, 5],
        );
        expect(location.pathname).toBe("/current");
        expect(failure().hidden).toBe(false);
        expect(navigationStatus().textContent).toBe("Connection failed");
        expect(navigationStatus().closest("[hidden]")).toBeNull();
        expect(live.resume).toHaveBeenCalledOnce();
        expect(commandBlockReason()).toBeUndefined();
        expect(push).not.toHaveBeenCalled();
        expect(location.assign).not.toHaveBeenCalled();
        const retried = pending();
        retry().click();
        expect(navigationStatus().textContent).toBe("");
        expect(events.at(-1)!.requestId).not.toBe(events[0]!.requestId);
        expect(push).not.toHaveBeenCalled();
        retried.resolve(reply());
        await flush();
        expect(push).toHaveBeenCalledTimes(1);
        expect(location.pathname).toBe("/patients");
    },
);

test("retry passes through departure guards and dismissal neither requests nor changes history", async () => {
    const request = pending();
    first.click();
    request.reject(new Error("offline"));
    await flush();
    retry().addEventListener("click", (event) => event.preventDefault(), {
        once: true,
    });
    retry().click();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(failure().hidden).toBe(false);
    document
        .querySelector<HTMLButtonElement>("[data-graft-navigation-dismiss]")!
        .click();
    expect(failure().hidden).toBe(true);
    expect(navigationStatus().textContent).toBe("");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe("/current");
});

test("a departure dialogue can resume the retry link after commitment cancellation", async () => {
    const failedRequest = pending();
    first.click();
    failedRequest.reject(new Error("offline"));
    await flush();
    const retried = pending();
    retry().click();
    const destination = retry().href;
    let resume!: () => void;
    const stopGuard = listenBeforeNavigation((event) => {
        event.preventDefault();
        resume = () => event.detail.link!.click();
    });
    cleanup.push(stopGuard);
    retried.resolve(reply());
    await flush();
    expect(location.pathname).toBe("/current");
    expect(retry().href).toBe(destination);
    stopGuard();
    const approved = pending();
    resume();
    expect(fetch).toHaveBeenCalledTimes(3);
    approved.resolve(reply("Approved destination"));
    await flush();
    expect(location.pathname).toBe("/patients");
    expect(main().textContent).toBe("Approved destination");
});

test("cancel retires identity, resumes live work and rejects even a late redirect", async () => {
    const request = pending();
    first.click();
    const id = events[0]!.requestId;
    expect(cancelNavigation(id + 1)).toBe(false);
    expect(commandBlockReason()).toBe("pending-navigation");
    expect(cancelNavigation(id)).toBe(true);
    expect(cancelNavigation(id)).toBe(false);
    expect(live.resume).toHaveBeenCalledOnce();
    expect(commandBlockReason()).toBeUndefined();
    request.resolve(
        new Response(null, { status: 302, headers: { location: "/obsolete" } }),
    );
    await flush();
    expect(location.assign).not.toHaveBeenCalled();
    expect(main().querySelector("input")!.value).toBe("Initial");
    expect(events.map((event) => event.state)).toEqual([
        "started",
        "cancelled",
    ]);
});

test.each(["failure", "cancel", "replacement"])(
    "a fragment change preserves the current document after navigation %s",
    async (path) => {
        const request = pending();
        const input = main().querySelector("input")!;
        input.value = "Local draft";
        first.click();
        history.replaceState(history.state, "", "#section");
        if (path === "failure") request.reject(new Error("offline"));
        if (path === "cancel") cancelNavigation(events[0]!.requestId);
        if (path === "replacement") cleanup.push(startHypergraft());
        await flush();
        expect(location.hash).toBe("#section");
        expect(main().querySelector("input")).toBe(input);
        expect(input.value).toBe("Local draft");
        expect(commandBlockReason()).toBeUndefined();
        expect(failure().hidden).toBe(path !== "failure");
        request.resolve(reply("Obsolete"));
        await flush();
        expect(main().querySelector("input")).toBe(input);
        resetHypergraftForTests();
        expect(location.assign).not.toHaveBeenCalled();
        expect(location.replace).not.toHaveBeenCalled();
        expect(location.reload).not.toHaveBeenCalled();
    },
);

test.each(["failure", "cancel", "replacement", "superseding-link"])(
    "traversal %s recovers the browser URL without another history entry",
    async (path) => {
        const request = pending();
        const push = vi.spyOn(history, "pushState");
        history.replaceState({ hypergraft: true }, "", "/previous");
        dispatchEvent(
            new PopStateEvent("popstate", { state: { hypergraft: true } }),
        );
        if (path === "failure") request.reject(new Error("offline"));
        if (path === "cancel") cancelNavigation(events[0]!.requestId);
        if (path === "replacement") cleanup.push(startHypergraft());
        if (path === "superseding-link") {
            const next = pending();
            second.click();
            next.reject(new Error("offline"));
        }
        await flush();
        expect(push).not.toHaveBeenCalled();
        expect(failure().hidden).toBe(true);
        if (path === "superseding-link")
            expect(location.replace).toHaveBeenCalledWith(second.href);
        else expect(location.reload).toHaveBeenCalledOnce();
        expect(commandBlockReason()).toBe("pending-navigation");
        request.resolve(reply("Obsolete"));
        await flush();
        expect(main().querySelector("input")).not.toBeNull();
    },
);

test.each(["failure", "cancel", "replacement"])(
    "same-URL traversal %s still uses document recovery",
    async (path) => {
        const request = pending();
        dispatchEvent(
            new PopStateEvent("popstate", { state: { hypergraft: true } }),
        );
        if (path === "failure") request.reject(new Error("offline"));
        if (path === "cancel") cancelNavigation(events[0]!.requestId);
        if (path === "replacement") cleanup.push(startHypergraft());
        await flush();
        expect(location.reload).toHaveBeenCalledOnce();
        expect(commandBlockReason()).toBe("pending-navigation");
        expect(failure().hidden).toBe(true);
        request.resolve(reply("Obsolete"));
        await flush();
        expect(main().querySelector("input")).not.toBeNull();
    },
);

test.each(["failure", "cancel"])(
    "a partial stream %s uses document recovery, never intact-page feedback",
    async (path) => {
        let body!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                body = controller;
            },
        });
        vi.mocked(fetch).mockResolvedValueOnce(
            new Response(stream, {
                headers: {
                    "content-type": MEDIA_TYPE,
                    "graft-transfer": "stream",
                },
            }),
        );
        first.click();
        const frame = patch("Partial", ' phase="progress"');
        body.enqueue(
            new TextEncoder().encode(
                `${new TextEncoder().encode(frame).byteLength}\n${frame}`,
            ),
        );
        await flush();
        expect(main().textContent).toBe("Partial");
        if (path === "failure") body.error(new Error("lost stream"));
        else {
            cancelNavigation(events[0]!.requestId);
            body.close();
        }
        await flush();
        expect(location.assign).toHaveBeenCalledWith(first.href);
        expect(failure().hidden).toBe(true);
        expect(commandBlockReason()).toBe("pending-navigation");
        expect(live.resume).not.toHaveBeenCalled();
    },
);

test("runtime replacement during handoff cannot strand the document behind a pending guard", async () => {
    cleanup.push(
        listenForNavigation((detail) => {
            if (detail.state === "handed-off") cleanup.push(startHypergraft());
        }),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/login" } }),
    );
    first.click();
    await flush();
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.reload).toHaveBeenCalledOnce();
    expect(commandBlockReason()).toBe("pending-navigation");
});

test("a later patch exception keeps earlier mutations and requires an authoritative document", async () => {
    const other = document.createElement("section");
    other.id = "other";
    document.body.append(other);
    other.insertBefore = (() => {
        throw new Error("synthetic morph failure");
    }) as typeof other.insertBefore;
    const response = patch("First target changed").replace(
        "</graft-patch-set>",
        '<graft-patch operation="children" target="other"><template><p>Second target</p></template></graft-patch></graft-patch-set>',
    );
    vi.mocked(fetch).mockResolvedValueOnce(
        new Response(response, { headers: { "content-type": MEDIA_TYPE } }),
    );
    first.click();
    await flush();
    expect(main().textContent).toBe("First target changed");
    expect(events.find((event) => event.state === "failed")).toMatchObject({
        recovery: "document",
    });
    expect(location.assign).toHaveBeenCalledWith(first.href);
    expect(failure().hidden).toBe(true);
    expect(live.resume).not.toHaveBeenCalled();
});

test("a commitment guard retains edits made during transport", async () => {
    const request = pending();
    const input = main().querySelector("input")!;
    cleanup.push(
        listenBeforeNavigation((event) => {
            if (input.value !== "Initial") event.preventDefault();
        }),
    );
    first.click();
    input.value = "New local draft";
    request.resolve(reply());
    await flush();
    expect(main().querySelector("input")?.value).toBe("New local draft");
    expect(location.pathname).toBe("/current");
    expect(events.at(-1)).toMatchObject({
        state: "cancelled",
        reason: "aborted",
    });
    expect(live.resume).toHaveBeenCalledOnce();
});

test.each(["pending", "uncertain"])(
    "recovery controls cannot release a %s command guard or replay the command",
    async (state) => {
        const navigation = pending();
        first.click();
        navigation.reject(new Error("offline"));
        await flush();
        const command = pending();
        document
            .querySelector("form")!
            .dispatchEvent(
                new SubmitEvent("submit", { bubbles: true, cancelable: true }),
            );
        if (state === "uncertain") {
            command.reject(new Error("response lost"));
            await flush();
        }
        cancelNavigation(events[0]!.requestId);
        retry().click();
        second.click();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(commandBlockReason()).toBe(`${state}-command`);
        expect(live.resume).toHaveBeenCalledTimes(1);
        if (state === "uncertain") expect(failure().hidden).toBe(true);
    },
);

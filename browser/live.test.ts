// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fixture from "../protocol-v1.json";
import {
    LIVE_PATCH_EVENT,
    listenForLiveStateChanges,
    type AppliedLivePatchDetail,
    type LiveStateChangeDetail,
} from "./events";
import {
    DEFAULT_LIVE_ENDPOINT,
    LIVE_CLOSE,
    LIVE_HEARTBEAT_SECONDS,
    LIVE_LEASE_SECONDS,
    LIVE_RETRY_MAX_SECONDS,
    LIVE_RETRY_MIN_SECONDS,
    LIVE_SUBPROTOCOL,
    LIVE_SUBSCRIPTION_HEADER_BYTES,
    MAX_LIVE_CONTROL_BYTES,
    MAX_LIVE_INBOUND_BYTES,
    MAX_LIVE_INBOUND_MESSAGES,
    MAX_LIVE_OUTBOUND_CONTROLS,
    MAX_LIVE_SUBSCRIPTIONS,
    MAX_LIVE_URL_BYTES,
} from "./live";
import { MAX_RESPONSE_BYTES, MEDIA_TYPE } from "./patches";
import { resetHypergraftForTests, startHypergraft } from "./requests";

class MockSocket extends EventTarget {
    static instances: MockSocket[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = MockSocket.CONNECTING;
    binaryType = "arraybuffer";
    sent: string[] = [];
    protocol = LIVE_SUBPROTOCOL;
    extensions = "";
    closedWith?: number;
    constructor(
        public url: string,
        public requestedProtocol?: string,
    ) {
        super();
        MockSocket.instances.push(this);
        queueMicrotask(() => {
            if (this.readyState !== MockSocket.CONNECTING) return;
            this.readyState = MockSocket.OPEN;
            this.dispatchEvent(new Event("open"));
        });
    }
    send(data: string) {
        this.sent.push(data);
    }
    close(code = 1000) {
        this.closedWith = code;
        this.readyState = MockSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code }));
    }
    finishClose(code = this.closedWith ?? 1000, reason = "") {
        this.closedWith = code;
        this.readyState = MockSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code, reason }));
    }
    receive(id: number, envelope: string) {
        const encoded = new TextEncoder().encode(envelope);
        const buffer = new ArrayBuffer(4 + encoded.byteLength);
        new DataView(buffer).setUint32(0, id);
        new Uint8Array(buffer).set(encoded, 4);
        this.dispatchEvent(new MessageEvent("message", { data: buffer }));
    }
}

type ProtocolCase = {
    name: string;
    consumers: string[];
    expectation: "accept" | "protocol";
    control?: string;
};

function protocolCases(consumer: string): ProtocolCase[] {
    return (fixture as { cases: ProtocolCase[] }).cases.filter((item) =>
        item.consumers.includes(consumer),
    );
}

function envelope(target: string, content: string) {
    return `<graft-patch-set version="1"><graft-patch operation="children" target="${target}"><template>${content}</template></graft-patch></graft-patch-set>`;
}

function liveForm(id: string, action: string, target: string) {
    const form = document.createElement("form");
    form.id = id;
    form.dataset.graft = "";
    form.dataset.graftLive = "";
    form.method = "get";
    form.action = action;
    form.innerHTML = `<button type="submit">Refresh</button>`;
    document.body.append(form);
    if (!document.getElementById(target)) {
        const section = document.createElement("section");
        section.id = target;
        document.body.append(section);
    }
    return form;
}

let cleanup: (() => void) | undefined;
let stopListeners: (() => void)[] = [];

function recordLiveStates(): LiveStateChangeDetail[] {
    const details: LiveStateChangeDetail[] = [];
    stopListeners.push(
        listenForLiveStateChanges((detail) => {
            details.push(detail);
        }),
    );
    return details;
}

beforeEach(() => {
    MockSocket.instances = [];
    stopListeners = [];
    vi.stubGlobal("WebSocket", MockSocket);
    vi.stubGlobal("fetch", vi.fn());
    history.replaceState({}, "", "/");
    document.body.innerHTML = "";
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    for (const stop of stopListeners) stop();
    stopListeners = [];
    resetHypergraftForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

test("matches the shared live fixture", () => {
    expect(LIVE_SUBPROTOCOL).toBe(fixture.live.subprotocol);
    expect(DEFAULT_LIVE_ENDPOINT).toBe(fixture.live.defaultPath);
    expect(MAX_LIVE_SUBSCRIPTIONS).toBe(fixture.live.limits.maxSubscriptions);
    expect(MAX_LIVE_URL_BYTES).toBe(fixture.live.limits.maxProjectionUrlBytes);
    expect(MAX_LIVE_CONTROL_BYTES).toBe(
        fixture.live.limits.maxControlMessageBytes,
    );
    expect(MAX_LIVE_OUTBOUND_CONTROLS).toBe(
        fixture.live.limits.maxInboundControls,
    );
    expect(MAX_LIVE_INBOUND_MESSAGES).toBe(
        fixture.live.limits.maxOutboundMessages,
    );
    expect(MAX_LIVE_INBOUND_BYTES).toBe(fixture.live.limits.maxOutboundBytes);
    expect(LIVE_LEASE_SECONDS).toBe(fixture.live.limits.leaseSeconds);
    expect(LIVE_HEARTBEAT_SECONDS).toBe(fixture.live.limits.heartbeatSeconds);
    expect(LIVE_RETRY_MIN_SECONDS).toBe(fixture.live.retry.minDelaySeconds);
    expect(LIVE_RETRY_MAX_SECONDS).toBe(fixture.live.retry.maxDelaySeconds);
    expect(LIVE_SUBSCRIPTION_HEADER_BYTES).toBe(fixture.live.patch.headerBytes);
    expect(MAX_RESPONSE_BYTES).toBe(fixture.live.patch.maxEnvelopeBytes);
    expect(fixture.live.heartbeat.pongRequired).toBe(true);
    expect(LIVE_CLOSE).toEqual(fixture.live.close);
    expect(fixture.request.kinds).toEqual(["navigation", "patch"]);
    expect(fixture.transfer.kinds).toEqual(["complete", "stream"]);
});

test("produces accepted control messages from the protocol fixture", async () => {
    const cases = protocolCases("browser-control");
    expect(cases.length).toBeGreaterThan(0);
    const form = liveForm("one", "/items", "item-results");
    form.insertAdjacentHTML(
        "afterbegin",
        '<input type="hidden" name="fixture" value="one">',
    );
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const socket = MockSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    form.remove();
    await vi.waitFor(() =>
        expect(socket.sent.some((value) => value.includes("unsubscribe"))).toBe(
            true,
        ),
    );
    await vi.waitFor(() =>
        expect(socket.sent.some((value) => value.includes("terminal"))).toBe(
            true,
        ),
    );
    const sent = socket.sent.map((value) => JSON.parse(value) as unknown);
    for (const item of cases) {
        expect(item.expectation, item.name).toBe("accept");
        expect(item.control, item.name).toBeTypeOf("string");
        expect(sent, item.name).toContainEqual(JSON.parse(item.control!));
    }
});

test("opens one socket and applies the first live patch", async () => {
    liveForm("one", "/items", "item-results");
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const socket = MockSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(JSON.parse(socket.sent[0]!)).toEqual({
        v: "1",
        type: "subscribe",
        id: 1,
        url: "/items",
    });
    const patches: AppliedLivePatchDetail[] = [];
    addEventListener(LIVE_PATCH_EVENT, (event) =>
        patches.push((event as CustomEvent<AppliedLivePatchDetail>).detail),
    );
    socket.receive(1, envelope("item-results", '<p id="ready">Ready</p>'));
    expect(document.getElementById("ready")).not.toBeNull();
    expect(patches[0]?.targetIds).toEqual(["item-results"]);
    expect(patches[0]?.form.id).toBe("one");
});

test("ignores patches for retired identifiers and obsolete generations", async () => {
    const form = liveForm("one", "/items", "item-results");
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const first = MockSocket.instances[0]!;
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    form.remove();
    await vi.waitFor(() =>
        expect(first.sent.some((value) => value.includes("unsubscribe"))).toBe(
            true,
        ),
    );
    first.receive(1, envelope("item-results", '<p id="stale">Stale</p>'));
    expect(document.getElementById("stale")).toBeNull();
});

test("rejects ancestor or descendant target ownership", async () => {
    document.body.innerHTML = `
        <form id="parent-form" method="get" action="/parent" data-graft data-graft-live><button>P</button></form>
        <form id="child-form" method="get" action="/child" data-graft data-graft-live><button>C</button></form>
        <div id="parent"><div id="child"></div></div>`;
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const socket = MockSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    socket.receive(
        1,
        envelope("parent", '<p id="outer">Outer</p><div id="child"></div>'),
    );
    expect(document.getElementById("outer")).not.toBeNull();
    socket.receive(2, envelope("child", '<p id="inner">Inner</p>'));
    expect(document.getElementById("inner")).toBeNull();
});

test("keeps target reservations until their subscription retires", async () => {
    document.body.innerHTML = `
        <form id="owner" method="get" action="/owner" data-graft data-graft-live><button>Owner</button></form>
        <form id="other" method="get" action="/other" data-graft data-graft-live><button>Other</button></form>
        <div id="parent"><div id="child"></div></div>
        <div id="sibling"></div>`;
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const socket = MockSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    socket.receive(1, envelope("parent", '<div id="child"></div>'));
    socket.receive(1, envelope("sibling", "<p>Updated</p>"));
    socket.receive(2, envelope("child", '<p id="stolen">Stolen</p>'));
    expect(document.getElementById("stolen")).toBeNull();
});

test("reconnects after a retryable close with a new first patch", async () => {
    vi.useFakeTimers();
    liveForm("one", "/items", "item-results");
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    MockSocket.instances[0]!.close(LIVE_CLOSE.retryable);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(2));
    const second = MockSocket.instances[1]!;
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    expect(JSON.parse(second.sent[0]!).id).toBe(1);
    second.receive(1, envelope("item-results", '<p id="again">Again</p>'));
    expect(document.getElementById("again")).not.toBeNull();
});

test("renews the socket when its lease expires", async () => {
    vi.useFakeTimers();
    liveForm("one", "/items", "item-results");
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const first = MockSocket.instances[0]!;
    await vi.advanceTimersByTimeAsync(LIVE_LEASE_SECONDS * 1000);
    expect(first.closedWith).toBe(LIVE_CLOSE.leaseExpiry);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(2));
});

test("renews before it exceeds the inbound message budget", async () => {
    liveForm("one", "/items", "item-results");
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const socket = MockSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    for (let count = 0; count <= MAX_LIVE_INBOUND_MESSAGES; count += 1)
        socket.receive(999, fixture.representativeLivePatch);
    expect(socket.closedWith).toBe(LIVE_CLOSE.leaseExpiry);
});

test("stops after a protocol frame from the server", async () => {
    liveForm("one", "/items", "item-results");
    const states = recordLiveStates();
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const socket = MockSocket.instances[0]!;
    socket.dispatchEvent(new MessageEvent("message", { data: "not binary" }));
    expect(socket.closedWith).toBe(LIVE_CLOSE.protocol);
    expect(states.at(-1)).toEqual({ state: "stopped", close: "protocol" });
    cleanup();
    cleanup();
    expect(states.filter((detail) => detail.state === "stopped")).toHaveLength(
        1,
    );
});

test("keeps a submitted live form retired until its GET settles", async () => {
    const form = liveForm("one", "/items", "item-results");
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    let resolveResponse!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((resolve) => {
            resolveResponse = resolve;
        }),
    );
    form.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() =>
        expect(MockSocket.instances[0]!.readyState).toBe(MockSocket.CLOSED),
    );
    document.body.append(document.createElement("div"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(MockSocket.instances).toHaveLength(1);
    resolveResponse(
        new Response(envelope("item-results", "<p>Settled</p>"), {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(2));
});

test("closes live mode before page navigation", async () => {
    liveForm("one", "/items", "item-results");
    const link = document.createElement("a");
    link.dataset.graft = "";
    link.href = "/next";
    document.body.append(link);
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    let resolveResponse!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((resolve) => {
            resolveResponse = resolve;
        }),
    );
    link.click();
    await vi.waitFor(() =>
        expect(MockSocket.instances[0]!.readyState).toBe(MockSocket.CLOSED),
    );
    resolveResponse(
        new Response(envelope("item-results", "<p>Next</p>"), {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(2));
});

test("closes the socket before an unsafe command and resumes after a known result", async () => {
    liveForm("one", "/items", "item-results");
    const command = document.createElement("form");
    command.dataset.graft = "";
    command.method = "post";
    command.action = "/save";
    command.innerHTML = '<button type="submit">Save</button>';
    document.body.append(command);
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const first = MockSocket.instances[0]!;
    vi.mocked(fetch).mockResolvedValue(
        new Response(envelope("item-results", '<p id="saved">Saved</p>'), {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    command.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(first.readyState).toBe(MockSocket.CLOSED));
    await vi.waitFor(() =>
        expect(MockSocket.instances.length).toBeGreaterThan(1),
    );
});

test("leaves live mode suspended after an uncertain unsafe result", async () => {
    liveForm("one", "/items", "item-results");
    const command = document.createElement("form");
    command.dataset.graft = "";
    command.method = "post";
    command.action = "/save";
    command.innerHTML = '<button type="submit">Save</button>';
    document.body.append(command);
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    vi.mocked(fetch).mockRejectedValue(new TypeError("network failed"));
    command.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() =>
        expect(MockSocket.instances[0]!.readyState).toBe(MockSocket.CLOSED),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(MockSocket.instances).toHaveLength(1);
});

test.each(["command", "navigation"])(
    "releases a cancelled GET without a reconnect during %s",
    async (kind) => {
        vi.useFakeTimers();
        const form = liveForm("one", "/items", "item-results");
        document.body.insertAdjacentHTML(
            "beforeend",
            '<form id="command" data-graft method="post" action="/save"></form><a id="next" data-graft href="/next">Next</a>',
        );
        cleanup = startHypergraft();
        await vi.advanceTimersByTimeAsync(0);
        const old = MockSocket.instances[0]!;
        const settled = vi.fn();
        const diagnostic = vi.fn();
        document.addEventListener("hypergraft:requestsettled", settled);
        document.addEventListener("hypergraft:diagnostic", diagnostic);
        let resolveGet!: (response: Response) => void;
        let resolveNext!: (response: Response) => void;
        vi.mocked(fetch)
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveGet = resolve;
                }),
            )
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveNext = resolve;
                }),
            );
        form.dispatchEvent(
            new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        );
        if (kind === "command")
            document.getElementById("command")!.dispatchEvent(
                new SubmitEvent("submit", {
                    bubbles: true,
                    cancelable: true,
                }),
            );
        else document.getElementById("next")!.click();
        expect(form.hasAttribute("data-graft-pending")).toBe(false);
        resolveGet(
            new Response(envelope("item-results", "Stale"), {
                headers: { "content-type": MEDIA_TYPE },
            }),
        );
        document.body.append(document.createElement("div"));
        old.receive(1, envelope("item-results", "Late socket"));
        old.dispatchEvent(
            new CloseEvent("close", { code: LIVE_CLOSE.retryable }),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        expect(MockSocket.instances).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(document.getElementById("item-results")!.textContent).toBe("");
        expect(settled).not.toHaveBeenCalled();
        expect(diagnostic).not.toHaveBeenCalled();
        resolveNext(
            new Response(envelope("item-results", "Current"), {
                headers: { "content-type": MEDIA_TYPE },
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(MockSocket.instances).toHaveLength(2);
        expect(JSON.parse(MockSocket.instances[1]!.sent[0]!)).toMatchObject({
            type: "subscribe",
            url: "/items",
        });
        document.removeEventListener("hypergraft:requestsettled", settled);
        document.removeEventListener("hypergraft:diagnostic", diagnostic);
    },
);

test.each(["pending", "uncertain"])(
    "a replacement inherits %s suspension until reload",
    async (state) => {
        vi.useFakeTimers();
        const reload = vi
            .spyOn(location, "reload")
            .mockImplementation(() => {});
        liveForm("one", "/items", "item-results");
        document.body.insertAdjacentHTML(
            "beforeend",
            '<form id="command" data-graft method="post" action="/save"></form>',
        );
        cleanup = startHypergraft();
        await vi.advanceTimersByTimeAsync(0);
        const old = MockSocket.instances[0]!;
        let resolve!: (response: Response) => void;
        let reject!: (error: Error) => void;
        vi.mocked(fetch).mockReturnValue(
            new Promise((done, fail) => {
                resolve = done;
                reject = fail;
            }),
        );
        document
            .getElementById("command")!
            .dispatchEvent(
                new SubmitEvent("submit", { bubbles: true, cancelable: true }),
            );
        if (state === "uncertain") {
            reject(new TypeError("network failed"));
            await vi.advanceTimersByTimeAsync(0);
        }
        cleanup = startHypergraft();
        liveForm("two", "/other", "other-results");
        old.receive(1, envelope("item-results", "Late"));
        old.dispatchEvent(new Event("open"));
        old.dispatchEvent(
            new CloseEvent("close", { code: LIVE_CLOSE.retryable }),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        expect(MockSocket.instances).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(document.getElementById("item-results")!.textContent).toBe("");
        if (state === "pending") {
            resolve(
                new Response(envelope("item-results", "Disposed"), {
                    headers: { "content-type": MEDIA_TYPE },
                }),
            );
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reload).toHaveBeenCalledOnce();
            expect(document.getElementById("item-results")!.textContent).toBe(
                "",
            );
            expect(MockSocket.instances).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(0);
        }
        cleanup();
        cleanup = undefined;
        expect(reload).toHaveBeenCalled();
    },
);

test("an older GET cannot release its replacement's live retirement", async () => {
    vi.useFakeTimers();
    const form = liveForm("one", "/items", "item-results");
    cleanup = startHypergraft();
    await vi.advanceTimersByTimeAsync(0);
    let resolveOld!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    vi.mocked(fetch)
        .mockReturnValueOnce(
            new Promise((resolve) => {
                resolveOld = resolve;
            }),
        )
        .mockReturnValueOnce(
            new Promise((resolve) => {
                resolveNew = resolve;
            }),
        );
    for (let index = 0; index < 2; index++)
        form.dispatchEvent(
            new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        );
    resolveOld(
        new Response(envelope("item-results", "Stale"), {
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(MockSocket.instances).toHaveLength(1);
    expect(form.hasAttribute("data-graft-pending")).toBe(true);
    resolveNew(
        new Response(envelope("item-results", "Current"), {
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(MockSocket.instances).toHaveLength(2);
    expect(document.getElementById("item-results")!.textContent).toBe(
        "Current",
    );
});

test("keeps the socket while visibility changes", async () => {
    liveForm("one", "/items", "item-results");
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(MockSocket.instances[0]!.readyState).toBe(MockSocket.OPEN);
});

test("teardown closes the socket", async () => {
    liveForm("one", "/items", "item-results");
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    cleanup();
    cleanup = undefined;
    expect(MockSocket.instances[0]!.readyState).toBe(MockSocket.CLOSED);
});

test("emits reconnect and teardown live state without duplicates", async () => {
    vi.useFakeTimers();
    liveForm("one", "/items", "item-results");
    const states = recordLiveStates();
    cleanup = startHypergraft();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual([{ state: "connecting" }, { state: "open" }]);
    document.body.append(document.createElement("div"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual([{ state: "connecting" }, { state: "open" }]);
    const first = MockSocket.instances[0]!;
    first.close(LIVE_CLOSE.retryable);
    const reconnect = states.at(-1);
    expect(reconnect?.state).toBe("reconnecting");
    if (reconnect?.state !== "reconnecting") return;
    expect(reconnect.close).toBe("retryable");
    expect(reconnect.retryDelayMs).toBeGreaterThanOrEqual(
        LIVE_RETRY_MIN_SECONDS * 1000,
    );
    expect(reconnect.retryDelayMs).toBeLessThanOrEqual(
        LIVE_RETRY_MAX_SECONDS * 1000,
    );
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_MAX_SECONDS * 1000);
    expect(states.at(-2)).toEqual({ state: "connecting" });
    expect(states.at(-1)).toEqual({ state: "open" });
    cleanup();
    cleanup = undefined;
    first.close(LIVE_CLOSE.retryable);
    MockSocket.instances[1]?.close(LIVE_CLOSE.retryable);
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_MAX_SECONDS * 1000);
    expect(states.at(-1)).toEqual({ state: "stopped" });
    expect(states.filter((detail) => detail.state === "stopped")).toHaveLength(
        1,
    );
    cleanup = startHypergraft();
    cleanup();
    cleanup = undefined;
    expect(states.filter((detail) => detail.state === "stopped")).toHaveLength(
        2,
    );
});

test("emits reconnecting only after a delayed close event", async () => {
    vi.useFakeTimers();
    liveForm("one", "/items", "item-results");
    const states = recordLiveStates();
    cleanup = startHypergraft();
    await vi.advanceTimersByTimeAsync(0);
    const socket = MockSocket.instances[0]!;
    expect(states).toEqual([{ state: "connecting" }, { state: "open" }]);
    vi.spyOn(socket, "close").mockImplementation((code = 1000) => {
        socket.readyState = MockSocket.CLOSING;
        setTimeout(() => socket.finishClose(code, "private peer reason"), 25);
    });
    await vi.advanceTimersByTimeAsync(LIVE_LEASE_SECONDS * 1000);
    expect(socket.readyState).toBe(MockSocket.CLOSING);
    expect(states).toEqual([{ state: "connecting" }, { state: "open" }]);
    await vi.advanceTimersByTimeAsync(25);
    const reconnect = states.at(-1);
    expect(reconnect).toEqual({
        state: "reconnecting",
        close: "leaseExpiry",
        retryDelayMs: expect.any(Number),
    });
    if (reconnect?.state !== "reconnecting") return;
    expect(reconnect.retryDelayMs).toBeGreaterThanOrEqual(
        LIVE_RETRY_MIN_SECONDS * 1000,
    );
    expect(reconnect.retryDelayMs).toBeLessThanOrEqual(
        LIVE_RETRY_MAX_SECONDS * 1000,
    );
});

test.each(["open", "reconnecting"] as const)(
    "teardown from a %s listener releases transport timers",
    async (state) => {
        vi.useFakeTimers();
        liveForm("one", "/items", "item-results");
        const states = recordLiveStates();
        stopListeners.push(
            listenForLiveStateChanges((detail) => {
                if (detail.state === state) cleanup?.();
            }),
        );
        cleanup = startHypergraft();
        await vi.advanceTimersByTimeAsync(0);
        const socket = MockSocket.instances[0]!;
        if (state === "reconnecting") socket.finishClose(LIVE_CLOSE.retryable);
        expect(states.at(-1)).toEqual({ state: "stopped" });
        expect(vi.getTimerCount()).toBe(0);
        socket.finishClose(LIVE_CLOSE.retryable);
        await vi.advanceTimersByTimeAsync(LIVE_LEASE_SECONDS * 1000);
        expect(MockSocket.instances).toHaveLength(1);
        expect(
            states.filter((detail) => detail.state === "stopped"),
        ).toHaveLength(1);
    },
);

test.each(["pending", "uncertain"] as const)(
    "a replacement emits inherited %s suspension as its initial live state",
    async (state) => {
        vi.useFakeTimers();
        vi.spyOn(location, "reload").mockImplementation(() => {});
        liveForm("one", "/items", "item-results");
        document.body.insertAdjacentHTML(
            "beforeend",
            '<form id="command" data-graft method="post" action="/save"></form>',
        );
        const first = recordLiveStates();
        cleanup = startHypergraft();
        await vi.advanceTimersByTimeAsync(0);
        let resolve!: (response: Response) => void;
        let reject!: (error: Error) => void;
        vi.mocked(fetch).mockReturnValue(
            new Promise((done, fail) => {
                resolve = done;
                reject = fail;
            }),
        );
        document.getElementById("command")!.dispatchEvent(
            new SubmitEvent("submit", {
                bubbles: true,
                cancelable: true,
            }),
        );
        if (state === "uncertain") {
            reject(new TypeError("network failed"));
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(first.at(-1)).toEqual({ state: "suspended" });
        for (const stop of stopListeners) stop();
        stopListeners = [];
        const replacement = recordLiveStates();
        cleanup = startHypergraft();
        liveForm("two", "/other", "other-results");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(replacement.slice(0, 2)).toEqual([
            { state: "stopped" },
            { state: "suspended" },
        ]);
        expect(
            replacement.some(
                (detail) =>
                    detail.state === "connecting" || detail.state === "open",
            ),
        ).toBe(false);
        if (state === "pending") {
            resolve(
                new Response(envelope("item-results", "Disposed"), {
                    headers: { "content-type": MEDIA_TYPE },
                }),
            );
            await vi.advanceTimersByTimeAsync(0);
        }
        cleanup();
        cleanup();
        cleanup = undefined;
        expect(replacement.at(-1)).toEqual({ state: "stopped" });
        expect(
            replacement.filter((detail) => detail.state === "stopped"),
        ).toHaveLength(2);
    },
);

test("emits idle at startup when the document has no live form", async () => {
    const states = recordLiveStates();
    cleanup = startHypergraft();
    expect(states).toEqual([{ state: "idle" }]);
    document.body.append(document.createElement("div"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toEqual([{ state: "idle" }]);
});

test("discovers at most 64 live forms", async () => {
    for (let index = 0; index < 65; index += 1) {
        liveForm(`form-${index}`, `/items/${index}`, `target-${index}`);
    }
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const socket = MockSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(64));
});

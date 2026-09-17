import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listenForDiagnostics, type DiagnosticDetail } from "./diagnostics";
import {
    createEnterEffects,
    type EnterEffect,
    type EnterEffects,
} from "./enter-effects";
import {
    listenForLivePatches,
    listenForProgress,
    listenForRequestSettled,
} from "./events";
import { LIVE_SUBPROTOCOL } from "./live";
import { apply, MEDIA_TYPE, preflightLive } from "./patches";
import {
    commandBlockReason,
    resetHypergraftForTests,
    startHypergraft,
} from "./requests";

const message: EnterEffect = {
    keyframes: [
        { opacity: 0.2, transform: "translateY(10px)" },
        { opacity: 1, transform: "none" },
    ],
    timing: { duration: 60_000 },
};
let effects: EnterEffects | undefined;
let stops: (() => void)[];
let diagnostics: DiagnosticDetail[];
let motion: EventTarget & { matches: boolean };

function patch(
    content: string,
    target = "main",
    operation = "children",
): string {
    return `<graft-patch operation="${operation}" target="${target}"><template>${content}</template></graft-patch>`;
}
function envelope(content: string, attributes = ""): string {
    return `<graft-patch-set version="1" ${attributes}>${content}</graft-patch-set>`;
}
function item(id: string, tag = "article", name = "message"): string {
    return `<${tag} id="${id}" data-graft-enter="${name}">Text</${tag}>`;
}
function update(content: string): void {
    apply(preflightLive(envelope(content)), undefined, effects);
}
function element(id: string): HTMLElement {
    return document.getElementById(id)!;
}
function animation(id: string): Animation {
    const animations = element(id).getAnimations();
    expect(animations).toHaveLength(1);
    return animations[0]!;
}
function reply(content: string, attributes = ""): Response {
    return new Response(envelope(patch(content), attributes), {
        headers: { "content-type": MEDIA_TYPE },
    });
}
function submit(method = "post"): HTMLFormElement {
    const form = element("command") as HTMLFormElement;
    form.method = method;
    form.requestSubmit(form.querySelector("button"));
    return form;
}

beforeEach(() => {
    document.body.innerHTML =
        '<form id="command" data-graft method="post" action="/entry-command"><button>Send</button></form><a href="/entry-page" data-graft>Next</a><main id="main" tabindex="-1"></main>';
    history.replaceState({}, "", "/entry-start");
    motion = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", () => motion);
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    stops = [];
    diagnostics = [];
    stops.push(listenForDiagnostics((detail) => diagnostics.push(detail)));
});
afterEach(() => {
    resetHypergraftForTests();
    for (const stop of stops) stop();
    effects?.destroy();
    effects = undefined;
    for (const active of document.getAnimations()) active.cancel();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test("batch identity survives new opt-in attributes, moves and replacement roots", () => {
    element("main").setAttribute("data-graft-enter", "message");
    element("main").innerHTML =
        '<section id="left"><p id="existing">Old</p></section><section id="right"></section>';
    effects = createEnterEffects({ message });
    update(patch(item("existing") + item("new"), "left"));
    expect(element("existing").getAnimations()).toHaveLength(0);
    const first = animation("new");
    update(
        patch(item("new"), "left") + patch(item("existing", "aside"), "right"),
    );
    expect(animation("new")).toBe(first);
    expect(element("existing").getAnimations()).toHaveLength(0);
    update(
        patch(
            `<aside id="left">${item("new", "p")}${item("later")}</aside><aside id="right">${item("existing")}</aside>`,
        ),
    );
    expect(first.playState).toBe("idle");
    expect(element("new").getAnimations()).toHaveLength(0);
    expect(element("existing").getAnimations()).toHaveLength(0);
    animation("later");
    expect(element("main").getAnimations()).toHaveLength(0);
});

test("rapid patches retain active effects, but removal and later reintroduction start a new lifetime", async () => {
    effects = createEnterEffects({ message });
    update(patch(item("new"), "main", "append"));
    const first = animation("new");
    for (let i = 0; i < 5; i++)
        update(patch(item("new").replace("Text", String(i))));
    expect(animation("new")).toBe(first);
    element("new").remove();
    await vi.waitFor(() => expect(first.playState).toBe("idle"));
    update(patch(item("new")));
    expect(animation("new")).not.toBe(first);
    const second = animation("new");
    element("new").id = "changed-identity";
    await vi.waitFor(() => expect(second.playState).toBe("idle"));
});

test("completion releases ownership and teardown cancels only runtime effects", async () => {
    effects = createEnterEffects({ message });
    update(patch(item("finished") + item("active")));
    const finished = animation("finished");
    const cancelled = vi.spyOn(finished, "cancel");
    finished.finish();
    await new Promise<void>((resolve) =>
        finished.addEventListener("finish", () => resolve(), { once: true }),
    );
    expect(element("finished").getAttribute("style")).toBeNull();
    expect(getComputedStyle(element("finished")).opacity).toBe("1");
    const owned = animation("active");
    const host = element("active").animate(
        [{ color: "red" }, { color: "blue" }],
        60_000,
    );
    effects.destroy();
    expect(owned.playState).toBe("idle");
    expect(host.playState).not.toBe("idle");
    expect(cancelled).not.toHaveBeenCalled();
    host.cancel();
});

test("reduced motion suppresses effects by default and cancels without replay on preference changes", () => {
    effects = createEnterEffects({
        message,
        gentle: {
            ...message,
            reducedMotion: {
                keyframes: [{ opacity: 0.65 }, { opacity: 1 }],
                timing: { duration: 20_000 },
            },
        },
    });
    update(patch(item("normal")));
    const normal = animation("normal");
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    expect(normal.playState).toBe("idle");
    update(
        patch(
            item("normal") + item("suppressed") + item("gentle", "p", "gentle"),
        ),
    );
    expect(element("normal").getAnimations()).toHaveLength(0);
    expect(element("suppressed").getAnimations()).toHaveLength(0);
    const reduced = animation("gentle");
    expect(reduced.effect!.getTiming().duration).toBe(20_000);
    expect(
        (reduced.effect as KeyframeEffect).getKeyframes()[0]!.transform,
    ).toBeUndefined();
    motion.matches = false;
    motion.dispatchEvent(new Event("change"));
    expect(reduced.playState).toBe("idle");
    expect(document.getAnimations()).toHaveLength(0);
});

test.each([
    { timing: { duration: -1 } },
    { timing: { duration: Infinity } },
    { timing: { duration: NaN } },
    { timing: { duration: 1, delay: -1 } },
    { timing: { duration: Number.MAX_VALUE, delay: Number.MAX_VALUE } },
    { timing: { duration: 1, iterations: Infinity } },
    { timing: { duration: 1, fill: "forwards" } },
    { timing: { duration: 1, easing: "not-an-easing" } },
    { keyframes: [{ offset: 2, opacity: 0 }] },
    { keyframes: "secret invalid definition" },
    {
        reducedMotion: {
            keyframes: [{ opacity: 1 }],
            timing: { duration: Infinity },
        },
    },
])(
    "invalid definitions cannot create persistent effects or expose their contents: %j",
    (invalid) => {
        effects = createEnterEffects({
            bad: { ...message, ...invalid } as EnterEffect,
            message,
        });
        expect(diagnostics).toEqual([
            {
                reason: "enter-effect",
                issue: "invalid-definition",
                element: undefined,
            },
        ]);
        update(patch(item("valid") + item("bad", "p", "bad")));
        animation("valid");
        expect(element("bad").getAnimations()).toHaveLength(0);
        expect(element("bad").getAttribute("style")).toBeNull();
    },
);

test("missing IDs, unknown names and form named properties cannot break a patch", () => {
    effects = createEnterEffects({ message });
    update(
        patch(
            '<p data-graft-enter="message">No ID</p>' +
                item("unknown", "p", "toString") +
                '<form id="animated-form" data-graft-enter="message"><input name="id"><input name="querySelectorAll"><input name="isConnected"><input name="getAttributeNS"></form>',
        ),
    );
    animation("animated-form");
    expect(element("unknown").getAnimations()).toHaveLength(0);
    expect(
        diagnostics.map((d) => d.reason === "enter-effect" && d.issue),
    ).toEqual(["missing-id", "unknown-effect"]);
});

test("unavailable Web Animations leave content visible without transport failure", async () => {
    vi.stubGlobal("KeyframeEffect", undefined);
    stops.push(startHypergraft({ enterEffects: { message } }));
    vi.mocked(fetch).mockResolvedValue(reply(item("visible")));
    submit();
    await vi.waitFor(() => expect(element("visible")).not.toBeNull());
    expect(commandBlockReason()).toBeUndefined();
    expect(getComputedStyle(element("visible")).opacity).toBe("1");
    expect(diagnostics.map((d) => d.reason)).toEqual(["enter-effect"]);
});

test("rejected preflight and partial application failures start no effects", () => {
    element("main").innerHTML = '<div id="left"></div><div id="right"></div>';
    effects = createEnterEffects({ message });
    expect(() =>
        update(
            patch(item("duplicate"), "left") +
                patch(item("duplicate"), "right"),
        ),
    ).toThrow();
    expect(document.getAnimations()).toHaveLength(0);
    const batch = preflightLive(
        envelope(
            patch(item("introduced"), "left") +
                patch(item("fails"), "right", "append"),
        ),
    );
    vi.spyOn(element("right"), "appendChild").mockImplementation(() => {
        throw new Error("DOM failure");
    });
    expect(() => apply(batch, undefined, effects)).toThrow("DOM failure");
    expect(element("introduced")).not.toBeNull();
    expect(document.getAnimations()).toHaveLength(0);
});

test("command replacement starts effects after focus restoration and before island mount and settlement", async () => {
    element("main").innerHTML =
        '<section id="island" data-island="probe"><input id="focus" value="old"></section>';
    element("focus").focus();
    const focusedAtStart: (Element | null)[] = [];
    const play = Animation.prototype.play;
    vi.spyOn(Animation.prototype, "play").mockImplementation(function (
        this: Animation,
    ) {
        focusedAtStart.push(document.activeElement);
        play.call(this);
    });
    const mounted: number[] = [];
    stops.push(
        startHypergraft({
            enterEffects: { message },
            islands: {
                probe: (root) => {
                    mounted.push(root.getAnimations({ subtree: true }).length);
                },
            },
        }),
    );
    const facts: unknown[] = [];
    stops.push(
        listenForRequestSettled((detail) =>
            facts.push({
                outcome: detail.outcome,
                focus: document.activeElement?.id,
                blocked: commandBlockReason(),
                animations: document.getAnimations().length,
            }),
        ),
    );
    vi.mocked(fetch).mockResolvedValue(
        reply(
            `<aside id="island" data-island="probe"><input id="focus" value="new">${item("new")}</aside>`,
            'location="/entry-created"',
        ),
    );
    submit();
    await vi.waitFor(() => expect(facts).toHaveLength(1));
    expect(location.pathname).toBe("/entry-created");
    expect(mounted).toEqual([0, 1]);
    expect(focusedAtStart).toEqual([element("focus")]);
    expect(facts).toEqual([
        {
            outcome: "applied-patch",
            focus: "focus",
            blocked: undefined,
            animations: 1,
        },
    ]);
    const active = animation("new");
    stops.push(startHypergraft({ enterEffects: { message } }));
    expect(active.playState).toBe("idle");
    expect(document.getAnimations()).toHaveLength(0);
});

test("navigation and history suppress effects while targeted GET replacement remains eligible", async () => {
    element("main").innerHTML = item("initial");
    stops.push(startHypergraft({ enterEffects: { message } }));
    expect(document.getAnimations()).toHaveLength(0);
    vi.mocked(fetch).mockResolvedValueOnce(reply(item("query")));
    submit("get");
    await vi.waitFor(() => expect(element("query")).not.toBeNull());
    const query = animation("query");
    vi.mocked(fetch).mockResolvedValueOnce(
        reply(item("query") + item("page"), 'title="Page"'),
    );
    document.querySelector<HTMLAnchorElement>("a")!.click();
    await vi.waitFor(() => expect(element("page")).not.toBeNull());
    expect(query.playState).toBe("idle");
    expect(document.getAnimations()).toHaveLength(0);
    vi.mocked(fetch).mockResolvedValueOnce(
        reply(item("history"), 'title="History"'),
    );
    history.replaceState({ hypergraft: true }, "", "/entry-history");
    dispatchEvent(
        new PopStateEvent("popstate", { state: { hypergraft: true } }),
    );
    await vi.waitFor(() => expect(element("history")).not.toBeNull());
    expect(document.getAnimations()).toHaveLength(0);
});

test("stream frames preserve effect identity and settle without animation completion", async () => {
    stops.push(startHypergraft({ enterEffects: { message } }));
    const progress: Animation[] = [];
    stops.push(
        listenForProgress(() => {
            expect(commandBlockReason()).toBe("pending-command");
            progress.push(animation("streamed"));
        }),
    );
    const frames = [
        envelope(patch(item("streamed")), 'phase="progress"'),
        envelope(
            patch(item("streamed").replace("Text", "More text")),
            'phase="progress"',
        ),
        envelope(
            patch(item("streamed") + item("final")),
            'phase="final" status="200"',
        ),
    ];
    const encoder = new TextEncoder();
    vi.mocked(fetch).mockResolvedValue(
        new Response(
            new ReadableStream({
                start(controller) {
                    for (const frame of frames)
                        controller.enqueue(
                            encoder.encode(
                                `${encoder.encode(frame).length}\n${frame}`,
                            ),
                        );
                    controller.close();
                },
            }),
            {
                headers: {
                    "content-type": MEDIA_TYPE,
                    "graft-transfer": "stream",
                },
            },
        ),
    );
    submit();
    await vi.waitFor(() => expect(element("final")).not.toBeNull());
    await vi.waitFor(() => expect(commandBlockReason()).toBeUndefined());
    expect(progress).toHaveLength(2);
    expect(progress[0]).toBe(progress[1]);
    expect(animation("streamed")).toBe(progress[0]);
    animation("final");
});

test("an animation exception cannot turn a successful command into uncertainty", async () => {
    stops.push(startHypergraft({ enterEffects: { message } }));
    vi.spyOn(Animation.prototype, "play").mockImplementation(() => {
        throw new Error("secret animation error");
    });
    const outcomes: string[] = [];
    stops.push(
        listenForRequestSettled((detail) => outcomes.push(detail.outcome)),
    );
    vi.mocked(fetch).mockResolvedValue(reply(item("visible")));
    submit();
    await vi.waitFor(() => expect(outcomes).toEqual(["applied-patch"]));
    expect(commandBlockReason()).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(getComputedStyle(element("visible")).opacity).toBe("1");
    expect(diagnostics).toEqual([
        {
            reason: "enter-effect",
            issue: "animation-failure",
            element: element("visible"),
        },
    ]);
});

test("live patches use the same identity boundary before live notifications", async () => {
    const sockets: Socket[] = [];
    class Socket extends EventTarget {
        static OPEN = 1;
        static CONNECTING = 0;
        readyState = 0;
        protocol = LIVE_SUBPROTOCOL;
        extensions = "";
        sent: string[] = [];
        constructor() {
            super();
            sockets.push(this);
        }
        send(value: string) {
            this.sent.push(value);
        }
        close() {
            this.readyState = 3;
        }
        receive(content: string) {
            const encoded = new TextEncoder().encode(envelope(patch(content)));
            const buffer = new ArrayBuffer(4 + encoded.length);
            const subscription = this.sent
                .map((value) => JSON.parse(value))
                .find((value) => value.type === "subscribe");
            new DataView(buffer).setUint32(0, subscription.id);
            new Uint8Array(buffer).set(encoded, 4);
            this.dispatchEvent(new MessageEvent("message", { data: buffer }));
        }
    }
    vi.stubGlobal("WebSocket", Socket);
    const form = element("command") as HTMLFormElement;
    form.method = "get";
    form.setAttribute("data-graft-live", "");
    stops.push(startHypergraft({ enterEffects: { message } }));
    const socket = sockets[0]!;
    socket.readyState = Socket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const seen: Animation[] = [];
    stops.push(listenForLivePatches(() => seen.push(animation("live"))));
    socket.receive(item("live"));
    socket.receive(item("live").replace("Text", "Updated"));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(diagnostics).toEqual([]);
});

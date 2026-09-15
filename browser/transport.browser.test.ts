import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LocationChangeDetail } from "./events";
import { apply, MEDIA_TYPE, preflight } from "./patches";
import { resetHypergraftForTests, startHypergraft } from "./requests";

let cleanup: (() => void) | undefined;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function envelope(
    target: string,
    content: string,
    status = 200,
    title?: string,
    location?: string,
) {
    const titleAttribute = title ? ` title="${title}"` : "";
    const locationAttribute = location ? ` location="${location}"` : "";
    const headers: Record<string, string> = { "content-type": MEDIA_TYPE };
    if (status === 429) headers["retry-after"] = "60";
    return new Response(
        `<graft-patch-set version="1"${titleAttribute}${locationAttribute}><graft-patch operation="children" target="${target}"><template>${content}</template></graft-patch></graft-patch-set>`,
        { status, headers },
    );
}

function submit(form: HTMLFormElement, submitter?: HTMLElement) {
    const event = new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter,
    });
    form.dispatchEvent(event);
    return event;
}

function commandForm() {
    const form = document.createElement("form");
    form.dataset.graft = "";
    form.method = "post";
    form.action = "/command";
    form.innerHTML =
        '<input name="credential" value="wrong"><button type="submit">Save</button>';
    document.getElementById("command")!.replaceChildren(form);
    return form;
}

beforeEach(() => {
    history.replaceState({}, "", "/contract/start");
    document.title = "Contract";
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    document.body.innerHTML = `
      <main id="main" tabindex="-1"><div id="command"></div><div id="secondary"></div></main>`;
    vi.stubGlobal("fetch", vi.fn());
    cleanup = startHypergraft();
});

afterEach(() => {
    // Clear the unsafe guard before the production stop function. A final stop
    // reloads when a command is pending or uncertain. That reload leaves the
    // Firefox and WebKit testers without a document.
    resetHypergraftForTests();
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test("forward navigation updates title, URL, focus and location observers", async () => {
    let notifications = 0;
    const listener = () => notifications++;
    addEventListener("hypergraft:locationchange", listener);
    vi.mocked(fetch).mockResolvedValue(
        envelope("main", '<h1 id="patients">Patients</h1>', 200, "Patients"),
    );
    const link = document.createElement("a");
    link.dataset.graft = "";
    link.href = "/patients";
    document.body.append(link);
    link.click();

    await vi.waitFor(() => expect(location.pathname).toBe("/patients"));
    expect(document.title).toBe("Patients");
    expect(document.activeElement).toBe(document.getElementById("main"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(notifications).toBe(1);
    removeEventListener("hypergraft:locationchange", listener);
});

test("back and forward restore authoritative history entries", async () => {
    vi.mocked(fetch)
        .mockResolvedValueOnce(
            envelope("main", '<p id="back-restored">Back</p>', 200, "Back"),
        )
        .mockResolvedValueOnce(
            envelope(
                "main",
                '<p id="forward-restored">Forward</p>',
                200,
                "Forward",
            ),
        );
    history.replaceState({ hypergraft: true }, "", "/history/one");
    history.pushState({ hypergraft: true }, "", "/history/two");

    history.back();
    await vi.waitFor(() =>
        expect(document.getElementById("back-restored")).not.toBeNull(),
    );
    expect(location.pathname).toBe("/history/one");
    expect(document.title).toBe("Back");

    history.forward();
    await vi.waitFor(() =>
        expect(document.getElementById("forward-restored")).not.toBeNull(),
    );
    expect(location.pathname).toBe("/history/two");
    expect(document.title).toBe("Forward");
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
});

test("back waits for a pending POST and suppresses its location replacement", async () => {
    const locationCauses: LocationChangeDetail["cause"][] = [];
    const listener = (event: Event) =>
        locationCauses.push(
            (event as CustomEvent<LocationChangeDetail>).detail.cause,
        );
    addEventListener("hypergraft:locationchange", listener);
    let resolveCommand!: (response: Response) => void;
    const fetchMock = vi
        .mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveCommand = resolve;
                }),
        )
        .mockResolvedValueOnce(
            envelope("main", '<p id="history-after-command">Earlier page</p>'),
        );
    history.replaceState({ hypergraft: true }, "", "/command-history/one");
    history.pushState({ hypergraft: true }, "", "/command-history/two");
    history.pushState({ hypergraft: true }, "", "/command-history/three");

    submit(commandForm());
    history.back();
    await vi.waitFor(() =>
        expect(location.pathname).toBe("/command-history/two"),
    );
    history.back();
    await vi.waitFor(() =>
        expect(location.pathname).toBe("/command-history/one"),
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveCommand(
        envelope(
            "command",
            '<p id="command-finished">Saved</p>',
            200,
            undefined,
            "/command-result",
        ),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
        expect(document.getElementById("history-after-command")).not.toBeNull(),
    );
    expect(new URL(String(fetchMock.mock.calls[1]![0])).pathname).toBe(
        "/command-history/one",
    );
    expect(locationCauses).not.toContain("command-patch-replacement");
    removeEventListener("hypergraft:locationchange", listener);
});

test("back during an uncertain POST leaves reload guidance at that destination", async () => {
    let resolveCommand!: (response: Response) => void;
    const fetchMock = vi.mocked(fetch).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                resolveCommand = resolve;
            }),
    );
    history.replaceState({ hypergraft: true }, "", "/uncertain-history/one");
    history.pushState({ hypergraft: true }, "", "/uncertain-history/two");

    const original = commandForm();
    submit(original);
    history.back();
    await vi.waitFor(() =>
        expect(location.pathname).toBe("/uncertain-history/one"),
    );
    resolveCommand(
        new Response("malformed", {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );

    await vi.waitFor(() =>
        expect(original.hasAttribute("data-graft-uncertain")).toBe(true),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(location.pathname).toBe("/uncertain-history/one");
});

test("back supersedes an in-flight safe navigation", async () => {
    let resolveOld!: (response: Response) => void;
    const fetchMock = vi
        .mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        )
        .mockResolvedValueOnce(
            envelope("main", '<p id="history-won">History won</p>'),
        );
    history.replaceState({ hypergraft: true }, "", "/safe-history/one");
    history.pushState({ hypergraft: true }, "", "/safe-history/two");
    const link = document.createElement("a");
    link.dataset.graft = "";
    link.href = "/safe-history/new";
    document.body.append(link);

    link.click();
    history.back();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
        expect(document.getElementById("history-won")).not.toBeNull(),
    );
    resolveOld(envelope("main", '<p id="stale-navigation">Stale</p>'));
    await flush();
    expect(document.getElementById("stale-navigation")).toBeNull();
    expect(location.pathname).toBe("/safe-history/one");
});

test("multi-target preflight restores focus by stable ID", () => {
    document.getElementById("command")!.innerHTML =
        '<input id="stable-control" value="abcdef">';
    const control = document.getElementById(
        "stable-control",
    ) as HTMLInputElement;
    control.focus();
    control.setSelectionRange(2, 4);
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="command"><template><input id="stable-control" value="updated"></template></graft-patch><graft-patch operation="children" target="secondary"><template><p id="other-result">Other</p></template></graft-patch></graft-patch-set>`;
    const prepared = preflight(
        new Response(text, {
            status: 409,
            headers: { "content-type": MEDIA_TYPE },
        }),
        text,
    );
    if (prepared.kind === "patches") apply(prepared.batch);
    expect(document.activeElement?.id).toBe("stable-control");
    expect((document.activeElement as HTMLInputElement).selectionStart).toBe(2);
    expect(document.getElementById("other-result")).not.toBeNull();
});

function focusBatch(content: string) {
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="command"><template>${content}</template></graft-patch></graft-patch-set>`;
    const prepared = preflight(
        new Response(text, { headers: { "content-type": MEDIA_TYPE } }),
        text,
    );
    if (prepared.kind !== "patches")
        throw new Error("Expected prepared patches");
    return prepared.batch;
}

test.each(["input", "textarea"])(
    "retained no-ID %s restores directional selection after focus loss",
    (tag) => {
        const markup =
            tag === "input"
                ? '<input data-graft-key="u:aa" value="abcdef">'
                : '<textarea data-graft-key="u:aa">abcdef</textarea>';
        document.getElementById("command")!.innerHTML = markup;
        document.getElementById("secondary")!.innerHTML = markup;
        const control = document.querySelector<
            HTMLInputElement | HTMLTextAreaElement
        >(`#command ${tag}`)!;
        control.focus();
        control.setSelectionRange(1, 5, "backward");
        const focus = vi.spyOn(control, "focus");
        let visited = false;
        apply(focusBatch(markup.replace("abcdef", "abc")), (element) => {
            if (element === control) {
                visited = true;
                control.blur();
            }
        });
        expect(visited).toBe(true);
        expect(document.activeElement).toBe(control);
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(control.value).toBe("abc");
        expect([
            control.selectionStart,
            control.selectionEnd,
            control.selectionDirection,
        ]).toEqual([1, 3, "backward"]);
    },
);

test("retained focus follows an authored ID change without redundant focus", () => {
    const markup = '<input id="original" value="abcdef">';
    document.getElementById("command")!.innerHTML = markup;
    const control = document.querySelector<HTMLInputElement>("#command input")!;
    control.focus();
    const focus = vi.spyOn(control, "focus");
    apply(focusBatch(markup));
    expect(focus).not.toHaveBeenCalled();
    let visited = false;
    apply(focusBatch(markup), (element) => {
        if (element === control) {
            visited = true;
            // Morphlex does not retain controls across authored ID changes.
            // Simulate that retained-node visit without a new correspondence engine.
            control.id = "changed";
            document.getElementById("secondary")!.innerHTML = markup;
            control.blur();
        }
    });
    expect(visited).toBe(true);
    expect(control.id).toBe("changed");
    expect(document.activeElement).toBe(control);
});

test("removed controls never restore focus through private keys under another parent", () => {
    const markup = '<input data-graft-key="u:aa" value="abcdef">';
    document.getElementById("command")!.innerHTML = markup;
    document.getElementById("secondary")!.innerHTML = markup;
    const control = document.querySelector<HTMLInputElement>("#command input")!;
    control.focus();
    apply(focusBatch("<p>Removed</p>"));
    expect(control.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
});

test("public-ID fallback restores directional selection on a shorter replacement", () => {
    document.getElementById("command")!.innerHTML =
        '<input id="control" value="abcdef">';
    const control = document.querySelector<HTMLInputElement>("#command input")!;
    control.focus();
    control.setSelectionRange(1, 5, "backward");
    apply(focusBatch('<textarea id="control">abc</textarea>'));
    const replacement =
        document.querySelector<HTMLTextAreaElement>("#command textarea")!;
    expect(control.isConnected).toBe(false);
    expect(document.activeElement).toBe(replacement);
    expect([
        replacement.selectionStart,
        replacement.selectionEnd,
        replacement.selectionDirection,
    ]).toEqual([1, 3, "backward"]);
});

test("public-ID fallback restores a replacement but skips unsupported selection APIs", () => {
    document.getElementById("command")!.innerHTML =
        '<textarea id="control">abcdef</textarea>';
    const control =
        document.querySelector<HTMLTextAreaElement>("#command textarea")!;
    control.focus();
    control.setSelectionRange(2, 5, "backward");
    apply(focusBatch('<input id="control" type="number" value="12">'));
    const replacement =
        document.querySelector<HTMLInputElement>("#command input")!;
    expect(control.isConnected).toBe(false);
    expect(document.activeElement).toBe(replacement);
    const selection = vi.spyOn(replacement, "setSelectionRange");
    const getter = vi.spyOn(replacement, "selectionStart", "get");
    apply(
        focusBatch('<input id="control" type="number" value="1">'),
        (element) => {
            if (element === replacement) replacement.blur();
        },
    );
    expect(document.activeElement).toBe(replacement);
    expect(getter).not.toHaveBeenCalled();
    expect(selection).not.toHaveBeenCalled();
});

test.each(["get", "post"])(
    "an applied %s patch clears pending ARIA before settlement",
    async (method) => {
        const form = commandForm();
        form.method = method;
        const button = form.querySelector("button")!;
        vi.mocked(fetch).mockResolvedValue(
            envelope(
                "command",
                `<form method="${method}" action="/command" data-graft><input name="credential" value="wrong"><button type="submit">Next</button></form>`,
            ),
        );
        const observed: {
            disabled: boolean;
            ariaDisabled: string | null;
            busy: string | null;
            pending: boolean;
        }[] = [];
        addEventListener(
            "hypergraft:requestsettled",
            () => {
                observed.push({
                    disabled: button.disabled,
                    ariaDisabled: button.getAttribute("aria-disabled"),
                    busy: form.getAttribute("aria-busy"),
                    pending:
                        form.hasAttribute("data-graft-pending") ||
                        button.hasAttribute("data-graft-submitter-pending"),
                });
            },
            { once: true },
        );

        submit(form, button);
        await vi.waitFor(() => expect(observed).toHaveLength(1));

        expect(document.querySelector("#command form")).toBe(form);
        expect(form.querySelector("button")).toBe(button);
        expect(button.textContent).toBe("Next");
        expect(observed).toEqual([
            { disabled: false, ariaDisabled: null, busy: null, pending: false },
        ]);
    },
);

test("an applied command keeps a server-disabled submitter disabled", async () => {
    const form = commandForm();
    const button = form.querySelector("button")!;
    button.id = "save";
    vi.mocked(fetch).mockResolvedValue(
        envelope(
            "command",
            '<form method="post" action="/command" data-graft><input name="credential" value="wrong"><button id="save" type="submit" disabled>Save</button></form>',
            422,
        ),
    );
    const observed: { disabled: boolean; pending: boolean }[] = [];
    addEventListener("hypergraft:requestsettled", () => {
        const save = document.getElementById(
            "save",
        ) as HTMLButtonElement | null;
        observed.push({
            disabled: save?.disabled === true,
            pending:
                save?.hasAttribute("data-graft-submitter-pending") === true,
        });
    });
    submit(form, button);
    await flush();
    const save = document.getElementById("save") as HTMLButtonElement;
    expect(save).toBe(button);
    expect(save.disabled).toBe(true);
    expect(save.hasAttribute("data-graft-submitter-pending")).toBe(false);
    expect(observed).toEqual([{ disabled: true, pending: false }]);
});

test("one live socket applies several atomic projection patches", async () => {
    class MockSocket extends EventTarget {
        static instances: MockSocket[] = [];
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 3;
        readyState = MockSocket.CONNECTING;
        binaryType = "arraybuffer";
        protocol = "hypergraft.v1";
        extensions = "";
        sent: string[] = [];
        constructor(public url: string) {
            super();
            MockSocket.instances.push(this);
            queueMicrotask(() => {
                this.readyState = MockSocket.OPEN;
                this.dispatchEvent(new Event("open"));
            });
        }
        send(data: string) {
            this.sent.push(data);
        }
        close() {
            this.readyState = MockSocket.CLOSED;
            this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
        }
        receive(id: number, target: string, content: string) {
            const envelopeText = `<graft-patch-set version="1"><graft-patch operation="children" target="${target}"><template>${content}</template></graft-patch></graft-patch-set>`;
            const encoded = new TextEncoder().encode(envelopeText);
            const buffer = new ArrayBuffer(4 + encoded.byteLength);
            new DataView(buffer).setUint32(0, id);
            new Uint8Array(buffer).set(encoded, 4);
            this.dispatchEvent(new MessageEvent("message", { data: buffer }));
        }
    }
    vi.stubGlobal("WebSocket", MockSocket);
    document.body.innerHTML = `
      <main id="main">
        <form id="one" method="get" action="/one" data-graft data-graft-live><button>One</button></form>
        <form id="two" method="get" action="/two" data-graft data-graft-live><button>Two</button></form>
        <section id="first"></section>
        <section id="second"></section>
      </main>`;
    cleanup?.();
    cleanup = startHypergraft();
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const socket = MockSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    socket.receive(1, "first", '<p id="one-ready">One</p>');
    socket.receive(2, "second", '<p id="two-ready">Two</p>');
    expect(document.getElementById("one-ready")).not.toBeNull();
    expect(document.getElementById("two-ready")).not.toBeNull();
    expect(MockSocket.instances).toHaveLength(1);
});

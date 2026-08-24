// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MEDIA_TYPE, MAX_RESPONSE_BYTES, PATCH_STATUSES } from "./patches";
import {
    requestGraftRefresh,
    resetHypergraftForTests,
    startHypergraft,
} from "./requests";
import { DIAGNOSTIC_EVENT, type DiagnosticDetail } from "./diagnostics";
import type { RequestSettledDetail } from "./events";

function collectSettled(): RequestSettledDetail[] {
    const details: RequestSettledDetail[] = [];
    addEventListener("hypergraft:requestsettled", (event) =>
        details.push((event as CustomEvent<RequestSettledDetail>).detail),
    );
    return details;
}

function collectDiagnostics(): DiagnosticDetail[] {
    const details: DiagnosticDetail[] = [];
    addEventListener(DIAGNOSTIC_EVENT, (event) =>
        details.push((event as CustomEvent<DiagnosticDetail>).detail),
    );
    return details;
}

function showTestAlert(uncertain: boolean) {
    const alert = document.getElementById("hypergraft-transport-alert");
    if (!alert) return;
    const text = alert.querySelector<HTMLElement>("[data-graft-error-text]");
    if (text)
        text.textContent = uncertain
            ? "The change may have been saved. Reload the page before trying again."
            : "We could not update the page. Check your connection and try again.";
    const dismiss = alert.querySelector<HTMLElement>("[data-graft-dismiss]");
    const reload = alert.querySelector<HTMLElement>("[data-graft-reload]");
    if (dismiss) dismiss.hidden = uncertain;
    if (reload) reload.hidden = !uncertain;
    alert.hidden = false;
}

let cleanup: (() => void) | undefined;
const patch = (content = "Updated", status = 200) => {
    const headers: Record<string, string> = { "content-type": MEDIA_TYPE };
    if (status === 429) headers["retry-after"] = "60";
    return new Response(
        `<graft-patch-set version="1"><graft-patch operation="children" target="theme-card"><template><p id="result">${content}</p></template></graft-patch></graft-patch-set>`,
        { status, headers },
    );
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    history.replaceState({}, "", "/dashboard/account/preferences");
    document.body.innerHTML = `
        <div id="hypergraft-transport-alert" hidden>
            <span data-graft-error-text></span>
            <button data-graft-dismiss>Dismiss</button>
            <button data-graft-reload hidden>Reload</button>
        </div>
        <main id="main"><div id="theme-card"></div></main>`;
    vi.stubGlobal("fetch", vi.fn());
    cleanup = startHypergraft({
        feedback: {
            safeFailure: () => showTestAlert(false),
            safeRecovery: () => {
                const alert = document.getElementById(
                    "hypergraft-transport-alert",
                );
                if (alert) alert.hidden = true;
            },
            uncertainUnsafeOutcome: () => showTestAlert(true),
        },
    });
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    resetHypergraftForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function form(markup = '<input name="theme" value="dark">') {
    const element = document.createElement("form");
    element.method = "post";
    element.action = "/dashboard/account/theme";
    element.dataset.graft = "";
    element.innerHTML = markup;
    document.getElementById("theme-card")!.replaceChildren(element);
    return element;
}

function submit(element: HTMLFormElement, submitter?: HTMLElement) {
    const event = new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter,
    });
    element.dispatchEvent(event);
    return event;
}

function refreshForm() {
    const element = document.createElement("form");
    element.method = "get";
    element.action = "/messages";
    element.dataset.graft = "";
    element.innerHTML =
        '<input name="view" value="inbox"><button name="intent" value="manual">Refresh</button>';
    document.body.append(element);
    return element;
}

test("requestSubmit derives the native POST contract and uses the unsafe lane", async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    const element = form(
        `<input name="practitioner_id" value="dr-2"><input name="practitioners" value="dr-1"><input name="practitioners" value="dr-2"><button name="intent" value="move">Move</button>`,
    );
    element.action = "/diary/appointments/a1/move";
    const button = element.querySelector("button")!;

    element.requestSubmit(button);
    element.requestSubmit(button);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(element.hasAttribute("data-graft-pending")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
        "http://localhost:3000/diary/appointments/a1/move",
    );
    expect(init).toMatchObject({
        method: "POST",
        headers: { "Graft-Request": "patch", Accept: MEDIA_TYPE },
    });
    const body = init?.body as URLSearchParams;
    expect(body.get("practitioner_id")).toBe("dr-2");
    expect(body.getAll("practitioners")).toEqual(["dr-1", "dr-2"]);
    expect(body.get("intent")).toBe("move");

    resolve(
        new Response(
            '<graft-patch-set version="1" navigate="/diary?result=move-conflict"></graft-patch-set>',
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        ),
    );
    await flush();
    expect(location.pathname).toBe("/diary");
    expect(location.search).toBe("?result=move-conflict");
});

test("an unknown POST result settles uncertain after pending state is final", async () => {
    let resolveResponse!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((resolve) => {
            resolveResponse = resolve;
        }),
    );
    const details = collectSettled();
    const element = form();
    const observed: { pending: boolean; uncertain: boolean }[] = [];
    addEventListener("hypergraft:requestsettled", () =>
        observed.push({
            pending: element.hasAttribute("data-graft-pending"),
            uncertain: element.hasAttribute("data-graft-uncertain"),
        }),
    );

    submit(element);
    expect(element.hasAttribute("data-graft-pending")).toBe(true);
    resolveResponse(
        new Response("malformed", {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    await flush();

    expect(element.hasAttribute("data-graft-pending")).toBe(false);
    expect(element.hasAttribute("data-graft-uncertain")).toBe(true);
    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        requestKind: "patch",
        form: element,
        url: "http://localhost:3000/dashboard/account/theme",
        outcome: "uncertain-unsafe-result",
        status: 200,
    });
    expect(observed).toEqual([{ pending: false, uncertain: true }]);
});

test("an unsafe patch application failure settles uncertain without targets", async () => {
    vi.mocked(fetch).mockResolvedValue(patch("Cannot land"));
    const details = collectSettled();
    const element = form();
    const target = document.getElementById("theme-card")!;
    target.insertBefore = (() => {
        throw new Error("synthetic morph failure");
    }) as typeof target.insertBefore;

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        requestKind: "patch",
        form: element,
        url: "http://localhost:3000/dashboard/account/theme",
        outcome: "uncertain-unsafe-result",
        status: 200,
    });
    expect(element.hasAttribute("data-graft-pending")).toBe(false);
    expect(element.hasAttribute("data-graft-uncertain")).toBe(true);
});

test("an uncertain transport failure reports no status and the attempted URL", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
    const details = collectSettled();
    const element = form();

    submit(element);
    await flush();

    expect(element.hasAttribute("data-graft-uncertain")).toBe(true);
    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        requestKind: "patch",
        form: element,
        url: "http://localhost:3000/dashboard/account/theme",
        outcome: "uncertain-unsafe-result",
    });
});

test.each(PATCH_STATUSES)(
    "an applied %i unsafe patch settles with status and targets after pending clears",
    async (status) => {
        vi.mocked(fetch).mockResolvedValue(patch("Applied", status));
        const details = collectSettled();
        const element = form();
        const observed: boolean[] = [];
        addEventListener("hypergraft:requestsettled", () =>
            observed.push(element.hasAttribute("data-graft-pending")),
        );

        submit(element);
        await flush();

        expect(element.hasAttribute("data-graft-pending")).toBe(false);
        expect(element.hasAttribute("data-graft-uncertain")).toBe(false);
        expect(details).toHaveLength(1);
        expect(details[0]).toEqual({
            requestKind: "patch",
            form: element,
            url: "http://localhost:3000/dashboard/account/theme",
            outcome: "applied-patch",
            status,
            targetIds: ["theme-card"],
        });
        expect(observed).toEqual([false]);
    },
);

test("an applied unsafe patch settles before a queued history fetch starts", async () => {
    let resolveCommand!: (response: Response) => void;
    const fetchMock = vi
        .mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveCommand = resolve;
                }),
        )
        .mockResolvedValue(
            new Response(
                '<graft-patch-set version="1"><graft-patch operation="children" target="main"><template><p id="history-landed">Earlier page</p></template></graft-patch></graft-patch-set>',
                { status: 200, headers: { "content-type": MEDIA_TYPE } },
            ),
        );
    history.replaceState({ hypergraft: true }, "", "/queued/one");
    history.pushState({ hypergraft: true }, "", "/queued/two");
    const element = form();
    submit(element);
    history.back();
    await vi.waitFor(() => expect(location.pathname).toBe("/queued/one"));
    expect(fetchMock).toHaveBeenCalledOnce();

    let settledAt: number[] = [];
    addEventListener("hypergraft:requestsettled", () =>
        settledAt.push(fetchMock.mock.calls.length),
    );
    resolveCommand(patch("Committed"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(settledAt).toEqual([1]);
    expect(new URL(String(fetchMock.mock.calls[1]![0])).pathname).toBe(
        "/queued/one",
    );
});

test("an unknown POST result globally locks links and every form", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response("malformed", {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    const element = form();
    element.requestSubmit();
    await flush();

    const other = document.createElement("form");
    other.method = "post";
    other.action = "/other";
    other.dataset.graft = "";
    document.body.append(other);
    const safe = document.createElement("form");
    safe.method = "get";
    safe.action = "/patients";
    safe.dataset.graft = "";
    document.body.append(safe);
    const link = document.createElement("a");
    link.href = "/patients";
    link.dataset.graft = "";
    document.body.append(link);

    expect(submit(other).defaultPrevented).toBe(true);
    expect(submit(safe).defaultPrevented).toBe(true);
    link.click();
    expect(fetch).toHaveBeenCalledOnce();
    expect(element.hasAttribute("data-graft-uncertain")).toBe(true);
});

test("POST derives its request and preserves repeated values and the submitter", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(patch());
    const element = form(`
        <input name="theme" value="dark">
        <input name="setting" value="one">
        <input name="setting" value="two">
        <button name="intent" value="save" type="submit">Save</button>`);
    const button = element.querySelector("button")!;

    expect(submit(element, button).defaultPrevented).toBe(true);
    await flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:3000/dashboard/account/theme");
    expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        headers: {
            "Graft-Request": "patch",
            Accept: MEDIA_TYPE,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    });
    const body = init?.body as URLSearchParams;
    expect(body.getAll("setting")).toEqual(["one", "two"]);
    expect(body.get("intent")).toBe("save");
});

test("marks the actual submitter and leaves a patched-out control detached", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    const element = form(
        `<button id="save" name="intent" value="save" formaction="/save" formmethod="post">Save</button>`,
    );
    const button = element.querySelector<HTMLButtonElement>("button")!;

    submit(element, button);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("data-graft-submitter-pending")).toBe(true);
    const body = vi.mocked(fetch).mock.calls[0]![1]?.body as URLSearchParams;
    expect(body.get("intent")).toBe("save");
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("/save");

    resolve(patch());
    await flush();
    expect(button.isConnected).toBe(false);
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute("data-graft-submitter-pending")).toBe(true);
});

test("a known 429 patch applies once, releases the unsafe lane and does not retry", async () => {
    const fetchMock = vi
        .mocked(fetch)
        .mockResolvedValueOnce(patch("Try again later", 429))
        .mockResolvedValueOnce(patch("Allowed"));
    const element = form('<button type="submit">Save</button>');
    submit(element, element.querySelector("button")!);
    await flush();
    expect(document.getElementById("result")?.textContent).toBe(
        "Try again later",
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    const retry = form('<button type="submit">Save</button>');
    submit(retry, retry.querySelector("button")!);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

test.each([
    ["cross-origin", { action: "https://example.test/theme" }],
    ["unsupported method", { method: "put" }],
    ["unsupported encoding", { enctype: "multipart/form-data" }],
])("uses native fallback for %s", (_name, values) => {
    const element = form();
    Object.assign(element, values);
    expect(submit(element).defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
});

test("uses native fallback when a file is selected", () => {
    const element = form('<input name="attachment" type="file">');
    const input = element.elements.namedItem("attachment") as HTMLInputElement;
    Object.defineProperty(input, "files", {
        configurable: true,
        value: [new File(["content"], "record.txt", { type: "text/plain" })],
    });

    expect(submit(element).defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
});

test("one pending POST blocks every other enhanced request", async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    const first = form();
    const second = document.createElement("form");
    second.method = "post";
    second.action = "/other-command";
    second.dataset.graft = "";
    document.body.append(second);
    const safe = document.createElement("form");
    safe.method = "get";
    safe.action = "/patients";
    safe.dataset.graft = "";
    document.body.append(safe);
    const link = document.createElement("a");
    link.href = "/patients";
    link.dataset.graft = "";
    document.body.append(link);

    submit(first);
    expect(submit(second).defaultPrevented).toBe(true);
    expect(submit(safe).defaultPrevented).toBe(true);
    const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
    });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeUndefined();
    expect(first.getAttribute("aria-busy")).toBe("true");
    expect(first.hasAttribute("data-graft-pending")).toBe(true);

    resolve(patch());
    await flush();
});

test("a POST cannot start while navigation is pending", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    const link = document.createElement("a");
    link.href = "/patients";
    link.dataset.graft = "";
    document.body.append(link);
    link.click();

    const command = form();
    expect(submit(command).defaultPrevented).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    resolve(
        new Response(
            '<graft-patch-set version="1"><graft-patch operation="children" target="main"><template>Patients</template></graft-patch></graft-patch-set>',
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        ),
    );
    await flush();
});

test.each(PATCH_STATUSES)(
    "restores pending state and permits a later command after a valid %i patch",
    async (status) => {
        vi.mocked(fetch).mockImplementation(() =>
            Promise.resolve(patch("Correct this", status)),
        );
        const element = form();
        element.setAttribute("aria-busy", "polite");

        submit(element);
        await flush();

        expect(element.getAttribute("aria-busy")).toBe("polite");
        expect(element.hasAttribute("data-graft-pending")).toBe(false);
        expect(document.getElementById("result")?.textContent).toBe(
            "Correct this",
        );
        expect(location.pathname).toBe("/dashboard/account/preferences");

        submit(form());
        await flush();
        expect(fetch).toHaveBeenCalledTimes(2);
    },
);

test("a cancelled native submit event is not enhanced", () => {
    const element = form();
    element.addEventListener("submit", (event) => event.preventDefault(), {
        capture: true,
    });
    const event = submit(element);
    expect(event.defaultPrevented).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
});

test("a valid conflict clears pending and permits a corrected retry", async () => {
    const fetchMock = vi
        .mocked(fetch)
        .mockResolvedValueOnce(patch("Latest truth", 409))
        .mockResolvedValueOnce(patch("Retried", 200));
    const element = form();
    submit(element);
    await flush();
    expect(element.hasAttribute("data-graft-pending")).toBe(false);
    expect(element.hasAttribute("data-graft-uncertain")).toBe(false);
    const replacement = form();
    submit(replacement);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("performs full navigation only after a valid navigation envelope", async () => {
    const details = collectSettled();
    vi.mocked(fetch).mockResolvedValue(
        new Response(
            '<graft-patch-set version="1" navigate="/dashboard/account/preferences?theme=updated"></graft-patch-set>',
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        ),
    );

    submit(form());
    await flush();

    expect(location.pathname).toBe("/dashboard/account/preferences");
    expect(location.search).toBe("?theme=updated");
    expect(details).toHaveLength(0);
});

test.each(PATCH_STATUSES)(
    "locks an uncertain form after malformed %i, preserves markup and shows reload guidance",
    async (status) => {
        vi.mocked(fetch).mockResolvedValue(
            new Response("malformed", {
                status,
                headers: { "content-type": MEDIA_TYPE },
            }),
        );
        const element = form();
        const before = element.querySelector("input")!.outerHTML;

        submit(element);
        await flush();
        submit(element);
        await flush();

        expect(fetch).toHaveBeenCalledOnce();
        expect(element.querySelector("input")!.outerHTML).toBe(before);
        expect(document.getElementById("result")).toBeNull();
        expect(element.hasAttribute("data-graft-uncertain")).toBe(true);
        const alert = document.getElementById("hypergraft-transport-alert")!;
        expect(alert.hidden).toBe(false);
        expect(
            alert.querySelector<HTMLElement>("[data-graft-reload]")?.hidden,
        ).toBe(false);
    },
);

test("automated controls honour a referenced native GET submitter", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(patch("Patients"));
    const element = form(`
        <input name="q" value="Alex" data-graft-submit-on="input" data-graft-submit-with="patient-refresh">
        <button id="patient-refresh" type="submit" formmethod="get" formaction="/diary/appointments/new" name="refresh" value="patients">Search</button>`);

    element
        .querySelector("input")!
        .dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe("/diary/appointments/new");
    expect(url.searchParams.get("q")).toBe("Alex");
    expect(url.searchParams.get("refresh")).toBe("patients");
});

test.each([
    ["missing", "missing", ""],
    ["non-submitter", "marker", '<span id="marker"></span>'],
    [
        "ambiguous",
        "refresh",
        '<button id="refresh" type="submit" formmethod="get">One</button><button id="refresh" type="submit" formmethod="get">Two</button>',
    ],
    ["non-GET", "refresh", '<button id="refresh" type="submit">Save</button>'],
    [
        "unsupported encoding",
        "refresh",
        '<button id="refresh" type="submit" formmethod="get" formenctype="multipart/form-data">Refresh</button>',
    ],
    [
        "cross-origin",
        "refresh",
        '<button id="refresh" type="submit" formmethod="get" formaction="https://example.test/search">Refresh</button>',
    ],
])(
    "fails closed for a %s submitter reference",
    async (_name, id, submitter) => {
        const element = form(
            `<input data-graft-submit-on="change" data-graft-submit-with="${id}">${submitter}`,
        );
        element
            .querySelector("input")!
            .dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
        expect(fetch).not.toHaveBeenCalled();
    },
);

test("fails closed for a cross-form submitter reference", async () => {
    const element = form(
        '<input data-graft-submit-on="change" data-graft-submit-with="other-refresh">',
    );
    document.body.insertAdjacentHTML(
        "beforeend",
        '<form><button id="other-refresh" type="submit" formmethod="get">Refresh</button></form>',
    );
    element
        .querySelector("input")!
        .dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(fetch).not.toHaveBeenCalled();
});

test("a requested refresh starts immediately without changing location state", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(patch("Messages"));
    const details = collectSettled();
    const locationChanges = vi.fn();
    addEventListener("hypergraft:locationchange", locationChanges);
    const element = refreshForm();
    const originalUrl = location.href;
    const originalState = history.state;

    requestGraftRefresh(element);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(element.hasAttribute("data-graft-pending")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:3000/messages?view=inbox");
    expect(init).toMatchObject({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        headers: { "Graft-Request": "patch", Accept: MEDIA_TYPE },
    });

    await flush();

    expect(document.getElementById("result")?.textContent).toBe("Messages");
    expect(element.hasAttribute("data-graft-pending")).toBe(false);
    expect(location.href).toBe(originalUrl);
    expect(history.state).toEqual(originalState);
    expect(locationChanges).not.toHaveBeenCalled();
    expect(details).toHaveLength(1);
    removeEventListener("hypergraft:locationchange", locationChanges);
});

test.each([
    [
        "detached",
        (element: HTMLFormElement) => {
            element.remove();
        },
    ],
    [
        "foreign-document",
        (element: HTMLFormElement) => {
            document.implementation.createHTMLDocument().body.append(element);
        },
    ],
    [
        "unmarked",
        (element: HTMLFormElement) => {
            element.removeAttribute("data-graft");
        },
    ],
    [
        "non-GET",
        (element: HTMLFormElement) => {
            element.method = "post";
        },
    ],
    [
        "unsupported-encoding",
        (element: HTMLFormElement) => {
            element.enctype = "multipart/form-data";
        },
    ],
    [
        "cross-origin",
        (element: HTMLFormElement) => {
            element.action = "https://example.test/messages";
        },
    ],
    [
        "fragment",
        (element: HTMLFormElement) => {
            element.action = "/messages#latest";
        },
    ],
])("ignores a %s refresh form", (_name, invalidate) => {
    const element = refreshForm();
    invalidate(element);

    requestGraftRefresh(element);

    expect(fetch).not.toHaveBeenCalled();
});

test("refresh signals coalesce while navigation blocks their form", async () => {
    let resolveNavigation!: (response: Response) => void;
    let resolveRefresh!: (response: Response) => void;
    const fetchMock = vi
        .mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveNavigation = resolve;
                }),
        )
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveRefresh = resolve;
                }),
        );
    const element = refreshForm();
    const link = document.createElement("a");
    link.href = "/patients";
    link.dataset.graft = "";
    document.body.append(link);

    link.click();
    requestGraftRefresh(element);
    requestGraftRefresh(element);
    requestGraftRefresh(element);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveNavigation(patch("Patients"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveRefresh(patch("Refreshed"));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a refresh signal during an active refresh retains one later refresh", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const fetchMock = vi
        .mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFirst = resolve;
                }),
        )
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveSecond = resolve;
                }),
        );
    const element = refreshForm();

    requestGraftRefresh(element);
    requestGraftRefresh(element);
    requestGraftRefresh(element);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFirst(patch("First"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveSecond(patch("Second"));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.getElementById("result")?.textContent).toBe("Second");
});

test("navigation cancels an active refresh and retains one later refresh", async () => {
    const resolvers: ((response: Response) => void)[] = [];
    const fetchMock = vi.mocked(fetch).mockImplementation(
        () =>
            new Promise((resolve) => {
                resolvers.push(resolve);
            }),
    );
    const element = refreshForm();
    const link = document.createElement("a");
    link.href = "/patients";
    link.dataset.graft = "";
    document.body.append(link);

    requestGraftRefresh(element);
    link.click();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(element.hasAttribute("data-graft-pending")).toBe(false);

    resolvers[1]!(patch("Patients"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    resolvers[0]!(patch("Stale refresh"));
    await flush();
    expect(document.getElementById("result")?.textContent).toBe("Patients");

    resolvers[2]!(patch("Current refresh"));
    await flush();
    expect(document.getElementById("result")?.textContent).toBe(
        "Current refresh",
    );
});

test("a known unsafe settlement releases one queued refresh", async () => {
    let resolveCommand!: (response: Response) => void;
    let resolveRefresh!: (response: Response) => void;
    const fetchMock = vi
        .mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveCommand = resolve;
                }),
        )
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveRefresh = resolve;
                }),
        );
    const command = form();
    const refresh = refreshForm();

    submit(command);
    requestGraftRefresh(refresh);
    requestGraftRefresh(refresh);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveCommand(patch("Saved"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveRefresh(patch("Authoritative messages"));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("an uncertain unsafe settlement discards queued refreshes", async () => {
    let resolveCommand!: (response: Response) => void;
    const fetchMock = vi.mocked(fetch).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                resolveCommand = resolve;
            }),
    );
    const command = form();
    const refresh = refreshForm();

    submit(command);
    requestGraftRefresh(refresh);
    resolveCommand(
        new Response("malformed", {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    await flush();
    requestGraftRefresh(refresh);
    await flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(command.hasAttribute("data-graft-uncertain")).toBe(true);
});

test("a queued refresh is discarded when its form disconnects", async () => {
    let resolveNavigation!: (response: Response) => void;
    const fetchMock = vi.mocked(fetch).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                resolveNavigation = resolve;
            }),
    );
    const element = refreshForm();
    const link = document.createElement("a");
    link.href = "/patients";
    link.dataset.graft = "";
    document.body.append(link);

    link.click();
    requestGraftRefresh(element);
    element.remove();
    resolveNavigation(patch("Patients"));
    await flush();

    expect(fetchMock).toHaveBeenCalledOnce();
});

test("a safe refresh failure does not start an automatic retry", async () => {
    const fetchMock = vi
        .mocked(fetch)
        .mockRejectedValue(new TypeError("offline"));

    requestGraftRefresh(refreshForm());
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledOnce();
});

test("runtime teardown cancels an active refresh and its retained signal", async () => {
    let resolveRefresh!: (response: Response) => void;
    const fetchMock = vi.mocked(fetch).mockReturnValue(
        new Promise((resolve) => {
            resolveRefresh = resolve;
        }),
    );
    const element = refreshForm();

    requestGraftRefresh(element);
    requestGraftRefresh(element);
    cleanup?.();
    cleanup = undefined;
    resolveRefresh(patch("Late refresh"));
    await flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(document.getElementById("result")).toBeNull();
    requestGraftRefresh(element);
    expect(fetchMock).toHaveBeenCalledOnce();
});

test("a safe GET navigation hand-off emits no settled event", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response(
            '<graft-patch-set version="1" navigate="/patients/selected"></graft-patch-set>',
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        ),
    );
    const details = collectSettled();
    const element = form('<input name="q" value="Alex">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(location.pathname).toBe("/patients/selected");
    expect(details).toHaveLength(0);
});

test("a settled safe GET restores pending state before the settled event", async () => {
    let resolveResponse!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((resolve) => {
            resolveResponse = resolve;
        }),
    );
    const element = form('<input name="q" value="Alex">');
    element.method = "get";
    element.action = "/patients";
    const assertRestored = () => {
        expect(element.hasAttribute("data-graft-pending")).toBe(false);
    };
    addEventListener("hypergraft:requestsettled", assertRestored);
    submit(element);
    expect(element.hasAttribute("data-graft-pending")).toBe(true);
    resolveResponse(patch("Results"));
    await flush();
    removeEventListener("hypergraft:requestsettled", assertRestored);
});

test("a settled safe GET reports the effective URL and applied targets", async () => {
    vi.mocked(fetch).mockResolvedValue(patch("Search results"));
    const details = collectSettled();
    const element = form('<input name="q" value="Alex">');
    element.method = "get";
    element.action = "/patients?q=prefix";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        requestKind: "patch",
        form: element,
        url: "http://localhost:3000/patients?q=Alex",
        outcome: "applied-patch",
        status: 200,
        targetIds: ["theme-card"],
    });
});

test("a failed safe GET settles with a failure outcome and no targets", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    const details = collectSettled();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        requestKind: "patch",
        form: element,
        url: "http://localhost:3000/patients?q=x",
        outcome: "safe-failure",
    });
    expect(element.hasAttribute("data-graft-pending")).toBe(false);
});

test("a safe patch application failure reports the accepted response status", async () => {
    vi.mocked(fetch).mockResolvedValue(patch("Cannot land", 409));
    const details = collectSettled();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";
    const target = document.getElementById("theme-card")!;
    target.insertBefore = (() => {
        throw new Error("synthetic morph failure");
    }) as typeof target.insertBefore;

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ outcome: "safe-failure", status: 409 });
    expect(element.hasAttribute("data-graft-pending")).toBe(false);
});

test("a safe GET that receives an accepted but malformed status settles as a failure with a status", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response("malformed", {
            status: 422,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    const details = collectSettled();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ outcome: "safe-failure", status: 422 });
});

test("a safe GET that receives an unaccepted status settles without a status", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response("malformed", {
            status: 500,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    const details = collectSettled();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ outcome: "safe-failure" });
    expect(details[0]).not.toHaveProperty("status");
});

test("a superseded safe GET restores pending state and emits no settled event", async () => {
    let resolveOld!: (response: Response) => void;
    vi.mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        )
        .mockResolvedValue(patch("New"));
    const details = collectSettled();
    const element = form('<input name="q" value="old">');
    element.method = "get";
    element.action = "/patients";
    submit(element);
    expect(element.hasAttribute("data-graft-pending")).toBe(true);

    const link = document.createElement("a");
    link.href = "/";
    link.dataset.graft = "";
    document.body.append(link);
    link.click();
    await flush();

    resolveOld(patch("Stale"));
    await flush();

    expect(element.hasAttribute("data-graft-pending")).toBe(false);
    expect(document.body.textContent).not.toContain("Stale");
    expect(details).toHaveLength(0);
});

test("a replacement request on the same form owns and restores pending state", async () => {
    let resolveOld!: (response: Response) => void;
    let resolveLatest!: (response: Response) => void;
    vi.mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        )
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveLatest = resolve;
                }),
        );
    const details = collectSettled();
    const element = form('<input name="q" value="old">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    element.querySelector("input")!.value = "latest";
    submit(element);
    expect(element.hasAttribute("data-graft-pending")).toBe(true);

    resolveLatest(patch("Latest"));
    await flush();
    resolveOld(patch("Stale"));
    await flush();

    expect(element.hasAttribute("data-graft-pending")).toBe(false);
    expect(details).toHaveLength(1);
    expect(details[0]!.outcome).toBe("applied-patch");
    expect(document.body.textContent).toContain("Latest");
    expect(document.body.textContent).not.toContain("Stale");
});

test("safe recovery waits for every connected failed GET form", async () => {
    cleanup?.();
    const safeFailure = vi.fn();
    const safeRecovery = vi.fn();
    cleanup = startHypergraft({
        feedback: {
            safeFailure,
            safeRecovery,
            uncertainUnsafeOutcome: vi.fn(),
        },
    });
    document.getElementById("theme-card")!.innerHTML = `
        <form id="first" data-graft method="get" action="/first"></form>
        <form id="second" data-graft method="get" action="/second"></form>
        <div id="first-result"></div><div id="second-result"></div>`;
    const first = document.getElementById("first") as HTMLFormElement;
    const second = document.getElementById("second") as HTMLFormElement;
    const resultPatch = (target: string) =>
        new Response(
            `<graft-patch-set version="1"><graft-patch operation="children" target="${target}"><template>Recovered</template></graft-patch></graft-patch-set>`,
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        );
    vi.mocked(fetch)
        .mockRejectedValueOnce(new TypeError("first offline"))
        .mockRejectedValueOnce(new TypeError("second offline"))
        .mockResolvedValueOnce(resultPatch("first-result"))
        .mockResolvedValueOnce(resultPatch("second-result"));

    submit(first);
    await flush();
    submit(second);
    await flush();
    expect(safeFailure).toHaveBeenCalledTimes(2);

    submit(first);
    await flush();
    expect(safeRecovery).not.toHaveBeenCalled();

    submit(second);
    await flush();
    expect(safeRecovery).toHaveBeenCalledOnce();
});

test("an authoritative patch prunes removed failed GET forms", async () => {
    cleanup?.();
    const safeRecovery = vi.fn();
    cleanup = startHypergraft({
        feedback: {
            safeFailure: vi.fn(),
            safeRecovery,
            uncertainUnsafeOutcome: vi.fn(),
        },
    });
    document.getElementById("theme-card")!.innerHTML = `
        <form id="failed" data-graft method="get" action="/failed"></form>
        <form id="refresh" data-graft method="get" action="/refresh"></form>`;
    const failed = document.getElementById("failed") as HTMLFormElement;
    const refresh = document.getElementById("refresh") as HTMLFormElement;
    vi.mocked(fetch)
        .mockRejectedValueOnce(new TypeError("offline"))
        .mockResolvedValueOnce(patch("Authoritative replacement"));

    submit(failed);
    await flush();
    submit(refresh);
    await flush();

    expect(failed.isConnected).toBe(false);
    expect(safeRecovery).toHaveBeenCalledOnce();
});

test("a safe failure leaves the form unlocked for a later retry", async () => {
    vi.mocked(fetch)
        .mockRejectedValueOnce(new TypeError("offline"))
        .mockResolvedValue(patch("Recovered"));
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";
    submit(element);
    await flush();
    expect(element.hasAttribute("data-graft-pending")).toBe(false);

    submit(element);
    await flush();
    expect(document.getElementById("result")?.textContent).toBe("Recovered");
    expect(fetch).toHaveBeenCalledTimes(2);
});

test("keeps safe GET form patch and history behaviour", async () => {
    vi.mocked(fetch).mockResolvedValue(patch("Search results"));
    const element = form('<input name="q" value="Alex">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(history.state.hypergraft).toBe(true);
});

test("navigation aborts an older page-local GET before it can patch", async () => {
    let resolveSearch!: (response: Response) => void;
    const fetchMock = vi
        .mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveSearch = resolve;
                }),
        )
        .mockResolvedValueOnce(
            new Response(
                '<graft-patch-set version="1"><graft-patch operation="children" target="main"><template><p id="destination">Destination</p></template></graft-patch></graft-patch-set>',
                { status: 200, headers: { "content-type": MEDIA_TYPE } },
            ),
        );
    const search = form('<input name="q" value="old">');
    search.method = "get";
    search.action = "/patients";
    submit(search);

    const link = document.createElement("a");
    link.href = "/";
    link.dataset.graft = "";
    document.body.append(link);
    link.click();
    await flush();

    resolveSearch(patch("Stale search"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.getElementById("destination")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Stale search");
    expect(search.hasAttribute("data-graft-pending")).toBe(false);
});

test("page-local GET cannot start while navigation is pending", async () => {
    let resolveNavigation!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((resolve) => {
            resolveNavigation = resolve;
        }),
    );
    const link = document.createElement("a");
    link.href = "/";
    link.dataset.graft = "";
    document.body.append(link);
    link.click();

    const search = form();
    search.method = "get";
    submit(search);
    expect(fetch).toHaveBeenCalledOnce();

    resolveNavigation(
        new Response(
            '<graft-patch-set version="1"><graft-patch operation="children" target="main"><template>Home</template></graft-patch></graft-patch-set>',
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        ),
    );
    await flush();
});

test("a transport failure on a safe GET emits a diagnostic before feedback", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    const details = collectDiagnostics();
    const alert = document.getElementById("hypergraft-transport-alert")!;
    const hiddenAtDiagnostic: boolean[] = [];
    addEventListener("hypergraft:diagnostic", () =>
        hiddenAtDiagnostic.push(Boolean(alert.hidden)),
    );
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        reason: "transport",
        requestKind: "patch",
        unsafe: false,
        url: "http://localhost:3000/patients?q=x",
        element,
    });
    expect(hiddenAtDiagnostic).toEqual([true]);
    expect(alert.hidden).toBe(false);
});

test("an uncertain transport failure emits a diagnostic before unsafe feedback", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
    const details = collectDiagnostics();
    const alert = document.getElementById("hypergraft-transport-alert")!;
    const hiddenAtDiagnostic: boolean[] = [];
    addEventListener("hypergraft:diagnostic", () =>
        hiddenAtDiagnostic.push(Boolean(alert.hidden)),
    );
    const element = form();

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        reason: "transport",
        requestKind: "patch",
        unsafe: true,
        url: "http://localhost:3000/dashboard/account/theme",
        element,
    });
    expect(hiddenAtDiagnostic).toEqual([true]);
    expect(alert.hidden).toBe(false);
    expect(element.hasAttribute("data-graft-uncertain")).toBe(true);
});

test("an unusable redirect emits a redirect diagnostic", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 302 }));
    const details = collectDiagnostics();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        reason: "redirect",
        requestKind: "patch",
        unsafe: false,
        url: "http://localhost:3000/patients?q=x",
        element,
    });
});

test("a malformed redirect destination remains a redirect diagnostic", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response("", {
            status: 302,
            headers: { location: "http://[" },
        }),
    );
    const details = collectDiagnostics();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
        reason: "redirect",
        requestKind: "patch",
        unsafe: false,
        element,
    });
});

test("an unsafe HTTP redirect emits a redirect diagnostic and keeps the lock", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response("", {
            status: 303,
            headers: { location: "/login" },
        }),
    );
    const details = collectDiagnostics();
    const element = form();

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        reason: "redirect",
        requestKind: "patch",
        unsafe: true,
        url: "http://localhost:3000/dashboard/account/theme",
        element,
    });
    expect(element.hasAttribute("data-graft-uncertain")).toBe(true);
});

test("an oversized response emits a byte-limit diagnostic", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response("", {
            status: 200,
            headers: {
                "content-type": MEDIA_TYPE,
                "content-length": String(MAX_RESPONSE_BYTES + 1),
            },
        }),
    );
    const details = collectDiagnostics();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ reason: "byte-limit" });
});

test("an invalid UTF-8 response emits a utf-8 diagnostic", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response(new Uint8Array([0x68, 0x69, 0xff, 0xfe]), {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    const details = collectDiagnostics();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ reason: "utf-8" });
});

test("a malformed protocol response emits a protocol diagnostic", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response("malformed", {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    const details = collectDiagnostics();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        reason: "protocol",
        requestKind: "patch",
        unsafe: false,
        url: "http://localhost:3000/patients?q=x",
        element,
    });
});

test("a missing patch target emits a target-content diagnostic with the target", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response(
            '<graft-patch-set version="1"><graft-patch operation="children" target="missing"><template>x</template></graft-patch></graft-patch-set>',
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        ),
    );
    const details = collectDiagnostics();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        reason: "target-content",
        requestKind: "patch",
        unsafe: false,
        url: "http://localhost:3000/patients?q=x",
        element,
        targetId: "missing",
    });
});

test("a patch application failure emits an apply-failure diagnostic", async () => {
    vi.mocked(fetch).mockResolvedValue(patch("Cannot land"));
    const details = collectDiagnostics();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";
    const target = document.getElementById("theme-card")!;
    target.insertBefore = (() => {
        throw new Error("synthetic morph failure");
    }) as typeof target.insertBefore;

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        reason: "apply-failure",
        requestKind: "patch",
        unsafe: false,
        url: "http://localhost:3000/patients?q=x",
        element,
    });
});

test("an invalid live-form configuration emits a diagnostic and nothing else", async () => {
    const details = collectDiagnostics();
    const element = form(
        '<input data-graft-submit-on="change" data-graft-submit-with="missing-ref">',
    );

    element
        .querySelector("input")!
        .dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(fetch).not.toHaveBeenCalled();
    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
        reason: "invalid-live-form",
        requestKind: "patch",
        unsafe: false,
        url: "http://localhost:3000/dashboard/account/theme",
        element: element.querySelector("input"),
    });
});

test("a diagnostic never exposes response bodies, form values or thrown errors", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response(
            '<graft-patch-set version="1">secret-server-text</graft-patch-set>',
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        ),
    );
    const details = collectDiagnostics();
    const element = form('<input name="password" value="super-secret-value">');

    submit(element);
    await flush();

    expect(details).toHaveLength(1);
    const serialised = JSON.stringify(details[0]);
    expect(serialised).not.toContain("secret-server-text");
    expect(serialised).not.toContain("super-secret-value");
    expect(serialised).not.toContain("Invalid Hypergraft response");
    expect(details[0]).toEqual({
        reason: "protocol",
        requestKind: "patch",
        unsafe: true,
        url: "http://localhost:3000/dashboard/account/theme",
        element,
    });
});

test("an applied patch emits no diagnostic", async () => {
    vi.mocked(fetch).mockResolvedValue(patch("Applied"));
    const details = collectDiagnostics();

    submit(form());
    await flush();

    expect(details).toHaveLength(0);
});

test("a superseded safe GET emits no diagnostic", async () => {
    let resolveOld!: (response: Response) => void;
    vi.mocked(fetch)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        )
        .mockResolvedValue(patch("New"));
    const details = collectDiagnostics();
    const element = form('<input name="q" value="old">');
    element.method = "get";
    element.action = "/patients";
    submit(element);

    const link = document.createElement("a");
    link.href = "/";
    link.dataset.graft = "";
    document.body.append(link);
    link.click();
    await flush();

    resolveOld(patch("Stale"));
    await flush();

    expect(details).toHaveLength(0);
});

test("a failed navigation emits a diagnostic before native fallback", async () => {
    vi.mocked(fetch).mockResolvedValue(
        new Response("malformed", {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
        }),
    );
    const details = collectDiagnostics();
    const assignSpy = vi
        .spyOn(window.location, "assign")
        .mockImplementation(() => {});
    const callsAtDiagnostic: number[] = [];
    addEventListener("hypergraft:diagnostic", () =>
        callsAtDiagnostic.push(assignSpy.mock.calls.length),
    );
    const link = document.createElement("a");
    link.href = "/patients";
    link.dataset.graft = "";
    document.body.append(link);

    link.click();
    await flush();

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
        reason: "protocol",
        requestKind: "navigation",
        unsafe: false,
        element: link,
    });
    expect(callsAtDiagnostic).toEqual([0]);
    expect(assignSpy).toHaveBeenCalledOnce();
    assignSpy.mockRestore();
});

test("fragment-bearing links stay native", () => {
    const samePage = document.createElement("a");
    samePage.dataset.graft = "";
    samePage.href = `${location.pathname}${location.search}#same`;
    const otherPage = document.createElement("a");
    otherPage.dataset.graft = "";
    otherPage.href = "/patients#results";
    document.body.append(samePage, otherPage);
    samePage.click();
    otherPage.click();
    expect(fetch).not.toHaveBeenCalled();
});

test("GET and POST forms with fragment actions stay native", () => {
    const getForm = form('<input name="q" value="x">');
    getForm.method = "get";
    getForm.action = "/patients#results";
    const getEvent = submit(getForm);
    expect(getEvent.defaultPrevented).toBe(false);

    const postForm = form();
    postForm.action = "/dashboard/account/theme#card";
    const postEvent = submit(postForm);
    expect(postEvent.defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
});

test("a submitter formaction with a fragment stays native", () => {
    const element = form(
        '<button type="submit" formaction="/save#done">Save</button>',
    );
    const event = submit(element, element.querySelector("button")!);
    expect(event.defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
});

test("live-form input and change do not schedule a fragment action", async () => {
    const details = collectDiagnostics();
    const element = form(
        '<input data-graft-submit-on="input" name="q" value="x"><select data-graft-submit-on="change"><option selected>one</option></select>',
    );
    element.method = "get";
    element.action = "/patients#results";
    element
        .querySelector("input")!
        .dispatchEvent(new Event("input", { bubbles: true }));
    element
        .querySelector("select")!
        .dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(details.map((detail) => detail.reason)).toEqual([
        "invalid-live-form",
        "invalid-live-form",
    ]);
});

test("teardown during a debounce does not start a later request", async () => {
    vi.useFakeTimers();
    const element = form(
        '<input data-graft-submit-on="input" data-graft-debounce="200" name="q" value="x">',
    );
    element.method = "get";
    element.action = "/patients";
    element
        .querySelector("input")!
        .dispatchEvent(new Event("input", { bubbles: true }));
    cleanup?.();
    cleanup = undefined;
    await vi.advanceTimersByTimeAsync(250);
    expect(fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
});

test("teardown during a safe fetch does not patch or settle", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    const details = collectSettled();
    const element = form('<input name="q" value="x">');
    element.method = "get";
    element.action = "/patients";
    submit(element);
    cleanup?.();
    cleanup = undefined;
    resolve(
        new Response(
            '<graft-patch-set version="1"><graft-patch operation="children" target="theme-card"><template><p id="late">Late</p></template></graft-patch></graft-patch-set>',
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        ),
    );
    await flush();
    expect(document.getElementById("late")).toBeNull();
    expect(details).toHaveLength(0);
});

test("teardown during navigation does not apply a later patch", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    const link = document.createElement("a");
    link.dataset.graft = "";
    link.href = "/patients";
    document.body.append(link);
    link.click();
    cleanup?.();
    cleanup = undefined;
    resolve(
        new Response(
            '<graft-patch-set version="1" title="Patients"><graft-patch operation="children" target="main"><template><p id="navigated">Patients</p></template></graft-patch></graft-patch-set>',
            { status: 200, headers: { "content-type": MEDIA_TYPE } },
        ),
    );
    await flush();
    expect(document.getElementById("navigated")).toBeNull();
});

test("final teardown during an unsafe command reloads without applying it", async () => {
    const reload = vi
        .spyOn(location, "reload")
        .mockImplementation(() => undefined);
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    const details = collectSettled();
    const first = form();
    submit(first);
    cleanup?.();
    cleanup = undefined;
    expect(reload).toHaveBeenCalled();

    resolve(patch("Late unsafe"));
    await flush();
    expect(document.getElementById("result")).toBeNull();
    expect(details).toHaveLength(0);
});

test("a replaced runtime reloads when the old unsafe command returns", async () => {
    const reload = vi
        .spyOn(location, "reload")
        .mockImplementation(() => undefined);
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    submit(form());
    cleanup = startHypergraft();
    expect(reload).not.toHaveBeenCalled();

    resolve(patch("Late unsafe"));
    await flush();
    expect(reload).toHaveBeenCalledOnce();
    expect(document.getElementById("result")).toBeNull();
});

test("runtime startup owns registered island lifetimes", () => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = `<div data-island="example"></div>`;
    const destroy = vi.fn();
    let lifetime: AbortSignal | undefined;

    cleanup = startHypergraft({
        islands: {
            example: (_root, context) => {
                lifetime = context.signal;
                return { destroy };
            },
        },
    });

    expect(lifetime?.aborted).toBe(false);
    cleanup();
    cleanup = undefined;
    expect(lifetime?.aborted).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
});

test("runtime replacement clears existing safe-failure feedback", async () => {
    cleanup?.();
    const safeFailure = vi.fn();
    const safeRecovery = vi.fn();
    cleanup = startHypergraft({
        feedback: {
            safeFailure,
            safeRecovery,
            uncertainUnsafeOutcome: vi.fn(),
        },
    });
    vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
    const safeForm = form();
    safeForm.method = "get";
    safeForm.action = "/patients";
    submit(safeForm);
    await flush();
    expect(safeFailure).toHaveBeenCalledOnce();

    cleanup = startHypergraft();
    expect(safeRecovery).toHaveBeenCalledOnce();
});

test("restart while an unsafe command is already uncertain does not unlock", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
    const first = form();
    submit(first);
    await flush();
    expect(first.hasAttribute("data-graft-uncertain")).toBe(true);
    cleanup = startHypergraft();
    const second = form();
    submit(second);
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
});

function frameEnvelope(envelope: string): string {
    return `${new TextEncoder().encode(envelope).length}\n${envelope}`;
}

function streamReply(envelopes: string[]) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        start(controller) {
            for (const envelope of envelopes)
                controller.enqueue(encoder.encode(frameEnvelope(envelope)));
            controller.close();
        },
    });
    return new Response(body, {
        status: 200,
        headers: {
            "content-type": MEDIA_TYPE,
            "graft-transfer": "stream",
        },
    });
}

test("an unsafe stream applies progress then settles on the final frame", async () => {
    const progress: number[] = [];
    addEventListener("hypergraft:progress", (event) => {
        progress.push((event as CustomEvent).detail.frame);
    });
    const details = collectSettled();
    vi.mocked(fetch).mockResolvedValue(
        streamReply([
            '<graft-patch-set version="1" phase="progress"><graft-patch operation="children" target="theme-card"><template><p id="partial">Partial</p></template></graft-patch></graft-patch-set>',
            '<graft-patch-set version="1" phase="final"><graft-patch operation="children" target="theme-card"><template><p id="result">Done</p></template></graft-patch></graft-patch-set>',
        ]),
    );
    const element = form();
    submit(element);
    await flush();
    expect(document.getElementById("result")?.textContent).toBe("Done");
    expect(element.hasAttribute("data-graft-pending")).toBe(false);
    expect(element.hasAttribute("data-graft-progress")).toBe(false);
    expect(progress).toEqual([1]);
    expect(details).toHaveLength(1);
    expect(details[0]?.outcome).toBe("applied-patch");
});

test("an incomplete unsafe stream stays uncertain", async () => {
    const details = collectSettled();
    vi.mocked(fetch).mockResolvedValue(
        streamReply([
            '<graft-patch-set version="1" phase="progress"><graft-patch operation="children" target="theme-card"><template><p id="partial">Partial</p></template></graft-patch></graft-patch-set>',
        ]),
    );
    const element = form();
    submit(element);
    await flush();
    expect(document.getElementById("partial")?.textContent).toBe("Partial");
    expect(element.hasAttribute("data-graft-uncertain")).toBe(true);
    expect(details[0]?.outcome).toBe("uncertain-unsafe-result");
    expect(details[0]).not.toHaveProperty("status");
});

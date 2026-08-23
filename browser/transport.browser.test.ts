import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { apply, MEDIA_TYPE, preflight } from "./patches";
import { resetHypergraftForTests, startHypergraft } from "./requests";

let cleanup: (() => void) | undefined;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function envelope(
    target: string,
    content: string,
    status = 200,
    title?: string,
) {
    const titleAttribute = title ? ` title="${title}"` : "";
    const headers: Record<string, string> = { "content-type": MEDIA_TYPE };
    if (status === 429) headers["retry-after"] = "60";
    return new Response(
        `<graft-patch-set version="1"${titleAttribute}><graft-patch operation="children" target="${target}"><template>${content}</template></graft-patch></graft-patch-set>`,
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
    cleanup?.();
    cleanup = undefined;
    resetHypergraftForTests();
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

test("back waits for a pending POST and then restores its destination", async () => {
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

    resolveCommand(envelope("command", '<p id="command-finished">Saved</p>'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
        expect(document.getElementById("history-after-command")).not.toBeNull(),
    );
    expect(new URL(String(fetchMock.mock.calls[1]![0])).pathname).toBe(
        "/command-history/one",
    );
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

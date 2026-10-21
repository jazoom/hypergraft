import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { defineIslandModules } from "./required-islands";
import { resetHypergraftForTests, startHypergraft } from "./requests";
import { MEDIA_TYPE } from "./patches";
import { listenForLocationChanges, listenForNavigation } from "./events";
import type { IslandInitialiser } from "./islands";

let stop: (() => void) | undefined;
afterEach(() => {
    resetHypergraftForTests();
    stop?.();
    stop = undefined;
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

test("workspace loading blocks Enter, external controls, requestSubmit and declarative gestures without releasing other owners' locks", async () => {
    document.body.innerHTML = `<input id="outside" form="save" value="outside"><button id="external" form="save">Save</button><button id="shell">Independent</button><section data-graft-workspace-feedback><a href="">Reload</a></section><main data-graft-workspace inert aria-busy="true"><div data-island="editor"></div><form id="save" data-graft method="post" action="/save"><input id="inside" name="text"><input id="disabled" disabled><input id="readonly" readonly><section inert><input id="authored-inert"></section><button>Save</button></form><form id="query" data-graft method="get" action="/query"><input id="query-input" name="q" data-graft-submit-on="input"></form></main><aside id="result"></aside>`;
    let resolve!: (module: { islands: { editor: IslandInitialiser } }) => void;
    const loaded = new Promise<{ islands: { editor: IslandInitialiser } }>(
        (yes) => {
            resolve = yes;
        },
    );
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
            async () =>
                new Response(
                    '<graft-patch-set version="1"><graft-patch operation="children" target="result"><template>Saved</template></graft-patch></graft-patch-set>',
                    { headers: { "Content-Type": MEDIA_TYPE } },
                ),
        );
    const independent = vi.fn();
    document.getElementById("shell")!.addEventListener("click", independent);
    stop = startHypergraft({
        islands: defineIslandModules([
            { names: ["editor"], load: () => loaded },
        ]),
    });
    document.getElementById("inside")!.focus();
    expect(document.activeElement).not.toBe(document.getElementById("inside"));
    await userEvent.click(document.getElementById("outside")!);
    await userEvent.keyboard("{Enter}");
    await userEvent.click(document.getElementById("external")!);
    (document.getElementById("save") as HTMLFormElement).requestSubmit();
    document
        .getElementById("query-input")!
        .dispatchEvent(new Event("input", { bubbles: true }));
    await userEvent.click(document.getElementById("shell")!);
    expect(independent).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    resolve({ islands: { editor: () => {} } });
    await vi.waitFor(() =>
        expect(
            document
                .querySelector("[data-graft-workspace]")!
                .hasAttribute("inert"),
        ).toBe(false),
    );
    expect(fetch).not.toHaveBeenCalled();
    document.getElementById("inside")!.focus();
    expect(document.activeElement).toBe(document.getElementById("inside"));
    for (const id of ["disabled", "authored-inert"]) {
        document.getElementById(id)!.focus();
        expect(document.activeElement).not.toBe(document.getElementById(id));
    }
    await userEvent.fill(document.getElementById("inside")!, "Ready");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(String(fetch.mock.calls[0]![1]?.body)).toContain("text=Ready");
    expect(
        (document.getElementById("readonly") as HTMLInputElement).readOnly,
    ).toBe(true);
});

test("a cold navigation is visibly committed while all submission paths stay gated until reconciliation and focus finish", async () => {
    const original = location.href;
    document.body.innerHTML =
        '<a id="next" href="/cold" data-graft>Next</a><input id="outside" form="save"><button id="external" form="save">Save</button><section data-graft-workspace-feedback><p data-graft-workspace-loading>Loading</p><p data-graft-workspace-failure hidden>Failed</p><a href="">Reload</a></section><main id="main" tabindex="-1" data-graft-workspace>Old page</main><aside id="result"></aside>';
    let resolve!: (module: { islands: { editor: IslandInitialiser } }) => void;
    const loaded = new Promise<{ islands: { editor: IslandInitialiser } }>(
        (yes) => {
            resolve = yes;
        },
    );
    const html =
        '<div data-island="editor">New page</div><form id="save" data-graft method="post" action="/save"><input id="inside" name="text"><button>Save</button></form><form id="query" data-graft method="get" action="/query"><input id="search" name="q" data-graft-submit-on="input"></form>';
    const reply = (content: string, target: string) =>
        new Response(
            `<graft-patch-set version="1"><graft-patch operation="children" target="${target}"><template>${content}</template></graft-patch></graft-patch-set>`,
            { headers: { "Content-Type": MEDIA_TYPE } },
        );
    const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => reply(html, "main"));
    const order: string[] = [];
    const locationStop = listenForLocationChanges(() => order.push("location"));
    const navigationStop = listenForNavigation((detail) => {
        if (detail.state === "succeeded") {
            order.push("success");
            expect(document.activeElement).toBe(
                document.getElementById("main"),
            );
        }
    });
    try {
        stop = startHypergraft({
            islands: defineIslandModules([
                { names: ["editor"], load: () => loaded },
            ]),
        });
        await userEvent.click(document.getElementById("next")!);
        await vi.waitFor(() =>
            expect(document.getElementById("inside")).not.toBeNull(),
        );
        expect(document.getElementById("main")!.innerText).toContain(
            "New page",
        );
        expect(
            document.getElementById("main")!.getBoundingClientRect().height,
        ).toBeGreaterThan(0);
        expect(location.pathname).toBe("/cold");
        expect(order).toEqual([]);
        document.getElementById("inside")!.focus();
        expect(document.activeElement).not.toBe(
            document.getElementById("inside"),
        );
        await userEvent.click(document.getElementById("outside")!);
        await userEvent.keyboard("{Enter}");
        await userEvent.click(document.getElementById("external")!);
        (document.getElementById("save") as HTMLFormElement).requestSubmit();
        document
            .getElementById("search")!
            .dispatchEvent(new Event("input", { bubbles: true }));
        expect(fetch).toHaveBeenCalledOnce();
        resolve({
            islands: {
                editor() {
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
        await vi.waitFor(() =>
            expect(order).toEqual([
                "mount",
                "reconcile",
                "location",
                "success",
            ]),
        );
        expect(fetch).toHaveBeenCalledOnce();
        fetch.mockImplementation(async () => reply("Saved", "result"));
        await userEvent.fill(document.getElementById("inside")!, "Ready");
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() =>
            expect(document.getElementById("result")!.textContent).toBe(
                "Saved",
            ),
        );
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(String(fetch.mock.calls[1]![1]?.body)).toContain("text=Ready");
    } finally {
        locationStop();
        navigationStop();
        stop?.();
        history.replaceState({}, "", original);
    }
});

test("readiness leaves an active ancestor-level alarm lock intact", async () => {
    document.body.innerHTML =
        '<section inert><main data-graft-workspace inert><input id="control"><div data-island="editor"></div></main></section><button id="safety">Safety</button>';
    stop = startHypergraft({
        islands: defineIslandModules([
            {
                names: ["editor"],
                load: async () => ({ islands: { editor() {} } }),
            },
        ]),
    });
    await vi.waitFor(() =>
        expect(
            document
                .querySelector("[data-graft-workspace]")!
                .hasAttribute("inert"),
        ).toBe(false),
    );
    document.getElementById("control")!.focus();
    expect(document.activeElement).not.toBe(document.getElementById("control"));
    document.getElementById("safety")!.focus();
    expect(document.activeElement).toBe(document.getElementById("safety"));
});

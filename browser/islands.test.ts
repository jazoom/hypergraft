// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from "vitest";
import { DIAGNOSTIC_EVENT, type DiagnosticDetail } from "./diagnostics";
import { LOCATION_CHANGE_EVENT, REQUEST_SETTLED_EVENT } from "./events";
import {
    observeIslands,
    type IslandReconcileContext,
    type IslandInstance,
} from "./islands";

beforeEach(() => document.body.replaceChildren());
const mutations = () => new Promise((resolve) => setTimeout(resolve, 0));

function settle(
    outcome: "applied-patch" | "uncertain-unsafe-result" = "applied-patch",
) {
    const form = document.createElement("form");
    const detail =
        outcome === "applied-patch"
            ? {
                  requestKind: "patch" as const,
                  form,
                  url: "https://example.test/command",
                  outcome,
                  status: 200 as const,
                  targetIds: ["target"],
              }
            : {
                  requestKind: "patch" as const,
                  form,
                  url: "https://example.test/command",
                  outcome,
              };
    dispatchEvent(new CustomEvent(REQUEST_SETTLED_EVENT, { detail }));
    return detail;
}

test("scans initial and added subtrees, mounts once, and normalises simple results", async () => {
    document.body.innerHTML = `<div data-island="cleanup"></div>`;
    const cleanup = vi.fn();
    const mount = vi.fn(() => cleanup);
    const empty = vi.fn(() => undefined);
    const stop = observeIslands({ cleanup: mount, empty });
    const subtree = document.createElement("section");
    subtree.innerHTML = `<div data-island="empty"></div>`;
    document.body.append(subtree);
    await mutations();
    document.body.append(subtree);
    await mutations();

    expect(mount).toHaveBeenCalledOnce();
    expect(empty).toHaveBeenCalledOnce();
    stop();
    expect(cleanup).toHaveBeenCalledOnce();
});

test("scans applied targets before reconciling retained instances and carries lifecycle facts", () => {
    document.body.innerHTML = `<main id="target"><div data-island="old"></div></main>`;
    const contexts: IslandReconcileContext[] = [];
    const mounted: string[] = [];
    const initialise = (root: HTMLElement): IslandInstance => {
        mounted.push(root.dataset.island!);
        return {
            destroy: vi.fn(),
            reconcile: (context) => contexts.push(context),
        };
    };
    const stop = observeIslands({ old: initialise, new: initialise });
    document
        .querySelector("#target")!
        .insertAdjacentHTML("beforeend", `<div data-island="new"></div>`);
    const applied = settle();
    const uncertain = settle("uncertain-unsafe-result");
    const location = {
        url: "https://example.test/next",
        cause: "history-traversal" as const,
    };
    dispatchEvent(new CustomEvent(LOCATION_CHANGE_EVENT, { detail: location }));

    expect(mounted).toEqual(["old", "new"]);
    expect(contexts).toContainEqual({ cause: "patch", detail: applied });
    expect(contexts).toContainEqual({ cause: "patch", detail: uncertain });
    expect(contexts).toContainEqual({ cause: "location", detail: location });
    expect("targetIds" in contexts[2]).toBe(false);
    stop();
});

test("preserves moved roots and destroys disconnected roots", async () => {
    document.body.innerHTML = `<div id="one"><div data-island="item"></div></div><div id="two"></div>`;
    const destroy = vi.fn();
    const mount = vi.fn(() => ({ destroy }));
    const stop = observeIslands({ item: mount });
    const root = document.querySelector<HTMLElement>("[data-island]")!;
    document.querySelector("#two")!.append(root);
    await mutations();
    expect(mount).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    root.remove();
    await mutations();
    expect(destroy).toHaveBeenCalledOnce();
    stop();
});

test("reports each unknown connected root once with only its bounded name", async () => {
    document.body.innerHTML = `<div data-island="mystery" data-secret="do-not-copy"></div>`;
    const details: DiagnosticDetail[] = [];
    const listener = (event: Event) =>
        details.push((event as CustomEvent<DiagnosticDetail>).detail);
    addEventListener(DIAGNOSTIC_EVENT, listener);
    const stop = observeIslands({});
    const root = document.querySelector<HTMLElement>("[data-island]")!;
    document.body.append(root);
    await mutations();
    expect(details).toEqual([
        { reason: "unknown-island", element: root, islandName: "mystery" },
    ]);
    stop();
    removeEventListener(DIAGNOSTIC_EVENT, listener);
});

test("location change scans retained roots before reconciling", () => {
    document.body.innerHTML = `<main id="main"><div id="old" data-island="old"></div><div id="next"></div></main>`;
    const contexts: IslandReconcileContext[] = [];
    const mounted: string[] = [];
    const oldDestroy = vi.fn();
    const stop = observeIslands({
        old: () => {
            mounted.push("old");
            return { destroy: oldDestroy };
        },
        next: (root) => {
            mounted.push(root.id);
            return {
                destroy: vi.fn(),
                reconcile: (context) => contexts.push(context),
            };
        },
    });
    document.getElementById("old")!.removeAttribute("data-island");
    document.getElementById("next")!.dataset.island = "next";
    const location = {
        url: "https://example.test/diary?view=day",
        cause: "link-navigation" as const,
    };
    dispatchEvent(new CustomEvent(LOCATION_CHANGE_EVENT, { detail: location }));
    expect(mounted).toEqual(["old", "next"]);
    expect(oldDestroy).toHaveBeenCalledOnce();
    expect(contexts).toEqual([{ cause: "location", detail: location }]);
    stop();
});

test("renames and removals on a retained root destroy the previous instance", () => {
    document.body.innerHTML = `<main id="target"><div data-island="old"></div></main>`;
    const oldDestroy = vi.fn();
    const newDestroy = vi.fn();
    const mounted: string[] = [];
    const stop = observeIslands({
        old: () => {
            mounted.push("old");
            return { destroy: oldDestroy };
        },
        next: () => {
            mounted.push("next");
            return { destroy: newDestroy };
        },
    });
    expect(mounted).toEqual(["old"]);
    const root = document.querySelector<HTMLElement>("[data-island]")!;
    root.dataset.island = "next";
    settle();
    expect(mounted).toEqual(["old", "next"]);
    expect(oldDestroy).toHaveBeenCalledOnce();
    expect(newDestroy).not.toHaveBeenCalled();
    root.removeAttribute("data-island");
    settle();
    expect(newDestroy).toHaveBeenCalledOnce();
    stop();
});

test("unknown names report once per identity and mount when later known", () => {
    document.body.innerHTML = `<main id="target"><div data-island="mystery"></div></main>`;
    const names: string[] = [];
    const listener = (event: Event) => {
        const detail = (event as CustomEvent<DiagnosticDetail>).detail;
        if (detail.reason === "unknown-island") names.push(detail.islandName);
    };
    addEventListener(DIAGNOSTIC_EVENT, listener);
    const destroyKnown = vi.fn();
    const mount = vi.fn(() => ({ destroy: destroyKnown }));
    const stop = observeIslands({ known: mount });
    const root = document.querySelector<HTMLElement>("[data-island]")!;
    expect(names).toEqual(["mystery"]);
    root.dataset.island = "known";
    settle();
    expect(mount).toHaveBeenCalledOnce();
    root.dataset.island = "other-mystery";
    settle();
    expect(destroyKnown).toHaveBeenCalledOnce();
    expect(names).toEqual(["mystery", "other-mystery"]);
    root.dataset.island = "vanished";
    settle();
    expect(names).toEqual(["mystery", "other-mystery", "vanished"]);
    stop();
    removeEventListener(DIAGNOSTIC_EVENT, listener);
});

test("isolates mount, reconcile, and destroy failures", () => {
    document.body.innerHTML = `<div data-island="bad-mount"></div><div data-island="bad"></div><div data-island="good"></div>`;
    const goodReconcile = vi.fn();
    const goodDestroy = vi.fn();
    const report = vi.fn();
    const stop = observeIslands(
        {
            "bad-mount": () => {
                throw new Error("mount");
            },
            bad: () => ({
                reconcile: () => {
                    throw new Error("reconcile");
                },
                destroy: () => {
                    throw new Error("destroy");
                },
            }),
            good: () => ({ reconcile: goodReconcile, destroy: goodDestroy }),
        },
        report,
    );
    settle("uncertain-unsafe-result");
    stop();
    expect(goodReconcile).toHaveBeenCalledOnce();
    expect(goodDestroy).toHaveBeenCalledOnce();
    expect(report.mock.calls.map((call) => call[1])).toEqual([
        "mount",
        "reconcile",
        "destroy",
    ]);
});

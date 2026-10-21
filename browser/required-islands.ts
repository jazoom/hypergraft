import { elementProperty, nodeProperty } from "./dom";
import { HypergraftError } from "./diagnostics";
import {
    createIslandObserver,
    type IslandController,
    type IslandErrorReporter,
    type IslandInitialiser,
    type IslandReconcileContext,
    type IslandRegistry,
} from "./islands";
import type { PreparedBatch } from "./patches";

const requiredRegistry = Symbol("required-islands");
type ModuleExport = { islands: IslandRegistry; islandLoading?: "eager" };
export type RequiredIslandModule = { names: readonly string[] } & (
    | { module: ModuleExport; load?: never }
    | { load: () => Promise<ModuleExport>; module?: never }
);
export interface RequiredIslandRegistry {
    readonly [requiredRegistry]: true;
    readonly modules: readonly RequiredIslandModule[];
}

export function defineIslandModules(
    modules: readonly RequiredIslandModule[],
): RequiredIslandRegistry {
    const names = new Set<string>();
    const snapshot = modules.map((module) => {
        if (!module.names.length || !!module.module === !!module.load)
            throw new TypeError("Invalid required island module");
        for (const name of module.names) {
            if (!name || names.has(name))
                throw new TypeError(`Invalid or duplicate island: ${name}`);
            names.add(name);
        }
        return Object.freeze({
            ...module,
            names: Object.freeze([...module.names]),
        });
    });
    return Object.freeze({
        [requiredRegistry]: true as const,
        modules: Object.freeze(snapshot),
    });
}

export function isRequiredRegistry(
    value: unknown,
): value is RequiredIslandRegistry {
    return !!value && typeof value === "object" && requiredRegistry in value;
}

function roots(nodes: readonly Node[]): HTMLElement[] {
    const found: HTMLElement[] = [];
    for (const node of nodes) {
        if (
            node instanceof HTMLElement &&
            elementProperty(node, "getAttributeNS").call(
                node,
                null,
                "data-island",
            ) !== null
        )
            found.push(node);
        if (
            node instanceof Element ||
            node === document ||
            node instanceof DocumentFragment
        )
            found.push(
                ...((node instanceof HTMLFormElement
                    ? Element.prototype.querySelectorAll.call(
                          node,
                          "[data-island]",
                      )
                    : (node as ParentNode).querySelectorAll(
                          "[data-island]",
                      )) as NodeListOf<HTMLElement>),
            );
    }
    return found;
}

function waitFor(load: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () =>
            reject(new DOMException("Island preparation ended", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        load.then(resolve, reject).finally(() =>
            signal.removeEventListener("abort", abort),
        );
    });
}

export function createRequiredIslands(
    registry: RequiredIslandRegistry,
    signal: AbortSignal,
    report?: IslandErrorReporter,
) {
    const initialisers: Record<string, IslandInitialiser> = Object.create(null);
    const modules = new Map<string, RequiredIslandModule>();
    const loads = new Map<RequiredIslandModule, Promise<void>>();
    const eager = new Set<string>();
    const holds = new Set<unknown>();
    let observer: IslandController;
    let workspace: HTMLElement | undefined;
    let failed = false;
    let gated = true;
    let starting = true;
    let waiting: AbortController | undefined;
    let waitingRoots: HTMLElement[] = [];
    let waitingNames: string[] = [];
    let focus: HTMLElement | undefined;

    const name = (root: HTMLElement) =>
        elementProperty(root, "getAttributeNS").call(
            root,
            null,
            "data-island",
        ) ?? "";
    const show = () => {
        for (const element of document.querySelectorAll<HTMLElement>(
            "[data-graft-workspace-feedback]",
        )) {
            element.hidden = !gated;
            for (const status of element.querySelectorAll<HTMLElement>(
                "[data-graft-workspace-loading]",
            ))
                status.hidden = failed;
            for (const status of element.querySelectorAll<HTMLElement>(
                "[data-graft-workspace-failure]",
            ))
                status.hidden = !failed;
        }
    };
    const boundary = () => {
        const found = document.querySelectorAll<HTMLElement>(
            "[data-graft-workspace]",
        );
        if (found.length !== 1)
            throw new Error("Automatic islands require exactly one workspace");
        workspace = found[0]!;
        return workspace;
    };
    const gate = () => {
        if (signal.aborted) return;
        const target = boundary();
        if (
            !gated &&
            document.activeElement instanceof HTMLElement &&
            nodeProperty(target, "contains").call(
                target,
                document.activeElement,
            )
        )
            focus = document.activeElement;
        gated = true;
        Element.prototype.setAttribute.call(target, "inert", "");
        Element.prototype.setAttribute.call(target, "aria-busy", "true");
        show();
    };
    const fail = () => {
        if (signal.aborted) return;
        failed = true;
        gated = true;
        try {
            gate();
        } catch {
            show();
        }
    };
    const release = () => {
        if (signal.aborted || failed || holds.size || waiting) return;
        const target = boundary();
        gated = false;
        Element.prototype.removeAttribute.call(target, "inert");
        Element.prototype.removeAttribute.call(target, "aria-busy");
        show();
        if (focus?.isConnected && !focus.closest("[inert]"))
            focus.focus({ preventScroll: true });
        focus = undefined;
    };
    const install = (
        definition: RequiredIslandModule,
        loaded: ModuleExport,
    ) => {
        const exported = loaded?.islands;
        if (
            !exported ||
            typeof exported !== "object" ||
            ![null, Object.prototype].includes(
                Object.getPrototypeOf(exported),
            ) ||
            Object.keys(exported).length !== definition.names.length ||
            loaded.islandLoading !== (definition.module ? "eager" : undefined)
        )
            throw new Error(
                "Island module export differs from its build declaration",
            );
        for (const key of definition.names) {
            if (
                !Object.hasOwn(exported, key) ||
                typeof exported[key] !== "function"
            )
                throw new Error("Invalid required island initialiser");
        }
        if (!signal.aborted)
            for (const key of definition.names)
                initialisers[key] = exported[key]!;
    };
    for (const definition of registry.modules)
        for (const key of definition.names) {
            modules.set(key, definition);
            if (definition.module) eager.add(key);
        }
    const prepareRoots = (
        current: readonly HTMLElement[],
        owner: AbortSignal,
    ): Promise<void> | undefined => {
        const missing = new Set<RequiredIslandModule>();
        for (const root of current) {
            const key = name(root);
            const definition = modules.get(key);
            if (!definition)
                throw new HypergraftError(
                    "transport",
                    "Unknown required island",
                );
            if (!initialisers[key]) missing.add(definition);
        }
        if (!missing.size) return;
        const work = [...missing].map((definition) => {
            let load = loads.get(definition);
            if (!load) {
                load = Promise.resolve()
                    .then(() => {
                        if (signal.aborted)
                            throw new DOMException(
                                "Runtime ended",
                                "AbortError",
                            );
                        return definition.module ?? definition.load!();
                    })
                    .then((loaded) => install(definition, loaded));
                loads.set(definition, load);
            }
            return load;
        });
        return waitFor(
            Promise.all(work)
                .then(() => undefined)
                .catch(() => {
                    throw new HypergraftError(
                        "transport",
                        "Required island module unavailable",
                    );
                }),
            owner,
        );
    };
    const prepare = (nodes: readonly Node[], owner: AbortSignal) =>
        prepareRoots(roots(nodes), owner);
    const affectsWorkspace = (batch: PreparedBatch) => {
        const target = boundary();
        return batch.patches.some(
            (patch) =>
                nodeProperty(target, "contains").call(target, patch.target) ||
                nodeProperty(patch.target, "contains").call(
                    patch.target,
                    target,
                ),
        );
    };
    const prepareBatch = (batch: PreparedBatch, owner: AbortSignal) => {
        const current = roots(batch.patches.flatMap((patch) => patch.nodes));
        if (affectsWorkspace(batch)) {
            // Workspace patches also depend on retained roots, which may still
            // be loading from the initial document. Replaced roots do not block them.
            for (const root of roots([document]))
                if (
                    !batch.patches.some(
                        (patch) =>
                            patch.operation === "children" &&
                            patch.target !== root &&
                            nodeProperty(patch.target, "contains").call(
                                patch.target,
                                root,
                            ),
                    )
                )
                    current.push(root);
        }
        return prepareRoots(current, owner);
    };
    const independent = (root: HTMLElement) => eager.has(name(root));
    const mount = (wholeWorkspace = true) => {
        if (signal.aborted) return;
        if (wholeWorkspace) {
            observer.scan(document);
            if (signal.aborted) return;
            observer.assertHealthy();
        } else {
            observer.scan(document, independent);
            observer.assertHealthy(independent);
        }
    };
    const checkOwner = (ownerSignal: AbortSignal) => {
        signal.throwIfAborted();
        ownerSignal.throwIfAborted();
    };
    const mountCurrent = (
        owner: unknown,
        ownerSignal: AbortSignal,
        wholeWorkspace: boolean,
    ): Promise<void> | undefined => {
        checkOwner(ownerSignal);
        if (!wholeWorkspace) {
            mount(false);
            return;
        }
        observer.assertHealthy();
        if (roots([document]).some((root) => !observer.mounted(root))) {
            holds.add(owner);
            gate();
            const loading = prepare([document], ownerSignal);
            if (loading)
                return loading.then(() =>
                    mountCurrent(owner, ownerSignal, true),
                );
        }
        mount();
        checkOwner(ownerSignal);
        // Mounting can introduce another required root. Prepare it from the
        // current document without replaying a retained instance's lifecycle fact.
        if (roots([document]).some((root) => !observer.mounted(root)))
            return mountCurrent(owner, ownerSignal, true);
    };
    const complete = (
        ownerSignal: AbortSignal,
        work: () => Promise<void> | undefined,
    ): Promise<void> | undefined => {
        const reject = (error: unknown): never => {
            if (!signal.aborted && !ownerSignal.aborted) fail();
            throw error;
        };
        try {
            return work()?.catch(reject);
        } catch (error) {
            return reject(error);
        }
    };
    const refresh = () => {
        if (signal.aborted || starting) return;
        // Eager roots remain independent during loading, failure and stream holds.
        try {
            mount(false);
        } catch {
            fail();
        }
        if (signal.aborted || failed || holds.size) return;
        const current = roots([document]);
        if (
            waiting &&
            current.length === waitingRoots.length &&
            current.every(
                (root, index) =>
                    root === waitingRoots[index] &&
                    name(root) === waitingNames[index],
            )
        )
            return;
        waiting?.abort();
        waiting = undefined;
        waitingRoots = [];
        waitingNames = [];
        try {
            observer.assertHealthy();
            if (current.every((root) => observer.mounted(root))) {
                release();
                return;
            }
            gate();
            const controller = new AbortController();
            const pending = prepare(
                [document],
                AbortSignal.any([signal, controller.signal]),
            );
            if (!pending) {
                mount();
                if (roots([document]).some((root) => !observer.mounted(root)))
                    refresh();
                else release();
                return;
            }
            waiting = controller;
            waitingRoots = current;
            waitingNames = current.map(name);
            void pending.then(
                () => {
                    if (signal.aborted || waiting !== controller) return;
                    waiting = undefined;
                    waitingRoots = [];
                    waitingNames = [];
                    refresh();
                },
                () => {
                    if (!signal.aborted && waiting === controller) {
                        waiting = undefined;
                        const current = roots([document]);
                        if (
                            current.length !== waitingRoots.length ||
                            current.some(
                                (root, index) =>
                                    root !== waitingRoots[index] ||
                                    name(root) !== waitingNames[index],
                            )
                        )
                            refresh();
                        else {
                            waitingRoots = [];
                            waitingNames = [];
                            fail();
                        }
                    }
                },
            );
        } catch {
            fail();
        }
    };
    signal.addEventListener(
        "abort",
        () => {
            waiting?.abort();
            waiting = undefined;
            waitingRoots = [];
            waitingNames = [];
            focus = undefined;
            workspace = undefined;
            holds.clear();
            loads.clear();
        },
        { once: true },
    );
    observer = createIslandObserver(initialisers, report, signal, {
        required: true,
        changed: refresh,
    });
    const affects = (form: HTMLFormElement) => {
        if (!workspace?.isConnected) return true;
        if (nodeProperty(workspace, "contains").call(workspace, form))
            return true;
        const controls = Object.getOwnPropertyDescriptor(
            HTMLFormElement.prototype,
            "elements",
        )!.get!.call(form) as HTMLFormControlsCollection;
        return [...controls].some((control) =>
            nodeProperty(workspace!, "contains").call(workspace, control),
        );
    };
    const blocked = (form: HTMLFormElement) => {
        try {
            boundary();
        } catch {
            fail();
            return true;
        }
        if (
            !gated &&
            roots([document]).some((root) => !observer.mounted(root))
        ) {
            gate();
            refresh();
            // Listeners installed during this capture phase may miss this gesture.
            return affects(form);
        }
        return gated && affects(form);
    };
    const guard = (event: Event) => {
        if (event.target instanceof HTMLFormElement && blocked(event.target)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };
    document.addEventListener("submit", guard, { capture: true, signal });

    return {
        observer,
        prepare,
        prepareBatch,
        blocked,
        fail,
        navigationCommitted(owner: unknown) {
            failed = false;
            focus = undefined;
            waiting?.abort();
            waiting = undefined;
            waitingRoots = [];
            waitingNames = [];
            for (const element of document.querySelectorAll<HTMLElement>(
                "[data-graft-workspace-live-failure]",
            ))
                element.hidden = true;
            holds.add(owner);
            gate();
            mount(false);
        },
        abandon(owner: unknown) {
            if (holds.delete(owner)) fail();
        },
        notifyFailure(context: IslandReconcileContext) {
            observer.reconcile(context);
            try {
                observer.assertHealthy();
            } catch {
                fail();
            }
        },
        projectionUnavailable() {
            if (signal.aborted) return;
            for (const element of document.querySelectorAll<HTMLElement>(
                "[data-graft-workspace-live-failure]",
            ))
                element.hidden = false;
        },
        start() {
            try {
                gate();
            } catch {
                fail();
            }
            for (const definition of registry.modules)
                if (definition.module) {
                    try {
                        install(definition, definition.module);
                    } catch {
                        fail();
                    }
                }
            starting = false;
            refresh();
        },
        begin(batch: PreparedBatch, owner: unknown) {
            if (signal.aborted) return;
            if (affectsWorkspace(batch)) {
                holds.add(owner);
                gate();
            }
        },
        mounted(owner: unknown, ownerSignal: AbortSignal) {
            return complete(ownerSignal, () =>
                mountCurrent(owner, ownerSignal, holds.has(owner) || !gated),
            );
        },
        finish(
            context: IslandReconcileContext,
            owner: unknown,
            ownerSignal: AbortSignal,
        ) {
            const wholeWorkspace = holds.has(owner) || !gated;
            const include = wholeWorkspace ? undefined : independent;
            return complete(ownerSignal, () => {
                const reconcile = () => {
                    checkOwner(ownerSignal);
                    observer.reconcile(context, include);
                    checkOwner(ownerSignal);
                    observer.assertHealthy(include);
                    return mountCurrent(owner, ownerSignal, wholeWorkspace);
                };
                const loading = mountCurrent(
                    owner,
                    ownerSignal,
                    wholeWorkspace,
                );
                return loading ? loading.then(reconcile) : reconcile();
            });
        },
        end(owner: unknown) {
            holds.delete(owner);
            refresh();
        },
    };
}
export type RequiredIslands = ReturnType<typeof createRequiredIslands>;

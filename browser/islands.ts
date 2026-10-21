import { emitDiagnostic } from "./diagnostics";
import { elementProperty, nodeProperty } from "./dom";

function islandName(root: HTMLElement): string | undefined {
    return (
        elementProperty(root, "getAttributeNS").call(
            root,
            null,
            "data-island",
        ) ?? undefined
    );
}
import {
    LIVE_PATCH_EVENT,
    LOCATION_CHANGE_EVENT,
    PROGRESS_EVENT,
    REQUEST_SETTLED_EVENT,
    type AppliedLivePatchDetail,
    type LocationChangeDetail,
    type ProgressDetail,
    type RequestSettledDetail,
} from "./events";

/** Authoritative lifecycle fact delivered after transport state is final. */
export type IslandReconcileContext =
    | { cause: "patch"; detail: RequestSettledDetail }
    | { cause: "live-patch"; detail: AppliedLivePatchDetail }
    | { cause: "location"; detail: LocationChangeDetail };

export interface IslandInstance {
    reconcile?(context: IslandReconcileContext): void;
    destroy(): void;
}

export interface IslandMountContext {
    readonly signal: AbortSignal;
}

export type IslandInitialiser = (
    root: HTMLElement,
    context: IslandMountContext,
) => IslandInstance | (() => void) | void;
const lazyDefinition = Symbol("lazy-island");

export interface LazyIsland {
    readonly [lazyDefinition]: true;
    readonly load: () => Promise<IslandInitialiser>;
}

/** Keep registration eager while deferring a root's implementation. */
export function lazyIsland(load: () => Promise<IslandInitialiser>): LazyIsland {
    if (typeof load !== "function")
        throw new TypeError("A lazy island requires a loader");
    return Object.freeze({ [lazyDefinition]: true as const, load });
}

export type IslandDefinition = IslandInitialiser | LazyIsland;
export type IslandRegistry<
    Definition extends IslandDefinition = IslandInitialiser,
> = Readonly<Record<string, Definition>>;

function isLazy(definition: IslandDefinition): definition is LazyIsland {
    return (
        typeof definition === "object" &&
        definition !== null &&
        definition[lazyDefinition] === true &&
        typeof definition.load === "function"
    );
}

export interface IslandModule<
    Services = void,
    Definition extends IslandDefinition = IslandInitialiser,
> {
    readonly islands:
        | IslandRegistry<Definition>
        | ((services: Services) => IslandRegistry<Definition>);
}

export function collectIslands(
    modules: Readonly<Record<string, IslandModule<void, IslandInitialiser>>>,
): IslandRegistry<IslandInitialiser>;
export function collectIslands<Services>(
    modules: Readonly<
        Record<string, IslandModule<Services, IslandInitialiser>>
    >,
    services: Services,
): IslandRegistry<IslandInitialiser>;
export function collectIslands(
    modules: Readonly<Record<string, IslandModule<void, IslandDefinition>>>,
): IslandRegistry<IslandDefinition>;
export function collectIslands<Services>(
    modules: Readonly<Record<string, IslandModule<Services, IslandDefinition>>>,
    services: Services,
): IslandRegistry<IslandDefinition>;
export function collectIslands<Services>(
    modules: Readonly<Record<string, IslandModule<Services, IslandDefinition>>>,
    services?: Services,
): IslandRegistry<IslandDefinition> {
    const registry: Record<string, IslandDefinition> = Object.create(null);
    const sources = new Map<string, string>();
    for (const [source, module] of Object.entries(modules)) {
        const exported = module?.islands;
        const islands =
            typeof exported === "function"
                ? exported(services as Services)
                : exported;
        if (
            !islands ||
            typeof islands !== "object" ||
            ![null, Object.prototype].includes(Object.getPrototypeOf(islands))
        )
            throw new TypeError(
                `Island module "${source}" must supply an island map`,
            );
        for (const [name, initialise] of Object.entries(islands)) {
            if (sources.has(name))
                throw new TypeError(
                    `Island "${name}" is declared by both "${sources.get(name)}" and "${source}"`,
                );
            if (
                !name ||
                (typeof initialise !== "function" && !isLazy(initialise))
            )
                throw new TypeError(`Invalid island "${name}" in "${source}"`);
            sources.set(name, source);
            registry[name] = initialise;
        }
    }
    return Object.freeze(registry);
}

export type IslandErrorReporter = (
    name: string,
    phase: "mount" | "reconcile" | "destroy",
    error: unknown,
    root: HTMLElement,
) => void;

export interface IslandObserver {
    (): void;
    retryIsland(root: HTMLElement): boolean;
}

function normaliseInstance(
    result: ReturnType<IslandInitialiser>,
): IslandInstance {
    if (typeof result === "function") return { destroy: result };
    return result ?? { destroy: () => undefined };
}

/** Observe and reconcile host-registered islands without modifying server-authored markup. */
export function observeIslands(
    initialisers: IslandRegistry<IslandDefinition>,
    report?: IslandErrorReporter,
    signal?: AbortSignal,
): IslandObserver {
    return createIslandObserver(initialisers, report, signal);
}

export interface IslandController extends IslandObserver {
    scan(root: ParentNode, include?: (root: HTMLElement) => boolean): void;
    reconcile(
        context: IslandReconcileContext,
        include?: (root: HTMLElement) => boolean,
    ): void;
    mounted(root: HTMLElement): boolean;
    assertHealthy(include?: (root: HTMLElement) => boolean): void;
}

export function createIslandObserver(
    initialisers: IslandRegistry<IslandDefinition>,
    report: IslandErrorReporter = (name, phase, error) =>
        console.error(`Island "${name}" failed to ${phase}:`, error),
    signal?: AbortSignal,
    internal?: { changed?: () => void; required?: boolean },
): IslandController {
    const instances = new Map<
        HTMLElement,
        {
            name: string;
            controller: AbortController;
            instance: IslandInstance;
        }
    >();
    let disposed = false;
    const failures = new Map<HTMLElement, string>();
    const failed = (
        name: string,
        phase: "mount" | "reconcile",
        error: unknown,
        root: HTMLElement,
    ) => {
        if (internal?.required) failures.set(root, name);
        report(name, phase, error, root);
    };
    const pending = new Map<HTMLElement, { name: string; failed: boolean }>();
    const loads = new Map<LazyIsland, Promise<IslandInitialiser | undefined>>();
    const reportedUnknown = new WeakMap<HTMLElement, string>();
    const destroyRoot = (root: HTMLElement, fallbackName: string) => {
        pending.delete(root);
        failures.delete(root);
        const mounted = instances.get(root);
        instances.delete(root);
        if (!mounted) return;
        mounted.controller.abort();
        try {
            mounted.instance.destroy();
        } catch (error) {
            report(mounted.name || fallbackName, "destroy", error, root);
        }
    };
    const mountRoot = (element: HTMLElement, name: string) => {
        if (disposed) return;
        const initialise = Object.hasOwn(initialisers, name)
            ? initialisers[name]
            : undefined;
        if (!initialise) {
            if (internal?.required) return;
            if (reportedUnknown.get(element) !== name) {
                reportedUnknown.set(element, name);
                emitDiagnostic({
                    reason: "unknown-island",
                    element,
                    islandName: name,
                });
            }
            return;
        }
        if (isLazy(initialise)) {
            const waiting = { name, failed: false };
            pending.set(element, waiting);
            let loading = loads.get(initialise);
            if (!loading) {
                loading = Promise.resolve()
                    .then(() => (disposed ? undefined : initialise.load()))
                    .then((loaded) => {
                        if (disposed) return;
                        if (typeof loaded !== "function")
                            throw new TypeError(
                                `Lazy island "${name}" must load an initialiser`,
                            );
                        return loaded;
                    });
                loads.set(initialise, loading);
                void loading.catch(() => {
                    loads.delete(initialise);
                });
            }
            const current = () =>
                !disposed &&
                pending.get(element) === waiting &&
                element.isConnected &&
                element.getAttribute("data-island") === name;
            void loading.then(
                (loaded) => {
                    if (!current() || !loaded) return;
                    mount(element, name, loaded);
                    if (instances.has(element)) pending.delete(element);
                },
                (error: unknown) => {
                    // Keep failed roots recorded: unrelated mutations must not retry them.
                    if (!current()) return;
                    waiting.failed = true;
                    report(name, "mount", error, element);
                },
            );
            return;
        }
        mount(element, name, initialise);
    };
    const mount = (
        element: HTMLElement,
        name: string,
        initialise: IslandInitialiser,
    ) => {
        const waiting = pending.get(element);
        const controller = new AbortController();
        const mounted = {
            name,
            controller,
            instance: normaliseInstance(undefined),
        };
        instances.set(element, mounted);
        try {
            const instance = normaliseInstance(
                initialise(element, { signal: controller.signal }),
            );
            // An initialiser may synchronously replace or dispose its runtime.
            if (instances.get(element) !== mounted) {
                controller.abort();
                try {
                    instance.destroy();
                } catch (error) {
                    report(name, "destroy", error, element);
                }
                return;
            }
            mounted.instance = instance;
        } catch (error) {
            if (instances.get(element) === mounted) instances.delete(element);
            controller.abort();
            if (waiting && pending.get(element) === waiting)
                waiting.failed = true;
            if (!disposed) failed(name, "mount", error, element);
        }
    };
    const scan = (
        root: ParentNode,
        include: (root: HTMLElement) => boolean = () => true,
    ) => {
        if (disposed) return;
        const candidates = new Set<HTMLElement>();
        if (root instanceof HTMLElement && islandName(root) !== undefined)
            candidates.add(root);
        const descendants =
            root instanceof HTMLFormElement
                ? (Element.prototype.querySelectorAll.call(
                      root,
                      "[data-island]",
                  ) as NodeListOf<HTMLElement>)
                : root.querySelectorAll<HTMLElement>("[data-island]");
        for (const element of descendants) candidates.add(element);
        for (const element of [...instances.keys(), ...pending.keys()]) {
            if (
                nodeProperty(root, "contains").call(root, element) ||
                root === element
            )
                candidates.add(element);
        }
        for (const element of candidates) {
            if (disposed) return;
            if (!nodeProperty(element, "isConnected")) continue;
            const name = islandName(element);
            const mounted = instances.get(element) ?? pending.get(element);
            if (failures.has(element) && failures.get(element) === name)
                continue;
            failures.delete(element);
            if (name === undefined) {
                if (mounted) destroyRoot(element, mounted.name);
                continue;
            }
            if (mounted) {
                if (mounted.name === name) continue;
                destroyRoot(element, mounted.name);
            }
            if (include(element)) mountRoot(element, name);
        }
    };
    const clean = () => {
        for (const [root, name] of failures)
            if (!nodeProperty(root, "isConnected") || islandName(root) !== name)
                failures.delete(root);
        for (const [root, mounted] of [...instances, ...pending])
            if (
                !nodeProperty(root, "isConnected") ||
                islandName(root) !== mounted.name
            )
                destroyRoot(root, mounted.name);
    };
    const reconcile = (
        context: IslandReconcileContext,
        include: (root: HTMLElement) => boolean = () => true,
    ) => {
        clean();
        for (const [root, mounted] of instances) {
            if (!include(root)) continue;
            try {
                mounted.instance.reconcile?.(context);
            } catch (error) {
                if (internal?.required) destroyRoot(root, mounted.name);
                failed(mounted.name, "reconcile", error, root);
            }
        }
    };
    const observer = new MutationObserver((records) => {
        if (internal?.changed) {
            clean();
            internal.changed();
            return;
        }
        for (const record of records) {
            if (
                record.type === "attributes" &&
                record.target instanceof HTMLElement
            )
                scan(record.target);
            for (const node of record.addedNodes)
                if (node instanceof HTMLElement) scan(node);
        }
        // Cleanup after all additions preserves roots moved within the document.
        clean();
    });
    const settled = (event: Event) => {
        const detail = (event as CustomEvent<RequestSettledDetail>).detail;
        // Events precede observer delivery, so new roots need an immediate scan.
        if (detail.outcome === "applied-patch")
            for (const id of detail.targetIds) {
                const target = document.getElementById(id);
                if (target) scan(target);
            }
        reconcile({ cause: "patch", detail });
    };
    const location = (event: Event) => {
        // Navigation supplies no target list for the synchronous scan.
        scan(document);
        reconcile({
            cause: "location",
            detail: (event as CustomEvent<LocationChangeDetail>).detail,
        });
    };
    const progress = (event: Event) => {
        const detail = (event as CustomEvent<ProgressDetail>).detail;
        for (const id of detail.targetIds) {
            const target = document.getElementById(id);
            if (target) scan(target);
        }
    };
    const livePatch = (event: Event) => {
        const detail = (event as CustomEvent<AppliedLivePatchDetail>).detail;
        for (const id of detail.targetIds) {
            const target = document.getElementById(id);
            if (target) scan(target);
        }
        reconcile({ cause: "live-patch", detail });
    };
    const stop = () => {
        if (disposed) return;
        disposed = true;
        failures.clear();
        pending.clear();
        loads.clear();
        observer.disconnect();
        signal?.removeEventListener("abort", stop);
        removeEventListener(REQUEST_SETTLED_EVENT, settled);
        removeEventListener(LOCATION_CHANGE_EVENT, location);
        removeEventListener(PROGRESS_EVENT, progress);
        removeEventListener(LIVE_PATCH_EVENT, livePatch);
        for (const [root, mounted] of [...instances])
            destroyRoot(root, mounted.name);
    };
    const handle: IslandController = Object.assign(stop, {
        scan,
        reconcile,
        mounted(root: HTMLElement) {
            return (
                instances.has(root) &&
                instances.get(root)?.name === islandName(root)
            );
        },
        assertHealthy(include: (root: HTMLElement) => boolean = () => true) {
            clean();
            if ([...failures.keys()].some(include))
                throw new Error("Required island initialisation failed");
        },
        retryIsland(root: HTMLElement): boolean {
            const waiting = pending.get(root);
            if (
                disposed ||
                !waiting?.failed ||
                !root.isConnected ||
                root.getAttribute("data-island") !== waiting.name
            )
                return false;
            mountRoot(root, waiting.name);
            return true;
        },
    });
    if (signal?.aborted) {
        stop();
        return handle;
    }
    // Install teardown before eager mounting: an initialiser may end its owner.
    signal?.addEventListener("abort", stop, { once: true });
    if (!internal?.changed) scan(document);
    if (!disposed) {
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-island"],
        });
        if (!internal) {
            addEventListener(REQUEST_SETTLED_EVENT, settled);
            addEventListener(LOCATION_CHANGE_EVENT, location);
            addEventListener(PROGRESS_EVENT, progress);
            addEventListener(LIVE_PATCH_EVENT, livePatch);
        }
    }
    return handle;
}

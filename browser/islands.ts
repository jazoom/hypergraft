import { emitDiagnostic } from "./diagnostics";
import {
    LOCATION_CHANGE_EVENT,
    PROGRESS_EVENT,
    REQUEST_SETTLED_EVENT,
    type LocationChangeDetail,
    type ProgressDetail,
    type RequestSettledDetail,
} from "./events";

/** Authoritative lifecycle fact delivered after transport state is final. */
export type IslandReconcileContext =
    | { cause: "patch"; detail: RequestSettledDetail }
    | { cause: "location"; detail: LocationChangeDetail };

export interface IslandInstance {
    reconcile?(context: IslandReconcileContext): void;
    destroy(): void;
}

export type IslandInitialiser = (
    root: HTMLElement,
) => IslandInstance | (() => void) | void;
export type IslandErrorReporter = (
    name: string,
    phase: "mount" | "reconcile" | "destroy",
    error: unknown,
) => void;

function normaliseInstance(
    result: ReturnType<IslandInitialiser>,
): IslandInstance {
    if (typeof result === "function") return { destroy: result };
    return result ?? { destroy: () => undefined };
}

/** Observe and reconcile host-registered islands without modifying server-authored markup. */
export function observeIslands(
    initialisers: Record<string, IslandInitialiser>,
    report: IslandErrorReporter = (name, phase, error) =>
        console.error(`Island "${name}" failed to ${phase}:`, error),
): () => void {
    const instances = new Map<
        HTMLElement,
        { name: string; instance: IslandInstance }
    >();
    const reportedUnknown = new WeakMap<HTMLElement, string>();
    const destroyRoot = (root: HTMLElement, fallbackName: string) => {
        const mounted = instances.get(root);
        instances.delete(root);
        if (!mounted) return;
        try {
            mounted.instance.destroy();
        } catch (error) {
            report(mounted.name || fallbackName, "destroy", error);
        }
    };
    const mountRoot = (element: HTMLElement, name: string) => {
        const initialise = initialisers[name];
        if (!initialise) {
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
        try {
            instances.set(element, {
                name,
                instance: normaliseInstance(initialise(element)),
            });
        } catch (error) {
            report(name, "mount", error);
        }
    };
    const scan = (root: ParentNode) => {
        const candidates = new Set<HTMLElement>();
        if (root instanceof HTMLElement && root.hasAttribute("data-island"))
            candidates.add(root);
        for (const element of root.querySelectorAll<HTMLElement>(
            "[data-island]",
        ))
            candidates.add(element);
        for (const [element] of instances) {
            if (root.contains(element) || root === element)
                candidates.add(element);
        }
        for (const element of candidates) {
            if (!element.isConnected) continue;
            const name = element.hasAttribute("data-island")
                ? (element.dataset.island ?? "")
                : undefined;
            const mounted = instances.get(element);
            if (name === undefined) {
                if (mounted) destroyRoot(element, mounted.name);
                continue;
            }
            if (mounted) {
                if (mounted.name === name) continue;
                destroyRoot(element, mounted.name);
            }
            mountRoot(element, name);
        }
    };
    const clean = () => {
        for (const [root, mounted] of instances)
            if (!root.isConnected) destroyRoot(root, mounted.name);
    };
    const reconcile = (context: IslandReconcileContext) => {
        clean();
        for (const [root, mounted] of instances)
            try {
                mounted.instance.reconcile?.(context);
            } catch (error) {
                report(mounted.name, "reconcile", error);
            }
    };
    scan(document);
    const observer = new MutationObserver((records) => {
        for (const record of records)
            for (const node of record.addedNodes)
                if (node instanceof HTMLElement) scan(node);
        // Cleaning after all additions preserves roots moved within the document.
        clean();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const settled = (event: Event) => {
        const detail = (event as CustomEvent<RequestSettledDetail>).detail;
        // Applied targets are authoritative and may contain newly rendered roots.
        if (detail.outcome === "applied-patch")
            for (const id of detail.targetIds) {
                const target = document.getElementById(id);
                if (target) scan(target);
            }
        reconcile({ cause: "patch", detail });
    };
    const location = (event: Event) => {
        // Navigation has no target list. Morph may author data-island onto a
        // retained node, which childList observation cannot see.
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
    addEventListener(REQUEST_SETTLED_EVENT, settled);
    addEventListener(LOCATION_CHANGE_EVENT, location);
    addEventListener(PROGRESS_EVENT, progress);
    return () => {
        observer.disconnect();
        removeEventListener(REQUEST_SETTLED_EVENT, settled);
        removeEventListener(LOCATION_CHANGE_EVENT, location);
        removeEventListener(PROGRESS_EVENT, progress);
        for (const [root, mounted] of instances)
            try {
                mounted.instance.destroy();
            } catch (error) {
                report(mounted.name, "destroy", error);
            }
        instances.clear();
    };
}

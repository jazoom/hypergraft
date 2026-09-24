import { emitDiagnostic } from "./diagnostics";
import { listenForNavigation, listenForQueryPending } from "./events";
import type { TransportFeedback } from "./requests";

export type BoundTransportFeedback = {
    feedback: TransportFeedback;
    destroy: () => void;
};

function exactlyOne<T extends Element>(
    root: ParentNode,
    selector: string,
    guard: (element: Element) => element is T,
): T | undefined {
    const matches = [...root.querySelectorAll(selector)];
    return matches.length === 1 && guard(matches[0]!) ? matches[0] : undefined;
}

type PendingRead = {
    ready: boolean;
    timer?: ReturnType<typeof setTimeout>;
};

/** Keep presentation timers separate from request startup. */
export function bindReadFeedback(root: ParentNode): () => void {
    const htmlElement = (element: Element): element is HTMLElement =>
        element instanceof HTMLElement;
    const indicator = exactlyOne(
        root,
        "[data-graft-read-indicator]",
        htmlElement,
    );
    const status = exactlyOne(root, "[data-graft-read-status]", htmlElement);
    if (!indicator || !status) {
        emitDiagnostic({
            reason: "invalid-feedback",
            element: root instanceof HTMLElement ? root : document.body,
        });
        return () => {};
    }
    const message = indicator.textContent?.trim() ?? "";
    const active = new Map<string, PendingRead>();
    const ended = new Set<string>();
    let destroyed = false;
    const render = () => {
        const visible = [...active.values()].some((request) => request.ready);
        indicator.hidden = !visible;
        const text = visible ? message : "";
        if (status.textContent !== text) status.textContent = text;
    };
    const end = (key: string) => {
        // An earlier listener can end ownership before this listener sees startup.
        // Retain terminal facts until synchronous event dispatch unwinds.
        ended.add(key);
        queueMicrotask(() => ended.delete(key));
        const request = active.get(key);
        if (!request) return;
        clearTimeout(request.timer);
        active.delete(key);
        render();
    };
    const begin = (key: string) => {
        if (ended.has(key) || active.has(key)) return;
        const request: PendingRead = { ready: false };
        active.set(key, request);
        request.timer = setTimeout(() => {
            if (active.get(key) !== request) return;
            request.ready = true;
            render();
        }, 200);
    };
    render();
    const stopNavigation = listenForNavigation((detail) => {
        const key = `navigation:${detail.requestId}`;
        if (detail.state === "started") begin(key);
        else end(key);
    });
    const stopQueries = listenForQueryPending((detail) => {
        const key = `query:${detail.requestId}`;
        if (detail.pending) begin(key);
        else end(key);
    });
    return () => {
        if (destroyed) return;
        destroyed = true;
        stopNavigation();
        stopQueries();
        for (const key of active.keys()) end(key);
    };
}

/** Bind transport behaviour to host-authored semantic slots. */
export function bindTransportFeedback(
    root: ParentNode,
): BoundTransportFeedback {
    const containers = [...root.querySelectorAll("[data-graft-feedback]")];
    if (root instanceof HTMLElement && root.matches("[data-graft-feedback]"))
        containers.unshift(root);
    const container =
        containers.length === 1 && containers[0] instanceof HTMLElement
            ? containers[0]
            : undefined;
    const htmlElement = (element: Element): element is HTMLElement =>
        element instanceof HTMLElement;
    const buttonElement = (element: Element): element is HTMLButtonElement =>
        element instanceof HTMLButtonElement;
    const safe = container
        ? exactlyOne(container, "[data-graft-feedback-safe]", htmlElement)
        : undefined;
    const blocked = container
        ? exactlyOne(container, "[data-graft-feedback-blocked]", htmlElement)
        : undefined;
    const uncertain = container
        ? exactlyOne(container, "[data-graft-feedback-uncertain]", htmlElement)
        : undefined;
    const dismiss = container
        ? exactlyOne(container, "[data-graft-feedback-dismiss]", buttonElement)
        : undefined;
    const reload = container
        ? exactlyOne(container, "[data-graft-feedback-reload]", buttonElement)
        : undefined;
    if (!container || !safe || !uncertain || !dismiss || !reload) {
        emitDiagnostic({
            reason: "invalid-feedback",
            element:
                container ??
                (root instanceof HTMLElement ? root : document.body),
        });
        return {
            feedback: {
                safeFailure: () => {},
                safeRecovery: () => {},
                uncertainUnsafeOutcome: () => {},
            },
            destroy: () => {},
        };
    }

    let uncertainShown = false;
    let destroyed = false;
    const showMessage = (message: HTMLElement) => {
        if (destroyed || uncertainShown) return;
        container.hidden = false;
        safe.hidden = message !== safe;
        if (blocked) blocked.hidden = message !== blocked;
        uncertain.hidden = true;
        dismiss.hidden = false;
        reload.hidden = true;
    };
    const showUncertain = () => {
        if (destroyed) return;
        uncertainShown = true;
        container.hidden = false;
        safe.hidden = true;
        if (blocked) blocked.hidden = true;
        uncertain.hidden = false;
        dismiss.hidden = true;
        reload.hidden = false;
    };
    const recoverSafe = () => {
        if (!destroyed && !uncertainShown) container.hidden = true;
    };
    const onDismiss = () => recoverSafe();
    const onReload = () => location.reload();
    dismiss.addEventListener("click", onDismiss);
    reload.addEventListener("click", onReload);

    return {
        feedback: {
            safeFailure: () => showMessage(safe),
            commandBlocked: () => {
                if (blocked) showMessage(blocked);
            },
            safeRecovery: recoverSafe,
            uncertainUnsafeOutcome: showUncertain,
        },
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            dismiss.removeEventListener("click", onDismiss);
            reload.removeEventListener("click", onReload);
        },
    };
}

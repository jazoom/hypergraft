import { emitDiagnostic } from "./diagnostics";
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

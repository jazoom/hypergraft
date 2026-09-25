import { emitDiagnostic } from "./diagnostics";
import {
    listenForLocationChanges,
    listenForNavigation,
    listenForRequestSettled,
    type NavigationRequest,
} from "./events";

/** Retry remains a real link so host departure guards run again. */
export function bindNavigationRecovery(root: ParentNode): () => void {
    const slot = <T extends Element>(
        selector: string,
        type: { new (...args: never[]): T },
    ): T | undefined => {
        const matches = root.querySelectorAll(selector);
        return matches.length === 1 && matches[0] instanceof type
            ? matches[0]
            : undefined;
    };
    const failure = slot("[data-graft-navigation-failure]", HTMLElement);
    const message = slot("[data-graft-navigation-message]", HTMLElement);
    const status = slot("[data-graft-navigation-status]", HTMLElement);
    const retry = slot("[data-graft-navigation-retry]", HTMLAnchorElement);
    const dismiss = slot("[data-graft-navigation-dismiss]", HTMLButtonElement);
    if (
        !failure ||
        !message ||
        !status ||
        !retry ||
        !dismiss ||
        !retry.hasAttribute("data-graft") ||
        failure.contains(status)
    ) {
        emitDiagnostic({
            reason: "invalid-feedback",
            element: root instanceof HTMLElement ? root : document.body,
        });
        return () => {};
    }
    let active: NavigationRequest | undefined;
    let failed: NavigationRequest | undefined;
    const ended = new Set<number>();
    const clear = () => {
        active = undefined;
        failed = undefined;
        failure.hidden = true;
        status.textContent = "";
    };
    const restoreFocus = (request?: NavigationRequest) => {
        const link = request?.link;
        if (link?.isConnected) {
            link.focus({ preventScroll: true });
            if (document.activeElement === link) return;
        }
        document
            .querySelector<HTMLElement>("main[tabindex]")
            ?.focus({ preventScroll: true });
    };
    const onDismiss = () => {
        const request = failed;
        clear();
        restoreFocus(request);
    };
    clear();
    const stopNavigation = listenForNavigation((detail) => {
        if (detail.state === "started") {
            if (ended.has(detail.requestId)) return;
            clear();
            active = detail;
            return;
        }
        ended.add(detail.requestId);
        queueMicrotask(() => ended.delete(detail.requestId));
        if (active?.requestId !== detail.requestId) return;
        clear();
        if (detail.state === "failed" && detail.recovery === "retry") {
            failed = detail;
            retry.href = detail.url;
            failure.hidden = false;
            status.textContent = message.textContent?.trim() ?? "";
        }
    });
    const stopLocation = listenForLocationChanges(clear);
    const stopSettled = listenForRequestSettled((detail) => {
        if (detail.outcome === "uncertain-unsafe-result") clear();
    });
    dismiss.addEventListener("click", onDismiss);
    return () => {
        stopNavigation();
        stopLocation();
        stopSettled();
        dismiss.removeEventListener("click", onDismiss);
        clear();
    };
}

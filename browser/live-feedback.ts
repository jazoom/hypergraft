import { listenForDiagnostics } from "./diagnostics";
import {
    listenForLivePatches,
    listenForLiveStateChanges,
    listenForLocationChanges,
    listenForQueryPending,
    listenForRequestSettled,
    type LiveStateChangeDetail,
} from "./events";
import { commandBlockReason } from "./requests";

type Observation = {
    form?: HTMLFormElement;
    targets: string;
    verified: boolean;
    received?: { iso: string; label: string };
};

function text(element: Element | null, value: string): void {
    if (element && element.textContent !== value) element.textContent = value;
}

export function bindLiveFeedback(root: ParentNode): () => void {
    let state: LiveStateChangeDetail["state"] = "idle";
    let disconnected = false;
    let uncertain = commandBlockReason() === "uncertain-command";
    const observations = new Map<HTMLElement, Observation>();
    const queries = new Set<HTMLFormElement>();
    const connection = root.querySelector<HTMLElement>(
        "[data-graft-live-connection]",
    );
    const announcement = root.querySelector<HTMLElement>(
        "[data-graft-live-announcement]",
    );
    const reconnecting = connection?.querySelector<HTMLElement>(
        "[data-graft-live-reconnecting]",
    );
    const stopped = connection?.querySelector<HTMLElement>(
        "[data-graft-live-stopped]",
    );

    const scan = () => {
        for (const element of observations.keys()) {
            if (
                !element.isConnected ||
                !root.contains(element) ||
                !element.hasAttribute("data-graft-live-status")
            )
                observations.delete(element);
        }
        for (const element of root.querySelectorAll<HTMLElement>(
            "[data-graft-live-status]",
        )) {
            const candidate = document.getElementById(
                element.dataset.graftLiveStatus ?? "",
            );
            const form =
                candidate instanceof HTMLFormElement &&
                candidate.matches("[data-graft][data-graft-live]")
                    ? candidate
                    : undefined;
            const targets = element.dataset.graftLiveTargets?.trim() ?? "";
            const previous = observations.get(element);
            if (
                !previous ||
                previous.form !== form ||
                previous.targets !== targets
            )
                observations.set(element, { form, targets, verified: false });
        }
    };

    const render = () => {
        scan();
        const unavailable =
            !uncertain &&
            !!root.querySelector("form[data-graft][data-graft-live]");
        const showStopped = unavailable && state === "stopped";
        const showDisconnected =
            unavailable &&
            disconnected &&
            (state === "reconnecting" || state === "connecting");
        if (connection) connection.hidden = !(showStopped || showDisconnected);
        if (reconnecting) reconnecting.hidden = !showDisconnected;
        if (stopped) stopped.hidden = !showStopped;
        text(
            announcement,
            (
                (showStopped ? stopped : showDisconnected ? reconnecting : null)
                    ?.textContent ?? ""
            ).trim(),
        );
        for (const [element, observation] of observations) {
            element.hidden = uncertain;
            const unverified = element.querySelector<HTMLElement>(
                "[data-graft-live-unverified]",
            );
            const updated = element.querySelector<HTMLElement>(
                "[data-graft-live-updated]",
            );
            const time = element.querySelector<HTMLTimeElement>(
                "time[data-graft-live-time]",
            );
            if (unverified)
                unverified.hidden =
                    observation.verified ||
                    state === "suspended" ||
                    state === "idle";
            if (updated) updated.hidden = !observation.received;
            if (time) {
                const iso = observation.received?.iso ?? "";
                if (time.dateTime !== iso) time.dateTime = iso;
                text(time, observation.received?.label ?? "");
            }
        }
    };

    const received = (form: HTMLFormElement, targets: readonly string[]) => {
        scan();
        if (uncertain) return;
        for (const observation of observations.values()) {
            if (
                observation.form === form &&
                observation.targets &&
                observation.targets
                    .split(/\s+/)
                    .every((id) => targets.includes(id))
            ) {
                const now = new Date();
                observation.verified = true;
                observation.received = {
                    iso: now.toISOString(),
                    label: now.toLocaleString(
                        document.documentElement.lang || undefined,
                        {
                            dateStyle: "short",
                            timeStyle: "medium",
                        },
                    ),
                };
            }
        }
        render();
    };

    const invalidate = (form?: HTMLFormElement) => {
        scan();
        for (const observation of observations.values())
            if (!form || observation.form === form)
                observation.verified = false;
    };

    const listeners = [
        listenForLiveStateChanges((detail) => {
            state = detail.state;
            if (state === "reconnecting") disconnected = true;
            if (state === "idle" || state === "suspended" || state === "open")
                disconnected = false;
            if (
                state === "reconnecting" ||
                state === "stopped" ||
                state === "suspended"
            )
                invalidate();
            render();
        }),
        listenForLivePatches((detail) => {
            if (state !== "stopped") received(detail.form, detail.targetIds);
        }),
        listenForQueryPending((detail) => {
            if (detail.pending) {
                queries.add(detail.form);
                invalidate(detail.form);
            } else queries.delete(detail.form);
            render();
        }),
        listenForRequestSettled((detail) => {
            if (detail.outcome === "uncertain-unsafe-result") uncertain = true;
            if (
                detail.outcome === "applied-patch" &&
                detail.status === 200 &&
                queries.has(detail.form)
            )
                received(detail.form, detail.targetIds);
            render();
        }),
        listenForLocationChanges((detail) => {
            if (
                detail.cause === "link-navigation" ||
                detail.cause === "history-traversal"
            )
                observations.clear();
            render();
        }),
        listenForDiagnostics((detail) => {
            if (
                detail.element instanceof HTMLFormElement &&
                (detail.reason === "invalid-live-form" ||
                    ("requestKind" in detail && detail.requestKind === "patch"))
            ) {
                invalidate(detail.element);
                render();
            }
        }),
    ];
    const observer = new MutationObserver(render);
    if (root instanceof Node)
        observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
                "id",
                "data-graft",
                "data-graft-live",
                "data-graft-live-status",
                "data-graft-live-targets",
            ],
        });
    render();
    return () => {
        observer.disconnect();
        for (const stop of listeners) stop();
        if (connection) connection.hidden = true;
        text(announcement, "");
        observations.clear();
        queries.clear();
    };
}

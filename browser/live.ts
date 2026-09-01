import { emitDiagnostic, HypergraftError } from "./diagnostics";
import { emitLivePatch } from "./events";
import {
    apply,
    MAX_RESPONSE_BYTES,
    preflightLive,
    type ValidateContent,
} from "./patches";

export const DEFAULT_LIVE_ENDPOINT = "/_hypergraft/live";
export const LIVE_SUBPROTOCOL = "hypergraft.v1";
export const MAX_LIVE_SUBSCRIPTIONS = 64;
export const MAX_LIVE_URL_BYTES = 8192;
export const MAX_LIVE_CONTROL_BYTES = 16384;
export const MAX_LIVE_OUTBOUND_CONTROLS = 4096;
export const MAX_LIVE_INBOUND_MESSAGES = 4096;
export const MAX_LIVE_INBOUND_BYTES = 128 * 1024 * 1024;
export const LIVE_LEASE_SECONDS = 300;
export const LIVE_HEARTBEAT_SECONDS = 15;
export const LIVE_RETRY_MIN_SECONDS = 1;
export const LIVE_RETRY_MAX_SECONDS = 30;
export const LIVE_SUBSCRIPTION_HEADER_BYTES = 4;
export const LIVE_CLOSE = {
    retryable: 4000,
    terminal: 4001,
    protocol: 4002,
    leaseExpiry: 4003,
    resynchronisation: 4004,
} as const;

export type LiveCloseCode = (typeof LIVE_CLOSE)[keyof typeof LIVE_CLOSE];

type LiveMode =
    "idle" | "connecting" | "open" | "reconnecting" | "suspended" | "stopped";

type Subscription = {
    id: number;
    form: HTMLFormElement;
    url: string;
    targets: string[];
};

export type LiveController = {
    reconcile(): void;
    retireForm(form: HTMLFormElement): void;
    restoreForm(form: HTMLFormElement): void;
    suspend(): void;
    resume(): void;
    stop(): void;
};

export type LiveControllerOptions = {
    endpoint?: string;
    disposed: () => boolean;
    validateContent?: ValidateContent;
};

function sameOrigin(url: URL) {
    return url.origin === location.origin;
}

function formIdlString(
    form: HTMLFormElement,
    name: "action" | "method" | "enctype",
) {
    const getter = Object.getOwnPropertyDescriptor(
        HTMLFormElement.prototype,
        name,
    )?.get;
    const value = getter?.call(form);
    return typeof value === "string" ? value : "";
}

function liveFormUrl(form: HTMLFormElement): URL | undefined {
    const method = formIdlString(form, "method").toLowerCase();
    const encoding = (
        form.getAttribute("enctype") ||
        formIdlString(form, "enctype") ||
        "application/x-www-form-urlencoded"
    ).toLowerCase();
    if (method !== "get" || encoding !== "application/x-www-form-urlencoded")
        return undefined;
    try {
        const url = new URL(formIdlString(form, "action"), document.baseURI);
        const data = new FormData(form);
        const parameters = new URLSearchParams();
        for (const [name, value] of data)
            parameters.append(
                name,
                typeof value === "string" ? value : value.name,
            );
        url.search = parameters.toString();
        if (!sameOrigin(url) || url.hash) return undefined;
        return url;
    } catch {
        return undefined;
    }
}

function localUrl(url: URL): string {
    return `${url.pathname}${url.search}`;
}

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).length;
}

function websocketUrl(path: string): string | undefined {
    try {
        const url = new URL(path, location.href);
        if (
            !sameOrigin(url) ||
            url.hash ||
            url.search ||
            url.username ||
            url.password
        )
            return undefined;
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        return url.href;
    } catch {
        return undefined;
    }
}

function reconnects(code: number): boolean {
    return (
        code === LIVE_CLOSE.retryable ||
        code === LIVE_CLOSE.leaseExpiry ||
        code === LIVE_CLOSE.resynchronisation ||
        code === 1006
    );
}

function retryDelay(attempt: number): number {
    const exponential = Math.min(
        LIVE_RETRY_MAX_SECONDS,
        LIVE_RETRY_MIN_SECONDS * 2 ** (attempt + 1),
    );
    const jittered = exponential * (0.5 + Math.random() * 0.5);
    return (
        Math.min(
            LIVE_RETRY_MAX_SECONDS,
            Math.max(LIVE_RETRY_MIN_SECONDS, jittered),
        ) * 1000
    );
}

function decodeFrame(buffer: ArrayBuffer): { id: number; text: string } {
    if (buffer.byteLength < LIVE_SUBSCRIPTION_HEADER_BYTES)
        throw new HypergraftError("protocol", "live frame header");
    const view = new DataView(buffer);
    const id = view.getUint32(0);
    if (id === 0) throw new HypergraftError("protocol", "live frame ID");
    try {
        return {
            id,
            text: new TextDecoder("utf-8", { fatal: true }).decode(
                buffer.slice(LIVE_SUBSCRIPTION_HEADER_BYTES),
            ),
        };
    } catch (error) {
        throw new HypergraftError(
            "utf-8",
            `Invalid Hypergraft live patch: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

export function createLiveController(
    options: LiveControllerOptions,
): LiveController {
    const endpoint = websocketUrl(options.endpoint ?? DEFAULT_LIVE_ENDPOINT);
    let generation = 0;
    let nextId = 0;
    let socket: WebSocket | null = null;
    let mode: LiveMode = "idle";
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    let outboundControls = 0;
    let inboundMessages = 0;
    let inboundBytes = 0;
    let reportedInvalidEndpoint = false;
    const subs = new Map<HTMLFormElement, Subscription>();
    const byId = new Map<number, Subscription>();
    const retiredForms = new Set<HTMLFormElement>();

    const clearRetry = () => {
        if (retryTimer !== undefined) clearTimeout(retryTimer);
        retryTimer = undefined;
    };

    const clearLease = () => {
        if (leaseTimer !== undefined) clearTimeout(leaseTimer);
        leaseTimer = undefined;
    };

    const clearIdentifiers = () => {
        byId.clear();
        for (const sub of subs.values()) sub.id = 0;
    };

    const closeSocket = (code: LiveCloseCode) => {
        const current = socket;
        if (!current) return;
        try {
            current.close(code);
        } catch {
            generation += 1;
            socket = null;
            clearLease();
            clearIdentifiers();
            mode = code === LIVE_CLOSE.protocol ? "stopped" : "idle";
        }
    };

    const reportSocketProtocol = (
        reason: "protocol" | "byte-limit" | "utf-8",
    ) => {
        emitDiagnostic({
            reason,
            requestKind: "patch",
            unsafe: false,
            url: endpoint ?? "",
        });
        closeSocket(LIVE_CLOSE.protocol);
    };

    const abandonSocket = () => {
        const current = socket;
        if (current?.readyState === WebSocket.OPEN)
            sendControl(JSON.stringify({ v: "1", type: "terminal" }));
        clearRetry();
        generation += 1;
        socket = null;
        clearLease();
        clearIdentifiers();
        try {
            current?.close();
        } catch {
            // The generation check keeps late events from a failed close inert.
        }
    };

    const releaseTargets = (sub: Subscription) => {
        sub.targets = [];
    };

    const sendControl = (message: string): boolean => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        if (utf8Bytes(message) > MAX_LIVE_CONTROL_BYTES) {
            reportSocketProtocol("byte-limit");
            return false;
        }
        if (outboundControls >= MAX_LIVE_OUTBOUND_CONTROLS) {
            closeSocket(LIVE_CLOSE.leaseExpiry);
            return false;
        }
        outboundControls += 1;
        try {
            socket.send(message);
            return true;
        } catch {
            closeSocket(LIVE_CLOSE.retryable);
            return false;
        }
    };

    const unsubscribe = (form: HTMLFormElement, notify: boolean) => {
        const sub = subs.get(form);
        if (!sub) return;
        subs.delete(form);
        byId.delete(sub.id);
        releaseTargets(sub);
        if (notify && sub.id !== 0)
            sendControl(
                JSON.stringify({
                    v: "1",
                    type: "unsubscribe",
                    id: sub.id,
                }),
            );
    };

    const sendSubscribe = (sub: Subscription) => {
        sendControl(
            JSON.stringify({
                v: "1",
                type: "subscribe",
                id: sub.id,
                url: sub.url,
            }),
        );
    };

    const assignAndSubscribe = (sub: Subscription) => {
        if (sub.id !== 0) byId.delete(sub.id);
        nextId += 1;
        sub.id = nextId;
        byId.set(sub.id, sub);
        sendSubscribe(sub);
    };

    const conflicts = (sub: Subscription, target: HTMLElement): boolean => {
        for (const other of subs.values()) {
            if (other === sub) continue;
            for (const targetId of other.targets) {
                const owned = document.getElementById(targetId);
                if (!owned) continue;
                if (
                    owned === target ||
                    owned.contains(target) ||
                    target.contains(owned)
                )
                    return true;
            }
        }
        return false;
    };

    const handlePatch = (sub: Subscription, text: string) => {
        let batch;
        try {
            batch = preflightLive(text, document, options.validateContent);
        } catch (error) {
            emitDiagnostic({
                reason:
                    error instanceof HypergraftError
                        ? error.reason
                        : "protocol",
                requestKind: "patch",
                unsafe: false,
                url: new URL(sub.url, location.href).href,
                element: sub.form,
                targetId:
                    error instanceof HypergraftError
                        ? error.targetId
                        : undefined,
            });
            unsubscribe(sub.form, true);
            return;
        }
        for (const patch of batch.patches) {
            if (conflicts(sub, patch.target)) {
                emitDiagnostic({
                    reason: "target-content",
                    requestKind: "patch",
                    unsafe: false,
                    url: new URL(sub.url, location.href).href,
                    element: sub.form,
                    targetId: patch.targetId,
                });
                unsubscribe(sub.form, true);
                return;
            }
        }
        try {
            apply(batch);
        } catch (error) {
            emitDiagnostic({
                reason: "apply-failure",
                requestKind: "patch",
                unsafe: false,
                url: new URL(sub.url, location.href).href,
                element: sub.form,
            });
            unsubscribe(sub.form, true);
            return;
        }
        retryAttempt = 0;
        const targetIds = batch.patches.map((patch) => patch.targetId);
        for (const targetId of targetIds)
            if (!sub.targets.includes(targetId)) sub.targets.push(targetId);
        emitLivePatch({
            form: sub.form,
            url: new URL(sub.url, location.href).href,
            targetIds,
        });
        reconcile();
    };

    const handleMessage = (event: MessageEvent, expectedGeneration: number) => {
        if (generation !== expectedGeneration || options.disposed()) return;
        const data = event.data;
        if (!(data instanceof ArrayBuffer)) {
            reportSocketProtocol("protocol");
            return;
        }
        const buffer = data;
        if (
            buffer.byteLength >
            MAX_RESPONSE_BYTES + LIVE_SUBSCRIPTION_HEADER_BYTES
        ) {
            reportSocketProtocol("byte-limit");
            return;
        }
        if (
            inboundMessages >= MAX_LIVE_INBOUND_MESSAGES ||
            inboundBytes + buffer.byteLength > MAX_LIVE_INBOUND_BYTES
        ) {
            closeSocket(LIVE_CLOSE.leaseExpiry);
            return;
        }
        inboundMessages += 1;
        inboundBytes += buffer.byteLength;
        let decoded: { id: number; text: string };
        try {
            decoded = decodeFrame(buffer);
        } catch (error) {
            const reason =
                error instanceof HypergraftError &&
                ["protocol", "byte-limit", "utf-8"].includes(error.reason)
                    ? (error.reason as "protocol" | "byte-limit" | "utf-8")
                    : "protocol";
            reportSocketProtocol(reason);
            return;
        }
        const sub = byId.get(decoded.id);
        if (!sub) return;
        handlePatch(sub, decoded.text);
    };

    const connect = () => {
        if (
            options.disposed() ||
            !endpoint ||
            mode === "stopped" ||
            mode === "suspended" ||
            subs.size === 0
        )
            return;
        if (
            socket &&
            (socket.readyState === WebSocket.OPEN ||
                socket.readyState === WebSocket.CONNECTING)
        )
            return;
        generation += 1;
        const expectedGeneration = generation;
        nextId = 0;
        outboundControls = 0;
        inboundMessages = 0;
        inboundBytes = 0;
        clearIdentifiers();
        let ws: WebSocket;
        try {
            ws = new WebSocket(endpoint, LIVE_SUBPROTOCOL);
        } catch {
            emitDiagnostic({
                reason: "transport",
                requestKind: "patch",
                unsafe: false,
                url: endpoint,
            });
            mode = "stopped";
            return;
        }
        ws.binaryType = "arraybuffer";
        socket = ws;
        mode = "connecting";
        ws.addEventListener("open", () => {
            if (generation !== expectedGeneration || socket !== ws) return;
            if (ws.protocol !== LIVE_SUBPROTOCOL || ws.extensions !== "") {
                reportSocketProtocol("protocol");
                return;
            }
            mode = "open";
            clearLease();
            leaseTimer = setTimeout(
                () => closeSocket(LIVE_CLOSE.leaseExpiry),
                LIVE_LEASE_SECONDS * 1000,
            );
            for (const sub of subs.values()) assignAndSubscribe(sub);
        });
        ws.addEventListener("message", (event) =>
            handleMessage(event, expectedGeneration),
        );
        ws.addEventListener("close", (event) => {
            if (generation !== expectedGeneration) return;
            socket = null;
            clearLease();
            clearIdentifiers();
            if (mode === "stopped" || mode === "suspended") return;
            if (reconnects(event.code)) {
                mode = "reconnecting";
                const delay = retryDelay(retryAttempt);
                retryAttempt += 1;
                clearRetry();
                retryTimer = setTimeout(() => {
                    retryTimer = undefined;
                    if (mode === "reconnecting") connect();
                }, delay);
                return;
            }
            mode = "stopped";
        });
    };

    const discover = (): HTMLFormElement[] => {
        const found = [
            ...document.querySelectorAll<HTMLFormElement>(
                "form[data-graft][data-graft-live]",
            ),
        ];
        const valid: HTMLFormElement[] = [];
        for (const form of found) {
            if (
                retiredForms.has(form) ||
                !form.isConnected ||
                form.ownerDocument !== document
            )
                continue;
            const url = liveFormUrl(form);
            if (!url || utf8Bytes(localUrl(url)) > MAX_LIVE_URL_BYTES) {
                emitDiagnostic({
                    reason: "invalid-live-form",
                    requestKind: "patch",
                    unsafe: false,
                    url: url?.href ?? "",
                    element: form,
                });
                continue;
            }
            if (valid.length >= MAX_LIVE_SUBSCRIPTIONS) {
                emitDiagnostic({
                    reason: "invalid-live-form",
                    requestKind: "patch",
                    unsafe: false,
                    url: url.href,
                    element: form,
                });
                continue;
            }
            valid.push(form);
        }
        return valid;
    };

    const reconcile = () => {
        if (options.disposed() || mode === "stopped" || mode === "suspended")
            return;
        const desired = discover();
        if (desired.length > 0 && !endpoint) {
            if (!reportedInvalidEndpoint) {
                reportedInvalidEndpoint = true;
                emitDiagnostic({
                    reason: "invalid-live-form",
                    requestKind: "patch",
                    unsafe: false,
                    url: options.endpoint ?? DEFAULT_LIVE_ENDPOINT,
                    element: desired[0],
                });
            }
            mode = "stopped";
            return;
        }
        const desiredSet = new Set(desired);
        for (const form of [...subs.keys()]) {
            const sub = subs.get(form);
            if (!sub) continue;
            const url = desiredSet.has(form) ? liveFormUrl(form) : undefined;
            if (!url || localUrl(url) !== sub.url) unsubscribe(form, true);
        }
        for (const form of desired) {
            if (subs.has(form)) continue;
            const url = liveFormUrl(form);
            if (!url) continue;
            const sub: Subscription = {
                id: 0,
                form,
                url: localUrl(url),
                targets: [],
            };
            subs.set(form, sub);
            if (mode === "open") assignAndSubscribe(sub);
        }
        if (subs.size === 0) {
            clearRetry();
            if (socket) abandonSocket();
            mode = "idle";
            return;
        }
        if (mode === "idle") connect();
    };

    const observer = new MutationObserver(() => reconcile());
    if (document.body)
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
                "data-graft",
                "data-graft-live",
                "action",
                "method",
                "enctype",
                "name",
                "value",
                "checked",
                "disabled",
                "selected",
                "type",
                "form",
            ],
        });

    return {
        reconcile,
        retireForm(form) {
            retiredForms.add(form);
            unsubscribe(form, true);
            if (subs.size === 0) {
                clearRetry();
                if (socket) abandonSocket();
                mode = "idle";
            }
        },
        restoreForm(form) {
            retiredForms.delete(form);
            reconcile();
        },
        suspend() {
            if (mode === "stopped" || mode === "suspended") return;
            clearRetry();
            abandonSocket();
            mode = "suspended";
        },
        resume() {
            if (mode !== "suspended") return;
            mode = "idle";
            retryAttempt = 0;
            reconcile();
        },
        stop() {
            mode = "stopped";
            clearRetry();
            observer.disconnect();
            abandonSocket();
            for (const form of [...subs.keys()]) unsubscribe(form, false);
            byId.clear();
            retiredForms.clear();
        },
    };
}

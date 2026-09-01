import {
    emitDiagnostic,
    HypergraftError,
    type DiagnosticReason,
} from "./diagnostics";
import {
    emitLocationChange,
    emitProgress,
    emitRequestSettled,
    type RequestSettledDetail,
} from "./events";
import { observeIslands, type IslandInitialiser } from "./islands";
import {
    apply,
    MAX_RESPONSE_BYTES,
    MEDIA_TYPE,
    PATCH_STATUSES,
    preflight,
    preflightFrame,
    transferKind,
    type PreparedBatch,
    type PreparedResponse,
    type ValidateContent,
} from "./patches";
import { readStreamFrames } from "./stream";
import {
    createLiveController,
    DEFAULT_LIVE_ENDPOINT,
    type LiveController,
} from "./live";

type SafeFormSource = "submission" | "refresh";
type Lane = {
    controller?: AbortController;
    sequence: number;
    error: boolean;
    cancelPending?: () => void;
    active?: { form: HTMLFormElement; source: SafeFormSource };
};
type UnsafeState =
    | { kind: "idle" }
    | { kind: "pending"; form: HTMLFormElement }
    | { kind: "uncertain"; form: HTMLFormElement };
// The unsafe guard is document-level: an in-flight or uncertain POST is not
// cancelled by tearing the runtime down, and a replacement runtime must not
// unlock it.
let documentUnsafe: UnsafeState = { kind: "idle" };
let activeRuntime: Runtime | undefined;

type Runtime = {
    disposed: boolean;
    options: HypergraftOptions;
    navigationLane: Lane;
    formLanes: WeakMap<HTMLFormElement, Lane>;
    activeSafeFormLanes: Set<Lane>;
    failedSafeForms: Set<HTMLFormElement>;
    liveTimers: Map<HTMLElement, ReturnType<typeof setTimeout>>;
    composing: boolean;
    navigationPending: boolean;
    queuedHistoryUrl: URL | undefined;
    queuedRefreshForms: Set<HTMLFormElement>;
    detachListeners: () => void;
    stopIslands: () => void;
    live: LiveController;
};

export interface TransportFeedback {
    safeFailure(): void;
    safeRecovery(): void;
    uncertainUnsafeOutcome(): void;
}

export interface HypergraftOptions {
    validateContent?: ValidateContent;
    feedback?: TransportFeedback;
    islands?: Record<string, IslandInitialiser>;
    liveEndpoint?: string;
}

function pruneFailedSafeForms(runtime: Runtime): boolean {
    const hadFailures = runtime.failedSafeForms.size > 0;
    for (const form of runtime.failedSafeForms) {
        if (!form.isConnected) runtime.failedSafeForms.delete(form);
    }
    return hadFailures && runtime.failedSafeForms.size === 0;
}
function showError(runtime: Runtime, lane: Lane, form: HTMLFormElement) {
    if (runtime.disposed) return;
    lane.error = true;
    runtime.failedSafeForms.add(form);
    // Every failure presents again, including a repeat after dismissal.
    runtime.options.feedback?.safeFailure();
}
function showUncertain(runtime: Runtime) {
    if (runtime.disposed) return;
    runtime.options.feedback?.uncertainUnsafeOutcome();
}
function clearError(runtime: Runtime, lane: Lane, form: HTMLFormElement) {
    if (runtime.disposed) return;
    const hadFailures = runtime.failedSafeForms.size > 0;
    if (lane.error) {
        lane.error = false;
        runtime.failedSafeForms.delete(form);
    }
    pruneFailedSafeForms(runtime);
    if (hadFailures && runtime.failedSafeForms.size === 0)
        runtime.options.feedback?.safeRecovery();
}
function clearAllSafeErrors(runtime: Runtime) {
    if (runtime.disposed || runtime.failedSafeForms.size === 0) return;
    runtime.failedSafeForms.clear();
    runtime.options.feedback?.safeRecovery();
}

function sameOrigin(url: URL) {
    return url.origin === location.origin;
}
function supportedLink(event: MouseEvent, link: HTMLAnchorElement) {
    return (
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !link.download &&
        (!link.target || link.target === "_self")
    );
}
function submitterControl(submitter?: HTMLElement | null) {
    return submitter instanceof HTMLButtonElement ||
        submitter instanceof HTMLInputElement
        ? submitter
        : undefined;
}
// Named controls shadow HTMLFormElement IDL attributes. Read the prototype
// getters so a field named "action" or "method" cannot replace the form URL.
function formIdlString(
    form: HTMLFormElement,
    name: "action" | "method" | "enctype",
): string {
    const getter = Object.getOwnPropertyDescriptor(
        HTMLFormElement.prototype,
        name,
    )?.get;
    const value = getter?.call(form);
    return typeof value === "string" ? value : "";
}
function effectiveFormValues(
    form: HTMLFormElement,
    submitter?: HTMLElement | null,
) {
    const button = submitterControl(submitter);
    return {
        button,
        action:
            button?.getAttribute("formaction") || formIdlString(form, "action"),
        method: (
            button?.getAttribute("formmethod") || formIdlString(form, "method")
        ).toLowerCase(),
        encoding: (
            button?.getAttribute("formenctype") ||
            form.getAttribute("enctype") ||
            formIdlString(form, "enctype") ||
            "application/x-www-form-urlencoded"
        ).toLowerCase(),
    };
}
function getFormUrl(form: HTMLFormElement, submitter?: HTMLElement | null) {
    const values = effectiveFormValues(form, submitter);
    const url = new URL(values.action, document.baseURI);
    const data = new FormData(form, values.button);
    const parameters = new URLSearchParams();
    for (const [name, value] of data)
        parameters.append(name, typeof value === "string" ? value : value.name);
    url.search = parameters.toString();
    return url;
}
function isRefreshForm(form: HTMLFormElement): boolean {
    if (
        !(form instanceof HTMLFormElement) ||
        form.ownerDocument !== document ||
        !form.isConnected ||
        !form.hasAttribute("data-graft")
    )
        return false;
    const values = effectiveFormValues(form);
    if (
        values.method !== "get" ||
        values.encoding !== "application/x-www-form-urlencoded"
    )
        return false;
    try {
        const url = new URL(values.action, document.baseURI);
        return sameOrigin(url) && !url.hash;
    } catch {
        return false;
    }
}
function preparePost(form: HTMLFormElement, submitter?: HTMLElement | null) {
    const values = effectiveFormValues(form, submitter);
    if (
        values.method !== "post" ||
        values.encoding !== "application/x-www-form-urlencoded"
    )
        return undefined;
    const url = new URL(values.action, document.baseURI);
    if (!sameOrigin(url)) return undefined;
    if (
        [...form.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(
            (input) => (input.files?.length ?? 0) > 0,
        )
    )
        return undefined;
    if (url.hash) return undefined;
    const data = new FormData(form, values.button);
    const body = new URLSearchParams();
    for (const [name, value] of data) {
        if (typeof value !== "string") {
            if (value.name || value.size) return undefined;
            body.append(name, "");
            continue;
        }
        body.append(name, value);
    }
    return { url, body, submitter: values.button };
}

export async function readBoundedResponse(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (
        declared &&
        /^\d+$/.test(declared) &&
        Number(declared) > MAX_RESPONSE_BYTES
    )
        throw new HypergraftError(
            "byte-limit",
            "Hypergraft response byte limit exceeded",
        );
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
        while (true) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (error) {
                throw new HypergraftError(
                    "transport",
                    `Hypergraft response stream failed: ${errorMessage(error)}`,
                );
            }
            const { done, value } = chunk;
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
                try {
                    await reader.cancel();
                } catch {
                    // Cancellation failure must not hide the byte-limit fact.
                }
                throw new HypergraftError(
                    "byte-limit",
                    "Hypergraft response byte limit exceeded",
                );
            }
            try {
                text += decoder.decode(value, { stream: true });
            } catch (error) {
                throw new HypergraftError(
                    "utf-8",
                    `Invalid Hypergraft response: invalid UTF-8 (${errorMessage(error)})`,
                );
            }
        }
        try {
            return text + decoder.decode();
        } catch (error) {
            throw new HypergraftError(
                "utf-8",
                `Invalid Hypergraft response: invalid UTF-8 (${errorMessage(error)})`,
            );
        }
    } finally {
        reader.releaseLock();
    }
}

type ConsumeOutcome =
    | { kind: "navigation"; destination: string }
    | {
          kind: "applied";
          settlement: AppliedSettlement;
          replaceLocation?: string;
      }
    | { kind: "stale" };

async function consumeEnhanced(
    runtime: Runtime,
    response: Response,
    isStale: () => boolean,
    allowLocationReplacement: boolean,
    onProgress?: (batch: PreparedBatch, frame: number) => void,
): Promise<ConsumeOutcome> {
    let transfer: "complete" | "stream";
    try {
        transfer = transferKind(response);
    } catch (error) {
        throw tagStatus(error, response.status);
    }
    if (transfer === "complete") {
        const text = await readBoundedResponse(response);
        if (isStale()) return { kind: "stale" };
        let prepared: PreparedResponse;
        try {
            prepared = preflight(
                response,
                text,
                document,
                runtime.options.validateContent,
            );
        } catch (error) {
            throw tagStatus(error, response.status);
        }
        if (isStale()) return { kind: "stale" };
        if (prepared.kind === "navigation")
            return { kind: "navigation", destination: prepared.destination };
        if (prepared.batch.replaceLocation && !allowLocationReplacement)
            throw tagStatus(
                new HypergraftError(
                    "protocol",
                    "Safe patch cannot replace the browser location",
                ),
                response.status,
            );
        try {
            apply(prepared.batch);
        } catch (error) {
            throw tagStatus(
                new HypergraftError("apply-failure", errorMessage(error)),
                response.status,
            );
        }
        return {
            kind: "applied",
            settlement: {
                outcome: "applied-patch",
                status: acceptedStatus(response.status) ?? 200,
                targetIds: prepared.batch.patches.map(
                    (patch) => patch.targetId,
                ),
            },
            replaceLocation: prepared.batch.replaceLocation,
        };
    }
    if (response.status !== 200)
        throw tagStatus(
            new HypergraftError("protocol", "status"),
            response.status,
        );
    if (response.headers.get("content-type") !== MEDIA_TYPE)
        throw tagStatus(
            new HypergraftError("protocol", "media type"),
            response.status,
        );
    let sawFinal = false;
    let settlement: AppliedSettlement | undefined;
    let frame = 0;
    try {
        for await (const text of readStreamFrames(response)) {
            if (isStale()) return { kind: "stale" };
            if (sawFinal)
                throw new HypergraftError("protocol", "data after final frame");
            const prepared = preflightFrame(
                text,
                document,
                runtime.options.validateContent,
            );
            try {
                apply(prepared.batch);
            } catch (error) {
                throw new HypergraftError("apply-failure", errorMessage(error));
            }
            frame += 1;
            if (prepared.phase === "progress") {
                onProgress?.(prepared.batch, frame);
                continue;
            }
            sawFinal = true;
            settlement = {
                outcome: "applied-patch",
                status: prepared.status,
                targetIds: prepared.batch.patches.map(
                    (patch) => patch.targetId,
                ),
            };
        }
    } catch (error) {
        throw error;
    }
    if (isStale()) return { kind: "stale" };
    if (!sawFinal || !settlement)
        throw new HypergraftError("protocol", "incomplete stream");
    return { kind: "applied", settlement };
}

// Safe GET requests settle into exactly one of three states: a complete
// preflighted batch was applied, the request was superseded or aborted
// before it could settle, or a same-origin redirect or navigation envelope
// handed the document over to full navigation. The three states are not
// interchangeable; callers must never infer one from the absence of another.
type SafeOutcome =
    | { kind: "applied"; url: string; settlement: AppliedSettlement }
    | { kind: "stale" }
    | { kind: "handed-off" };

type AcceptedStatus = (typeof PATCH_STATUSES)[number];
type Settlement = RequestSettledDetail extends infer Detail
    ? Detail extends RequestSettledDetail
        ? Omit<Detail, "requestKind" | "form" | "url">
        : never
    : never;
type AppliedSettlement = Extract<Settlement, { outcome: "applied-patch" }>;
type FailedSettlement = Exclude<Settlement, AppliedSettlement>;

/** A status is trustworthy for settlement only when the server used a
 * protocol-accepted patch status; transport failures carry none. */
function acceptedStatus(value: unknown): AcceptedStatus | undefined {
    return typeof value === "number" &&
        (PATCH_STATUSES as readonly number[]).includes(value)
        ? (value as AcceptedStatus)
        : undefined;
}

const RESPONSE_FAILURE = Symbol("response-failure");
type ResponseFailure = {
    [RESPONSE_FAILURE]: true;
    cause: unknown;
    status: number;
};

/** Keep received-response metadata separate from arbitrary thrown values. */
function tagStatus(cause: unknown, status: number): ResponseFailure {
    return { [RESPONSE_FAILURE]: true, cause, status };
}
function responseFailure(error: unknown): ResponseFailure | undefined {
    return typeof error === "object" &&
        error !== null &&
        RESPONSE_FAILURE in error
        ? (error as ResponseFailure)
        : undefined;
}
function errorName(error: unknown): string | undefined {
    const cause = responseFailure(error)?.cause ?? error;
    return typeof cause === "object" && cause !== null && "name" in cause
        ? String((cause as { name: unknown }).name)
        : undefined;
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
function hypergraftFailure(error: unknown): HypergraftError | undefined {
    const cause = responseFailure(error)?.cause ?? error;
    return cause instanceof HypergraftError ? cause : undefined;
}
function diagnosticReason(
    error: unknown,
): Exclude<DiagnosticReason, "unknown-island" | "invalid-feedback"> {
    return hypergraftFailure(error)?.reason ?? "transport";
}
function diagnosticTargetId(error: unknown): string | undefined {
    return hypergraftFailure(error)?.targetId;
}

async function safeRequest(
    runtime: Runtime,
    url: URL,
    kind: "navigation" | "patch",
    lane: Lane,
    sequence: number,
    responseUrl?: { current?: string },
    failedForm?: HTMLFormElement,
): Promise<SafeOutcome> {
    let response: Response;
    try {
        response = await fetch(url, {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "manual",
            signal: lane.controller?.signal,
            headers: { "Graft-Request": kind, Accept: MEDIA_TYPE },
        });
    } catch (error) {
        // Expected aborts stay AbortError so callers skip diagnostics and
        // settlement; every other transport failure carries a typed reason.
        if (errorName(error) === "AbortError") throw error;
        throw new HypergraftError(
            "transport",
            `Hypergraft request transport failed: ${errorMessage(error)}`,
        );
    }
    if (responseUrl) responseUrl.current = response.url || url.href;
    // An abort does not guarantee that a mocked or already-resolved fetch
    // rejects. Check the lane before following any response redirect.
    if (runtime.disposed || lane.sequence !== sequence)
        return { kind: "stale" };
    if (
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
    ) {
        const locationHeader = response.headers.get("location");
        if (!locationHeader)
            throw new HypergraftError("redirect", "Unusable redirect");
        let destination: URL;
        try {
            destination = new URL(locationHeader, response.url || url);
        } catch (error) {
            throw new HypergraftError(
                "redirect",
                `Unusable redirect: ${errorMessage(error)}`,
            );
        }
        if (!sameOrigin(destination))
            throw new HypergraftError("redirect", "Cross-origin redirect");
        window.location.assign(destination.href);
        return { kind: "handed-off" };
    }
    const consumed = await consumeEnhanced(
        runtime,
        response,
        () => runtime.disposed || lane.sequence !== sequence,
        false,
        failedForm
            ? (batch, frame) => {
                  failedForm.setAttribute("data-graft-progress", "");
                  emitProgress({
                      requestKind: "patch",
                      form: failedForm,
                      url: response.url || url.href,
                      frame,
                      targetIds: batch.patches.map((patch) => patch.targetId),
                  });
              }
            : undefined,
    );
    if (consumed.kind === "stale") return { kind: "stale" };
    if (consumed.kind === "navigation") {
        window.location.assign(consumed.destination);
        return { kind: "handed-off" };
    }
    if (failedForm) clearError(runtime, lane, failedForm);
    else if (pruneFailedSafeForms(runtime))
        runtime.options.feedback?.safeRecovery();
    return {
        kind: "applied",
        url: response.url || url.href,
        settlement: consumed.settlement,
    };
}

function queueRefresh(runtime: Runtime, form: HTMLFormElement): void {
    if (runtime.disposed || !isRefreshForm(form)) return;
    if (documentUnsafe.kind === "uncertain") return;
    runtime.queuedRefreshForms.add(form);
}

function drainQueuedRefreshes(runtime: Runtime): void {
    if (
        runtime.disposed ||
        runtime.navigationPending ||
        documentUnsafe.kind !== "idle"
    )
        return;
    for (const form of [...runtime.queuedRefreshForms]) {
        if (!isRefreshForm(form)) {
            runtime.queuedRefreshForms.delete(form);
            continue;
        }
        if (runtime.formLanes.get(form)?.active) continue;
        runtime.queuedRefreshForms.delete(form);
        void submitSafe(runtime, form, undefined, "refresh");
    }
}

function cancelActiveSafeForms(runtime: Runtime, retainRefreshes = false) {
    for (const lane of runtime.activeSafeFormLanes) {
        if (retainRefreshes && lane.active?.source === "refresh")
            queueRefresh(runtime, lane.active.form);
        ++lane.sequence;
        lane.controller?.abort();
        lane.cancelPending?.();
        lane.cancelPending = undefined;
        lane.active = undefined;
    }
    runtime.activeSafeFormLanes.clear();
}

function clearLiveTimers(runtime: Runtime) {
    for (const timer of runtime.liveTimers.values()) clearTimeout(timer);
    runtime.liveTimers.clear();
}

async function navigate(
    runtime: Runtime,
    url: URL,
    mode: "push" | "pop" = "push",
    element?: HTMLElement,
) {
    if (
        runtime.disposed ||
        documentUnsafe.kind !== "idle" ||
        (runtime.navigationPending && mode !== "pop")
    )
        return;
    runtime.navigationPending = true;
    cancelActiveSafeForms(runtime, true);
    runtime.live.suspend();
    const sequence = ++runtime.navigationLane.sequence;
    runtime.navigationLane.controller?.abort();
    runtime.navigationLane.controller = new AbortController();
    const responseUrl: { current?: string } = {};
    let refreshDisposition: "retain" | "drain" | "discard" = "retain";
    try {
        const result = await safeRequest(
            runtime,
            url,
            "navigation",
            runtime.navigationLane,
            sequence,
            responseUrl,
        );
        if (
            runtime.disposed ||
            result.kind === "stale" ||
            sequence !== runtime.navigationLane.sequence
        )
            return;
        if (result.kind === "handed-off") {
            refreshDisposition = "discard";
            return;
        }
        if (mode === "push")
            history.pushState({ hypergraft: true }, "", result.url);
        emitLocationChange({
            url: location.href,
            cause: mode === "pop" ? "history-traversal" : "link-navigation",
        });
        // A successful page replacement is authoritative for the whole
        // page; failures whose forms disappeared must not survive it.
        clearAllSafeErrors(runtime);
        // Version 1 does not restore history scroll positions. After a
        // children patch the previous offset belongs to different content.
        const firstTarget = result.settlement.targetIds[0];
        const focusRoot = firstTarget
            ? document.getElementById(firstTarget)
            : null;
        if (focusRoot && typeof focusRoot.focus === "function") {
            try {
                focusRoot.focus();
            } catch {
                // A target that cannot take programmatic focus stays native.
            }
        }
        window.scrollTo(0, 0);
        runtime.live.resume();
        refreshDisposition = "drain";
    } catch (error) {
        if (
            errorName(error) === "AbortError" ||
            runtime.disposed ||
            sequence !== runtime.navigationLane.sequence
        )
            return;
        emitDiagnostic({
            reason: diagnosticReason(error),
            requestKind: "navigation",
            unsafe: false,
            url: responseUrl.current ?? url.href,
            element,
            targetId: diagnosticTargetId(error),
        });
        refreshDisposition = "discard";
        if (mode === "push") location.assign(url.href);
        else location.reload();
    } finally {
        if (sequence === runtime.navigationLane.sequence) {
            runtime.navigationPending = false;
            if (refreshDisposition === "discard")
                runtime.queuedRefreshForms.clear();
            else if (refreshDisposition === "drain")
                drainQueuedRefreshes(runtime);
        }
    }
}

function pendingState(
    form: HTMLFormElement,
    submitter?: HTMLButtonElement | HTMLInputElement,
) {
    const oldBusy = form.getAttribute("aria-busy");
    const hadPending = form.hasAttribute("data-graft-pending");
    const oldDisabled = submitter?.disabled;
    const oldAriaDisabled = submitter?.getAttribute("aria-disabled") ?? null;
    const hadSubmitterPending =
        submitter?.hasAttribute("data-graft-submitter-pending") ?? false;
    let restored = false;
    form.setAttribute("aria-busy", "true");
    form.setAttribute("data-graft-pending", "");
    if (submitter) {
        submitter.disabled = true;
        submitter.setAttribute("aria-disabled", "true");
        submitter.setAttribute("data-graft-submitter-pending", "");
    }
    return () => {
        if (restored) return;
        restored = true;
        oldBusy === null
            ? form.removeAttribute("aria-busy")
            : form.setAttribute("aria-busy", oldBusy);
        if (!hadPending) form.removeAttribute("data-graft-pending");
        form.removeAttribute("data-graft-progress");
        if (!submitter?.isConnected) return;
        submitter.disabled = oldDisabled ?? false;
        oldAriaDisabled === null
            ? submitter.removeAttribute("aria-disabled")
            : submitter.setAttribute("aria-disabled", oldAriaDisabled);
        if (!hadSubmitterPending)
            submitter.removeAttribute("data-graft-submitter-pending");
    };
}

async function submitSafe(
    runtime: Runtime,
    form: HTMLFormElement,
    submitter?: HTMLElement | null,
    source: SafeFormSource = "submission",
) {
    if (runtime.disposed || !form.isConnected) return;
    if (source === "refresh" && !isRefreshForm(form)) {
        runtime.queuedRefreshForms.delete(form);
        return;
    }
    if (documentUnsafe.kind !== "idle" || runtime.navigationPending) {
        if (source === "refresh") queueRefresh(runtime, form);
        return;
    }
    const url = getFormUrl(form, submitter);
    if (source === "submission" && form.hasAttribute("data-graft-live"))
        runtime.live.retireForm(form);
    const button = submitterControl(submitter);
    const lane = runtime.formLanes.get(form) ?? { sequence: 0, error: false };
    runtime.formLanes.set(form, lane);
    const sequence = ++lane.sequence;
    lane.controller?.abort();
    // A replacement request owns a fresh pending snapshot. Restore the old
    // one before taking it, otherwise the replacement can preserve a stale
    // data-graft-pending attribute indefinitely.
    lane.cancelPending?.();
    lane.cancelPending = undefined;
    lane.controller = new AbortController();
    lane.active = { form, source };
    runtime.activeSafeFormLanes.add(lane);
    const restorePending = pendingState(form, button);
    lane.cancelPending = restorePending;
    // The effective request URL: the response URL once a response was
    // received, otherwise the attempted request URL.
    const responseUrl: { current?: string } = {};
    // Applied only when a batch actually settled this sequence; a failure
    // records only the outcome and the status of a received unparseable
    // response. Superseded requests and navigation hand-offs emit nothing.
    let settlement: Settlement | undefined;
    let drainRefreshes = false;
    try {
        const result = await safeRequest(
            runtime,
            url,
            "patch",
            lane,
            sequence,
            responseUrl,
            form,
        );
        if (result.kind === "applied") {
            settlement = result.settlement;
            responseUrl.current = result.url;
            if (source === "submission") {
                history.replaceState({ hypergraft: true }, "", result.url);
                emitLocationChange({
                    url: location.href,
                    cause: "get-form-replacement",
                });
            }
            drainRefreshes = true;
        } else if (result.kind === "handed-off") {
            runtime.queuedRefreshForms.clear();
        }
    } catch (error) {
        if (
            !runtime.disposed &&
            errorName(error) !== "AbortError" &&
            sequence === lane.sequence
        ) {
            emitDiagnostic({
                reason: diagnosticReason(error),
                requestKind: "patch",
                unsafe: false,
                url: responseUrl.current ?? url.href,
                element: form,
                targetId: diagnosticTargetId(error),
            });
            showError(runtime, lane, form);
            const status = acceptedStatus(responseFailure(error)?.status);
            settlement =
                status === undefined
                    ? { outcome: "safe-failure" }
                    : { outcome: "safe-failure", status };
            drainRefreshes = true;
        }
    } finally {
        // An older request for this form must not clear the replacement's
        // active-lane registration or pending-state cleanup callback.
        if (!runtime.disposed && sequence === lane.sequence) {
            runtime.activeSafeFormLanes.delete(lane);
            lane.cancelPending = undefined;
            lane.active = undefined;
            if (settlement) {
                // Pending state is final before lifecycle observers reconcile
                // retained roots, so restore the form and submitter first.
                restorePending();
                emitRequestSettled({
                    requestKind: "patch",
                    form,
                    url: responseUrl.current ?? url.href,
                    ...settlement,
                });
            }
            if (drainRefreshes) drainQueuedRefreshes(runtime);
            runtime.live.restoreForm(form);
        }
    }
}

// Unsafe submissions settle into exactly one of three states: a complete
// preflighted batch was applied, the outcome is uncertain because nothing
// authoritative was applied and the global lock remains, or a valid
// navigation envelope handed the document over to full navigation.
type UnsafeOutcome =
    | {
          kind: "applied";
          settlement: AppliedSettlement;
          url: string;
          replaceLocation?: string;
      }
    | {
          kind: "uncertain";
          settlement: FailedSettlement;
          url: string;
          reason: Exclude<
              DiagnosticReason,
              "unknown-island" | "invalid-feedback"
          >;
          targetId?: string;
      }
    | { kind: "handed-off" };

function uncertainSettlement(status?: AcceptedStatus): FailedSettlement {
    return status === undefined
        ? { outcome: "uncertain-unsafe-result" }
        : { outcome: "uncertain-unsafe-result", status };
}

async function unsafeRequest(
    runtime: Runtime,
    form: HTMLFormElement,
    request: {
        url: URL;
        body: URLSearchParams;
    },
): Promise<UnsafeOutcome> {
    let response: Response;
    try {
        response = await fetch(request.url, {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "manual",
            headers: {
                "Graft-Request": "patch",
                Accept: MEDIA_TYPE,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: request.body,
        });
    } catch {
        return {
            kind: "uncertain",
            settlement: uncertainSettlement(),
            url: request.url.href,
            reason: "transport",
        };
    }
    const responseUrl = response.url || request.url.href;
    const failure = (error: unknown): UnsafeOutcome => ({
        kind: "uncertain",
        settlement: uncertainSettlement(
            acceptedStatus(responseFailure(error)?.status),
        ),
        url: responseUrl,
        reason: diagnosticReason(error),
        targetId: diagnosticTargetId(error),
    });
    if (
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
    )
        return failure(new HypergraftError("redirect", "Unusable redirect"));
    let consumed: ConsumeOutcome;
    try {
        consumed = await consumeEnhanced(
            runtime,
            response,
            () => runtime.disposed,
            true,
            (batch, frame) => {
                form.setAttribute("data-graft-progress", "");
                emitProgress({
                    requestKind: "patch",
                    form,
                    url: responseUrl,
                    frame,
                    targetIds: batch.patches.map((patch) => patch.targetId),
                });
            },
        );
    } catch (error) {
        return failure(error);
    }
    if (consumed.kind === "stale") {
        return {
            kind: "uncertain",
            settlement: uncertainSettlement(),
            url: responseUrl,
            reason: "transport",
        };
    }
    if (consumed.kind === "navigation") {
        window.location.assign(consumed.destination);
        return { kind: "handed-off" };
    }
    return {
        kind: "applied",
        settlement: consumed.settlement,
        url: responseUrl,
        replaceLocation: consumed.replaceLocation,
    };
}

async function submitUnsafe(
    runtime: Runtime,
    form: HTMLFormElement,
    prepared: {
        url: URL;
        body: URLSearchParams;
        submitter?: HTMLButtonElement | HTMLInputElement;
    },
) {
    if (
        runtime.disposed ||
        documentUnsafe.kind !== "idle" ||
        runtime.navigationPending
    )
        return;
    cancelActiveSafeForms(runtime, true);
    runtime.live.suspend();
    documentUnsafe = { kind: "pending", form };
    const restorePending = pendingState(form, prepared.submitter);
    const outcome = await unsafeRequest(runtime, form, prepared);
    if (runtime.disposed) {
        restorePending();
        // The command may have reached the server, but a disposed runtime
        // cannot apply or report its response. Reload authoritative state
        // rather than leaving a replacement runtime silently locked.
        documentUnsafe = { kind: "uncertain", form };
        location.reload();
        return;
    }
    if (outcome.kind === "handed-off") {
        runtime.queuedRefreshForms.clear();
        restorePending();
        return;
    }
    if (outcome.kind === "uncertain") {
        runtime.queuedRefreshForms.clear();
        documentUnsafe = { kind: "uncertain", form };
        form.setAttribute("data-graft-uncertain", "");
        // Mark uncertainty before restoring pending state, then request host
        // feedback before observers receive the final settlement fact.
        restorePending();
        emitDiagnostic({
            reason: outcome.reason,
            requestKind: "patch",
            unsafe: true,
            url: outcome.url,
            element: form,
            targetId: outcome.targetId,
        });
        showUncertain(runtime);
    } else {
        // Known patches release the global lane before pending state is
        // restored, as both facts must be final before settlement.
        documentUnsafe = { kind: "idle" };
        if (outcome.replaceLocation && !runtime.queuedHistoryUrl) {
            history.replaceState(
                { ...(history.state ?? {}), hypergraft: true },
                "",
                outcome.replaceLocation,
            );
            emitLocationChange({
                url: location.href,
                cause: "command-patch-replacement",
            });
        }
        restorePending();
    }
    emitRequestSettled({
        requestKind: "patch",
        form,
        url: outcome.url,
        ...outcome.settlement,
    });
    // A queued history destination is serviced only after settlement.
    if (outcome.kind === "applied" && runtime.queuedHistoryUrl) {
        const historyUrl = runtime.queuedHistoryUrl;
        runtime.queuedHistoryUrl = undefined;
        void navigate(runtime, historyUrl, "pop");
    } else if (outcome.kind === "applied") {
        runtime.live.resume();
        drainQueuedRefreshes(runtime);
    }
}

function referencedSubmitter(
    control: HTMLElement,
    form: HTMLFormElement,
): HTMLElement | undefined {
    const id = control.dataset.graftSubmitWith;
    if (!id) return undefined;
    const escapedId = id.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const matches = document.querySelectorAll<HTMLElement>(
        `[id="${escapedId}"]`,
    );
    if (matches.length !== 1) return undefined;
    const submitter = submitterControl(matches[0]);
    if (!submitter || ![...form.elements].includes(submitter)) return undefined;
    if (submitter instanceof HTMLButtonElement)
        return !["button", "reset"].includes(submitter.type)
            ? submitter
            : undefined;
    return ["submit", "image"].includes(submitter.type) ? submitter : undefined;
}

function handleLiveEvent(runtime: Runtime, event: Event) {
    const control = (event.target as Element).closest<HTMLElement>(
        "[data-graft-submit-on]",
    );
    if (
        runtime.disposed ||
        !control ||
        control.dataset.graftSubmitOn !== event.type ||
        runtime.composing
    )
        return;
    const form = control.closest("form[data-graft]") as HTMLFormElement | null;
    const delayText = control.dataset.graftDebounce ?? "0";
    const hasReference = control.hasAttribute("data-graft-submit-with");
    const submitter =
        form && hasReference ? referencedSubmitter(control, form) : undefined;
    const values = form ? effectiveFormValues(form, submitter) : undefined;
    let url: URL | undefined;
    try {
        if (values) url = new URL(values.action, document.baseURI);
    } catch {
        url = undefined;
    }
    if (
        !form ||
        (hasReference && !submitter) ||
        values?.method !== "get" ||
        values.encoding !== "application/x-www-form-urlencoded" ||
        !url ||
        url.hash ||
        !sameOrigin(url) ||
        !/^[0-9]+$/.test(delayText) ||
        Number(delayText) > 2000 ||
        !["input", "change"].includes(event.type)
    ) {
        emitDiagnostic({
            reason: "invalid-live-form",
            requestKind: "patch",
            unsafe: false,
            url: url?.href ?? "",
            element: control,
        });
        return;
    }
    const previous = runtime.liveTimers.get(control);
    if (previous) clearTimeout(previous);
    runtime.liveTimers.set(
        control,
        setTimeout(() => {
            runtime.liveTimers.delete(control);
            void submitSafe(runtime, form, submitter);
        }, Number(delayText)),
    );
}

function disposeRuntime(runtime: Runtime, replacement: boolean) {
    if (runtime.disposed) return;
    runtime.stopIslands();
    runtime.stopIslands = () => undefined;
    // Intentional teardown clears feedback synchronously; later responses
    // must not call options owned by the disposed runtime.
    clearAllSafeErrors(runtime);
    runtime.disposed = true;
    runtime.live.stop();
    runtime.detachListeners();
    clearLiveTimers(runtime);
    runtime.navigationLane.sequence += 1;
    runtime.navigationLane.controller?.abort();
    runtime.navigationPending = false;
    runtime.queuedHistoryUrl = undefined;
    runtime.queuedRefreshForms.clear();
    cancelActiveSafeForms(runtime);
    runtime.options = {};
    // A replacement inherits the document-level unsafe guard. A final stop
    // removes interception, so reload before a native POST can bypass it.
    if (!replacement && documentUnsafe.kind !== "idle") location.reload();
}

function createRuntime(options: HypergraftOptions): Runtime {
    const runtime: Runtime = {
        disposed: false,
        options,
        navigationLane: { sequence: 0, error: false },
        formLanes: new WeakMap(),
        activeSafeFormLanes: new Set(),
        failedSafeForms: new Set(),
        liveTimers: new Map(),
        composing: false,
        navigationPending: false,
        queuedHistoryUrl: undefined,
        queuedRefreshForms: new Set(),
        detachListeners: () => undefined,
        stopIslands: () => undefined,
        live: {
            reconcile() {},
            retireForm() {},
            restoreForm() {},
            suspend() {},
            resume() {},
            stop() {},
        },
    };
    runtime.live = createLiveController({
        endpoint: options.liveEndpoint ?? DEFAULT_LIVE_ENDPOINT,
        disposed: () => runtime.disposed,
        validateContent: options.validateContent,
    });
    history.replaceState({ ...(history.state ?? {}), hypergraft: true }, "");
    const onClick = (event: MouseEvent) => {
        if (runtime.disposed || event.defaultPrevented) return;
        const link = (event.target as Element).closest(
            "a[data-graft]",
        ) as HTMLAnchorElement | null;
        if (!link || !supportedLink(event, link)) return;
        const url = new URL(link.href);
        if (!sameOrigin(url) || url.hash) return;
        event.preventDefault();
        void navigate(runtime, url, "push", link);
    };
    const onSubmit = (event: SubmitEvent) => {
        if (runtime.disposed || event.defaultPrevented) return;
        const form = event.target as HTMLFormElement;
        if (!form.matches("form[data-graft]")) return;
        const values = effectiveFormValues(form, event.submitter);
        if (values.method === "get") {
            if (values.encoding !== "application/x-www-form-urlencoded") return;
            const url = new URL(values.action, document.baseURI);
            if (!sameOrigin(url) || url.hash) return;
            event.preventDefault();
            void submitSafe(runtime, form, event.submitter);
            return;
        }
        const prepared = preparePost(form, event.submitter);
        if (!prepared) return;
        event.preventDefault();
        void submitUnsafe(runtime, form, prepared);
    };
    const onLive = (event: Event) => handleLiveEvent(runtime, event);
    const onCompositionStart = () => {
        runtime.composing = true;
    };
    const onCompositionEnd = (event: CompositionEvent) => {
        runtime.composing = false;
        (event.target as HTMLElement).dispatchEvent(
            new Event("input", { bubbles: true }),
        );
    };
    const onPopState = (event: PopStateEvent) => {
        if (runtime.disposed || !event.state?.hypergraft) return;
        const url = new URL(location.href);
        if (documentUnsafe.kind !== "idle") {
            runtime.queuedHistoryUrl = url;
            return;
        }
        void navigate(runtime, url, "pop");
    };
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    document.addEventListener("input", onLive);
    document.addEventListener("change", onLive);
    document.addEventListener("compositionstart", onCompositionStart);
    document.addEventListener("compositionend", onCompositionEnd);
    addEventListener("popstate", onPopState);
    runtime.detachListeners = () => {
        document.removeEventListener("click", onClick);
        document.removeEventListener("submit", onSubmit);
        document.removeEventListener("input", onLive);
        document.removeEventListener("change", onLive);
        document.removeEventListener("compositionstart", onCompositionStart);
        document.removeEventListener("compositionend", onCompositionEnd);
        removeEventListener("popstate", onPopState);
    };
    runtime.live.reconcile();
    return runtime;
}

export function requestGraftRefresh(form: HTMLFormElement): void {
    const runtime = activeRuntime;
    if (!runtime || !isRefreshForm(form)) return;
    queueRefresh(runtime, form);
    drainQueuedRefreshes(runtime);
}

export function startHypergraft(options: HypergraftOptions = {}) {
    if (activeRuntime) disposeRuntime(activeRuntime, true);
    const runtime = createRuntime(options);
    activeRuntime = runtime;
    if (options.islands) runtime.stopIslands = observeIslands(options.islands);
    return () => {
        if (activeRuntime === runtime) activeRuntime = undefined;
        disposeRuntime(runtime, false);
    };
}

/** Test helper: drop the document-level guard after an isolated case. */
export function resetHypergraftForTests() {
    if (activeRuntime) {
        disposeRuntime(activeRuntime, true);
        activeRuntime = undefined;
    }
    documentUnsafe = { kind: "idle" };
}

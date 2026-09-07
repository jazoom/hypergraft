import type { AcceptedPatchStatus } from "./patches";

export const LOCATION_CHANGE_EVENT = "hypergraft:locationchange";
export const REQUEST_SETTLED_EVENT = "hypergraft:requestsettled";
export const PROGRESS_EVENT = "hypergraft:progress";
export const LIVE_PATCH_EVENT = "hypergraft:livepatch";
export const LIVE_STATE_CHANGE_EVENT = "hypergraft:livestatechange";

export type LocationChangeDetail = {
    url: string;
    cause:
        | "link-navigation"
        | "get-form-replacement"
        | "command-patch-replacement"
        | "history-traversal";
};

type RequestSettledCommon = {
    requestKind: "patch";
    form: HTMLFormElement;
    /** Received response URL, or the attempted URL when no response arrived. */
    url: string;
};

/**
 * Settlement after pending and submitter state is final. Only applied patches
 * carry accepted status and authoritative target identifiers. Failures never
 * carry targets and only record a protocol-accepted status. The event never
 * carries HTML, form values or thrown errors.
 */
export type RequestSettledDetail = RequestSettledCommon &
    (
        | {
              outcome: "applied-patch";
              status: AcceptedPatchStatus;
              targetIds: readonly string[];
          }
        | {
              outcome: "safe-failure" | "uncertain-unsafe-result";
              status?: AcceptedPatchStatus;
          }
    );

export type AppliedLivePatchDetail = {
    form: HTMLFormElement;
    url: string;
    targetIds: readonly string[];
};

export type LiveCloseClassification =
    "retryable" | "terminal" | "protocol" | "leaseExpiry" | "resynchronisation";

/**
 * Bounded live transport state. An open socket does not prove that a
 * projection is current. Retry delay is present only while a reconnect
 * timer exists. Close classification is present only when a recognised
 * close caused the transition. The event never carries payloads, raw
 * close reasons, request URLs or form values.
 */
export type LiveStateChangeDetail =
    | { state: "idle" }
    | { state: "connecting" }
    | { state: "open" }
    | {
          state: "reconnecting";
          retryDelayMs: number;
          close: LiveCloseClassification;
      }
    | { state: "suspended" }
    | { state: "stopped"; close?: LiveCloseClassification };

export type ProgressDetail = {
    requestKind: "patch";
    form: HTMLFormElement;
    url: string;
    frame: number;
    targetIds: readonly string[];
};

export function emitLocationChange(detail: LocationChangeDetail): void {
    dispatchEvent(new CustomEvent(LOCATION_CHANGE_EVENT, { detail }));
}
export function emitRequestSettled(detail: RequestSettledDetail): void {
    dispatchEvent(new CustomEvent(REQUEST_SETTLED_EVENT, { detail }));
}
export function emitProgress(detail: ProgressDetail): void {
    dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail }));
}
export function listenForRequestSettled(
    listener: (detail: RequestSettledDetail) => void,
): () => void {
    const handler = (event: Event) =>
        listener((event as CustomEvent<RequestSettledDetail>).detail);
    addEventListener(REQUEST_SETTLED_EVENT, handler);
    return () => removeEventListener(REQUEST_SETTLED_EVENT, handler);
}
export function listenForLocationChanges(
    listener: (detail: LocationChangeDetail) => void,
): () => void {
    const handler = (event: Event) =>
        listener((event as CustomEvent<LocationChangeDetail>).detail);
    addEventListener(LOCATION_CHANGE_EVENT, handler);
    return () => removeEventListener(LOCATION_CHANGE_EVENT, handler);
}
export function listenForProgress(
    listener: (detail: ProgressDetail) => void,
): () => void {
    const handler = (event: Event) =>
        listener((event as CustomEvent<ProgressDetail>).detail);
    addEventListener(PROGRESS_EVENT, handler);
    return () => removeEventListener(PROGRESS_EVENT, handler);
}
export function emitLivePatch(detail: AppliedLivePatchDetail): void {
    dispatchEvent(new CustomEvent(LIVE_PATCH_EVENT, { detail }));
}
export function listenForLivePatches(
    listener: (detail: AppliedLivePatchDetail) => void,
): () => void {
    const handler = (event: Event) =>
        listener((event as CustomEvent<AppliedLivePatchDetail>).detail);
    addEventListener(LIVE_PATCH_EVENT, handler);
    return () => removeEventListener(LIVE_PATCH_EVENT, handler);
}
export function emitLiveStateChange(detail: LiveStateChangeDetail): void {
    dispatchEvent(new CustomEvent(LIVE_STATE_CHANGE_EVENT, { detail }));
}
export function listenForLiveStateChanges(
    listener: (detail: LiveStateChangeDetail) => void,
): () => void {
    const handler = (event: Event) =>
        listener((event as CustomEvent<LiveStateChangeDetail>).detail);
    addEventListener(LIVE_STATE_CHANGE_EVENT, handler);
    return () => removeEventListener(LIVE_STATE_CHANGE_EVENT, handler);
}

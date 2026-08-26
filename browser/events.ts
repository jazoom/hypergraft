import type { AcceptedPatchStatus } from "./patches";

export const LOCATION_CHANGE_EVENT = "hypergraft:locationchange";
export const REQUEST_SETTLED_EVENT = "hypergraft:requestsettled";
export const PROGRESS_EVENT = "hypergraft:progress";

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

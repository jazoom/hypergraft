export const DIAGNOSTIC_EVENT = "hypergraft:diagnostic";

/** Closed, secret-safe failure categories. The public diagnostic event never
 * exposes response bodies, form values, server diagnostics or thrown errors. */
export type DiagnosticReason =
    | "transport"
    | "redirect"
    | "byte-limit"
    | "utf-8"
    | "protocol"
    | "target-content"
    | "apply-failure"
    | "invalid-live-form"
    | "invalid-command-form"
    | "unknown-island"
    | "invalid-feedback";

/** A bounded failure fact. `targetId` is present only when a validated target
 * identifier existed at the point of failure; `element` is the originating
 * form, link or live control and is absent for history-driven navigation. */
export type DiagnosticDetail =
    | {
          reason: Exclude<
              DiagnosticReason,
              "invalid-command-form" | "unknown-island" | "invalid-feedback"
          >;
          requestKind: "navigation" | "patch";
          unsafe: boolean;
          url: string;
          element?: HTMLElement;
          targetId?: string;
      }
    | {
          reason: "invalid-command-form";
          element: HTMLElement;
      }
    | {
          reason: "unknown-island";
          element: HTMLElement;
          islandName: string;
      }
    | {
          reason: "invalid-feedback";
          element: HTMLElement;
      };

export function emitDiagnostic(detail: DiagnosticDetail): void {
    dispatchEvent(new CustomEvent(DIAGNOSTIC_EVENT, { detail }));
}

export function listenForDiagnostics(
    listener: (detail: DiagnosticDetail) => void,
): () => void {
    const handler = (event: Event) =>
        listener((event as CustomEvent<DiagnosticDetail>).detail);
    addEventListener(DIAGNOSTIC_EVENT, handler);
    return () => removeEventListener(DIAGNOSTIC_EVENT, handler);
}

// The reason an internal failure carries. Configuration problems are reported
// directly rather than thrown, so they are not failure reasons.
type FailureReason = Exclude<
    DiagnosticReason,
    | "invalid-live-form"
    | "invalid-command-form"
    | "unknown-island"
    | "invalid-feedback"
>;

/** Internal error used by the bounded reader and preflight. Public diagnostics
 * derive their reason from this type and never from the message text. */
export class HypergraftError extends Error {
    constructor(
        public readonly reason: FailureReason,
        message: string,
        public readonly targetId?: string,
    ) {
        super(message);
        this.name = "HypergraftError";
    }
}

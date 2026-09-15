import { startHypergraft } from "../requests";
import * as primaryPatches from "../patches";
// @ts-expect-error separately evaluated copy
import * as duplicatePatches from "../patches?hypergraft-copy=duplicate";

export type FixtureAction =
    | "snapshot"
    | "restart-runtime"
    | "preflight-primary"
    | "apply-primary"
    | "preflight-duplicate"
    | "submit-disabled";

export type FixtureViolation = {
    effectiveDirective: string;
};

export type FixtureRequest = {
    id: number;
    action: FixtureAction;
};

export type FixtureReady = {
    type: "ready";
    trustedTypes: boolean;
};

export type FixtureResult = {
    type: "result";
    id: number;
    ok: boolean;
    policies: string[];
    violations: FixtureViolation[];
    reason?: string;
    originalPresent?: boolean;
    patchedPresent?: boolean;
    disabled?: boolean;
    pending?: boolean;
    sameButton?: boolean;
    uncertain?: boolean;
};

const PATCH_CONTENT = '<p id="patched">Patched</p>';
const DISABLED_FORM =
    '<form method="post" action="/command" data-graft><input name="credential" value="wrong"><button id="save" type="submit" disabled>Save</button></form>';

const violations: FixtureViolation[] = [];

document.addEventListener("securitypolicyviolation", (event) => {
    violations.push({ effectiveDirective: event.effectiveDirective });
});
window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (event.origin !== window.location.origin) return;
    if (!isRequest(event.data)) return;
    void handle(event.data);
});
window.parent.postMessage(
    {
        type: "ready",
        trustedTypes: Boolean(
            (window as Window & { trustedTypes?: unknown }).trustedTypes,
        ),
    } satisfies FixtureReady,
    window.location.origin,
);

async function waitForPolicyViolation() {
    if (
        violations.some((event) => event.effectiveDirective === "trusted-types")
    )
        return;
    await new Promise<void>((resolve) => {
        const finish = () => {
            window.clearTimeout(timer);
            document.removeEventListener(
                "securitypolicyviolation",
                onViolation,
            );
            resolve();
        };
        const onViolation = (event: SecurityPolicyViolationEvent) => {
            if (event.effectiveDirective === "trusted-types") finish();
        };
        const timer = window.setTimeout(finish, 2_000);
        document.addEventListener("securitypolicyviolation", onViolation);
    });
}

function createdPolicies(): string[] {
    const names = (
        window as Window & { __hypergraftCreatedPolicies?: string[] }
    ).__hypergraftCreatedPolicies;
    return names ? [...names] : [];
}

function isRequest(value: unknown): value is FixtureRequest {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record.id === "number" && typeof record.action === "string";
}

function protocolReason(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const record = error as { reason?: unknown };
    return typeof record.reason === "string" ? record.reason : undefined;
}

function snapshot() {
    return {
        policies: createdPolicies(),
        violations: violations.map((violation) => ({
            effectiveDirective: violation.effectiveDirective,
        })),
        originalPresent: document.getElementById("original") !== null,
        patchedPresent: document.getElementById("patched") !== null,
    };
}

function reply(id: number, fields: Partial<FixtureResult> & { ok: boolean }) {
    window.parent.postMessage(
        {
            type: "result",
            id,
            ...snapshot(),
            ...fields,
        } satisfies FixtureResult,
        window.location.origin,
    );
}

function envelope(mod: typeof primaryPatches, content: string, status = 200) {
    const body = `<graft-patch-set version="1"><graft-patch operation="children" target="command"><template>${content}</template></graft-patch></graft-patch-set>`;
    return {
        body,
        response: new Response(body, {
            status,
            headers: { "content-type": mod.MEDIA_TYPE },
        }),
    };
}

function preflightWith(mod: typeof primaryPatches) {
    const { body, response } = envelope(mod, PATCH_CONTENT);
    return mod.preflight(response, body);
}

async function handle(request: FixtureRequest) {
    try {
        switch (request.action) {
            case "snapshot":
                reply(request.id, { ok: true });
                return;
            case "restart-runtime":
                startHypergraft();
                startHypergraft()();
                reply(request.id, { ok: true });
                return;
            case "preflight-primary": {
                const prepared = preflightWith(primaryPatches);
                reply(request.id, { ok: prepared.kind === "patches" });
                return;
            }
            case "apply-primary": {
                const prepared = preflightWith(primaryPatches);
                if (prepared.kind === "patches")
                    primaryPatches.apply(prepared.batch);
                reply(request.id, { ok: true });
                return;
            }
            case "preflight-duplicate": {
                const prepared = preflightWith(duplicatePatches);
                reply(request.id, { ok: prepared.kind === "patches" });
                return;
            }
            case "submit-disabled": {
                const form = document.querySelector("form");
                const button = document.getElementById("save");
                if (
                    !(form instanceof HTMLFormElement) ||
                    !(button instanceof HTMLButtonElement)
                ) {
                    reply(request.id, { ok: false });
                    return;
                }
                const originalButton = button;
                const { body } = envelope(primaryPatches, DISABLED_FORM, 422);
                window.fetch = async () =>
                    new Response(body, {
                        status: 422,
                        headers: {
                            "content-type": primaryPatches.MEDIA_TYPE,
                        },
                    });
                let uncertain = false;
                startHypergraft({
                    feedback: {
                        safeFailure() {},
                        safeRecovery() {},
                        uncertainUnsafeOutcome() {
                            uncertain = true;
                        },
                    },
                });
                const settled = await new Promise<{
                    disabled: boolean;
                    pending: boolean;
                    sameButton: boolean;
                }>((resolve, reject) => {
                    const timer = window.setTimeout(
                        () => reject(new Error("command did not settle")),
                        10_000,
                    );
                    addEventListener(
                        "hypergraft:requestsettled",
                        () => {
                            window.clearTimeout(timer);
                            const save = document.getElementById("save");
                            resolve({
                                disabled:
                                    save instanceof HTMLButtonElement &&
                                    save.disabled,
                                pending:
                                    save instanceof HTMLButtonElement &&
                                    save.hasAttribute(
                                        "data-graft-submitter-pending",
                                    ),
                                sameButton: save === originalButton,
                            });
                        },
                        { once: true },
                    );
                    form.dispatchEvent(
                        new SubmitEvent("submit", {
                            bubbles: true,
                            cancelable: true,
                            submitter: button,
                        }),
                    );
                });
                if (uncertain) await waitForPolicyViolation();
                reply(request.id, { ok: true, ...settled, uncertain });
                return;
            }
        }
    } catch (error) {
        if (protocolReason(error) === "protocol")
            await waitForPolicyViolation();
        reply(request.id, {
            ok: false,
            reason: protocolReason(error),
        });
    }
}
